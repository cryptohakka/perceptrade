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

app.get('/api/state', (req, res) => {
  res.json(latestState);
});

app.updateState = (state) => { latestState = state; };

// require()された場合はlistenしない（agent.jsから使う場合）
if (require.main === module) {
  app.listen(UI_PORT, () => {
    console.log(`PercepTrade UI running on port ${UI_PORT}`);
  });
}

module.exports = app;
