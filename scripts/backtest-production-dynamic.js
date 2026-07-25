import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";

const API = "https://fapi.binance.com";
const HOUR = 3600_000;
const START = Date.parse(process.env.BACKTEST_START || "2023-01-01T00:00:00Z");
const END = Date.parse(process.env.BACKTEST_END || "2026-07-01T00:00:00Z");
const TOP_N = Number(process.env.BACKTEST_TOP_N || 80);
const DATA_MODE = process.env.BACKTEST_DATA_MODE || "fetch";
const STRICT_DYNAMIC_POOL = process.env.BACKTEST_STRICT_DYNAMIC_POOL === "1";
const SYMBOLS = (process.env.BACKTEST_SYMBOLS || "")
  .split(",")
  .map((symbol) => symbol.trim().toUpperCase())
  .filter(Boolean);
const HOLD_HOURS = Number(process.env.BACKTEST_HOLD_HOURS || 8);
const COST = Number(process.env.BACKTEST_COST || 0.0012);
const REQUEST_DELAY_MS = Number(process.env.BACKTEST_REQUEST_DELAY_MS || (DATA_MODE === "powershell" ? 1500 : 30));
const CACHE_DIR = process.env.BACKTEST_CACHE_DIR || ".backtest-cache/binance-futures-1h";
const VISION_CACHE_DIR = process.env.BACKTEST_VISION_CACHE_DIR || ".backtest-cache/binance-vision-futures-1h";
const OUTPUT_FILE = process.env.BACKTEST_OUTPUT_FILE || "production_dynamic_backtest.json";
const FETCH_CONCURRENCY = Math.max(1, Number(process.env.BACKTEST_FETCH_CONCURRENCY || 1));
const QUIET = process.env.BACKTEST_QUIET === "1";
const CACHE_ONLY = process.env.BACKTEST_CACHE_ONLY === "1";
const MIN_QUOTE_VOLUME = 3_000_000;
const MAX_ASSETS_PER_SIDE = 10;
const MAX_SIGNALS_PER_EMAIL = 5;
const COOLDOWN_HOURS = 24;
const VALID_HOURS = 4;
const FUTURES_STOP_ATR_MULTIPLIER = 1.6;
const FUTURES_REWARD_RISK_RATIO = 1.8;
const LONG_REL_MIN = Number(process.env.BACKTEST_LONG_REL_MIN || 0.12);
const LONG_VOL_MAX = Number(process.env.BACKTEST_LONG_VOL_MAX || 2);
const LONG_SCORE_MIN = Number(process.env.BACKTEST_LONG_SCORE_MIN || 85);
const SHORT_MOM_MIN = Number(process.env.BACKTEST_SHORT_MOM_MIN || -0.11);
const SHORT_VOL_MIN = Number(process.env.BACKTEST_SHORT_VOL_MIN || 2.75);
const SHORT_VOL_MAX = Number(process.env.BACKTEST_SHORT_VOL_MAX || 3.5);
const SHORT_SCORE_MIN = Number(process.env.BACKTEST_SHORT_SCORE_MIN || 85);
const EXCLUDED = ["UPUSDT", "DOWNUSDT", "BULLUSDT", "BEARUSDT"];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(...args) {
  if (!QUIET) console.log(...args);
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

async function getJson(path, params = {}) {
  const url = new URL(`${API}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value != null) url.searchParams.set(key, String(value));
  }
  if (DATA_MODE === "powershell" || DATA_MODE === "vision") return getJsonViaPowerShell(url.href);
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url);
    if (res.ok) return res.json();
    if (![418, 429, 500, 502, 503, 504].includes(res.status)) {
      throw new Error(`${res.status} ${await res.text()}`);
    }
    await sleep(1000 * (attempt + 1));
  }
  throw new Error(`failed after retries: ${url}`);
}

function getJsonViaPowerShell(url) {
  const command = [
    "try {",
    "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12;",
    "$ErrorActionPreference='Stop';",
    "$ProgressPreference='SilentlyContinue';",
    `$r = Invoke-RestMethod -Uri '${url.replaceAll("'", "''")}' -Headers @{'User-Agent'='Mozilla/5.0'} -ErrorAction Stop;`,
    "$r | ConvertTo-Json -Depth 10 -Compress",
    "} catch {",
    "Write-Error $_;",
    "exit 1",
    "}"
  ].join(" ");
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const raw = execFileSync("powershell.exe", ["-NoProfile", "-Command", command], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024
      });
      return JSON.parse(raw);
    } catch (error) {
      if (attempt === 3) throw error;
      sleepSync(5000 * (attempt + 1));
    }
  }
}

