require('dotenv').config();
const server = require('./server');
const { runCycle } = require('./agent');
const { classifyRegime } = require('./regime_classifier');

const UI_PORT = parseInt(process.env.UI_PORT || '5006');
const CYCLE_MS = parseInt(process.env.CYCLE_INTERVAL_MS || '60000');

server.listen(UI_PORT, () => console.log(`PercepTrade UI running on port ${UI_PORT}`));
console.log('PercepTrade agent starting...');

async function loop() {
  try { await classifyRegime(); } catch(e) { console.error('[regime] startup failed:', e.message); }
  await runCycle(server);
  setInterval(() => runCycle(server), CYCLE_MS);
  setInterval(async () => {
    try { await classifyRegime(); } catch(e) { console.error('[regime] failed:', e.message); }
  }, 60 * 60 * 1000);
}
loop();
