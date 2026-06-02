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

// directionSignal: FR絶対値 + OI momentum → direction + strength
function calcDirectionSignal(sources, prevSources = []) {
  const avgFR = sources.reduce((s, d) => s + d.fr, 0) / sources.length;

  // OI momentum: 全CEX合計OIの前サイクル比
  let oiMomentum = 0;
  if (prevSources.length > 0) {
    let totalCurrent = 0, totalPrev = 0;
    for (const src of sources) {
      const prev = prevSources.find(p => p.exchange === src.exchange);
      totalCurrent += src.oi || 0;
      totalPrev += prev?.oi || 0;
    }
    oiMomentum = totalPrev > 0 ? (totalCurrent - totalPrev) / totalPrev : 0;
  }

  // FR強度: 0.00005〜0.0003 → 0〜1
  const frStrength = Math.min(1, Math.max(0, (Math.abs(avgFR) - 0.00005) / (0.0003 - 0.00005)));

  // direction判定
  let direction, strength;
  if (avgFR > 0.00005) {
    // ロング過熱域
    if (oiMomentum > 0.002) {
      direction = 'long';   // トレンド継続
      strength = frStrength * 0.7 + Math.min(1, oiMomentum / 0.02) * 0.3;
    } else if (oiMomentum < -0.002) {
      direction = 'short';  // 天井圏反転
      strength = frStrength * 0.6 + Math.min(1, Math.abs(oiMomentum) / 0.02) * 0.4;
    } else {
      direction = 'long';   // OI横ばい、FR方向に従う
      strength = frStrength * 0.5;
    }
  } else if (avgFR < -0.00005) {
    // ショート過熱域
    if (oiMomentum < -0.002) {
      direction = 'short';
      strength = Math.min(1, Math.abs(avgFR) / 0.0003) * 0.7 + Math.min(1, Math.abs(oiMomentum) / 0.02) * 0.3;
    } else if (oiMomentum > 0.002) {
      direction = 'long';
      strength = Math.min(1, Math.abs(avgFR) / 0.0003) * 0.6 + Math.min(1, oiMomentum / 0.02) * 0.4;
    } else {
      direction = 'short';
      strength = Math.min(1, Math.abs(avgFR) / 0.0003) * 0.5;
    }
  } else {
    // FR中立域 → OI momentumのみで判断
    if (oiMomentum > 0.005) {
      direction = 'long';
      strength = Math.min(1, oiMomentum / 0.02) * 0.4;
    } else if (oiMomentum < -0.005) {
      direction = 'short';
      strength = Math.min(1, Math.abs(oiMomentum) / 0.02) * 0.4;
    } else {
      direction = 'neutral';
      strength = 0;
    }
  }

  // strength下限: 0.3以上なら必ずシグナル出す（デモモード）
  if (direction !== 'neutral' && strength < 0.3) strength = 0.3;

  return { direction, strength: parseFloat(strength.toFixed(3)), avgFR, oiMomentum };
}

async function collectMarketData(symbol = 'BTCUSDT', prevSources = []) {
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
  const directionSignal = calcDirectionSignal(sources, prevSources);
  const consensus = calcConsensus(sources);

  // Bitget Long/Short Ratio (Bitget-specific signal)
  const bgSource = sources.find(s => s.exchange === 'bitget');
  const longShortRatio = bgSource?.longShortRatio || null;

  return { sources, avgFR, frDeviation, directionSignal, consensus, longShortRatio };
}

module.exports = { collectMarketData, getBybitFR, getHyperliquidFR, getOkxFR, getBitgetFR, getBinanceFR, getKucoinFR };