function parseKline(row) {
  const values = Array.isArray(row) ? row : row?.value;
  return {
    openTime: Number(values?.[0]),
    open: Number(values?.[1]),
    high: Number(values?.[2]),
    low: Number(values?.[3]),
    close: Number(values?.[4]),
    volume: Number(values?.[5]),
    quoteVolume: Number(values?.[7])
  };
}

async function fetchKlines(symbol) {
  if (DATA_MODE === "vision") return fetchVisionKlines(symbol);
  const out = [];
  let startTime = START;
  while (startTime < END) {
    const rows = await getJson("/fapi/v1/klines", {
      symbol,
      interval: "1h",
      startTime,
      endTime: END - 1,
      limit: 1000
    });
    if (!Array.isArray(rows) || rows.length === 0) break;
    out.push(...rows.map(parseKline));
    const lastRow = rows.at(-1);
    const lastValues = Array.isArray(lastRow) ? lastRow : lastRow?.value;
    const next = Number(lastValues?.[0]) + HOUR;
    if (!Number.isFinite(next) || next <= startTime) break;
    startTime = next;
    await sleep(REQUEST_DELAY_MS);
  }
  return out;
}

function monthKeys(start, end) {
  const out = [];
  const cursor = new Date(Date.UTC(new Date(start).getUTCFullYear(), new Date(start).getUTCMonth(), 1));
  const endMonth = new Date(Date.UTC(new Date(end - 1).getUTCFullYear(), new Date(end - 1).getUTCMonth(), 1));
  while (cursor <= endMonth) {
    out.push(`${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, "0")}`);
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return out;
}

function runPowerShell(command) {
  return execFileSync("powershell.exe", ["-NoProfile", "-Command", command], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024
  });
}

async function ensureVisionCsv(symbol, month) {
  const dir = `${VISION_CACHE_DIR}/${symbol}/${month}`;
  const zipPath = `${dir}/${symbol}-1h-${month}.zip`;
  const csvPath = `${dir}/${symbol}-1h-${month}.csv`;
  if (existsSync(csvPath)) return csvPath;
  await mkdir(dir, { recursive: true });
  const url = `https://data.binance.vision/data/futures/um/monthly/klines/${symbol}/1h/${symbol}-1h-${month}.zip`;
  const escapedUrl = url.replaceAll("'", "''");
  const escapedZip = zipPath.replaceAll("'", "''");
  const escapedDir = dir.replaceAll("'", "''");
  const command = [
    "$ErrorActionPreference='Stop';",
    "$ProgressPreference='SilentlyContinue';",
    "try {",
    `Invoke-WebRequest -Uri '${escapedUrl}' -OutFile '${escapedZip}' -UseBasicParsing;`,
    `Expand-Archive -Path '${escapedZip}' -DestinationPath '${escapedDir}' -Force;`,
    "'OK'",
    "} catch {",
    "if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 404) { 'MISSING'; exit 0 }",
    "Write-Error $_; exit 1",
    "}"
  ].join(" ");
  const result = runPowerShell(command).trim();
  if (result.includes("MISSING")) return null;
  return existsSync(csvPath) ? csvPath : null;
}

