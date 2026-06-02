require('dotenv').config();
const { collectMarketData } = require('./perception');
const { assess, calcSizeMultiplier, detectCrowdRisk } = require('./risk');
const bitget = require('./bitget');
const MAX_SIZE = parseFloat(process.env.MAX_POSITION_SIZE_USDT || '100');
const CYCLE_MS = parseInt(process.env.CYCLE_INTERVAL_MS || '300000');
const SYMBOL = 'BTCUSDT';
let prevSources = [];
const server = require('./server');

const ARCHITECT_PROMPT = (market, risk) => `
You are the Architect. Propose a trading action.

Direction Signal: ${JSON.stringify(market.directionSignal)}
riskLevel: ${risk.riskLevel} | sizeMultiplier: ${risk.sizeMultiplier}

Rules:
- direction="long" → long, direction="short" → short
- direction="neutral" AND strength=0 → hold
- strength >= 0.3 always triggers action

Respond in JSON. reasoning must be ONE sentence, max 10 words, no hedging, no meta-commentary.
{ "action": "long"|"short"|"hold", "confidence": 0-1, "reasoning": "..." }
`;

const AUDITOR_PROMPT = (proposal, risk, crowd) => `
You are the Auditor. Review this proposal focusing on position sizing risk.

Proposal: ${JSON.stringify(proposal)}
Risk Assessment:
- riskLevel: ${risk.riskLevel}
- sizeMultiplier: ${risk.sizeMultiplier}
- deviationScore: ${risk.deviationScore.toFixed(1)} (CEX spread risk)
- oiChangeScore: ${risk.oiChangeScore.toFixed(1)} (OI momentum risk)
- oiConcentration: ${risk.oiConcentration.toFixed(2)}

Crowd Risk Detection:
${crowd.hasCrowdRisk ? '⚠ ' + crowd.summary : 'none'}

Rules:
- If riskLevel="risk_off": recommend size reduction, but do NOT reject direction
- If oiConcentration > 0.7: flag liquidity concentration risk
- If crowd.hasCrowdRisk: flag the anomalous exchange and recommend reducing size
- Focus on WHETHER to reduce size, not whether to change direction

Respond: { approved: true|false, confidence: 0-1, feedback: "..." }
JSON only.
`;

const ARBITER_PROMPT = (proposal, audit, risk) => `
You are the Arbiter. Make the final decision.

Proposal: ${JSON.stringify(proposal)}
Audit: ${JSON.stringify(audit)}
sizeMultiplier: ${risk.sizeMultiplier}

Rules:
- Respect proposal direction unless audit.approved=false AND riskLevel="risk_off"
- Minimum confidence to act: 0.3
- size_pct = proposal.confidence * sizeMultiplier (show the math)

reasoning must follow this EXACT format (no other text):
"[ACTION] @ [size_pct*100]%\n[proposal.confidence*100]% confidence × ×[sizeMultiplier] risk multiplier = [size_pct*100]%"
Example: "LONG @ 35%\n70% confidence × ×0.5 risk multiplier = 35%"

{ "action": "long"|"short"|"close"|"hold", "confidence": 0-1, "size_pct": 0-1, "reasoning": "..." }
`;

