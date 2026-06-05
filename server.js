require('dotenv').config();
const express = require('express');
const path = require('path');
const app = express();
const UI_PORT = parseInt(process.env.UI_PORT || '5006');
let latestState = {};
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'landing.html'));
});
app.get('/analysis', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'analysis.html'));
});
app.get('/app', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});
const fs = require('fs');
const bitget = require('./bitget');
const CROWD_EVENTS_FILE = process.env.CROWD_EVENTS_FILE || '/home/agent/perceptrade/crowd_events.json';
const SNAPSHOTS_FILE   = process.env.SNAPSHOTS_FILE   || '/home/agent/perceptrade/snapshots.json';
const OUTCOMES_FILE    = process.env.OUTCOMES_FILE    || '/home/agent/perceptrade/crowd_outcomes.json';

app.get('/api/crowd-events', (req, res) => {
  try {
    const events = JSON.parse(fs.readFileSync(CROWD_EVENTS_FILE, 'utf8'));
    res.json(events.slice(0, 50));
  } catch(e) { res.json([]); }
});

app.get('/api/snapshots', (req, res) => {
  try {
    const snaps = JSON.parse(fs.readFileSync(SNAPSHOTS_FILE, 'utf8'));
    const limit = parseInt(req.query.limit || '200');
    res.json(snaps.slice(0, limit));
  } catch(e) { res.json([]); }
});

app.get('/api/outcomes', (req, res) => {
  try {
    const outcomes = JSON.parse(fs.readFileSync(OUTCOMES_FILE, 'utf8'));
    res.json(outcomes);
  } catch(e) { res.json([]); }
});

app.get('/api/state', (req, res) => {
  res.json(latestState);
});
app.updateState = (state) => { latestState = state; };


app.get('/history', (req, res) => res.sendFile(require('path').join(__dirname, 'public', 'history.html')));
app.get('/api/trades', async (req, res) => {
  try {
    const data = await bitget.getClosedOrders('BTCUSDT', 100);
    res.json(data?.entrustedList || data?.data || data?.list || []);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
if (require.main === module) {
  

app.listen(UI_PORT, () => {
    console.log(`PercepTrade UI running on port ${UI_PORT}`);
  });
}
module.exports = app;
