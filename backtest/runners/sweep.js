'use strict';
/**
 * backtest/runners/sweep.js
 * Parameter sweep — mode A (rule_only), fast, deterministic.
 *
 * Usage:
 *   node runners/sweep.js
 *   node runners/sweep.js --snapshots=../snapshots.json
 *   node runners/sweep.js --extreme=1.5,2.0,2.5 --tp=0.015,0.02
 *   node runners/sweep.js --mode=random
 *   node runners/sweep.js --mode=always_long
 *   node runners/sweep.js --mode=hold
 *
 * Output: backtest/output/sweep_<timestamp>.json + console table
 */

const path  = require('path');
const fs    = require('fs');
const { replay }          = require('../core/engine');
const { generateSignal }  = require('../core/signal');
const { getAuditorHook }  = require('../core/auditor_hook');

function parseArgs() {
  const args = {};
  process.argv.slice(2).forEach(arg => {
    const [key, val] = arg.replace(/^--/, '').split('=');
    args[key] = val;
  });
  return args;
}

function parseList(str, defaultVals) {
  if (!str) return defaultVals;
  return str.split(',').map(Number).filter(v => !isNaN(v));
}

const DEFAULTS = {
  LEVERAGE:         2,
  ENTRY_FEE_PCT:    0.0006,
  EXIT_FEE_PCT:     0.0006,
  MAX_SIZE_USDT:    100,
  OI_MOMENTUM_GATE: 0.003,
};

// ── Baseline signal functions ────────────────────────────────────
let _randomSeed = 0;
function seededRandom() { _randomSeed = (_randomSeed * 1664525 + 1013904223) & 0xffffffff; return (_randomSeed >>> 0) / 0xffffffff; }

function randomSignal(snap, prevSnap, params) {
  const ds = snap.directionSignal || {};
  if (!ds.baselineReady) return { action: 'hold', frZ: ds.frZ ?? null, strength: 0, blocked_reason: 'baseline_not_ready' };
  const frZ = ds.frZ ?? null;
  if (frZ === null) return { action: 'hold', frZ: null, strength: 0, blocked_reason: 'no_frZ' };
  const threshold = params.FR_Z_EXTREME ?? 1.5;
  if (Math.abs(frZ) >= threshold) {
    const side = seededRandom() > 0.5 ? 'long' : 'short';
    return { action: side, frZ, strength: 0.5, blocked_reason: null };
  }
  return { action: 'hold', frZ, strength: 0, blocked_reason: 'below_threshold' };
}

function alwaysLongSignal(snap, prevSnap, params) {
  const ds = snap.directionSignal || {};
  if (!ds.baselineReady) return { action: 'hold', frZ: ds.frZ ?? null, strength: 0, blocked_reason: 'baseline_not_ready' };
  const frZ = ds.frZ ?? null;
  if (frZ === null) return { action: 'hold', frZ: null, strength: 0, blocked_reason: 'no_frZ' };
  const threshold = params.FR_Z_EXTREME ?? 1.5;
  if (Math.abs(frZ) >= threshold) return { action: 'long', frZ, strength: 0.5, blocked_reason: null };
  return { action: 'hold', frZ, strength: 0, blocked_reason: 'below_threshold' };
}

// ── Main ──────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs();

  const mode = args.mode || 'strategy';
  const validModes = ['strategy', 'random', 'always_long', 'hold'];
  if (!validModes.includes(mode)) { console.error('[sweep] unknown mode:', mode, '— valid:', validModes.join(', ')); process.exit(1); }

  const snapshotsPath = args.snapshots
    ? path.resolve(args.snapshots)
    : path.resolve(__dirname, '../../snapshots.json');

  if (mode === 'hold') {
    const snaps = JSON.parse(fs.readFileSync(snapshotsPath, 'utf8'))
      .filter(s => s.btcPrice).sort((a,b) => new Date(a.timestamp)-new Date(b.timestamp));
    if (snaps.length < 2) { console.log('[hold] not enough data'); process.exit(0); }
    const entryPrice = snaps[0].btcPrice, exitPrice = snaps[snaps.length-1].btcPrice;
    const rawPnl = (exitPrice - entryPrice) / entryPrice * 100;
    console.log(`[hold] ${snaps[0].timestamp.slice(0,16)} $${entryPrice} → ${snaps[snaps.length-1].timestamp.slice(0,16)} $${exitPrice}`);
    console.log(`[hold] raw PnL (1x): ${rawPnl >= 0 ? '+' : ''}${rawPnl.toFixed(4)}%`);
    console.log(`[hold] with 2x leverage: ${(rawPnl*2).toFixed(4)}%`);
    process.exit(0);
  }

  if (!fs.existsSync(snapshotsPath)) { console.error(`[sweep] snapshots not found: ${snapshotsPath}`); process.exit(1); }

  const signalFnMap = { strategy: generateSignal, random: randomSignal, always_long: alwaysLongSignal };
  const activeSigFn = signalFnMap[mode];
  _randomSeed = 42;

  const extremeVals = parseList(args.extreme, [1.5, 2.0, 2.5, 3.0]);
  const tpVals      = parseList(args.tp,      [0.012, 0.015, 0.020]);
  const slVals      = parseList(args.sl,      [0.010, 0.012, 0.015]);

  const auditorHook = getAuditorHook('rule_only');
  const results     = [];
  const total = extremeVals.length * tpVals.length * slVals.length;
  console.log(`[sweep] mode=${mode} | ${total} combinations × snapshots: ${snapshotsPath}`);
  console.log('');

  let idx = 0;
  for (const extreme of extremeVals) {
    for (const tp of tpVals) {
      for (const sl of slVals) {
        idx++;
        const params = { ...DEFAULTS, FR_Z_EXTREME: extreme, TP_PCT: tp, SL_PCT: sl };
        const { trades, summary } = await replay(snapshotsPath, params, activeSigFn, auditorHook);
        results.push({ params: { FR_Z_EXTREME: extreme, TP_PCT: tp, SL_PCT: sl }, summary, trades });
        process.stdout.write(`\r[sweep] ${idx}/${total} — extreme=${extreme} tp=${tp} sl=${sl} → trades=${summary.total} wr=${summary.win_rate}% pnl=${summary.total_pnl_net}%`);
      }
    }
  }

  console.log('\n');
  printTable(results);
  saveResults(results, mode);
}

function printTable(results) {
  const sorted = [...results].sort((a, b) => b.summary.total_pnl_net - a.summary.total_pnl_net);
  console.log('── Sweep Results (sorted by PnL) ──────────────────────────────');
  console.log('extreme  tp     sl     trades  wr%    pnl_net%  fee_drag%  avg_revert');
  console.log('─'.repeat(70));
  sorted.slice(0, 20).forEach(r => {
    const p = r.params, s = r.summary;
    console.log(`${String(p.FR_Z_EXTREME).padEnd(8)} ${String(p.TP_PCT).padEnd(6)} ${String(p.SL_PCT).padEnd(6)} ${String(s.total||0).padEnd(7)} ${String(s.win_rate??'-').padEnd(6)} ${String(s.total_pnl_net??'-').padEnd(9)} ${String(s.total_fee_drag??'-').padEnd(10)} ${String(s.avg_revert_ratio??'-')}`);
  });
  console.log('─'.repeat(70));
  if (results.length > 20) console.log(`(showing top 20 of ${results.length})`);
}

function saveResults(results, mode) {
  const outDir = path.resolve(__dirname, '../output');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outPath = path.join(outDir, `sweep_${ts}_${mode}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ generated: new Date().toISOString(), mode, results }, null, 2));
  console.log(`\n[sweep] saved → ${outPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