async function callLLM(prompt) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`
    },
    body: JSON.stringify({
      model: process.env.OPENROUTER_MODEL || 'google/gemini-2.5-flash-lite',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' }
    })
  });
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || '{}';
  try { return JSON.parse(text); } catch { return {}; }
}

let openPosition = null;

async function syncOpenPosition() {
  try {
    const positions = await bitget.getPositions();
    const pos = positions?.data?.find(p => p.symbol === 'BTCUSDT' && parseFloat(p.total) > 0);
    if (pos) {
      openPosition = pos;  // keep raw Bitget structure for UI
      console.log(`[sync] restored position: ${pos.holdSide} ${pos.total} BTC @ ${pos.openPriceAvg}`);
    }
  } catch(e) {
    console.error('[sync] failed:', e.message);
  }
}

syncOpenPosition();

async function runCycle(server) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] --- cycle start ---`);
  try {
    const prev = prevSources;
    const market = await collectMarketData(SYMBOL, prev);
    prevSources = market.sources;
    const risk = assess(market, prev);
    console.log(`[perception] ${market.sources.length} CEX sources, dir=${market.directionSignal.direction} strength=${market.directionSignal.strength}`);
    console.log(`[risk] ${risk.summary}`);
    const crowd = detectCrowdRisk(market.sources, risk.frChanges, risk.oiChanges);
    if (crowd.hasCrowdRisk) console.log(`[crowd] ${crowd.summary}`);

    const proposal = await callLLM(ARCHITECT_PROMPT(market, risk));
    console.log(`[architect] action=${proposal.action} confidence=${proposal.confidence}`);

    const audit = await callLLM(AUDITOR_PROMPT(proposal, risk, crowd));
    console.log(`[auditor] approved=${audit.approved} confidence=${audit.confidence}`);

    const decision = await callLLM(ARBITER_PROMPT(proposal, audit, risk));
    console.log(`[arbiter] action=${decision.action} confidence=${decision.confidence} size_pct=${decision.size_pct}`);

    // 執行
    const ticker = await bitget.getTicker(SYMBOL);
    const price = parseFloat(ticker?.data?.[0]?.lastPr || 0);

    if (decision.action === 'long' || decision.action === 'short') {
      if (decision.confidence >= 0.3 && decision.size_pct > 0 && price > 0) {
        // 既存ポジションと逆方向 → まず閉じる
        if (openPosition && (openPosition.holdSide || openPosition.side) !== decision.action) {
          const closeSide = (openPosition.holdSide || openPosition.side) === 'long' ? 'sell' : 'buy';
          await bitget.closePosition(SYMBOL, closeSide, openPosition.total || openPosition.size);
          console.log(`[execute] closed ${openPosition.holdSide || openPosition.side} before reversal`);
          openPosition = null;
        }
        // 既に同方向ポジションあり → スキップ
        if (openPosition && (openPosition.holdSide || openPosition.side) === decision.action) {
          console.log(`[execute] already ${decision.action}, hold`);
        } else {
          const leverage = parseInt(process.env.LEVERAGE || '3');
          const sizeUsdt = MAX_SIZE * decision.size_pct;
          const sizeContracts = (sizeUsdt * leverage / price).toFixed(4);
          const orderSide = decision.action === 'long' ? 'buy' : 'sell';

          const order = await bitget.placeOrder(SYMBOL, orderSide, sizeContracts);
          console.log(`[execute] ${decision.action} ${sizeContracts} BTC @ ~${price} (${sizeUsdt.toFixed(2)} USDT x${leverage})`);
          console.log(`[execute] order=${JSON.stringify(order?.data)}`);

          if (order?.code === '00000') {
            // TP/SL設定
            const TP_PCT = parseFloat(process.env.TP_PCT || '0.015');  // 1.5%
            const SL_PCT = parseFloat(process.env.SL_PCT || '0.010');  // 1.0%
            const tpPrice = decision.action === 'long'
              ? (price * (1 + TP_PCT)).toFixed(1)
              : (price * (1 - TP_PCT)).toFixed(1);
            const slPrice = decision.action === 'long'
              ? (price * (1 - SL_PCT)).toFixed(1)
              : (price * (1 + SL_PCT)).toFixed(1);

            await bitget.setTPSL(SYMBOL, decision.action, tpPrice, slPrice);
            console.log(`[execute] TP=${tpPrice} SL=${slPrice}`);

            openPosition = {
              holdSide: decision.action,
              total: sizeContracts,
              openPriceAvg: price.toString(),
              marginSize: (sizeUsdt / leverage).toFixed(4),
              unrealizedPL: '0',
              takeProfit: tpPrice,
              stopLoss: slPrice
            };
          } else {
            console.error(`[execute] order failed: ${JSON.stringify(order)}`);
          }
        }
      }
    } else if (decision.action === 'close' && openPosition) {
      const closeSide = (openPosition.holdSide || openPosition.side) === 'long' ? 'sell' : 'buy';
      const order = await bitget.closePosition(SYMBOL, closeSide, openPosition.total || openPosition.size);
      console.log(`[execute] close ${openPosition.holdSide || openPosition.side} @ ~${price}`);
      if (order?.code === '00000') { openPosition = null; }
    } else {
      console.log(`[execute] hold`);
    }

    // ポジション同期（外部決済検知）
    if (openPosition) {
      const positions = await bitget.getPositions();
      const pos = positions?.data?.find(p => p.symbol === SYMBOL && parseFloat(p.total) > 0);
      if (!pos) {
        console.log(`[execute] position closed externally (TP/SL hit)`);
        openPosition = null;
      }
    }

    // server用にstate更新
    if (server.updateState) server.updateState({ market, risk, crowd, proposal, audit, decision, timestamp, openPosition });

  } catch (err) {
    console.error(`[error] ${err.message}`);
  }
}


module.exports = { runCycle };
module.exports = { runCycle };