async function fetchVisionKlines(symbol) {
  const out = [];
  for (const month of monthKeys(START, END)) {
    const csvPath = await ensureVisionCsv(symbol, month);
    if (!csvPath) continue;
    const csv = await readFile(csvPath, "utf8");
    for (const line of csv.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const columns = line.split(",");
      const openTime = Number(columns[0]);
      if (!Number.isFinite(openTime) || openTime < START || openTime >= END) continue;
      out.push(parseKline(columns));
    }
    await sleep(REQUEST_DELAY_MS);
  }
  out.sort((a, b) => a.openTime - b.openTime);
  return out;
}

async function loadOrFetchKlines(symbol) {
  await mkdir(CACHE_DIR, { recursive: true });
  const cachePath = `${CACHE_DIR}/${symbol}-${START}-${END}.json`;
  try {
    const cached = JSON.parse(await readFile(cachePath, "utf8"));
    if (Array.isArray(cached) && cached.length) {
      log(`  cache hit ${symbol}: ${cached.length}`);
      return cached;
    }
  } catch {
    // Cache miss; download below.
  }
  const merged = await loadMergedCachedKlines(symbol);
  if (merged.length) return merged;
  if (CACHE_ONLY) return [];
  const rows = await fetchKlines(symbol);
  await writeFile(cachePath, JSON.stringify(rows));
  return rows;
}

async function loadMergedCachedKlines(symbol) {
  if (!existsSync(CACHE_DIR)) return [];
  const files = readdirSync(CACHE_DIR)
    .filter((name) => name.startsWith(`${symbol}-`) && name.endsWith(".json"));
  const byTime = new Map();
  for (const file of files) {
    try {
      const rows = JSON.parse(await readFile(`${CACHE_DIR}/${file}`, "utf8"));
      for (const row of rows) {
        const candle = parseKline(row);
        if (Number.isFinite(candle.openTime) && candle.openTime >= START && candle.openTime < END) {
          byTime.set(candle.openTime, candle);
        }
      }
    } catch {
      // Ignore corrupt cache shards and fall back to any usable shards.
    }
  }
  return [...byTime.values()].sort((a, b) => a.openTime - b.openTime);
}

function isEligibleSymbol(symbol) {
  return symbol.endsWith("USDT") && !EXCLUDED.some((pattern) => symbol.includes(pattern));
}

function avg(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : null;
}

function trueRange(candle, previous) {
  if (!candle) return null;
  if (!previous) return candle.high - candle.low;
  return Math.max(
    candle.high - candle.low,
    Math.abs(candle.high - previous.close),
    Math.abs(candle.low - previous.close)
  );
}

function atrAt(candles, index, period = 14) {
  if (!Array.isArray(candles) || index <= 0 || index < period) return null;
  const values = [];
  for (let i = index - period + 1; i <= index; i++) {
    const tr = trueRange(candles[i], candles[i - 1]);
    if (!Number.isFinite(tr)) return null;
    values.push(tr);
  }
  return avg(values);
}

function buildFuturesExecutionPlan(candles, index, side) {
  const latest = candles[index];
  const latestAtr = atrAt(candles, index, 14);
  const fallbackStopDistance = latest.close * 0.018;
  const stopDistance = Number.isFinite(latestAtr)
    ? Math.max(latestAtr * FUTURES_STOP_ATR_MULTIPLIER, latest.close * 0.006)
    : fallbackStopDistance;
  const isShort = side === "short";
  const stopLoss = isShort ? latest.close + stopDistance : latest.close - stopDistance;
  const takeProfit = isShort
    ? latest.close - stopDistance * FUTURES_REWARD_RISK_RATIO
    : latest.close + stopDistance * FUTURES_REWARD_RISK_RATIO;
  return {
    entryReference: latest.close,
    stopLoss,
    takeProfit,
    stopPct: Math.abs(stopDistance / latest.close),
    rewardRiskRatio: FUTURES_REWARD_RISK_RATIO
  };
}

