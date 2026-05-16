const BINANCE_REST = "https://api.binance.com/api/v3";
const BINANCE_DATA = "https://data.binance.vision/data/spot/monthly/klines";

export async function getCryptoCandles(symbol, interval, limit = 1000) {
  const url = `${BINANCE_REST}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Binance kline failed: ${symbol} ${interval} ${response.status}`);
  }
  const data = await response.json();
  return data.map(mapBinanceKline);
}

export async function getCryptoOrderBook(symbol, limit = 100) {
  const response = await fetch(`${BINANCE_REST}/depth?symbol=${symbol}&limit=${limit}`);
  if (!response.ok) return null;
  return response.json();
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
  const response = await fetch(url);
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
