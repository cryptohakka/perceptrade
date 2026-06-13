require('dotenv').config();
const fs = require('fs');
const { applyRegimeGate } = require('./regime_classifier');
const { loadRegimeState } = require('./regime_classifier');
const CROWD_EVENTS_FILE = process.env.CROWD_EVENTS_FILE || '/home/agent/perceptrade/crowd_events.json';
const SNAPSHOTS_FILE = process.env.SNAPSHOTS_FILE || '/home/agent/perceptrade/snapshots.json';
const OUTCOMES_FILE = process.env.OUTCOMES_FILE || '/home/agent/perceptrade/crowd_outcomes.json';
const SHADOW_TRADES_FILE = process.env.SHADOW_TRADES_FILE || '/home/agent/perceptrade/shadow_trades.json';
const SHADOW_CHECK_MS    = parseInt(process.env.SHADOW_CHECK_MS || String(30 * 60 * 1000)); // 30min

// ── Case 1: 多段ディベート設定 ────────────────────────────────────
const MAX_DEBATE_ROUNDS = parseInt(process.env.MAX_DEBATE_ROUNDS || '2');

// ── 案5: サーキットブレーカー設定 ────────────────────────────────
const DAILY_LOSS_LIMIT_PCT      = parseFloat(process.env.DAILY_LOSS_LIMIT_PCT      || '-3.0');
const CONSEC_LOSS_THRESHOLD     = parseInt(process.env.CONSEC_LOSS_THRESHOLD       || '3');
const CONSEC_LOSS_COOLDOWN_CYCLES = parseInt(process.env.CONSEC_LOSS_COOLDOWN_CYCLES || '6');

// サーキットブレーカー状態 (インメモリ、再起動でリセット)
const cbState = { cooldownUntil: null };

function checkCircuitBreaker(postMortems) {
  const now = new Date();

  // 1. 連敗クールダウン中か確認
  if (cbState.cooldownUntil && now < cbState.cooldownUntil) {
    const remainingMin = Math.ceil((cbState.cooldownUntil - now) / 60000);
    return { blocked: true, reason: 'consecutive_loss_cooldown', remainingMin };
  }
  cbState.cooldownUntil = null;

  if (!postMortems || postMortems.length === 0) return { blocked: false };

  // 2. 日次損失上限チェック (UTC日付基準)
  const todayStr   = now.toISOString().slice(0, 10);
  const todayTrades = postMortems.filter(m => m.ts && m.ts.startsWith(todayStr));
  const dailyPnl   = todayTrades.reduce((s, m) => s + (m.pnl_pct || 0), 0);

  if (dailyPnl <= DAILY_LOSS_LIMIT_PCT) {
    return {
      blocked:  true,
      reason:   'daily_loss_limit',
      dailyPnl: parseFloat(dailyPnl.toFixed(4)),
      limit:    DAILY_LOSS_LIMIT_PCT
    };
  }

  // 3. 連敗チェック → クールダウン開始
  const recent = postMortems.slice(0, CONSEC_LOSS_THRESHOLD);
  if (recent.length >= CONSEC_LOSS_THRESHOLD && recent.every(m => m.result === 'loss')) {
    const cooldownMs      = CONSEC_LOSS_COOLDOWN_CYCLES * CYCLE_MS;
    cbState.cooldownUntil = new Date(now.getTime() + cooldownMs);
    const cooldownMin     = Math.ceil(cooldownMs / 60000);
    return {
      blocked:    true,
      reason:     'consecutive_losses',
      count:      CONSEC_LOSS_THRESHOLD,
      cooldownMin
    };
  }

  return { blocked: false };
}

// ── 案3: Shadow Trade台帳 ─────────────────────────────────────────
// 「トレードしなかった判断」を並行追跡し、Councilの介入価値を定量化
// reason: 'auditor_rejected' | 'regime_gate'
// 30分後に価格取得 → 仮想PnL計算 → shadow_trades.jsonに記録

function recordShadowTrade(reason, side, entryPrice, frZ, confidence) {
  if (!side || side === 'hold' || side === 'neutral') return null;
  try {
    let shadows = [];
    if (fs.existsSync(SHADOW_TRADES_FILE)) {
      shadows = JSON.parse(fs.readFileSync(SHADOW_TRADES_FILE, 'utf8'));
    }
    const id = new Date().toISOString();
    shadows.unshift({
      id,
      ts:                   id,
      reason,
      side,
      virtual_entry_price:  entryPrice,
      frZ_at_block:         frZ     ?? null,
      confidence_at_block:  confidence ?? null,
      virtual_exit_price:   null,
      virtual_pnl_pct:      null,
      resolved:             false,
    });
    if (shadows.length > 200) shadows = shadows.slice(0, 200);
    fs.writeFileSync(SHADOW_TRADES_FILE, JSON.stringify(shadows, null, 2));
    console.log(`[shadow] recorded ${reason} | side=${side} entry=${entryPrice} frZ=${frZ}`);
    return id;
  } catch(e) {
    console.error('[shadow] record failed:', e.message);
    return null;
  }
}

