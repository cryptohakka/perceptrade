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
  const res = await axios.post('https://api.hyperliquid.xyz/info', {
    type: 'metaAndAssetCtxs'
  });
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
  const [frRes, oiRes] = await Promise.all([
    bitget.getFundingRate(symbol),
    bitget.getOpenInterest(symbol)
  ]);
  return {
    exchange: 'bitget',
    fr: parseFloat(frRes.data[0].fundingRate),
    oi: parseFloat(oiRes.data.openInterestList[0].size)
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

async function collectMarketData(symbol = 'BTCUSDT') {
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
  const bgFR = sources.find(d => d.exchange === 'bitget')?.fr ?? avgFR;
  const frDeviation = Math.abs(bgFR - avgFR);
  const riskScore = Math.min(100, Math.max(0, (frDeviation - 0.0001) / (0.001 - 0.0001) * 100));

  return { sources, avgFR, bgFR, frDeviation, riskScore };
}

module.exports = { collectMarketData, getBybitFR, getHyperliquidFR, getOkxFR, getBitgetFR, getBinanceFR, getKucoinFR };
