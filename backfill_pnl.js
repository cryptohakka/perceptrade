// backfill_pnl.js — 既存post_mortemsをleverage+fee込みpnlに再計算
const fs = require('fs');
const FILE = process.env.POSTMORTEM_FILE || '/home/agent/perceptrade/post_mortems.json';

const LEVERAGE  = parseFloat(process.env.LEVERAGE || '2');
const ENTRY_FEE = parseFloat(process.env.ENTRY_FEE_PCT || '0.0006');
const EXIT_FEE  = parseFloat(process.env.EXIT_FEE_PCT  || '0.0006');
const feePct = (ENTRY_FEE + EXIT_FEE) * LEVERAGE;

const mortems = JSON.parse(fs.readFileSync(FILE, 'utf8'));
fs.writeFileSync(FILE + '.bak', JSON.stringify(mortems, null, 2));

const fixed = mortems.map(m => {
  const dir = m.side === 'long' ? 1 : -1;
  const raw = (m.exit_price - m.entry_price) / m.entry_price * dir;
  const lev = raw * LEVERAGE;
  const net = lev - feePct;
  return {
    ...m,
    pnl_pct:     parseFloat((net * 100).toFixed(4)),
    pnl_pct_raw: parseFloat((raw * 100).toFixed(4)),
    pnl_pct_lev: parseFloat((lev * 100).toFixed(4)),
    fee_pct:     parseFloat((feePct * 100).toFixed(4)),
    leverage:    LEVERAGE,
    _backfilled: true
  };
});

fs.writeFileSync(FILE, JSON.stringify(fixed, null, 2));

console.log(`backfilled ${fixed.length} records (backup: ${FILE}.bak)\n`);
let sumNet = 0, sumRaw = 0, wins = 0;
fixed.forEach(m => {
  sumNet += m.pnl_pct; sumRaw += m.pnl_pct_raw;
  if (m.result === 'win') wins++;
  console.log(`${m.side.padEnd(5)} raw=${String(m.pnl_pct_raw).padStart(8)}%  lev=${String(m.pnl_pct_lev).padStart(8)}%  net=${String(m.pnl_pct).padStart(8)}%  [${m.result}]`);
});
console.log(`\nΣ raw=${sumRaw.toFixed(3)}%  Σ net=${sumNet.toFixed(3)}%  fee drag=${(feePct*100*fixed.length).toFixed(3)}%  winrate=${wins}/${fixed.length}`);
