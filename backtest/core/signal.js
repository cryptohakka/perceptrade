'use strict';
/**
 * backtest/core/signal.js
 * Rule-based signal — deterministic extraction of agent.js logic.
 *
 * Mirrors perception.js + agent.js directionSignal:
 *   frZ >= +FR_Z_EXTREME → short (crowd over-long, fade it)
 *   frZ <= -FR_Z_EXTREME → long  (crowd over-short, fade it)
 *   |oiMomentum| > OI_MOMENTUM_GATE → block entry (crowd still building)
 *   baselineReady=false → hold
 *
 * Returns: { action, frZ, strength, oiMomentum, blocked_reason }
 */

// ── OI momentum from consecutive snapshots ────────────────────────
// Mirrors perception.js: log(oi_now / oi_prev)
// Returns null if either snapshot is missing OI data.
function calcOiMomentum(snap, prevSnap) {
  if (!prevSnap) return null;
  const oi     = avgOI(snap);
  const oiPrev = avgOI(prevSnap);
  if (!oi || !oiPrev || oiPrev === 0) return null;
  return Math.log(oi / oiPrev);
}

function avgOI(snap) {
  const sources = snap.sources || [];
  if (sources.length === 0) return null;
  const vals = sources.map(s => s.oi).filter(v => typeof v === 'number' && v > 0);
  if (vals.length === 0) return null;
  return vals.reduce((s, v) => s + v, 0) / vals.length;
}

// ── Main signal function ──────────────────────────────────────────
/**
 * @param {object} snap      current snapshot
 * @param {object} prevSnap  previous snapshot (may be null for first in segment)
 * @param {object} params    { FR_Z_EXTREME, OI_MOMENTUM_GATE }
 * @returns {object} signal
 */
function generateSignal(snap, prevSnap, params) {
  const ds  = snap.directionSignal || {};
  const frZ = ds.frZ ?? null;

  const base = {
    action:         'hold',
    frZ,
    strength:       ds.strength ?? 0,
    oiMomentum:     null,
    blocked_reason: null,
  };

  // Guard: no baseline yet
  if (!ds.baselineReady) {
    return { ...base, blocked_reason: 'baseline_not_ready' };
  }

  if (frZ === null) {
    return { ...base, blocked_reason: 'no_frZ' };
  }

  // OI momentum gate
  const oiMomentum = calcOiMomentum(snap, prevSnap);
  base.oiMomentum  = oiMomentum;

  const gate = params.OI_MOMENTUM_GATE ?? 0.003;
  if (oiMomentum !== null && oiMomentum > gate) {
    return { ...base, blocked_reason: 'oi_momentum_gate' };
  }

  // frZ threshold
  const threshold = params.FR_Z_EXTREME ?? 1.5;

  if (frZ >= threshold) {
    return { ...base, action: 'short', blocked_reason: null };
  }
  if (frZ <= -threshold) {
    return { ...base, action: 'long', blocked_reason: null };
  }

  return { ...base, blocked_reason: 'frZ_below_threshold' };
}

module.exports = { generateSignal, calcOiMomentum };