function scheduleShadowOutcome(id, entryPrice, side) {
  if (!id) return;
  const leverage  = parseInt(process.env.LEVERAGE || '2');
  const entryFee  = parseFloat(process.env.ENTRY_FEE_PCT || '0.0006');
  const exitFee   = parseFloat(process.env.EXIT_FEE_PCT  || '0.0006');
  const feePct    = (entryFee + exitFee) * leverage * 100; // %

  setTimeout(async () => {
    try {
      const ticker    = await bitget.getTicker('BTCUSDT');
      const exitPrice = parseFloat(ticker?.data?.[0]?.lastPr || 0);
      if (!exitPrice) return;

      const dir           = side === 'long' ? 1 : -1;
      const raw           = (exitPrice - entryPrice) / entryPrice * dir;
      const virtual_pnl   = parseFloat((raw * leverage * 100 - feePct).toFixed(4));
      const virtual_result = virtual_pnl > 0 ? 'win' : 'loss';

      let shadows = [];
      if (fs.existsSync(SHADOW_TRADES_FILE)) {
        shadows = JSON.parse(fs.readFileSync(SHADOW_TRADES_FILE, 'utf8'));
      }
      const entry = shadows.find(s => s.id === id);
      if (entry) {
        entry.virtual_exit_price = exitPrice;
        entry.virtual_pnl_pct    = virtual_pnl;
        entry.virtual_result     = virtual_result;
        entry.resolved           = true;
        fs.writeFileSync(SHADOW_TRADES_FILE, JSON.stringify(shadows, null, 2));
        console.log(`[shadow] resolved ${entry.reason} | side=${side} pnl=${virtual_pnl}% (${virtual_result})`);
      }
    } catch(e) {
      console.error('[shadow] outcome failed:', e.message);
    }
  }, SHADOW_CHECK_MS);
}


// ── Crowd Risk Event保存 ──────────────────────────────────────────
function saveCrowdEvent(crowd, risk, decision, market, price) {
  try {
    let events = [];
    if (fs.existsSync(CROWD_EVENTS_FILE)) {
      events = JSON.parse(fs.readFileSync(CROWD_EVENTS_FILE, 'utf8'));
    }
    const originalSizePct = decision?.confidence || 0;
    const finalSizePct = decision?.size_pct || 0;
    events.unshift({
      timestamp: new Date().toISOString(),
      alerts: crowd.alerts,
      summary: crowd.summary,
      riskLevel: risk.riskLevel,
      sizeMultiplier: risk.sizeMultiplier,
      action: decision?.action || 'hold',
      original_size_pct: originalSizePct,
      size_pct: finalSizePct,
      reduction_pct: parseFloat((originalSizePct - finalSizePct).toFixed(3)),
      avgFR: market?.avgFR || null,
      btcPrice: price || null
    });
    if (events.length > 100) events = events.slice(0, 100);
    fs.writeFileSync(CROWD_EVENTS_FILE, JSON.stringify(events, null, 2));
  } catch(e) {
    console.error('[crowd_event] save failed:', e.message);
  }
}

// ── 毎サイクル スナップショット保存 ──────────────────────────────
// Case 1: debate情報を追加
function saveSnapshot(market, risk, crowd, decision, price, audit, debate) {
  try {
    let snaps = [];
    if (fs.existsSync(SNAPSHOTS_FILE)) {
      snaps = JSON.parse(fs.readFileSync(SNAPSHOTS_FILE, 'utf8'));
    }
    snaps.unshift({
      timestamp: new Date().toISOString(),
      btcPrice: price || null,
      sources: (market.sources || []).map(s => ({
        exchange: s.exchange,
        fr: s.fr,
        oi: s.oi
      })),
      avgFR: market.avgFR || null,
      frZ: market.directionSignal?.frZ ?? null,
      directionSignal: market.directionSignal,
      riskLevel: risk.riskLevel,
      sizeMultiplier: risk.sizeMultiplier,
      deviationScore: risk.deviationScore,
      oiChangeScore: risk.oiChangeScore,
      hasCrowdRisk: crowd.hasCrowdRisk,
      crowdAlerts: crowd.alerts || [],
      action: decision?.action || 'hold',
      size_pct: decision?.size_pct || 0,
      confidence: decision?.confidence || 0,
      audit: audit ? { approved: audit.approved, feedback: audit.feedback, scenarios: audit.scenarios || [] } : null,
      // Case 1: 多段ディベート可観測性
      debateRounds:      debate?.rounds      ?? null,
      converged:         debate?.converged   ?? null,
      disagreementIndex: debate?.disagreementIndex ?? null,
      // Case 4: confidence較正
      calibration: debate?._calibration ?? null,
    });
    fs.writeFileSync(SNAPSHOTS_FILE, JSON.stringify(snaps));
  } catch(e) {
    console.error('[snapshot] save failed:', e.message);
  }
}

// ── FR履歴をsnapshotsからロード ──────────────────────────────────
function loadRecentPostMortems(n = 3) {
  try {
    if (!fs.existsSync(POSTMORTEM_FILE)) return [];
    return JSON.parse(fs.readFileSync(POSTMORTEM_FILE, 'utf8')).slice(0, n);
  } catch { return []; }
}

function loadFRHistory(n = 288) {
  try {
    if (!fs.existsSync(SNAPSHOTS_FILE)) return [];
    const snaps = JSON.parse(fs.readFileSync(SNAPSHOTS_FILE, 'utf8'));
    return snaps.slice(0, n).map(s => s.avgFR).filter(v => typeof v === 'number');
  } catch { return []; }
}

// ── 再起動時のprevSources復元（OI momentumの連続性確保）──────────
function loadPrevSources(maxAgeMs = 10 * 60 * 1000) {
  try {
    if (!fs.existsSync(SNAPSHOTS_FILE)) return [];
    const snaps = JSON.parse(fs.readFileSync(SNAPSHOTS_FILE, 'utf8'));
    const latest = snaps[0];
    if (!latest || !latest.sources || !latest.timestamp) return [];
    const age = Date.now() - new Date(latest.timestamp).getTime();
    if (age > maxAgeMs) {
      console.log(`[sync] last snapshot ${Math.round(age/60000)}min old (>10min) — OI momentum starts fresh`);
      return [];
    }
    console.log(`[sync] restored prevSources from snapshot ${Math.round(age/1000)}s ago (OI continuity preserved)`);
    return latest.sources;
  } catch { return []; }
}

