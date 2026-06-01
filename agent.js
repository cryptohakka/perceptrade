require('dotenv').config();
const { collectMarketData } = require('./perception');
const { assess, calcPositionSize } = require('./risk');
const bitget = require('./bitget');

const MAX_SIZE = parseFloat(process.env.MAX_POSITION_SIZE_USDT || '100');
const CYCLE_MS = parseInt(process.env.CYCLE_INTERVAL_MS || '60000');
const SYMBOL = 'BTCUSDT';
let prevSources = [];
const server = require('./server');

const ARCHITECT_PROMPT = (market, risk) => `
You are the Architect. Analyze market data and propose a trading action.
Market Data:
${JSON.stringify(market, null, 2)}
Risk Assessment:
${JSON.stringify(risk, null, 2)}
Propose ONE action: { action: "long"|"short"|"close"|"hold", confidence: 0-1, reasoning: "..." }
Respond in JSON only.
`;

const AUDITOR_PROMPT = (proposal, risk) => `
You are the Auditor. Review this trading proposal with skepticism.
Proposal: ${JSON.stringify(proposal)}
Risk: ${JSON.stringify(risk)}
Rules:
- If riskLevel is "risk_off", reject unless closing a position
- If frBias conflicts with proposed direction, reduce confidence
- If oiConcentration > 0.7, flag as high risk
Respond: { approved: true|false, confidence: 0-1, feedback: "..." }
JSON only.
`;

const ARBITER_PROMPT = (proposal, audit, risk) => `
You are the Arbiter. Make the final trading decision.
Proposal: ${JSON.stringify(proposal)}
Audit: ${JSON.stringify(audit)}
Risk: ${JSON.stringify(risk)}
Rules:
- If audit.approved=false and riskLevel=risk_off: hold
- Minimum confidence to act: 0.65
- Output final decision
Respond: { action: "long"|"short"|"close"|"hold", confidence: 0-1, size_pct: 0-1, reasoning: "..." }
JSON only.
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
  const text = data.choices[0].message.content.replace(/```json|```/g, '').trim();
  try {
    return JSON.parse(text);
  } catch(e) {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch(e2) {} }
    console.error('[llm parse error]', text.slice(0, 100));
    throw e;
  }
}

async function getCurrentPosition(symbol) {
  try {
    const res = await bitget.getPositions();
    const positions = res.data || [];
    return positions.find(p => p.symbol === symbol && parseFloat(p.total) > 0) || null;
  } catch (e) {
    console.error('[position] fetch error:', e.message);
    return null;
  }
}

async function execute(decision, risk, currentPos) {
  const { action, size_pct } = decision;
  const size = calcPositionSize(MAX_SIZE, risk.riskScore) * size_pct;

  // closeが必要なケース
  if (currentPos) {
    const posSize = parseFloat(currentPos.total);
    const posSide = currentPos.holdSide; // 'long' or 'short'

    // 方向転換: 既存ポジをまずclose
    if ((action === 'long' && posSide === 'short') ||
        (action === 'short' && posSide === 'long') ||
        action === 'close') {
      const closeSide = posSide === 'long' ? 'sell' : 'buy';
      console.log(`[execute] close ${posSide} ${posSize}`);
      await bitget.closePosition(SYMBOL, closeSide, posSize);
      if (action === 'close') return;
    }
  }

  // 新規エントリー
  if (action === 'long' || action === 'short') {
    // sizeをBTC数量に変換（ticker取得）
    const ticker = await bitget.getTicker(SYMBOL);
    const markPrice = parseFloat(ticker.data[0].lastPr);
    const btcSize = (size / markPrice).toFixed(4);

    const side = action === 'long' ? 'buy' : 'sell';
    console.log(`[execute] ${action} ${btcSize} BTC (~${size.toFixed(2)} USDT) @ ${markPrice}`);
    const res = await bitget.placeOrder(SYMBOL, side, btcSize);
    console.log(`[execute] orderId=${res.data?.orderId || JSON.stringify(res)}`);
  }
}

async function runCycle(srv) {
  console.log(`\n[${new Date().toISOString()}] --- cycle start ---`);
  try {
    const market = await collectMarketData(SYMBOL);
    console.log(`[perception] ${market.sources.length} CEX sources, riskScore=${market.riskScore.toFixed(1)}`);

    const risk = assess(market, prevSources);
    prevSources = market.sources.map(s => ({ exchange: s.exchange, oi: s.oi, fr: s.fr }));
    console.log(`[risk] ${risk.summary}`);

    const proposal = await callLLM(ARCHITECT_PROMPT(market, risk));
    console.log(`[architect] action=${proposal.action} confidence=${proposal.confidence}`);

    const audit = await callLLM(AUDITOR_PROMPT(proposal, risk));
    console.log(`[auditor] approved=${audit.approved} confidence=${audit.confidence}`);

    const decision = await callLLM(ARBITER_PROMPT(proposal, audit, risk));
    console.log(`[arbiter] action=${decision.action} confidence=${decision.confidence} size_pct=${decision.size_pct}`);

    const currentPos = await getCurrentPosition(SYMBOL);
    if (currentPos) {
      console.log(`[position] ${currentPos.holdSide} ${currentPos.total} BTC, upl=${currentPos.unrealizedPL}`);
    }

    if (decision.confidence >= 0.65 && decision.action !== 'hold') {
      await execute(decision, risk, currentPos);
    } else {
      console.log(`[execute] hold`);
    }

    
    (srv || server).updateState({ market, risk, proposal, audit, decision, position: currentPos });
    return { market, risk, proposal, audit, decision };
  } catch (err) {
    console.error('[error]', err.message);
  }
}

async function main() {
  console.log('PercepTrade agent starting...');
  await runCycle();
  setInterval(runCycle, CYCLE_MS);
}

if (require.main === module) main();

module.exports = { runCycle };
