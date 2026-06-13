'use strict';
/**
 * backtest/core/engine.js
 * Cycle replay engine. Stateless per-cycle: caller maintains position.
 *
 * Responsibilities:
 *   - Load and validate snapshots (gap detection)
 *   - Replay cycles: signal → auditor_hook → position management → fee + carry
 *   - Emit trade records with full frZ metadata
 *
 * Does NOT:
 *   - Call LLM directly (delegated to auditor_hook)
 *   - Know about parameter sweep (caller's job)
 *
 * 案1: Funding Carry込みEV
 *   コントラリアン戦略の構造的優位を定量化:
 *   - frZが高い時のshort → funding受取側に立つ
 *   - carry_pct = (short?+1:-1) × avgFR × leverage × periods_held
 *   - net_with_carry = pnl_net + carry_pct
 */

const fs   = require('fs');
const path = require('path');

// ── Gap detection constants ───────────────────────────────────────
const EXPECTED_CYCLE_MS  = 5 * 60 * 1000;
const GAP_WARN_MS        = EXPECTED_CYCLE_MS + 30 * 1000;
const GAP_SPLIT_MS       = 60 * 60 * 1000;

// ── 案1: Funding period ───────────────────────────────────────────
const DEFAULT_FUNDING_PERIOD_MS = 8 * 60 * 60 * 1000;  // Bitget: 8h決済

// ── Fee model ─────────────────────────────────────────────────────
function calcFee(params) {
  return (params.ENTRY_FEE_PCT + params.EXIT_FEE_PCT) * params.LEVERAGE;
}

// ── PnL calculation (mirrors agent.js runPostMortem) ──────────────
function calcPnl(side, entryPrice, exitPrice, params) {
  const dir    = side === 'long' ? 1 : -1;
  const raw    = (exitPrice - entryPrice) / entryPrice * dir;
  const lev    = raw * params.LEVERAGE;
  const feePct = calcFee(params);
  const net    = lev - feePct;
  return {
    raw:       parseFloat((raw  * 100).toFixed(4)),
    leveraged: parseFloat((lev  * 100).toFixed(4)),
    fee_pct:   parseFloat((feePct * 100).toFixed(4)),
    net:       parseFloat((net  * 100).toFixed(4)),
  };
}

// ── 案1: Funding Carry計算 ────────────────────────────────────────
// avgFR: 8h期間のfunding rate (decimal, e.g. 0.0001 = 0.01%)
// 戦略的優位: frZ>0でshortすると funding受取側 → carry>0
// 戦略的不利: frZ>0でlongすると funding支払側   → carry<0
//
// carry_pct (%) = sign × avgFR × leverage × periods_held × 100
//   sign = short:+1, long:-1
//   periods_held = hold_duration_ms / FUNDING_PERIOD_MS
//
// 注意: avgFRはfloat精度のため|avgFR|<1e-7は0扱い
function calcCarry(side, avgFR, entryTs, exitTs, params) {
  const fundingPeriodMs = params.FUNDING_PERIOD_MS || DEFAULT_FUNDING_PERIOD_MS;
  if (avgFR === null || avgFR === undefined || Math.abs(avgFR) < 1e-7) {
    return { carry_pct: 0, periods_held: 0, carry_note: 'no_fr_data' };
  }

  const holdMs       = new Date(exitTs) - new Date(entryTs);
  const periodsHeld  = holdMs / fundingPeriodMs;
  const sign         = side === 'short' ? 1 : -1;
  const carry_pct    = parseFloat((sign * avgFR * params.LEVERAGE * periodsHeld * 100).toFixed(4));

  return {
    carry_pct,
    periods_held: parseFloat(periodsHeld.toFixed(3)),
    carry_note: carry_pct > 0 ? 'receive' : 'pay',
  };
}

