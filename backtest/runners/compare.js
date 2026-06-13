'use strict';
/**
 * backtest/runners/compare.js
 * Mode A (rule_only) vs Mode B (with_llm) PnL comparison.
 *
 * Usage (Day 9+, after with_llm mode is implemented):
 *   node runners/compare.js --extreme=2.5 --tp=0.015 --sl=0.012 --mode=llm
 *
 * Output:
 *   Rule-only PnL:  +X.XX%
 *   Rule+LLM PnL:   +Y.YY%
 *   AI alpha:       +Z.ZZ%
 *
 * TODO: implement after auditor_hook.js with_llm mode is ready (Day 6+)
 */

console.log('[compare] Not yet implemented — available Day 9+');
console.log('  Requires: backtest/modes/with_llm.js + cache population');
console.log('  Run sweep.js first to validate rule_only baseline.');
process.exit(0);
