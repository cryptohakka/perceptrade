const axios = require('axios');
const bitget = require('./bitget');

async function getBybitFR(symbol = 'BTCUSDT') {
  const res = await axios.get('https://api.bybit.com/v5/market/tickers', {
    params: { category: 'linear', symbol }
  });
  const d = res.data.result.list[0];
  return { exchange: 'bybit', fr: parseFloat(d.fundingRate), oi: parseFloat(d.openInterest) };
}

async function getHyperliquidFR(symbol = 'BTC') {
  const res = await axios.post('https://api.hyperliquid.xyz/info', { type: 'metaAndAssetCtxs' });
  const meta = res.data[0].universe;
  const ctxs = res.data[1];
  const idx = meta.findIndex(m => m.name === symbol);
  if (idx === -1) return null;
  return {
    exchange: 'hyperliquid',
    fr: parseFloat(ctxs[idx].funding),
    oi: parseFloat(ctxs[idx].openInterest) * parseFloat(ctxs[idx].markPx)
  };
}

async function getOkxFR(instId = 'BTC-USDT-SWAP') {
  const [frRes, oiRes] = await Promise.all([
    axios.get('https://www.okx.com/api/v5/public/funding-rate', { params: { instId } }),
    axios.get('https://www.okx.com/api/v5/rubik/stat/contracts/open-interest-volume', { params: { ccy: 'BTC', period: '5m' } })
  ]);
  const fr = parseFloat(frRes.data.data[0].fundingRate);
  const oiData = oiRes.data.data;
  const oi = oiData.length ? parseFloat(oiData[oiData.length - 1][1]) : 0;
  return { exchange: 'okx', fr, oi };
}

async function getBitgetFR(symbol = 'BTCUSDT') {
  const [frRes, oiRes, lsRes] = await Promise.all([
    bitget.getFundingRate(symbol),
    bitget.getOpenInterest(symbol),
    bitget.getLongShortRatio(symbol).catch(() => null)
  ]);
  const lsData = lsRes?.data?.[0];
  return {
    exchange: 'bitget',
    fr: parseFloat(frRes.data[0].fundingRate),
    oi: parseFloat(oiRes.data.openInterestList[0].size),
    longShortRatio: lsData ? {
      longRatio: parseFloat(lsData.longPositionRatio),
      shortRatio: parseFloat(lsData.shortPositionRatio),
      ratio: parseFloat(lsData.longShortPositionRatio)
    } : null
  };
}

async function getBinanceFR(symbol = 'BTCUSDT') {
  const [frRes, oiRes] = await Promise.all([
    axios.get('https://fapi.binance.com/fapi/v1/premiumIndex', { params: { symbol } }),
    axios.get('https://fapi.binance.com/fapi/v1/openInterest', { params: { symbol } })
  ]);
  return {
    exchange: 'binance',
    fr: parseFloat(frRes.data.lastFundingRate),
    oi: parseFloat(oiRes.data.openInterest)
  };
}

async function getKucoinFR(symbol = 'XBTUSDTM') {
  const [frRes, contractRes] = await Promise.all([
    axios.get(`https://api-futures.kucoin.com/api/v1/funding-rate/${symbol}/current`),
    axios.get(`https://api-futures.kucoin.com/api/v1/contracts/${symbol}`)
  ]);
  const oi = parseFloat(contractRes.data.data.openInterest) * parseFloat(contractRes.data.data.multiplier);
  return {
    exchange: 'kucoin',
    fr: parseFloat(frRes.data.data.value),
    oi
  };
}

// consensusScore: 各CEXのFR方向一致度
function calcConsensus(sources) {
  if (!sources || sources.length === 0) return { score: 0, long: 0, short: 0, neutral: 0, alignment: [] };
  const alignment = sources.map(s => ({
    exchange: s.exchange,
    direction: s.fr > 0.00005 ? 'long' : s.fr < -0.00005 ? 'short' : 'neutral',
    fr: s.fr
  }));
  const long = alignment.filter(a => a.direction === 'long').length;
  const short = alignment.filter(a => a.direction === 'short').length;
  const neutral = alignment.filter(a => a.direction === 'neutral').length;
  const majority = Math.max(long, short);
  const score = parseFloat((majority / sources.length * 100).toFixed(1));
  const label = score >= 85 ? 'STRONG AGREEMENT' : score >= 67 ? 'MAJORITY' : score >= 50 ? 'MIXED' : 'SPLIT';
  return { score, long, short, neutral, total: sources.length, label, alignment };
}

// directionSignal: Funding z-score逆張り + OI枯渇ゲート
const Z_THRESHOLD = parseFloat(process.env.FR_Z_THRESHOLD || '1.5');