// ── frZ reversion (mirrors agent.js computeReversion) ────────────
function computeReversion(entry, close) {
  if (entry == null || close == null) return null;
  if (Math.abs(entry) < 0.01) return null;
  const ratio = (Math.abs(entry) - Math.abs(close)) / Math.abs(entry);
  return {
    frZ_revert_ratio:  parseFloat(ratio.toFixed(4)),
    frZ_reverted:      ratio > 0,
    frZ_sign_flipped:  (entry * close) < 0,
  };
}

// ── 案1: 次の8h決済までの残時間(ms)を計算 ────────────────────────
// Bitget funding決済: 00:00, 08:00, 16:00 UTC
// 近いほど保有でcarryが確定しやすい
function msToNextSettlement(ts, fundingPeriodMs) {
  const period = fundingPeriodMs || DEFAULT_FUNDING_PERIOD_MS;
  const ms     = new Date(ts).getTime();
  const rem    = period - (ms % period);
  return rem;
}

// ── Load snapshots.json and return sorted segments ────────────────
function loadSegments(snapshotsPath) {
  const raw  = JSON.parse(fs.readFileSync(snapshotsPath, 'utf8'));
  const snaps = raw
    .filter(s => s.timestamp && s.btcPrice && s.directionSignal)
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  if (snaps.length === 0) throw new Error('No valid snapshots found');

  const segments = [];
  let current    = [snaps[0]];
  let warnCount  = 0;

  for (let i = 1; i < snaps.length; i++) {
    const gap = new Date(snaps[i].timestamp) - new Date(snaps[i-1].timestamp);
    if (gap > GAP_SPLIT_MS) {
      segments.push(current);
      current = [snaps[i]];
    } else {
      if (gap > GAP_WARN_MS) {
        warnCount++;
        snaps[i]._gap_ms = gap;
      }
      current.push(snaps[i]);
    }
  }
  segments.push(current);

  const totalSnaps = snaps.length;
  const totalSegs  = segments.length;
  console.log(`[engine] loaded ${totalSnaps} snapshots → ${totalSegs} segment(s), ${warnCount} gap warnings`);
  segments.forEach((seg, i) => {
    console.log(`  segment ${i+1}: ${seg[0].timestamp} → ${seg[seg.length-1].timestamp} (${seg.length} snaps)`);
  });

  return segments;
}

// ── Main replay function ──────────────────────────────────────────
/**
 * @param {string}   snapshotsPath
 * @param {object}   params  { FR_Z_EXTREME, TP_PCT, SL_PCT, LEVERAGE,
 *                             ENTRY_FEE_PCT, EXIT_FEE_PCT, MAX_SIZE_USDT,
 *                             OI_MOMENTUM_GATE,
 *                             FUNDING_PERIOD_MS (optional, default 8h) }
 * @param {function} signalFn       (snap, prevSnap, params) → { action, frZ, strength }
 * @param {function} auditorHookFn  async (signal, snap, params) → { approved }
 * @returns {object}  { trades, summary }
 */
