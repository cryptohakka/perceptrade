const crypto = require('crypto');
const axios = require('axios');

const BASE_URL = 'https://api.bitget.com';

function sign(timestamp, method, path, body = '') {
  const msg = timestamp + method.toUpperCase() + path + body;
  return crypto.createHmac('sha256', process.env.BITGET_SECRET_KEY).update(msg).digest('base64');
}

function headers(method, path, body = '') {
  const ts = Date.now().toString();
  return {
    'ACCESS-KEY': process.env.BITGET_API_KEY,
    'ACCESS-SIGN': sign(ts, method, path, body),
    'ACCESS-TIMESTAMP': ts,
    'ACCESS-PASSPHRASE': process.env.BITGET_PASSPHRASE,
    'Content-Type': 'application/json',
    'locale': 'en-US'
  };
}

async function get(path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const fullPath = qs ? `${path}?${qs}` : path;
  const res = await axios.get(BASE_URL + fullPath, { headers: headers('GET', fullPath) });
  return res.data;
}

async function post(path, body = {}) {
  const bodyStr = JSON.stringify(body);
  const res = await axios.post(BASE_URL + path, bodyStr, { headers: headers('POST', path, bodyStr) });
  return res.data;
}

// Futures
async function getFundingRate(symbol) {
  return get('/api/v2/mix/market/current-fund-rate', { symbol, productType: 'USDT-FUTURES' });
}

async function getOpenInterest(symbol) {
  return get('/api/v2/mix/market/open-interest', { symbol, productType: 'USDT-FUTURES' });
}

async function getTicker(symbol) {
  return get('/api/v2/mix/market/ticker', { symbol, productType: 'USDT-FUTURES' });
}

async function getPositions() {
  return get('/api/v2/mix/position/all-position', { productType: 'USDT-FUTURES', marginCoin: 'USDT' });
}

async function placeOrder(symbol, side, size, orderType = 'market') {
  return post('/api/v2/mix/order/place-order', {
    symbol,
    productType: 'USDT-FUTURES',
    marginMode: 'isolated',
    marginCoin: 'USDT',
    size: size.toString(),
    side,
    orderType,
    tradeSide: 'open'
  });
}

async function closePosition(symbol, side, size) {
  return post('/api/v2/mix/order/place-order', {
    symbol,
    productType: 'USDT-FUTURES',
    marginMode: 'isolated',
    marginCoin: 'USDT',
    size: size.toString(),
    side,
    orderType: 'market',
    tradeSide: 'close'
  });
}

async function getAccountAssets() {
  return get('/api/v2/mix/account/accounts', { productType: 'USDT-FUTURES' });
}

module.exports = { getFundingRate, getOpenInterest, getTicker, getPositions, placeOrder, closePosition, getAccountAssets };
