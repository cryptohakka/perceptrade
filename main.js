require('dotenv').config();
const server = require('./server');
const { runCycle } = require('./agent');

const UI_PORT = parseInt(process.env.UI_PORT || '5006');
const CYCLE_MS = parseInt(process.env.CYCLE_INTERVAL_MS || '60000');

server.listen(UI_PORT, () => {
  console.log(`PercepTrade UI running on port ${UI_PORT}`);
});

console.log('PercepTrade agent starting...');

async function loop() {
  await runCycle(server);
  setInterval(() => runCycle(server), CYCLE_MS);
}

loop();