function calcDirectionSignal(sources, prevSources = [], frHistory = []) {
  const avgFR = sources.reduce((s, d) => s + d.fr, 0) / sources.length;

  // OI momentum: 全CEX合計OIのlog変化率（スケール歪みを抑制）
  let oiMomentum = 0;
  if (prevSources.length > 0) {
    let tc = 0, tp = 0;
    for (const src of sources) {
      const prev = prevSources.find(p => p.exchange === src.exchange);
      tc += src.oi || 0;
      tp += prev?.oi || 0;
    }
    oiMomentum = (tp > 0 && tc > 0) ? Math.log(tc / tp) : 0;
  }

  // Funding z-score (24h baseline = 288サイクル @ 5min)
  let frZ = 0, baselineReady = false;
  if (frHistory.length >= 20) {
    baselineReady = true;
    const mean = frHistory.reduce((a, b) => a + b, 0) / frHistory.length;
    const sd = Math.sqrt(frHistory.reduce((a, b) => a + (mean - b) ** 2, 0) / frHistory.length);
    frZ = sd > 0 ? (avgFR - mean) / sd : 0;
  }

  let direction = 'neutral', strength = 0;

  // FR Regime label (statistical bands, independent of trigger)
  const absZ = Math.abs(frZ);
  let frRegime = 'neutral';        // |frZ| < 1.0  noise
  if (absZ >= 2.0) frRegime = 'extreme';   // ≥2σ  tail / unstable
  else if (absZ >= 1.0) frRegime = 'elevated'; // 1-2σ  monitoring

  // Extreme regime → caution: scale size down (unstable liquidity, not conviction)
  const EXTREME_FACTOR = 0.7;
  const extremeFactor = frRegime === 'extreme' ? EXTREME_FACTOR : 1.0;

  if (!baselineReady) {
    console.log(`[perception] FR baseline building (${frHistory.length}/20 samples) — hold`);
    return { direction, strength, avgFR, oiMomentum, frZ, baselineReady, frRegime, extremeFactor };
  }

  const OI_BUILD = 0.003;  // OI激増中 → 逆張り見送り
  const OI_FADE  = -0.001; // OI枯渇 → 逆張りボーナス

  if (frZ >= Z_THRESHOLD && oiMomentum <= OI_BUILD) {
    // 群衆が過剰ロング → fade short
    direction = 'short';
    const zPart = Math.min(1, (frZ - Z_THRESHOLD) / 1.5);
    const oiBonus = oiMomentum <= OI_FADE ? 0.3 : 0;
    strength = (0.4 + zPart * 0.3 + oiBonus) * extremeFactor;
  } else if (frZ <= -Z_THRESHOLD && oiMomentum <= OI_BUILD) {
    // 群衆が過剰ショート → fade long
    direction = 'long';
    const zPart = Math.min(1, (Math.abs(frZ) - Z_THRESHOLD) / 1.5);
    const oiBonus = oiMomentum <= OI_FADE ? 0.3 : 0;
    strength = (0.4 + zPart * 0.3 + oiBonus) * extremeFactor;
  }
  // それ以外 → neutral（大半のケース）

  strength = parseFloat(Math.min(1, strength).toFixed(3));
  return { direction, strength, avgFR, oiMomentum, frZ: parseFloat(frZ.toFixed(2)), baselineReady, frRegime, extremeFactor };
}

async function collectMarketData(symbol = 'BTCUSDT', prevSources = [], frHistory = []) {
  const [bybit, hl, okx, bg, bn, kc] = await Promise.allSettled([
    getBybitFR(symbol),
    getHyperliquidFR('BTC'),
    getOkxFR('BTC-USDT-SWAP'),
    getBitgetFR(symbol),
    getBinanceFR(symbol),
    getKucoinFR('XBTUSDTM')
  ]);
  const sources = [bybit, hl, okx, bg, bn, kc]
    .filter(r => r.status === 'fulfilled')
    .map(r => r.value);

  const avgFR = sources.reduce((s, d) => s + d.fr, 0) / sources.length;
  const frDeviation = Math.sqrt(sources.reduce((s, d) => s + (d.fr - avgFR) ** 2, 0) / sources.length);
  const directionSignal = calcDirectionSignal(sources, prevSources, frHistory);
  const consensus = calcConsensus(sources);

  const bgSource = sources.find(s => s.exchange === 'bitget');
  const longShortRatio = bgSource?.longShortRatio || null;

  return { sources, avgFR, frDeviation, directionSignal, consensus, longShortRatio };
}

module.exports = { collectMarketData, getBybitFR, getHyperliquidFR, getOkxFR, getBitgetFR, getBinanceFR, getKucoinFR };