function evaluatePlan({ byTime, entryTime, entry, side, plan }) {
  const isShort = side === "short";
  const validUntil = entryTime + VALID_HOURS * HOUR;
  const windowCandles = [];
  for (let time = entryTime + HOUR; time <= validUntil; time += HOUR) {
    const candle = byTime.get(time);
    if (!candle) return null;
    windowCandles.push(candle);
  }
  for (const candle of windowCandles) {
    const hitStop = isShort ? candle.high >= plan.stopLoss : candle.low <= plan.stopLoss;
    const hitTarget = isShort ? candle.low <= plan.takeProfit : candle.high >= plan.takeProfit;
    if (hitStop) {
      const rawReturn = isShort ? -(plan.stopLoss / entry - 1) : plan.stopLoss / entry - 1;
      return {
        exit: plan.stopLoss,
        exitTime: candle.openTime,
        outcome: "stop_loss",
        rawReturn,
        netReturn: rawReturn - COST
      };
    }
    if (hitTarget) {
      const rawReturn = isShort ? -(plan.takeProfit / entry - 1) : plan.takeProfit / entry - 1;
      return {
        exit: plan.takeProfit,
        exitTime: candle.openTime,
        outcome: "take_profit",
        rawReturn,
        netReturn: rawReturn - COST
      };
    }
  }
  const exitCandle = windowCandles.at(-1);
  const rawReturn = isShort ? -(exitCandle.close / entry - 1) : exitCandle.close / entry - 1;
  return {
    exit: exitCandle.close,
    exitTime: exitCandle.openTime,
    outcome: rawReturn >= 0 ? "profit_at_expiry" : "loss_at_expiry",
    rawReturn,
    netReturn: rawReturn - COST
  };
}

function clampScore(value) {
  return Math.max(0, Math.min(100, Math.round(Number.isFinite(value) ? value : 0)));
}

function dynamicLongScore({ momentum24h, relative, volumeMultiple }) {
  const momentumCenter = (0.08 + 0.10) / 2;
  const momentumWidth = 0.10 - 0.08;
  const momentumScore = clampScore(10 - Math.abs(momentum24h - momentumCenter) / momentumWidth * 6);
  const relativeScore = Math.min(4, Math.max(0, Number(relative) * 30));
  const volumeCenter = (1.5 + 2) / 2;
  const volumeWidth = 2 - 1.5;
  const volumeScore = clampScore(5 - Math.abs(volumeMultiple - volumeCenter) / volumeWidth * 4);
  return Math.min(89, clampScore(70 + momentumScore + relativeScore + volumeScore));
}

function dynamicShortScore({ momentum24h, relative, volumeMultiple }) {
  return clampScore(
    Math.min(
      89,
      62 +
        Math.min(12, Math.abs(momentum24h) * 100) +
        Math.min(8, Math.abs(relative) * 100) +
        Math.min(8, (volumeMultiple - 1) * 4)
    )
  );
}

function maxDrawdown(returns) {
  let equity = 1;
  let peak = 1;
  let drawdown = 0;
  for (const ret of returns) {
    equity *= 1 + ret;
    peak = Math.max(peak, equity);
    drawdown = Math.min(drawdown, equity / peak - 1);
  }
  return drawdown;
}

function summarize(trades, { includeByYear = true } = {}) {
  const returns = trades.map((trade) => trade.netReturn);
  const wins = returns.filter((value) => value > 0);
  const losses = returns.filter((value) => value <= 0);
  const grossWin = wins.reduce((sum, value) => sum + value, 0);
  const grossLoss = losses.reduce((sum, value) => sum + value, 0);
  const equity = returns.reduce((value, ret) => value * (1 + ret), 1);
  let byYear = undefined;
  if (includeByYear) {
    byYear = {};
    for (const trade of trades) {
      const year = new Date(trade.entryTime).getUTCFullYear();
      byYear[year] ??= [];
      byYear[year].push(trade);
    }
  }
  return {
    trades: trades.length,
    winRate: trades.length ? wins.length / trades.length : null,
    avgReturn: returns.length ? avg(returns) : null,
    medianReturn: returns.length ? returns.toSorted((a, b) => a - b)[Math.floor(returns.length / 2)] : null,
    totalCompoundedReturn: equity - 1,
    grossReturn: returns.reduce((sum, value) => sum + value, 0),
    profitFactor: grossLoss < 0 ? grossWin / Math.abs(grossLoss) : null,
    maxDrawdown: maxDrawdown(returns),
    best: returns.length ? Math.max(...returns) : null,
    worst: returns.length ? Math.min(...returns) : null,
    byYear: byYear
      ? Object.fromEntries(Object.entries(byYear).map(([year, rows]) => [year, summarize(rows, { includeByYear: false })]))
      : undefined
  };
}

