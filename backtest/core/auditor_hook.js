'use strict';
/**
 * backtest/core/auditor_hook.js
 * Interface definition for LLM auditor integration.
 *
 * Mode A (rule_only): always returns approved=true — no LLM calls.
 * Mode B (with_llm):  replace getAuditorHook() with modes/with_llm.js impl.
 *
 * Cache modes (for mode B):
 *   'record'  — call LLM, save response to cache/llm_responses/
 *   'replay'  — load from cache, error if missing
 *   'live'    — call LLM, ignore cache
 */

const NOOP_HOOK = async (_signal, _snap, _params) => ({
  approved:   true,
  confidence: 1.0,
  feedback:   'no-op (rule_only mode)',
  mode:       'rule_only',
});

/**
 * Returns the auditor hook function for the given mode.
 * @param {'rule_only'|'with_llm'} mode
 * @param {object} [options]  { cacheMode: 'record'|'replay'|'live' }
 */
function getAuditorHook(mode = 'rule_only', options = {}) {
  if (mode === 'rule_only') {
    return NOOP_HOOK;
  }

  if (mode === 'with_llm') {
    // TODO (Day 6+): import and return modes/with_llm.js hook
    // const { buildLLMHook } = require('../modes/with_llm');
    // return buildLLMHook(options.cacheMode || 'replay');
    throw new Error('with_llm mode not yet implemented — use rule_only');
  }

  throw new Error(`Unknown auditor mode: ${mode}`);
}

module.exports = { getAuditorHook, NOOP_HOOK };