// ── Crowd Risk アウトカム追跡 ──────────────────────────────────────
const OUTCOME_INTERVALS_MS = [
  { label: '1h',  ms: 1  * 60 * 60 * 1000 },
  { label: '3h',  ms: 3  * 60 * 60 * 1000 },
  { label: '6h',  ms: 6  * 60 * 60 * 1000 },
  { label: '12h', ms: 12 * 60 * 60 * 1000 }
];

function scheduleCrowdOutcome(eventTimestamp, entryPrice, alertSummary) {
  OUTCOME_INTERVALS_MS.forEach(({ label, ms }) => {
    setTimeout(async () => {
      try {
        const ticker = await bitget.getTicker('BTCUSDT');
        const exitPrice = parseFloat(ticker?.data?.[0]?.lastPr || 0);
        if (!exitPrice) return;
        const changePct = ((exitPrice - entryPrice) / entryPrice * 100).toFixed(3);
        let outcomes = [];
        if (fs.existsSync(OUTCOMES_FILE)) {
          outcomes = JSON.parse(fs.readFileSync(OUTCOMES_FILE, 'utf8'));
        }
        const existing = outcomes.find(o => o.eventTimestamp === eventTimestamp);
        if (existing) {
          existing.priceChanges[label] = { exitPrice, changePct: parseFloat(changePct) };
        } else {
          outcomes.unshift({
            eventTimestamp,
            entryPrice,
            alertSummary,
            priceChanges: { [label]: { exitPrice, changePct: parseFloat(changePct) } }
          });
        }
        if (outcomes.length > 200) outcomes = outcomes.slice(0, 200);
        fs.writeFileSync(OUTCOMES_FILE, JSON.stringify(outcomes, null, 2));
        console.log(`[outcome] ${label} after crowd risk: BTC ${changePct > 0 ? '+' : ''}${changePct}% (${entryPrice} → ${exitPrice})`);
      } catch(e) {
        console.error(`[outcome] ${label} fetch failed:`, e.message);
      }
    }, ms);
  });
}

const { collectMarketData } = require('./perception');
const { assess, calcSizeMultiplier, detectCrowdRisk } = require('./risk');
const bitget = require('./bitget');
const MAX_SIZE = parseFloat(process.env.MAX_POSITION_SIZE_USDT || '100');
const CYCLE_MS = parseInt(process.env.CYCLE_INTERVAL_MS || '300000');
const SYMBOL = 'BTCUSDT';
let prevSources = loadPrevSources();
const server = require('./server');

// ── ARCHITECT: 逆張り戦略前提 ────────────────────────────────────
const ARCHITECT_PROMPT = (market, risk) => `
You are the Architect in a CONTRARIAN funding-rate strategy.
The deterministic signal already encodes direction. Confirm or veto — never invent direction.

Direction Signal: ${JSON.stringify(market.directionSignal)}
  - frZ: funding z-score vs 24h baseline. frZ > 0 = crowd over-long. frZ < 0 = crowd over-short.
  - Strategy FADES extremes: over-long crowd -> short, over-short crowd -> long.
  - oiMomentum strongly positive = crowd still piling in (dangerous to fade).
  - frRegime: "extreme" (|frZ|>=2) means unstable liquidity — strength is already scaled down ×0.7 as caution. Respect the reduced strength.
  - baselineReady=false means insufficient history -> must hold.
Bitget L/S Ratio: ${market.longShortRatio ? `L${(market.longShortRatio.longRatio*100).toFixed(1)}% / S${(market.longShortRatio.shortRatio*100).toFixed(1)}%` : 'N/A'}
CEX Consensus: ${market.consensus.score}% ${market.consensus.label}
Recent Post-Mortems: ${loadRecentPostMortems().map(m => `${m.side} ${m.result} ${m.pnl_pct}% — ${m.analysis}`).join(" | ") || "none yet"}
riskLevel: ${risk.riskLevel} | sizeMultiplier: ${risk.sizeMultiplier}

Rules:
- If baselineReady=false OR direction="neutral" OR strength < 0.4: action="hold".
- Otherwise action = directionSignal.direction exactly. Do NOT flip or override it.
- confidence = directionSignal.strength.
- Adjust confidence: +0.1 if Bitget L/S ratio confirms crowd is lopsided in the direction being faded. -0.15 if oiMomentum > 0.003 (crowd still building).
- Cap confidence at 0.9.

Respond in JSON. reasoning must be ONE sentence, max 10 words, no hedging.
{ "action": "long"|"short"|"hold", "confidence": 0-1, "reasoning": "..." }
`;

// ── Case 1: ARCHITECT再提案プロンプト ─────────────────────────────
const ARCHITECT_REVISE_PROMPT = (market, risk, prevProposal, auditFeedback, round) => `
You are the Architect. This is revision round ${round}/${MAX_DEBATE_ROUNDS}.
The Auditor rejected your previous proposal. Revise your confidence or reasoning.
You may NOT change direction — only adjust confidence or add counter-argument.

Your previous proposal: ${JSON.stringify(prevProposal)}
Auditor's objection: "${auditFeedback}"

Direction Signal: ${JSON.stringify(market.directionSignal)}
Bitget L/S Ratio: ${market.longShortRatio ? `L${(market.longShortRatio.longRatio*100).toFixed(1)}% / S${(market.longShortRatio.shortRatio*100).toFixed(1)}%` : 'N/A'}
riskLevel: ${risk.riskLevel} | sizeMultiplier: ${risk.sizeMultiplier}

Rules:
- Keep action = "${prevProposal.action}" (direction is locked, do not change it).
- If the objection is valid: lower confidence by 0.1–0.2.
- If you believe the objection is wrong: maintain confidence but provide a counter-argument.
- Minimum confidence to trade: 0.4. If you drop below 0.4, change action to "hold".
- Cap confidence at 0.9.
- reasoning must be ONE sentence max 10 words, directly addressing the objection.

Respond in JSON:
{ "action": "long"|"short"|"hold", "confidence": 0-1, "reasoning": "..." }
`;