function signalForSymbol(symbol, candles, index, btcCandles, side) {
  const latest = candles[index];
  const prev24 = candles[index - 24];
  const exit = candles[index + HOLD_HOURS];
  if (!latest || !prev24 || !exit) return null;
  const prev = candles.slice(index - 20, index);
  if (prev.length < 20) return null;
  const quoteVolume24h = candles.slice(index - 23, index + 1).reduce((sum, candle) => sum + candle.quoteVolume, 0);
  if (quoteVolume24h < MIN_QUOTE_VOLUME) return null;
  const momentum24h = latest.close / prev24.close - 1;
  const btcMomentum24h = btcCandles?.[index] && btcCandles?.[index - 24]
    ? btcCandles[index].close / btcCandles[index - 24].close - 1
    : 0;
  const relative = momentum24h - btcMomentum24h;
  const volume20 = avg(prev.map((candle) => candle.volume));
  const volumeMultiple = volume20 ? latest.volume / volume20 : null;
  if (!Number.isFinite(volumeMultiple)) return null;

  if (side === "long") {
    const recentHigh = Math.max(...prev.map((candle) => candle.high));
    const breakout = latest.close >= recentHigh * 0.995;
    if (momentum24h < 0.08 || momentum24h > 0.10) return null;
    if (relative < LONG_REL_MIN) return null;
    if (volumeMultiple < 1.5 || volumeMultiple > LONG_VOL_MAX) return null;
    if (!breakout) return null;
    const recommendationScore = dynamicLongScore({ momentum24h, relative, volumeMultiple });
    if (recommendationScore < LONG_SCORE_MIN) return null;
    return {
      symbol,
      side,
      entryTime: latest.openTime,
      entry: latest.close,
      exit: exit.close,
      momentum24h,
      relative,
      volumeMultiple,
      recommendationScore,
      netReturn: exit.close / latest.close - 1 - COST
    };
  }

  const recentLow = Math.min(...prev.map((candle) => candle.low));
  const breakdown = latest.close <= recentLow * 1.005;
  if (momentum24h > -0.08 || momentum24h < SHORT_MOM_MIN) return null;
  if (relative > -0.03) return null;
  if (volumeMultiple < SHORT_VOL_MIN || volumeMultiple > SHORT_VOL_MAX) return null;
  if (!breakdown) return null;
  const recommendationScore = dynamicShortScore({ momentum24h, relative, volumeMultiple });
  if (recommendationScore < SHORT_SCORE_MIN) return null;
  return {
    symbol,
    side,
    entryTime: latest.openTime,
    entry: latest.close,
    exit: exit.close,
    momentum24h,
    relative,
    volumeMultiple,
    netReturn: (exit.close / latest.close - 1) * -1 - COST
  };
}

