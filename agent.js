require('dotenv').config();
const { collectMarketData } = require('./perception');
const { assess, calcSizeMultiplier } = require('./risk');
const bitget = require('./bitget');
const MAX_SIZE = parseFloat(process.env.MAX_POSITION_SIZE_USDT || '100');
const CYCLE_MS = parseInt(process.env.CYCLE_INTERVAL_MS || '300000');
const SYMBOL = 'BTCUSDT';
let prevSources = [];
const server = require('./server');

const ARCHITECT_PROMPT = (market, risk) => `
You are the Architect. Propose a trading action based on direction signal.

Direction Signal:
${JSON.stringify(market.directionSignal, null, 2)}

Risk (size control only):
- riskLevel: ${risk.riskLevel}
- sizeMultiplier: ${risk.sizeMultiplier}
- deviationScore: ${risk.deviationScore.toFixed(1)}
- oiChangeScore: ${risk.oiChangeScore.toFixed(1)}

Rules:
- direction="long" → propose long
- direction="short" → propose short
- direction="neutral" AND strength=0 → hold
- strength >= 0.3 always triggers an action (never hold on strength >= 0.3)

Propose: { action: "long"|"short"|"hold", confidence: 0-1, reasoning: "..." }
JSON only.
`;

const AUDITOR_PROMPT = (proposal, risk) => `
You are the Auditor. Review this proposal focusing on position sizing risk.

Proposal: ${JSON.stringify(proposal)}
Risk Assessment:
- riskLevel: ${risk.riskLevel}
- sizeMultiplier: ${risk.sizeMultiplier}
- deviationScore: ${risk.deviationScore.toFixed(1)} (CEX spread risk)
- oiChangeScore: ${risk.oiChangeScore.toFixed(1)} (OI momentum risk)
- oiConcentration: ${risk.oiConcentration.toFixed(2)}

Rules:
- If riskLevel="risk_off": recommend size reduction, but do NOT reject direction
- If oiConcentration > 0.7: flag liquidity concentration risk
- Focus on WHETHER to reduce size, not whether to change direction

Respond: { approved: true|false, confidence: 0-1, feedback: "..." }
JSON only.
`;

const ARBITER_PROMPT = (proposal, audit, risk) => `
You are the Arbiter. Make the final trading decision.

Proposal: ${JSON.stringify(proposal)}
Audit: ${JSON.stringify(audit)}
sizeMultiplier: ${risk.sizeMultiplier}

Rules:
- Respect proposal direction unless audit.approved=false AND riskLevel="risk_off"
- Minimum confidence to act: 0.6
- size_pct = proposal confidence * sizeMultiplier

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
  const text = data.choices?.[0]?.message?.content || '{}';
  try { return JSON.parse(text); } catch { return {}; }
}

let openPosition = null;

async function runCycle(server) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] --- cycle start ---`);
  try {
    const market = await collectMarketData(SYMBOL, prevSources);
    prevSources = market.sources;
    const risk = assess(market, prevSources);
    console.log(`[perception] ${market.sources.length} CEX sources, dir=${market.directionSignal.direction} strength=${market.directionSignal.strength}`);
    console.log(`[risk] ${risk.summary}`);

    const proposal = await callLLM(ARCHITECT_PROMPT(market, risk));
    console.log(`[architect] action=${proposal.action} confidence=${proposal.confidence}`);

    const audit = await callLLM(AUDITOR_PROMPT(proposal, risk));
    console.log(`[auditor] approved=${audit.approved} confidence=${audit.confidence}`);

    const decision = await callLLM(ARBITER_PROMPT(proposal, audit, risk));
    console.log(`[arbiter] action=${decision.action} confidence=${decision.confidence} size_pct=${decision.size_pct}`);

    // 執行
    if (decision.action === 'long' || decision.action === 'short') {
      if (decision.confidence >= 0.6 && decision.size_pct > 0) {
        const size = MAX_SIZE * (decision.size_pct || 0.5);
        console.log(`[execute] ${decision.action} size=${size.toFixed(2)} USDT`);
        // bitget execution here
      }
    } else if (decision.action === 'close' && openPosition) {
      console.log(`[execute] close position`);
    } else {
      console.log(`[execute] hold`);
    }

    // server用にstate更新
    if (server.updateState) server.updateState({ market, risk, proposal, audit, decision, timestamp });

  } catch (err) {
    console.error(`[error] ${err.message}`);
  }
}


module.exports = { runCycle };
module.exports = { runCycle };
