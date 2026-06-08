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
    res.json(events);
  } catch(e) { res.json([]); }
});

app.get('/api/snapshots', (req, res) => {
  try {
    const snaps = JSON.parse(fs.readFileSync(SNAPSHOTS_FILE, 'utf8'));
    res.json(snaps);
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
    const raw = data?.data?.entrustedList || data?.entrustedList || data?.data || data?.list;
    const all = Array.isArray(raw) ? raw : [];
    const cutoff = new Date("2026-06-06T00:00:00Z").getTime();
    const filtered = all.filter(t => {
      const ts = parseInt(t.cTime || t.createTime || t.uTime || 0);
      return ts >= cutoff && t.tradeSide === 'close';
    });
    res.json(filtered);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/status-dump', async (req, res) => {
  try {
    const snapshots    = JSON.parse(fs.readFileSync(SNAPSHOTS_FILE, 'utf8'));
    const outcomes     = JSON.parse(fs.readFileSync(OUTCOMES_FILE, 'utf8'));
    const crowd_events = JSON.parse(fs.readFileSync(CROWD_EVENTS_FILE, 'utf8'));
    const regime       = JSON.parse(fs.readFileSync('/home/agent/perceptrade/regime_state.json', 'utf8'));
    const post_mortems = JSON.parse(fs.readFileSync('/home/agent/perceptrade/post_mortems.json', 'utf8'));
    const tradeData    = await bitget.getClosedOrders('BTCUSDT', 100);
    const raw          = tradeData?.data?.entrustedList || tradeData?.entrustedList || tradeData?.data || tradeData?.list;
    const cutoff       = new Date("2026-06-06T00:00:00Z").getTime();
    const allTrades    = (Array.isArray(raw) ? raw : []).filter(t => {
      const ts = parseInt(t.cTime || t.createTime || t.uTime || 0);
      return ts >= cutoff && t.tradeSide === 'close';
    });

    // trades: 必要フィールドのみ
    const trades = allTrades.map(t => ({
      time:  new Date(parseInt(t.cTime||t.uTime)).toISOString(),
      side:  t.posSide,
      entry: parseFloat(t.posAvg || t.priceAvg || 0),
      exit:  parseFloat(t.priceAvg || 0),
      pnl:   parseFloat(t.totalProfits || 0),
      fee:   parseFloat(t.fee || 0)
    }));

    // frz_summary: snapshotsから集計
    const frZs     = snapshots.map(s => s.frZ).filter(v => v != null);
    const triggers = frZs.filter(z => Math.abs(z) >= 1.5).length;
    const extreme  = frZs.filter(z => Math.abs(z) >= 2.0).length;
    const noTrade  = frZs.filter(z => Math.abs(z) < 1.5).length;
    const latestSnap = snapshots[0] || {};
    const frz_summary = {
      snapshots:    snapshots.length,
      latest_frZ:   latestSnap.frZ ?? null,
      latest_price: latestSnap.btcPrice ?? null,
      triggers,
      extreme,
      no_trade_pct: frZs.length ? Math.round(noTrade/frZs.length*100) : 0,
      trade_zone_pct: frZs.length ? Math.round(triggers/frZs.length*100) : 0
    };

    // outcomes_summary (frChg from alertSummary, same logic as history.html)
    const results = outcomes.map(ev => {
      const m = (ev.alertSummary||'').match(/([+-][\d.]+)%/);
      const frChg = m ? parseFloat(m[1]) : null;
      const chg1h = ev.priceChanges?.['1h']?.changePct ?? null;
      const correct = (frChg!==null && chg1h!==null) ? (frChg>0) === (chg1h<0) : null;
      return { frChg, chg1h, correct };
    });
    const scored  = results.filter(r => r.correct !== null);
    const correct = scored.filter(r => r.correct).length;
    const avgMove = scored.length ? (scored.reduce((a,b)=>a+(b.chg1h||0),0)/scored.length).toFixed(4) : null;
    const outcomes_summary = {
      events: outcomes.length,
      scored: scored.length,
      correct,
      success_rate: scored.length ? parseFloat((correct/scored.length*100).toFixed(1)) : null,
      avg_1h_move: avgMove
    };

    // trades summary
    const pnls    = trades.map(t => t.pnl);
    const wins    = pnls.filter(p => p > 0).length;
    const trades_summary = {
      total:    trades.length,
      wins,
      win_rate: trades.length ? parseFloat((wins/trades.length*100).toFixed(1)) : null,
      gross_pnl: parseFloat(pnls.reduce((a,b)=>a+b,0).toFixed(4)),
      total_fee: parseFloat(trades.map(t=>t.fee).reduce((a,b)=>a+b,0).toFixed(4))
    };

    res.json({
      generated: new Date().toISOString(),
      regime: {
        current:    regime.current_regime,
        confidence: regime.current_confidence,
        history:    (regime.history || []).slice(0, 5)
      },
      frz_summary,
      trades_summary,
      trades,
      outcomes_summary,
      crowd_events: [...crowd_events].sort((a,b) => (b.reduction_pct||0) - (a.reduction_pct||0)).slice(0, 10),
      post_mortems
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/regime', (req, res) => {
  try {
    const data = JSON.parse(require('fs').readFileSync('/home/agent/perceptrade/regime_state.json', 'utf8'));
    res.json(data.history || []);
  } catch(e) { res.json([]); }
});

app.get('/api/mortems', (req, res) => {
  try {
    const data = JSON.parse(require('fs').readFileSync('/home/agent/perceptrade/post_mortems.json', 'utf8'));
    res.json(data);
  } catch(e) { res.json([]); }
});

if (require.main === module) {
  


app.listen(UI_PORT, () => {
    console.log(`PercepTrade UI running on port ${UI_PORT}`);
  });
}
module.exports = app;