function signalForSymbolAt(symbol, byTime, time, btcByTime, side) {
  const latest = byTime.get(time);
  const prev24 = byTime.get(time - 24 * HOUR);
  if (!latest || !prev24) return null;
  const prev = [];
  for (let step = 20; step >= 1; step--) {
    const candle = byTime.get(time - step * HOUR);
    if (!candle) return null;
    prev.push(candle);
  }
  const day = [];
  for (let step = 23; step >= 0; step--) {
    const candle = byTime.get(time - step * HOUR);
    if (!candle) return null;
    day.push(candle);
  }
  const quoteVolume24h = day.reduce((sum, candle) => sum + candle.quoteVolume, 0);
  if (quoteVolume24h < MIN_QUOTE_VOLUME) return null;
  const momentum24h = latest.close / prev24.close - 1;
  const btcLatest = btcByTime?.get(time);
  const btcPrev24 = btcByTime?.get(time - 24 * HOUR);
  const btcMomentum24h = btcLatest && btcPrev24 ? btcLatest.close / btcPrev24.close - 1 : 0;
  const relative = momentum24h - btcMomentum24h;
  const volume20 = avg(prev.map((candle) => candle.volume));
  const volumeMultiple = volume20 ? latest.volume / volume20 : null;
  if (!Number.isFinite(volumeMultiple)) return null;

  if (side === "long") {
    const recentHigh = Math.max(...prev.map((candle) => candle.high));
    const breakout = latest.close >= recentHigh * 0.995;
    if (momentum24h < 0.08 || momentum24h > 0.10) return null;
    if (relative < LONG_REL_MIN) return null;
    if (volumeMultiple < 1.5 || volumeMultiple > LONG_VOL_MAX) return null;
    if (!breakout) return null;
    const recommendationScore = dynamicLongScore({ momentum24h, relative, volumeMultiple });
    if (recommendationScore < LONG_SCORE_MIN) return null;
    const candles = [];
    for (let step = 40; step >= 0; step--) {
      const candle = byTime.get(time - step * HOUR);
      if (!candle) return null;
      candles.push(candle);
    }
    const plan = buildFuturesExecutionPlan(candles, candles.length - 1, side);
    const result = evaluatePlan({ byTime, entryTime: latest.openTime, entry: latest.close, side, plan });
    if (!result) return null;
    return {
      symbol,
      side,
      entryTime: latest.openTime,
      entry: latest.close,
      exit: result.exit,
      exitTime: result.exitTime,
      outcome: result.outcome,
      momentum24h,
      relative,
      volumeMultiple,
      recommendationScore,
      executionPlan: plan,
      rawReturn: result.rawReturn,
      netReturn: result.netReturn
    };
  }

  const recentLow = Math.min(...prev.map((candle) => candle.low));
  const breakdown = latest.close <= recentLow * 1.005;
  if (momentum24h > -0.08 || momentum24h < SHORT_MOM_MIN) return null;
  if (relative > -0.03) return null;
  if (volumeMultiple < SHORT_VOL_MIN || volumeMultiple > SHORT_VOL_MAX) return null;
  if (!breakdown) return null;
  const recommendationScore = dynamicShortScore({ momentum24h, relative, volumeMultiple });
  if (recommendationScore < SHORT_SCORE_MIN) return null;
  const candles = [];
  for (let step = 40; step >= 0; step--) {
    const candle = byTime.get(time - step * HOUR);
    if (!candle) return null;
    candles.push(candle);
  }
  const plan = buildFuturesExecutionPlan(candles, candles.length - 1, side);
  const result = evaluatePlan({ byTime, entryTime: latest.openTime, entry: latest.close, side, plan });
  if (!result) return null;
  return {
    symbol,
    side,
    entryTime: latest.openTime,
    entry: latest.close,
    exit: result.exit,
    exitTime: result.exitTime,
    outcome: result.outcome,
    momentum24h,
    relative,
    volumeMultiple,
    recommendationScore,
    executionPlan: plan,
    rawReturn: result.rawReturn,
    netReturn: result.netReturn
  };
}