// ── AUDITOR (Red Team) ───────────────────────────────────────────
function buildCrowdSection(crowd) {
  if (!crowd.hasCrowdRisk) return 'none';
  return '⚠ ACTIVE — ' + crowd.alerts.map(function(a) {
    if (a.type === 'fr_outlier') return a.exchange + ' FR ' + (a.value*100).toFixed(4) + '% vs median ' + (a.avg*100).toFixed(4) + '% (' + a.deviationX + 'x MAD)';
    if (a.type === 'oi_concentration') return a.exchange + ' OI change ' + (a.change*100).toFixed(2) + '% vs avg';
    return a.msg;
  }).join('; ');
}

const AUDITOR_PROMPT = function(proposal, risk, crowd, pos) {
  const posSection = pos
    ? `Open Position: ${pos.holdSide} ${pos.total} BTC @ $${pos.openPriceAvg} (unrealizedPL: ${pos.unrealizedPL})`
    : 'Open Position: none';
  return 'You are the Red Team Auditor. Your job is adversarial: find every reason this trade fails.\n' +
    'You do NOT change direction. You stress-test sizing and timing.\n\n' +
    'Proposal: ' + JSON.stringify(proposal) + '\n' +
    'Risk:\n' +
    '- riskLevel: ' + risk.riskLevel + ' | sizeMultiplier: ' + risk.sizeMultiplier + '\n' +
    '- deviationScore: ' + risk.deviationScore.toFixed(1) + ' | oiChangeScore: ' + risk.oiChangeScore.toFixed(1) + '\n' +
    '- oiConcentration: ' + risk.oiConcentration.toFixed(2) + '\n' +
    posSection + '\n\n' +
    'Crowd Risk: ' + buildCrowdSection(crowd) + '\n\n' +
    'Scenario constraints:\n' +
    '- Each scenario must describe a SPECIFIC market mechanism (positioning, liquidity, regime shift, correlation break)\n' +
    '- Do NOT invoke "unexpected news" or "macro shock" — these are not analyzable scenarios\n' +
    '- Each scenario must reference at least one observable indicator (frZ, OI, crowd concentration, regime)\n' +
    '- If proposal adds to an existing open position, assess compounding risk explicitly\n\n' +
    'Your task:\n' +
    '1. List exactly 3 scenarios where this trade loses. Be specific: reference frZ, oiMomentum, riskLevel, crowd data.\n' +
    '2. Rate overall approval: if 2+ scenarios are high-probability, set approved=false.\n' +
    '3. feedback = the single most dangerous scenario in one sentence.\n\n' +
    'Respond in JSON:\n' +
    '{\n' +
    '  "approved": true|false,\n' +
    '  "confidence": 0-1,\n' +
    '  "feedback": "worst-case scenario in one sentence",\n' +
    '  "scenarios": ["Scenario 1: ...", "Scenario 2: ...", "Scenario 3: ..."]\n' +
    '}';
};

// ── Case 1: Auditorラウンド対応ラッパー ───────────────────────────
function buildAuditorPrompt(proposal, risk, crowd, pos, round, prevAuditFeedback) {
  const base = AUDITOR_PROMPT(proposal, risk, crowd, pos);
  if (round === 1) return base;
  return base +
    `\n\nThis is audit round ${round}/${MAX_DEBATE_ROUNDS}. ` +
    `Your previous objection was: "${prevAuditFeedback}". ` +
    `The Architect has revised their proposal (new confidence: ${proposal.confidence}). ` +
    `Re-evaluate with fresh eyes. If the risk remains unaddressed, set approved=false again. ` +
    `If the revision adequately addressed your concern, you may set approved=true.`;
}

const ARBITER_PROMPT = (proposal, audit, risk) => `
You are the Arbiter. Make the final decision.

Proposal: ${JSON.stringify(proposal)}
Audit: ${JSON.stringify(audit)}
sizeMultiplier: ${risk.sizeMultiplier}

Rules:
- Respect proposal direction unless audit.approved=false AND riskLevel="risk_off".
- Minimum confidence to act: 0.4
- size_pct = proposal.confidence * sizeMultiplier (show the math)

reasoning must follow this EXACT format:
"[ACTION] @ [size_pct*100]%\n[proposal.confidence*100]% confidence × ${risk.sizeMultiplier} risk multiplier = [size_pct*100]%"

{ "action": "long"|"short"|"close"|"hold", "confidence": 0-1, "size_pct": 0-1, "reasoning": "..." }
`;