async function replay(snapshotsPath, params, signalFn, auditorHookFn) {
  const segments = loadSegments(snapshotsPath);
  const trades   = [];

  for (const segment of segments) {
    let position = null;

    for (let i = 0; i < segment.length; i++) {
      const snap     = segment[i];
      const prevSnap = i > 0 ? segment[i-1] : null;
      const price    = snap.btcPrice;

      // ── 1. Check TP/SL hit on open position ─────────────────────
      if (position) {
        const hit = checkTPSL(position, price);
        if (hit) {
          trades.push(closeTrade(position, price, snap, hit, params));
          position = null;
          continue;
        }
        // Update frZ min/max during hold
        const frZ = snap.directionSignal?.frZ ?? null;
        if (frZ !== null) {
          if (position.frZ_min === null || frZ < position.frZ_min) position.frZ_min = frZ;
          if (position.frZ_max === null || frZ > position.frZ_max) position.frZ_max = frZ;
        }
        // Update MAE/MFE
        const dir = position.side === 'long' ? 1 : -1;
        const excursion = (price - position.entryPrice) / position.entryPrice * dir;
        if (excursion < position.mae) position.mae = excursion;
        if (excursion > position.mfe) position.mfe = excursion;
      }

      // ── 2. Generate rule-based signal ───────────────────────────
      const signal = signalFn(snap, prevSnap, params);

      // ── 3. Auditor hook ──────────────────────────────────────────
      const audit = await auditorHookFn(signal, snap, params);
      if (!audit.approved) continue;

      // ── 4. Entry logic ──────────────────────────────────────────
      if (!position && (signal.action === 'long' || signal.action === 'short')) {
        const tp = signal.action === 'long'
          ? price * (1 + params.TP_PCT)
          : price * (1 - params.TP_PCT);
        const sl = signal.action === 'long'
          ? price * (1 - params.SL_PCT)
          : price * (1 + params.SL_PCT);

        // 案1: avgFRをentry時点で記録
        const avgFR_at_entry = snap.avgFR ?? null;

        // 案1: 次の決済までの残時間を記録(参考値)
        const msToSettle = msToNextSettlement(
          snap.timestamp,
          params.FUNDING_PERIOD_MS || DEFAULT_FUNDING_PERIOD_MS
        );

        position = {
          side:            signal.action,
          entryPrice:      price,
          entryTs:         snap.timestamp,
          frZ_at_entry:    signal.frZ,
          frZ_min:         signal.frZ,
          frZ_max:         signal.frZ,
          tp,
          sl,
          mae:             0,
          mfe:             0,
          avgFR_at_entry,           // 案1: carry計算用
          ms_to_settle_at_entry: msToSettle,  // 案1: 決済タイミング参考
        };
      }
    }

    // Segment end: force-close
    if (position) {
      const lastSnap = segment[segment.length - 1];
      trades.push(closeTrade(position, lastSnap.btcPrice, lastSnap, 'segment_end', params));
      position = null;
    }
  }

  const summary = calcSummary(trades);
  return { trades, summary };
}

// ── TP/SL check ───────────────────────────────────────────────────
function checkTPSL(position, price) {
  if (position.side === 'long') {
    if (price >= position.tp) return 'tp_hit';
    if (price <= position.sl) return 'sl_hit';
  } else {
    if (price <= position.tp) return 'tp_hit';
    if (price >= position.sl) return 'sl_hit';
  }
  return null;
}

// ── Build trade record on close ───────────────────────────────────
function closeTrade(position, exitPrice, exitSnap, closeReason, params) {
  const pnl       = calcPnl(position.side, position.entryPrice, exitPrice, params);
  const frZ_close = exitSnap.directionSignal?.frZ ?? null;
  const rev       = computeReversion(position.frZ_at_entry, frZ_close);

  // 案1: Funding carry計算
  const carryResult = calcCarry(
    position.side,
    position.avgFR_at_entry,
    position.entryTs,
    exitSnap.timestamp,
    params
  );

  const net_with_carry = parseFloat((pnl.net + carryResult.carry_pct).toFixed(4));

  return {
    entry_ts:               position.entryTs,
    exit_ts:                exitSnap.timestamp,
    side:                   position.side,
    entry_price:            position.entryPrice,
    exit_price:             exitPrice,
    close_reason:           closeReason,
    // 既存PnL (fee込み、carry無し)
    pnl_net:                pnl.net,
    pnl_raw:                pnl.raw,
    pnl_leveraged:          pnl.leveraged,
    fee_pct:                pnl.fee_pct,
    result:                 pnl.net > 0 ? 'win' : 'loss',
    // 案1: Carry込みPnL
    carry_pct:              carryResult.carry_pct,
    periods_held:           carryResult.periods_held,
    carry_note:             carryResult.carry_note,
    net_with_carry:         net_with_carry,
    result_with_carry:      net_with_carry > 0 ? 'win' : 'loss',
    avgFR_at_entry:         position.avgFR_at_entry,
    ms_to_settle_at_entry:  position.ms_to_settle_at_entry,
    // frZ metadata
    frZ_at_entry:           position.frZ_at_entry,
    frZ_at_close:           frZ_close,
    frZ_revert_ratio:       rev?.frZ_revert_ratio    ?? null,
    frZ_reverted:           rev?.frZ_reverted         ?? null,
    frZ_sign_flipped:       rev?.frZ_sign_flipped     ?? null,
    frZ_min_during_hold:    position.frZ_min,
    frZ_max_during_hold:    position.frZ_max,
    mae_pct: parseFloat((position.mae * 100).toFixed(4)),
    mfe_pct: parseFloat((position.mfe * 100).toFixed(4)),
  };
}