function runBacktest(data, symbols) {
  const bySymbolTime = new Map();
  for (const symbol of symbols) {
    bySymbolTime.set(symbol, new Map((data[symbol] || []).map((candle) => [candle.openTime, candle])));
  }
  const btcByTime = bySymbolTime.get("BTCUSDT");
  const lastAlert = new Map();
  const trades = [];
  let candidateSignals = 0;
  let emailBatches = 0;
  for (let time = START + 50 * HOUR; time < END - HOLD_HOURS * HOUR; time += HOUR) {
    const candidates = STRICT_DYNAMIC_POOL ? selectHistoricalDynamicPools(symbols, bySymbolTime, time) : {
      longSymbols: symbols,
      shortSymbols: symbols
    };
    const longs = [];
    const shorts = [];
    for (const symbol of candidates.longSymbols) {
      const byTime = bySymbolTime.get(symbol);
      if (!byTime) continue;
      const long = signalForSymbolAt(symbol, byTime, time, btcByTime, "long");
      if (long) longs.push(long);
    }
    for (const symbol of candidates.shortSymbols) {
      const byTime = bySymbolTime.get(symbol);
      if (!byTime) continue;
      const short = signalForSymbolAt(symbol, byTime, time, btcByTime, "short");
      if (short) shorts.push(short);
    }
    const cooledLongs = [];
    const cooledShorts = [];
    for (const trade of longs) {
      const key = `${trade.symbol}:long`;
      const previous = lastAlert.get(key);
      if (previous != null && trade.entryTime - previous < COOLDOWN_HOURS * HOUR) continue;
      cooledLongs.push(trade);
    }
    for (const trade of shorts) {
      const key = `${trade.symbol}:short`;
      const previous = lastAlert.get(key);
      if (previous != null && trade.entryTime - previous < COOLDOWN_HOURS * HOUR) continue;
      cooledShorts.push(trade);
    }

    candidateSignals += cooledLongs.length + cooledShorts.length;
    const sentSignals = [...cooledLongs, ...cooledShorts]
      .sort((a, b) => b.recommendationScore - a.recommendationScore)
      .slice(0, MAX_SIGNALS_PER_EMAIL);
    if (sentSignals.length) emailBatches += 1;

    for (const trade of sentSignals) {
      const key = `${trade.symbol}:${trade.side}`;
      lastAlert.set(key, trade.entryTime);
      trades.push(trade);
    }
  }
  return { trades, candidateSignals, emailBatches };
}

function selectHistoricalDynamicPools(symbols, bySymbolTime, time) {
  const tickers = [];
  for (const symbol of symbols) {
    if (!isEligibleSymbol(symbol)) continue;
    const byTime = bySymbolTime.get(symbol);
    const latest = byTime?.get(time);
    const prev24 = byTime?.get(time - 24 * HOUR);
    if (!latest || !prev24) continue;
    const day = [];
    for (let step = 23; step >= 0; step--) {
      const candle = byTime.get(time - step * HOUR);
      if (!candle) break;
      day.push(candle);
    }
    if (day.length < 24) continue;
    tickers.push({
      symbol,
      priceChangePercent: (latest.close / prev24.close - 1) * 100,
      quoteVolume: day.reduce((sum, candle) => sum + candle.quoteVolume, 0)
    });
  }

  const longSymbols = tickers
    .filter((ticker) =>
      ticker.priceChangePercent >= 8 &&
      ticker.priceChangePercent <= 10 &&
      ticker.quoteVolume >= MIN_QUOTE_VOLUME
    )
    .sort((a, b) => dynamicTickerScore(b) - dynamicTickerScore(a))
    .slice(0, MAX_ASSETS_PER_SIDE)
    .map((ticker) => ticker.symbol);

  const existing = new Set(longSymbols);
  const shortSymbols = tickers
    .filter((ticker) =>
      !existing.has(ticker.symbol) &&
      ticker.priceChangePercent <= -8 &&
      ticker.priceChangePercent >= SHORT_MOM_MIN * 100 &&
      ticker.quoteVolume >= MIN_QUOTE_VOLUME
    )
    .sort((a, b) => Math.abs(dynamicTickerScore(b)) - Math.abs(dynamicTickerScore(a)))
    .slice(0, MAX_ASSETS_PER_SIDE)
    .map((ticker) => ticker.symbol);

  return { longSymbols, shortSymbols };
}

function dynamicTickerScore(ticker) {
  return ticker.priceChangePercent * Math.log10(Math.max(10, ticker.quoteVolume));
}

