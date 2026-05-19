const BINANCE_REST = process.env.BINANCE_SPOT_REST || "https://api.binance.com/api/v3";
const BINANCE_FUTURES_REST = process.env.BINANCE_FUTURES_REST || "https://fapi.binance.com/fapi/v1";
const BINANCE_DATA = "https://data.binance.vision/data/spot/monthly/klines";
const FETCH_TIMEOUT_MS = Number(process.env.MARKET_DATA_FETCH_TIMEOUT_MS || 12000);

export async function getCryptoCandles(symbol, interval, limit = 1000) {
  const url = `${BINANCE_REST}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  let response;
  try {
    response = await fetchWithTimeout(url);
  } catch (error) {
    const fallback = await getFallbackCryptoCandles(symbol, interval, limit);
    if (fallback.length) return fallback;
    throw error;
  }
  if (!response.ok) {
    const fallback = await getFallbackCryptoCandles(symbol, interval, limit);
    if (fallback.length) return fallback;
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

export async function getFuturesCandles(symbol, interval, limit = 1000) {
  const url = `${BINANCE_FUTURES_REST}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  let response;
  try {
    response = await fetchWithTimeout(url);
  } catch (error) {
    const fallback = await getFallbackCryptoCandles(symbol, interval, limit);
    if (fallback.length) return fallback.map((candle) => ({ ...candle, proxySource: "Yahoo spot proxy" }));
    throw error;
  }
  if (!response.ok) {
    const fallback = await getFallbackCryptoCandles(symbol, interval, limit);
    if (fallback.length) return fallback.map((candle) => ({ ...candle, proxySource: "Yahoo spot proxy" }));
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

export async function getYahooCandles(symbol, range = "5y", interval = "1d") {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;
  const response = await fetchWithTimeout(url);
  if (!response.ok) {
    throw new Error(`Yahoo chart failed: ${symbol} ${response.status}`);
  }
  const json = await response.json();
  const result = json.chart?.result?.[0];
  if (!result) return [];
  const timestamps = result.timestamp || [];
  const quote = result.indicators?.quote?.[0] || {};
  return timestamps
    .map((time, index) => ({
      openTime: time * 1000,
      open: quote.open?.[index],
      high: quote.high?.[index],
      low: quote.low?.[index],
      close: quote.close?.[index],
      volume: quote.volume?.[index] ?? 0
    }))
    .filter((c) => Number.isFinite(c.open) && Number.isFinite(c.high) && Number.isFinite(c.low) && Number.isFinite(c.close));
}

export async function getYahooCryptoCandles(symbol, interval, limit = 1000) {
  const yahooSymbol = toYahooCryptoSymbol(symbol);
  if (!yahooSymbol) return [];

  if (interval === "4h") {
    const hourly = await getYahooCandles(yahooSymbol, "730d", "1h");
    return aggregateCandles(hourly, 4).slice(-limit);
  }

  if (interval === "1d") {
    return (await getYahooCandles(yahooSymbol, "max", "1d")).slice(-limit);
  }

  if (interval === "1h") {
    return (await getYahooCandles(yahooSymbol, "730d", "1h")).slice(-limit);
  }

  if (interval === "2h") {
    const hourly = await getYahooCandles(yahooSymbol, "730d", "1h");
    return aggregateCandles(hourly, 2).slice(-limit);
  }

  return [];
}

async function getFallbackCryptoCandles(symbol, interval, limit) {
  try {
    return await getYahooCryptoCandles(symbol, interval, limit);
  } catch {
    return [];
  }
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

function toYahooCryptoSymbol(symbol) {
  if (!symbol.endsWith("USDT")) return null;
  const base = symbol.slice(0, -4);
  return `${base}-USD`;
}

function aggregateCandles(candles, hours) {
  const bucketMs = hours * 60 * 60 * 1000;
  const buckets = new Map();
  for (const candle of candles) {
    const key = Math.floor(candle.openTime / bucketMs) * bucketMs;
    const existing = buckets.get(key);
    if (!existing) {
      buckets.set(key, { ...candle, openTime: key });
      continue;
    }
    existing.high = Math.max(existing.high, candle.high);
    existing.low = Math.min(existing.low, candle.low);
    existing.close = candle.close;
    existing.volume += candle.volume || 0;
  }
  return [...buckets.values()].sort((a, b) => a.openTime - b.openTime);
}

function fetchWithTimeout(url, options = {}) {
  return fetch(url, {
    ...options,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  });
}