// ── Summary stats ─────────────────────────────────────────────────
function calcSummary(trades) {
  if (trades.length === 0) return { total: 0 };

  const wins      = trades.filter(t => t.result === 'win');
  const totalPnl  = trades.reduce((s, t) => s + t.pnl_net, 0);
  const totalFee  = trades.reduce((s, t) => s + t.fee_pct, 0);
  const reverted  = trades.filter(t => t.frZ_reverted === true);
  const revertWins = reverted.filter(t => t.result === 'win');

  const ratios    = trades.map(t => t.frZ_revert_ratio).filter(v => v !== null);
  const avgRatio  = ratios.length > 0
    ? parseFloat((ratios.reduce((s, v) => s + v, 0) / ratios.length).toFixed(4))
    : null;

  // 案1: carry統計
  const totalCarry     = trades.reduce((s, t) => s + (t.carry_pct || 0), 0);
  const totalNetCarry  = trades.reduce((s, t) => s + (t.net_with_carry || 0), 0);
  const winsWithCarry  = trades.filter(t => t.result_with_carry === 'win');
  // carryが勝敗を変えたトレード数
  const carryFlipped   = trades.filter(t =>
    t.result !== t.result_with_carry
  ).length;
  // carryを受け取れたトレード数(short+positive FR, or long+negative FR)
  const carryReceived  = trades.filter(t => (t.carry_pct || 0) > 0).length;

  return {
    total:                  trades.length,
    wins:                   wins.length,
    losses:                 trades.length - wins.length,
    win_rate:               parseFloat((wins.length / trades.length * 100).toFixed(1)),
    total_pnl_net:          parseFloat(totalPnl.toFixed(4)),
    total_fee_drag:         parseFloat(totalFee.toFixed(4)),
    avg_pnl_per_trade:      parseFloat((totalPnl / trades.length).toFixed(4)),
    // 案1: carry統計
    total_carry:            parseFloat(totalCarry.toFixed(4)),
    total_pnl_with_carry:   parseFloat(totalNetCarry.toFixed(4)),
    avg_carry_per_trade:    parseFloat((totalCarry / trades.length).toFixed(4)),
    wins_with_carry:        winsWithCarry.length,
    win_rate_with_carry:    parseFloat((winsWithCarry.length / trades.length * 100).toFixed(1)),
    carry_flipped_result:   carryFlipped,   // carryで勝敗が変わったトレード数
    carry_received_count:   carryReceived,  // funding受取側に立てたトレード数
    carry_vs_fee_ratio:     totalFee > 0
      ? parseFloat((totalCarry / totalFee).toFixed(3))
      : null,  // carryがfee dragをどれだけ相殺したか
    // frZ reversion
    avg_revert_ratio:       avgRatio,
    reverted_count:         reverted.length,
    reverted_win_rate:      reverted.length > 0
      ? parseFloat((revertWins.length / reverted.length * 100).toFixed(1))
      : null,
    tp_hit_count:           trades.filter(t => t.close_reason === 'tp_hit').length,
    sl_hit_count:           trades.filter(t => t.close_reason === 'sl_hit').length,
    avg_mae_pct:            parseFloat((trades.reduce((s,t) => s + (t.mae_pct||0), 0) / trades.length).toFixed(4)),
    avg_mfe_pct:            parseFloat((trades.reduce((s,t) => s + (t.mfe_pct||0), 0) / trades.length).toFixed(4)),
  };
}

module.exports = {
  replay,
  loadSegments,
  calcPnl,
  calcCarry,
  computeReversion,
  calcSummary,
  msToNextSettlement,
};