async function main() {
  let symbols = SYMBOLS;
  if (!symbols.length) {
    const exchange = await getJson("/fapi/v1/exchangeInfo");
    const currentPerps = new Set(exchange.symbols
      .filter((item) => item.status === "TRADING" && item.contractType === "PERPETUAL" && item.quoteAsset === "USDT")
      .map((item) => item.symbol)
      .filter(isEligibleSymbol));
    if (STRICT_DYNAMIC_POOL) {
      symbols = [...currentPerps].sort();
    } else {
      const tickers = await getJson("/fapi/v1/ticker/24hr");
      symbols = tickers
        .filter((ticker) => currentPerps.has(ticker.symbol))
        .sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume))
        .slice(0, TOP_N)
        .map((ticker) => ticker.symbol);
    }
  }
  if (!symbols.includes("BTCUSDT")) symbols.unshift("BTCUSDT");

  const data = {};
  let nextSymbolIndex = 0;
  const workers = Array.from({ length: Math.min(FETCH_CONCURRENCY, symbols.length) }, async () => {
    while (nextSymbolIndex < symbols.length) {
      const i = nextSymbolIndex++;
      const symbol = symbols[i];
      log(`[${i + 1}/${symbols.length}] fetching ${symbol}`);
      data[symbol] = await loadOrFetchKlines(symbol);
      await sleep(REQUEST_DELAY_MS);
    }
  });
  await Promise.all(workers);
  const usableSymbols = symbols.filter((symbol) => (data[symbol]?.length || 0) >= 500);
  const backtest = runBacktest(data, usableSymbols);
  const { trades } = backtest;
  const result = {
    generatedAt: new Date().toISOString(),
    source: "Binance USD-M futures /fapi/v1/klines 1h",
    start: new Date(START).toISOString(),
    end: new Date(END).toISOString(),
    assumptions: {
      universe: `top ${TOP_N} current-volume USDT perpetual COIN contracts; delisted and low-current-volume symbols excluded`,
      strictDynamicPool: STRICT_DYNAMIC_POOL,
      dynamicPool: STRICT_DYNAMIC_POOL
        ? "At each historical hour, rebuild production-style long/short pools from all current Binance USDT perpetual symbols, score by 24h percent move * log10(24h quote volume), then take top 10 per side before signal quality filters."
        : undefined,
      cadence: "hourly closed candles approximate the 30-minute production cron",
      entry: "close of the triggering closed 1h candle",
      exit: `${HOLD_HOURS} hours later close`,
      tradingCostRoundTrip: COST,
      maxSignalsPerSidePerHour: MAX_ASSETS_PER_SIDE,
      maxSignalsPerEmail: MAX_SIGNALS_PER_EMAIL,
      perSymbolSideCooldownHours: COOLDOWN_HOURS
    },
    candidateSignalsBeforeEmailCap: backtest.candidateSignals,
    estimatedEmailBatches: backtest.emailBatches,
    symbols: usableSymbols,
    summary: summarize(trades),
    long: summarize(trades.filter((trade) => trade.side === "long")),
    short: summarize(trades.filter((trade) => trade.side === "short")),
    topSymbols: Object.entries(Object.groupBy(trades, (trade) => trade.symbol))
      .map(([symbol, rows]) => ({ symbol, ...summarize(rows, { includeByYear: false }) }))
      .sort((a, b) => b.grossReturn - a.grossReturn)
      .slice(0, 20),
    worstSymbols: Object.entries(Object.groupBy(trades, (trade) => trade.symbol))
      .map(([symbol, rows]) => ({ symbol, ...summarize(rows, { includeByYear: false }) }))
      .sort((a, b) => a.grossReturn - b.grossReturn)
      .slice(0, 20),
    trades: trades.map((trade) => ({ ...trade, time: new Date(trade.entryTime).toISOString() }))
  };
  await writeFile(OUTPUT_FILE, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({
    symbols: usableSymbols.length,
    trades: trades.length,
    summary: result.summary,
    long: result.long,
    short: result.short
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
