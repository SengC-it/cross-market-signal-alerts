const BINANCE_REST = "https://api.binance.com/api/v3";
const BINANCE_FUTURES_REST = "https://fapi.binance.com/fapi/v1";
const BINANCE_FUTURES_DATA = "https://fapi.binance.com/futures/data";
const BINANCE_DATA = "https://data.binance.vision/data/spot/monthly/klines";
const FETCH_TIMEOUT_MS = Number(process.env.MARKET_DATA_FETCH_TIMEOUT_MS || 12000);

export async function getCryptoCandles(symbol, interval, limit = 1000) {
  const url = `${BINANCE_REST}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const response = await fetchWithTimeout(url);
  if (!response.ok) {
    if (response.status === 451) throw new Error(`Binance spot restricted by location: ${symbol} ${interval} 451`);
    throw new Error(`Binance kline failed: ${symbol} ${interval} ${response.status}`);
  }
  const data = await response.json();
  return data.map(mapBinanceKline);
}

export async function getCryptoOrderBook(symbol, limit = 100) {
  let response;
  try {
    response = await fetchWithTimeout(`${BINANCE_REST}/depth?symbol=${symbol}&limit=${limit}`);
  } catch {
    return null;
  }
  if (!response.ok) return null;
  return response.json();
}

export async function getSpot24hTickers() {
  const response = await fetchWithTimeout(`${BINANCE_REST}/ticker/24hr`);
  if (!response.ok) {
    throw new Error(`Binance 24h ticker failed: ${response.status}`);
  }
  const data = await response.json();
  return data.map((item) => ({
    symbol: item.symbol,
    priceChangePercent: Number(item.priceChangePercent),
    quoteVolume: Number(item.quoteVolume),
    lastPrice: Number(item.lastPrice),
    count: Number(item.count)
  }));
}

export async function getFuturesCandles(symbol, interval, limit = 1000) {
  const url = `${BINANCE_FUTURES_REST}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const response = await fetchWithTimeout(url);
  if (!response.ok) {
    if (response.status === 451) throw new Error(`Binance futures restricted by location: ${symbol} ${interval} 451`);
    throw new Error(`Binance futures kline failed: ${symbol} ${interval} ${response.status}`);
  }
  const data = await response.json();
  return data.map(mapBinanceKline);
}

export async function getFuturesFundingRate(symbol) {
  let response;
  try {
    response = await fetchWithTimeout(`${BINANCE_FUTURES_REST}/fundingRate?symbol=${symbol}&limit=1`);
  } catch {
    return null;
  }
  if (!response.ok) return null;
  const data = await response.json();
  const latest = data?.[0];
  if (!latest) return null;
  return {
    fundingRate: Number(latest.fundingRate),
    fundingTime: Number(latest.fundingTime)
  };
}

export async function getFuturesPremiumIndex(symbol) {
  let response;
  try {
    response = await fetchWithTimeout(`${BINANCE_FUTURES_REST}/premiumIndex?symbol=${symbol}`);
  } catch {
    return null;
  }
  if (!response.ok) return null;
  const data = await response.json();
  return {
    markPrice: Number(data.markPrice),
    indexPrice: Number(data.indexPrice),
    estimatedSettlePrice: Number(data.estimatedSettlePrice),
    lastFundingRate: Number(data.lastFundingRate),
    nextFundingTime: Number(data.nextFundingTime),
    time: Number(data.time)
  };
}

export async function getFuturesOpenInterest(symbol) {
  let response;
  try {
    response = await fetchWithTimeout(`${BINANCE_FUTURES_REST}/openInterest?symbol=${symbol}`);
  } catch {
    return null;
  }
  if (!response.ok) return null;
  const data = await response.json();
  return {
    openInterest: Number(data.openInterest),
    time: Number(data.time)
  };
}

export async function getFuturesLongShortContext(symbol, period = "1h") {
  const [accounts, topPositions] = await Promise.all([
    fetchFuturesDataSeries("globalLongShortAccountRatio", symbol, period),
    fetchFuturesDataSeries("topLongShortPositionRatio", symbol, period)
  ]);
  return {
    accounts: summarizeLongShortSeries(accounts),
    topPositions: summarizeLongShortSeries(topPositions)
  };
}

export async function getCryptoHistoricalMonthly(symbol, interval, months = 72) {
  const now = new Date();
  const files = [];
  for (let i = months; i >= 1; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    files.push(`${BINANCE_DATA}/${symbol}/${interval}/${symbol}-${interval}-${ym}.zip`);
  }
  return files;
}

function mapBinanceKline(row) {
  return {
    openTime: Number(row[0]),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5])
  };
}

async function fetchFuturesDataSeries(path, symbol, period) {
  let response;
  try {
    response = await fetchWithTimeout(`${BINANCE_FUTURES_DATA}/${path}?symbol=${symbol}&period=${period}&limit=2`);
  } catch {
    return [];
  }
  if (!response.ok) return [];
  const data = await response.json();
  return Array.isArray(data) ? data : [];
}

function summarizeLongShortSeries(series) {
  const latest = series.at(-1);
  const previous = series.at(-2);
  const ratio = Number(latest?.longShortRatio);
  const prevRatio = Number(previous?.longShortRatio);
  return {
    ratio: Number.isFinite(ratio) ? ratio : null,
    previousRatio: Number.isFinite(prevRatio) ? prevRatio : null,
    change: Number.isFinite(ratio) && Number.isFinite(prevRatio) ? ratio - prevRatio : null,
    longAccount: Number(latest?.longAccount),
    shortAccount: Number(latest?.shortAccount),
    timestamp: Number(latest?.timestamp)
  };
}

function fetchWithTimeout(url, options = {}) {
  return fetch(url, {
    ...options,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  });
}