// ── LLM呼び出し（フォールバック付き）──────────────────────────────
async function callLLM(prompt, fallback = {}, model = null) {
  try {
    const useModel = model || process.env.OPENROUTER_MODEL || 'google/gemini-2.5-flash-lite';
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`
      },
      body: JSON.stringify({
        model: useModel,
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' }
      })
    });
    const data = await res.json();
    if (data.error) {
      console.warn(`[llm] API error: ${data.error.message} → fallback`);
      return fallback;
    }
    const text = data.choices?.[0]?.message?.content || '{}';
    try { return JSON.parse(text); } catch { return fallback; }
  } catch(e) {
    console.warn(`[llm] fetch failed: ${e.message} → fallback`);
    return fallback;
  }
}

// ── Case 4: Disagreement Index計算 ───────────────────────────────
// 0 = 完全合意 (round1でapproved=true、confidence差が小さい)
// 1 = 最大不一致 (maxRound到達、最終audit未承認、confidence乖離大)
// 構成:
//   roundScore  (0〜0.5): ラウンド数に比例
//   rejectScore (0 or 0.3): 最終audit.approved=falseなら+0.3
//   confScore   (0〜0.2): confidence乖離に比例
function buildDisagreementIndex(rounds, proposals, audits) {
  if (!proposals.length || !audits.length) return 0;

  const finalAudit    = audits[audits.length - 1];
  const finalProposal = proposals[proposals.length - 1];

  const roundScore = ((rounds - 1) / Math.max(MAX_DEBATE_ROUNDS - 1, 1)) * 0.5;
  const rejectScore = finalAudit.approved ? 0 : 0.3;
  const confGap = Math.abs((finalProposal.confidence || 0) - (finalAudit.confidence || 0));
  const confScore = Math.min(confGap, 1) * 0.2;

  return parseFloat(Math.min(roundScore + rejectScore + confScore, 1.0).toFixed(3));
}

// ── 方向ゲート: LLMが方向を無視するバグを防ぐ ───────────────────
// direction=neutral → 強制hold
// action ≠ directionSignal.direction → 強制hold + 警告ログ
function enforceDirectionGate(proposal, directionSignal) {
  const dir = directionSignal?.direction;
  if (dir === 'neutral' || !dir) {
    if (proposal.action !== 'hold') {
      console.warn(`[gate] neutral signal → forced hold (llm proposed ${proposal.action})`);
      proposal.action = 'hold';
      proposal.confidence = 0;
    }
    return proposal;
  }
  if (proposal.action !== 'hold' && proposal.action !== dir) {
    console.warn(`[gate] direction mismatch: signal=${dir} llm=${proposal.action} → forced hold`);
    proposal.action = 'hold';
    proposal.confidence = 0;
  }
  return proposal;
}

// ── Case 4: Confidence較正 → ポジションサイジング ─────────────────
// frZをbucket分けし、post_mortems実績winRateとブレンドして較正
// サンプル不足(<3件)時はrawをそのまま返す
function calibrateConfidence(rawConfidence, frZ, postMortems) {
  const absZ = Math.abs(frZ || 0);
  const bucket = absZ < 1 ? 'low' : absZ < 2 ? 'medium' : 'high';

  if (!postMortems || postMortems.length === 0) {
    return { calibrated: rawConfidence, winRate: null, n: 0, bucket, note: 'no history' };
  }

  const matching = postMortems.filter(m => {
    const mZ = Math.abs(m.frZ_at_entry || 0);
    if (bucket === 'low')    return mZ < 1;
    if (bucket === 'medium') return mZ >= 1 && mZ < 2;
    return mZ >= 2;
  });

  const n = matching.length;
  if (n < 3) {
    return { calibrated: rawConfidence, winRate: null, n, bucket, note: 'insufficient samples' };
  }

  const wins = matching.filter(m => m.result === 'win').length;
  const winRate = parseFloat((wins / n).toFixed(3));

  // history weightはサンプル数に比例して増加、最大0.4(n>=10で上限)
  const historyWeight = parseFloat(Math.min(n / 10, 0.4).toFixed(2));
  const calibrated = parseFloat(
    ((rawConfidence * (1 - historyWeight)) + (winRate * historyWeight)).toFixed(3)
  );

  return { calibrated, winRate, n, bucket, historyWeight, raw: rawConfidence };
}

// ── Case 1: 多段ディベートループ ─────────────────────────────────
async function runDebate(market, risk, crowd, pos) {
  const proposals = [];
  const audits    = [];
  let converged   = false;
  let rounds      = 0;

  // Round 1: Architect初回提案
  const firstProposal = await callLLM(ARCHITECT_PROMPT(market, risk), {
    action: 'hold', confidence: 0, reasoning: 'LLM unavailable — safe hold'
  });
  enforceDirectionGate(firstProposal, market.directionSignal);
  proposals.push(firstProposal);
  rounds = 1;
  console.log(`[architect R1] action=${firstProposal.action} confidence=${firstProposal.confidence}`);

  // holdなら即終了(Auditorスキップ、Disagreement=0)
  if (firstProposal.action === 'hold') {
    const holdAudit = { approved: false, confidence: 0, feedback: 'hold — audit skipped', scenarios: [] };
    audits.push(holdAudit);
    converged = true;
    console.log(`[debate] hold — skipping debate`);
    return {
      proposal: firstProposal,
      audit:    holdAudit,
      proposals, audits,
      rounds, converged,
      disagreementIndex: 0
    };
  }

  // Round 1 Auditor
  const firstAudit = await callLLM(
    buildAuditorPrompt(firstProposal, risk, crowd, pos, 1, null),
    { approved: false, confidence: 0, feedback: 'LLM unavailable — conservative reject', scenarios: [] }
  );
  audits.push(firstAudit);
  console.log(`[auditor R1] approved=${firstAudit.approved} confidence=${firstAudit.confidence}`);

  if (firstAudit.approved) {
    converged = true;
    console.log(`[debate] converged at round 1`);
  }

  let currentProposal = firstProposal;
  let currentAudit    = firstAudit;

  // Round 2以降: 未収束 & maxRounds未達なら継続
  while (!converged && rounds < MAX_DEBATE_ROUNDS) {
    rounds++;
    console.log(`[debate] R${rounds}: Auditor rejected — Architect revising...`);

    // Architect再提案 (direction固定、confidence調整のみ)
    const revisedProposal = await callLLM(
      ARCHITECT_REVISE_PROMPT(market, risk, currentProposal, currentAudit.feedback, rounds),
      {
        action:     currentProposal.action,
        confidence: parseFloat(Math.max((currentProposal.confidence || 0.5) - 0.15, 0.3).toFixed(2)),
        reasoning:  'revision fallback'
      },
      process.env.OPENROUTER_MODEL_REVISION || process.env.OPENROUTER_MODEL || 'google/gemini-2.5-flash-lite'
    );
    enforceDirectionGate(revisedProposal, market.directionSignal);
    proposals.push(revisedProposal);
    console.log(`[architect R${rounds}] confidence=${revisedProposal.confidence} (was ${currentProposal.confidence})`);

    // holdに転じた場合は終了
    if (revisedProposal.action === 'hold') {
      const skipAudit = { approved: false, confidence: 0, feedback: 'revised to hold', scenarios: [] };
      audits.push(skipAudit);
      converged       = true;
      currentProposal = revisedProposal;
      currentAudit    = skipAudit;
      console.log(`[debate] Architect revised to hold at R${rounds}`);
      break;
    }

    // Auditor再評価
    const revisedAudit = await callLLM(
      buildAuditorPrompt(revisedProposal, risk, crowd, pos, rounds, currentAudit.feedback),
      { approved: false, confidence: 0, feedback: 'LLM unavailable — conservative reject', scenarios: [] }
    );
    audits.push(revisedAudit);
    console.log(`[auditor R${rounds}] approved=${revisedAudit.approved} confidence=${revisedAudit.confidence}`);

    currentProposal = revisedProposal;
    currentAudit    = revisedAudit;

    if (revisedAudit.approved) {
      converged = true;
      console.log(`[debate] converged at round ${rounds}`);
    }
  }

  if (!converged) {
    console.log(`[debate] max rounds (${MAX_DEBATE_ROUNDS}) reached without convergence`);
  }

  const disagreementIndex = buildDisagreementIndex(rounds, proposals, audits);
  console.log(`[debate] rounds=${rounds} converged=${converged} disagreementIndex=${disagreementIndex}`);

  return {
    proposal: currentProposal,
    audit:    currentAudit,
    proposals, audits,
    rounds, converged,
    disagreementIndex
  };
}

let openPosition = null;

async function syncOpenPosition() {
  try {
    const positions = await bitget.getPositions();
    const pos = positions?.data?.find(p => p.symbol === 'BTCUSDT' && parseFloat(p.total) > 0);
    if (pos) {
      openPosition = pos;
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
    const frHistory = loadFRHistory();
    const market = await collectMarketData(SYMBOL, prev, frHistory);
    prevSources = market.sources;
    const risk = assess(market, prev);
    console.log(`[perception] ${market.sources.length} CEX sources, dir=${market.directionSignal.direction} frZ=${market.directionSignal.frZ} strength=${market.directionSignal.strength} baseline=${market.directionSignal.baselineReady}`);
    console.log(`[risk] ${risk.summary}`);
    const crowd = detectCrowdRisk(market.sources, risk.frChanges, risk.oiChanges);
    if (crowd.hasCrowdRisk) {
      const crowdMult = 0.7;
      risk.sizeMultiplier = parseFloat((risk.sizeMultiplier * crowdMult).toFixed(2));
      risk.summary += ` crowdMult=${crowdMult}→sizeMult=${risk.sizeMultiplier}`;
      console.log(`[crowd] ${crowd.summary} → sizeMultiplier ×${crowdMult} = ${risk.sizeMultiplier}`);
    } else {
      console.log(`[crowd] no risk detected`);
    }

    // ── 案5: サーキットブレーカー ─────────────────────────────────
    const cbPostMortems = loadRecentPostMortems(20);
    const cb = checkCircuitBreaker(cbPostMortems);
    if (cb.blocked) {
      console.log(`[circuit_breaker] BLOCKED: ${cb.reason} | ${JSON.stringify(cb)}`);
      const [cbTicker, cbAssets] = await Promise.all([
        bitget.getTicker(SYMBOL),
        bitget.getAccountAssets()
      ]);
      const cbPrice   = parseFloat(cbTicker?.data?.[0]?.lastPr || 0);
      const cbBalance = cbAssets?.data?.[0]?.available || '0';
      const holdDecision = { action: 'hold', size_pct: 0, confidence: 0, reasoning: `circuit_breaker: ${cb.reason}` };
      saveSnapshot(market, risk, crowd, holdDecision, cbPrice, null, null);
      if (server.updateState) server.updateState({
        market, risk, crowd,
        proposal:  { action: 'hold', confidence: 0, reasoning: cb.reason },
        audit:     null,
        decision:  holdDecision,
        timestamp, openPosition,
        accountBalance: cbBalance,
        circuitBreaker: cb
      });
      return;
    }

    // ── Case 1: 多段ディベート (Architect + Auditor ループ) ──────
    const debate = await runDebate(market, risk, crowd, openPosition);
    const { proposal, audit } = debate;

    // ── 案3: Shadow Trade — auditor_rejected ─────────────────────
    const _shadowAuditorRejected = (proposal.action !== 'hold' && !audit.approved);

    // ── Case 4: Confidence較正 ────────────────────────────────────
    const allPostMortems = loadRecentPostMortems(20);
    const calibration = calibrateConfidence(
      proposal.confidence,
      market.directionSignal?.frZ ?? 0,
      allPostMortems
    );
    const calibratedProposal = proposal.action === 'hold'
      ? proposal
      : { ...proposal, confidence: calibration.calibrated, rawConfidence: proposal.confidence };
    console.log(`[calibrate] bucket=${calibration.bucket} n=${calibration.n} winRate=${calibration.winRate ?? 'N/A'} raw=${proposal.confidence}→cal=${calibration.calibrated}`);

    const rawDecision = await callLLM(ARBITER_PROMPT(calibratedProposal, audit, risk), {
      action: 'hold', confidence: 0, size_pct: 0, reasoning: 'LLM unavailable — safe hold'
    });
    console.log(`[arbiter] action=${rawDecision.action} confidence=${rawDecision.confidence} size_pct=${rawDecision.size_pct}`);
    const decision = applyRegimeGate(rawDecision);

    const [ticker, assetsRes] = await Promise.all([
      bitget.getTicker(SYMBOL),
      bitget.getAccountAssets()
    ]);
    const accountBalance = assetsRes?.data?.[0]?.available || '0';
    const price = parseFloat(ticker?.data?.[0]?.lastPr || 0);

    // ── 案3: Shadow Trade記録 (price確定後) ──────────────────────
    if (price > 0) {
      const frZ_now = market.directionSignal?.frZ ?? null;
      // auditor_rejected: AuditorがArchitectをブロック
      if (_shadowAuditorRejected) {
        const sid = recordShadowTrade('auditor_rejected', proposal.action, price, frZ_now, proposal.confidence);
        scheduleShadowOutcome(sid, price, proposal.action);
      }
      // regime_gate: RegimeGateがArbiterをブロック
      if (rawDecision.action !== 'hold' && decision.action === 'hold') {
        const sid = recordShadowTrade('regime_gate', rawDecision.action, price, frZ_now, rawDecision.confidence);
        scheduleShadowOutcome(sid, price, rawDecision.action);
      }
    }

    if (crowd.hasCrowdRisk) {
      saveCrowdEvent(crowd, risk, decision, market, price);
      if (price > 0) {
        scheduleCrowdOutcome(timestamp, price, crowd.summary);
        console.log(`[outcome] tracking scheduled: 1h/3h/6h/12h from ${price}`);
      }
    }

    // Case 1+4: debate+calibration情報をsnapshotに保存
    const debateWithCal = { ...debate, _calibration: { raw: proposal.confidence, ...calibration } };
    saveSnapshot(market, risk, crowd, decision, price, audit, debateWithCal);

    if (decision.action === 'long' || decision.action === 'short') {
      if (decision.confidence >= 0.4 && decision.size_pct > 0 && price > 0) {
        if (openPosition && (openPosition.holdSide || openPosition.side) !== decision.action) {
          const closeSide = (openPosition.holdSide || openPosition.side) === 'long' ? 'sell' : 'buy';
          await bitget.closePosition(SYMBOL, closeSide, openPosition.total || openPosition.size);
          console.log(`[execute] closed ${openPosition.holdSide || openPosition.side} before reversal`);
          const _closedPos1 = openPosition; openPosition = null; schedulePostMortem(_closedPos1, "reversal");
        }
        if (openPosition && (openPosition.holdSide || openPosition.side) === decision.action) {
          console.log(`[execute] already ${decision.action}, hold`);
        } else {
          const leverage = parseInt(process.env.LEVERAGE || '2');
          const sizeUsdt = MAX_SIZE * decision.size_pct;
          const sizeContracts = (sizeUsdt * leverage / price).toFixed(4);
          const orderSide = decision.action === 'long' ? 'buy' : 'sell';

          const order = await bitget.placeOrder(SYMBOL, orderSide, sizeContracts);
          console.log(`[execute] ${decision.action} ${sizeContracts} BTC @ ~${price} (${sizeUsdt.toFixed(2)} USDT x${leverage})`);
          console.log(`[execute] order=${JSON.stringify(order?.data)}`);

          if (order?.code === '00000') {
            const TP_PCT = parseFloat(process.env.TP_PCT || '0.015');
            const SL_PCT = parseFloat(process.env.SL_PCT || '0.012');
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
              stopLoss: slPrice,
              frZ_at_entry: market.directionSignal?.frZ ?? null,
              frZ_min_during_hold: market.directionSignal?.frZ ?? null,
              frZ_max_during_hold: market.directionSignal?.frZ ?? null,
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
      if (order?.code === '00000') { const _closedPos2 = openPosition; openPosition = null; schedulePostMortem(_closedPos2, "close_signal"); }
    } else {
      console.log(`[execute] hold`);
    }

    // frZ min/max during hold を毎サイクル更新
    if (openPosition) {
      const currentFrZ = market.directionSignal?.frZ ?? null;
      if (currentFrZ !== null) {
        if (openPosition.frZ_min_during_hold === undefined || currentFrZ < openPosition.frZ_min_during_hold) {
          openPosition.frZ_min_during_hold = currentFrZ;
        }
        if (openPosition.frZ_max_during_hold === undefined || currentFrZ > openPosition.frZ_max_during_hold) {
          openPosition.frZ_max_during_hold = currentFrZ;
        }
      }

      const positions = await bitget.getPositions();
      const pos = positions?.data?.find(p => p.symbol === SYMBOL && parseFloat(p.total) > 0);
      if (!pos) {
        console.log(`[execute] position closed externally (TP/SL hit)`);
        const _closedPos3 = openPosition; openPosition = null; schedulePostMortem(_closedPos3, "tp_sl_hit");
      }
    }

    // Case 1: debate情報をUIに反映
    if (server.updateState) server.updateState({
      market, risk, crowd, proposal, audit, decision,
      timestamp, openPosition, accountBalance,
      debate: {
        rounds:            debate.rounds,
        converged:         debate.converged,
        disagreementIndex: debate.disagreementIndex
      },
      calibration: {
        raw:        proposal.confidence,
        calibrated: calibration.calibrated,
        winRate:    calibration.winRate,
        n:          calibration.n,
        bucket:     calibration.bucket
      }
    });

  } catch (err) {
    console.error(`[error] ${err.message}`);
  }
}

module.exports = { runCycle };

// ── Post-Mortem Agent ─────────────────────────────────────────────
const POSTMORTEM_FILE = process.env.POSTMORTEM_FILE || '/home/agent/perceptrade/post_mortems.json';

// ── frZ Reversion 計算 ────────────────────────────────────────────
function computeReversion(entry, close) {
  if (entry === null || entry === undefined || close === null || close === undefined) return null;
  if (Math.abs(entry) < 0.01) return null;
  const ratio = (Math.abs(entry) - Math.abs(close)) / Math.abs(entry);
  return {
    frZ_revert_ratio:  parseFloat(ratio.toFixed(4)),
    frZ_reverted:      ratio > 0,
    frZ_sign_flipped:  (entry * close) < 0,
  };
}

async function runPostMortem(closedPosition, exitPrice, closeReason) {
  try {
    if (!closedPosition) return;
    const entryPrice = parseFloat(closedPosition.openPriceAvg || 0);
    const side       = closedPosition.holdSide || closedPosition.side || 'unknown';

    const PM_LEVERAGE  = parseFloat(process.env.LEVERAGE || '2');
    const PM_ENTRY_FEE = parseFloat(process.env.ENTRY_FEE_PCT || '0.0006');
    const PM_EXIT_FEE  = parseFloat(process.env.EXIT_FEE_PCT  || '0.0006');

    let pnl = { raw: null, leveraged: null, fee_pct: null, net: null, usdt: null };
    if (entryPrice > 0) {
      const dir    = side === 'long' ? 1 : -1;
      const raw    = (exitPrice - entryPrice) / entryPrice * dir;
      const lev    = raw * PM_LEVERAGE;
      const feePct = (PM_ENTRY_FEE + PM_EXIT_FEE) * PM_LEVERAGE;
      const net    = lev - feePct;
      const marginUsdt = parseFloat(closedPosition.marginSize || 0);
      pnl = {
        raw:       parseFloat((raw * 100).toFixed(4)),
        leveraged: parseFloat((lev * 100).toFixed(4)),
        fee_pct:   parseFloat((feePct * 100).toFixed(4)),
        net:       parseFloat((net * 100).toFixed(4)),
        usdt:      marginUsdt > 0 ? parseFloat((net * marginUsdt * PM_LEVERAGE).toFixed(4)) : null
      };
    }
    const pnlPct = pnl.net;

    let recentCrowdEvents = [];
    try {
      if (fs.existsSync(CROWD_EVENTS_FILE)) {
        const events = JSON.parse(fs.readFileSync(CROWD_EVENTS_FILE, 'utf8'));
        recentCrowdEvents = events.slice(0, 3).map(e => e.summary);
      }
    } catch {}

    let currentFrZ = null;
    try {
      if (fs.existsSync(SNAPSHOTS_FILE)) {
        const snaps = JSON.parse(fs.readFileSync(SNAPSHOTS_FILE, 'utf8'));
        currentFrZ = snaps[0]?.frZ ?? null;
      }
    } catch {}

    const reversion = computeReversion(
      closedPosition.frZ_at_entry ?? null,
      currentFrZ
    );

    const prompt = `You are a trading post-mortem analyst. Write a brief analysis of this closed trade.

Trade summary:
- Side: ${side}
- Entry price: $${entryPrice}
- Exit price: $${exitPrice}
- PnL: ${pnlPct !== null ? pnlPct + '%' : 'unknown'}
- Close reason: ${closeReason}
- frZ at entry: ${closedPosition.frZ_at_entry ?? 'N/A'}
- frZ at close: ${currentFrZ ?? 'N/A'}
- frZ revert ratio: ${reversion?.frZ_revert_ratio ?? 'N/A'} (>0 = reverted toward 0, <0 = extended further)
- frZ min during hold: ${closedPosition.frZ_min_during_hold ?? 'N/A'}
- frZ max during hold: ${closedPosition.frZ_max_during_hold ?? 'N/A'}
- Recent crowd events: ${recentCrowdEvents.length > 0 ? recentCrowdEvents.join('; ') : 'none'}

Write ONE concise sentence explaining why this trade won or lost, focusing on whether the contrarian FR signal played out as expected. Be specific about frZ and price action.

Respond ONLY with JSON: {"result":"win"|"loss"|"unknown","pnl_pct":${pnlPct ?? null},"analysis":"<one sentence>"}`;

    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}` },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash-lite',
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        temperature: 0.2
      })
    });
    if (!res.ok) throw new Error(`OpenRouter ${res.status}`);
    const data = await res.json();
    const parsed = JSON.parse((data.choices?.[0]?.message?.content || '{}').replace(/```json|```/g, '').trim());

    let mortems = [];
    if (fs.existsSync(POSTMORTEM_FILE)) mortems = JSON.parse(fs.readFileSync(POSTMORTEM_FILE, 'utf8'));
    mortems.unshift({
      ts:                  new Date().toISOString(),
      side,
      entry_price:         entryPrice,
      exit_price:          exitPrice,
      pnl_pct:             pnl.net,
      pnl_pct_raw:         pnl.raw,
      pnl_pct_lev:         pnl.leveraged,
      fee_pct:             pnl.fee_pct,
      pnl_usdt:            pnl.usdt,
      leverage:            PM_LEVERAGE,
      result:              parsed.result,
      analysis:            parsed.analysis,
      close_reason:        closeReason,
      frZ_at_entry:        closedPosition.frZ_at_entry ?? null,
      frZ_at_close:        currentFrZ,
      frZ_revert_ratio:    reversion?.frZ_revert_ratio  ?? null,
      frZ_reverted:        reversion?.frZ_reverted       ?? null,
      frZ_sign_flipped:    reversion?.frZ_sign_flipped   ?? null,
      frZ_min_during_hold: closedPosition.frZ_min_during_hold ?? null,
      frZ_max_during_hold: closedPosition.frZ_max_during_hold ?? null,
    });
    if (mortems.length > 20) mortems = mortems.slice(0, 20);
    fs.writeFileSync(POSTMORTEM_FILE, JSON.stringify(mortems, null, 2));
    console.log(`[postmortem] ${parsed.result} — ${parsed.analysis}`);
  } catch(e) {
    console.error('[postmortem] failed:', e.message);
  }
}

function schedulePostMortem(closedPosition, closeReason) {
  setTimeout(async () => {
    try {
      const ticker = await bitget.getTicker('BTCUSDT');
      const exitPrice = parseFloat(ticker?.data?.[0]?.lastPr || 0);
      if (exitPrice > 0) await runPostMortem(closedPosition, exitPrice, closeReason);
    } catch(e) {
      console.error('[postmortem] price fetch failed:', e.message);
    }
  }, 5000);
}
