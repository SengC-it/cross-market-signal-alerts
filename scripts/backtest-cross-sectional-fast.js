import { readdir, readFile, writeFile } from "node:fs/promises";

const CACHE_DIR = ".backtest-cache/binance-futures-1h";
const HOUR = 3_600_000;
const BAR = 4 * HOUR;
const START = Date.parse("2023-01-01T00:00:00Z");
const END = Date.parse("2026-07-01T00:00:00Z");
const SPLIT_VALIDATION = Date.parse("2025-01-01T00:00:00Z");
const SPLIT_TEST = Date.parse("2026-01-01T00:00:00Z");
const COST = Number(process.env.CROSS_SECTIONAL_COST || 0.0012);
const STOP_LOSS = Number(process.env.CROSS_SECTIONAL_STOP_LOSS || 0.08);
const MAX_WIN = Number(process.env.CROSS_SECTIONAL_MAX_WIN || 0.25);
const TARGET_ANNUAL_VOL = Number(process.env.CROSS_SECTIONAL_TARGET_VOL || 0.15);
const MIN_GROSS_EXPOSURE = Number(process.env.CROSS_SECTIONAL_MIN_GROSS || 0.25);
const MAX_GROSS_EXPOSURE = Number(process.env.CROSS_SECTIONAL_MAX_GROSS || 1.25);
const VOL_LOOKBACK_PERIODS = Number(process.env.CROSS_SECTIONAL_VOL_LOOKBACK || 30);
const OUTPUT_FILE = process.env.CROSS_SECTIONAL_OUTPUT || "cross_sectional_fast_backtest_2026-08-01.json";
const REQUIRE_PASS = process.env.CROSS_SECTIONAL_REQUIRE_PASS === "1";

function numberList(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  return raw.split(",").map((value) => Number(value.trim())).filter(Number.isFinite);
}

function stringList(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  return raw.split(",").map((value) => value.trim()).filter(Boolean);
}

const UNIVERSE = [
  "BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT", "ADAUSDT",
  "AVAXUSDT", "LINKUSDT", "LTCUSDT", "BCHUSDT", "TRXUSDT", "SUIUSDT", "INJUSDT",
  "NEARUSDT", "APTUSDT", "DOTUSDT", "UNIUSDT", "AAVEUSDT", "FILUSDT"
];

async function loadSeries(symbol) {
  const names = (await readdir(CACHE_DIR)).filter((name) => name.startsWith(`${symbol}-`) && name.endsWith(".json"));
  const byTime = new Map();
  for (const name of names) {
    const rows = JSON.parse(await readFile(`${CACHE_DIR}/${name}`, "utf8"));
    for (const row of rows) {
      const values = Array.isArray(row) ? row : null;
      const openTime = Number(values?.[0] ?? row.openTime);
      const close = Number(values?.[4] ?? row.close);
      if (Number.isFinite(openTime) && Number.isFinite(close)) byTime.set(openTime, close);
    }
  }
  return byTime;
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function periodMetrics(periods) {
  const returns = periods.map((period) => period.return).filter(Number.isFinite);
  if (!returns.length) {
    return { observations: 0, totalReturn: 0, averageNetReturn: null, winRate: null, profitFactor: null, sharpe: null, maxDrawdown: 0, positiveMonthRate: null };
  }
  let equity = 1;
  let peak = 1;
  let maxDrawdown = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  for (const value of returns) {
    equity *= 1 + value;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.min(maxDrawdown, equity / peak - 1);
    if (value > 0) grossProfit += value;
    else grossLoss += value;
  }
  const averageNetReturn = mean(returns);
  const variance = returns.length > 1
    ? returns.reduce((sum, value) => sum + (value - averageNetReturn) ** 2, 0) / (returns.length - 1)
    : 0;
  const monthly = new Map();
  for (const period of periods) {
    const month = new Date(period.time).toISOString().slice(0, 7);
    monthly.set(month, (monthly.get(month) || 1) * (1 + period.return));
  }
  const monthReturns = [...monthly.values()].map((value) => value - 1);
  return {
    observations: returns.length,
    totalReturn: equity - 1,
    averageNetReturn,
    winRate: returns.filter((value) => value > 0).length / returns.length,
    profitFactor: grossLoss < 0 ? grossProfit / Math.abs(grossLoss) : null,
    sharpe: variance > 0 ? averageNetReturn / Math.sqrt(variance) * Math.sqrt(returns.length) : null,
    maxDrawdown,
    positiveMonthRate: monthReturns.length ? monthReturns.filter((value) => value > 0).length / monthReturns.length : null,
    months: monthReturns.length,
    averageExposure: periods.length ? mean(periods.map((period) => period.exposure ?? 1)) : null
  };
}

function applyRiskOverlay(periods, rebalanceHours) {
  const periodsPerYear = (365 * 24) / rebalanceHours;
  return periods.map((period, index) => {
    const history = periods
      .slice(Math.max(0, index - VOL_LOOKBACK_PERIODS), index)
      .map((item) => item.return)
      .filter(Number.isFinite);
    const average = mean(history);
    const variance = history.length > 1
      ? history.reduce((sum, value) => sum + (value - average) ** 2, 0) / (history.length - 1)
      : 0;
    const annualVol = Math.sqrt(variance) * Math.sqrt(periodsPerYear);
    const exposure = Number.isFinite(annualVol) && annualVol > 0
      ? Math.max(MIN_GROSS_EXPOSURE, Math.min(MAX_GROSS_EXPOSURE, TARGET_ANNUAL_VOL / annualVol))
      : 1;
    return { ...period, exposure, return: period.return * exposure };
  });
}

function choosePositions(series, time, config, times) {
  const entryTime = time - config.skipHours * HOUR;
  const lookbackTime = time - config.lookbackHours * HOUR;
  const exitTime = time + config.rebalanceHours * HOUR;
  if (!times.has(entryTime) || !times.has(lookbackTime) || !times.has(exitTime)) return [];
  const ranked = [];
  for (const symbol of UNIVERSE) {
    const values = series.get(symbol);
    const entry = values?.get(entryTime);
    const lookback = values?.get(lookbackTime);
    const exit = values?.get(exitTime);
    if (![entry, lookback, exit].every(Number.isFinite) || entry <= 0 || lookback <= 0 || exit <= 0) continue;
    ranked.push({ symbol, momentum: entry / lookback - 1, entry, exit });
  }
  if (ranked.length < config.positionsPerSide * (config.direction === "both" ? 2 : 1)) return [];
  ranked.sort((a, b) => b.momentum - a.momentum);
  const selected = [];
  if (config.direction !== "short") {
    for (const item of ranked.slice(0, config.positionsPerSide)) {
      selected.push({
        ...item,
        side: "long",
        return: Math.max(-STOP_LOSS, Math.min(MAX_WIN, item.exit / item.entry - 1 - COST))
      });
    }
  }
  if (config.direction !== "long") {
    for (const item of ranked.slice(-config.positionsPerSide)) {
      selected.push({
        ...item,
        side: "short",
        return: Math.max(-STOP_LOSS, Math.min(MAX_WIN, item.entry / item.exit - 1 - COST))
      });
    }
  }
  return selected;
}

function evaluate(series, times, config) {
  const periods = [];
  const timeSet = new Set(times);
  for (const time of times) {
    if (time < START + (config.lookbackHours + config.skipHours) * HOUR || time + config.rebalanceHours * HOUR >= END) continue;
    const positions = choosePositions(series, time, config, timeSet);
    if (!positions.length) continue;
    periods.push({
      time,
      return: positions.reduce((sum, position) => sum + position.return, 0) / positions.length,
      positions: positions.length
    });
  }
  const managedPeriods = applyRiskOverlay(periods, config.rebalanceHours);
  const split = (from, to) => managedPeriods.filter((period) => period.time >= from && period.time < to);
  return {
    all: periodMetrics(managedPeriods),
    train: periodMetrics(split(START, SPLIT_VALIDATION)),
    validation: periodMetrics(split(SPLIT_VALIDATION, SPLIT_TEST)),
    test: periodMetrics(split(SPLIT_TEST, END)),
    averagePositions: mean(managedPeriods.map((period) => period.positions)),
    signalObservationsPerMonth: managedPeriods.length / Math.max(1, new Set(managedPeriods.map((period) => new Date(period.time).toISOString().slice(0, 7))).size)
  };
}

function passesResearchGate(metrics) {
  const checks = {
    trainSample: metrics.train.observations >= 100,
    validationSample: metrics.validation.observations >= 40,
    testSample: metrics.test.observations >= 20,
    trainPositive: metrics.train.totalReturn > 0 && metrics.train.profitFactor > 1,
    validationPositive: metrics.validation.totalReturn > 0 && metrics.validation.profitFactor > 1,
    testPositive: metrics.test.totalReturn > 0 && metrics.test.profitFactor > 1,
    testDrawdown: Math.abs(metrics.test.maxDrawdown) <= 0.25,
    testPositiveMonths: metrics.test.positiveMonthRate >= 0.5
  };
  return { passed: Object.values(checks).every(Boolean), checks, passedCount: Object.values(checks).filter(Boolean).length };
}

const seriesEntries = await Promise.all(UNIVERSE.map(async (symbol) => [symbol, await loadSeries(symbol)]));
const series = new Map(seriesEntries);
const btc = series.get("BTCUSDT");
const times = new Set([...btc.keys()].filter((time) => time % BAR === 0));
const sortedTimes = [...times].sort((a, b) => a - b);

const configs = [];
for (const lookbackHours of numberList("CROSS_SECTIONAL_LOOKBACKS", [24, 48, 72, 120, 168, 240, 360, 720])) {
  for (const skipHours of numberList("CROSS_SECTIONAL_SKIPS", [0, 4, 8, 12, 24])) {
    for (const rebalanceHours of numberList("CROSS_SECTIONAL_REBALANCES", [24, 48, 72, 168])) {
      for (const positionsPerSide of numberList("CROSS_SECTIONAL_POSITIONS", [1, 2, 3])) {
        for (const direction of stringList("CROSS_SECTIONAL_DIRECTIONS", ["both", "short", "long"])) {
          configs.push({ lookbackHours, skipHours, rebalanceHours, positionsPerSide, direction });
        }
      }
    }
  }
}

const results = [];
for (const config of configs) {
  const metrics = evaluate(series, sortedTimes, config);
  const researchGate = passesResearchGate(metrics);
  results.push({ config, metrics, researchGate, score: (researchGate.passedCount * 10) + (metrics.test.profitFactor || 0) * 5 + (metrics.test.totalReturn || 0) * 10 });
}
results.sort((a, b) => b.score - a.score);
const result = {
  generatedAt: new Date().toISOString(),
  purpose: "Search a higher-frequency cross-sectional momentum model with strict train/validation/test gates.",
  assumptions: {
    universe: UNIVERSE,
    barHours: 4,
    costRoundTrip: COST,
    funding: "Not modeled; deployment requires an additional funding/slippage stress test.",
    positionWeight: "Equal weight within selected long/short legs; no leverage beyond 1x gross.",
    sampleSplits: { train: "2023-01-01 through 2024-12-31", validation: "2025-01-01 through 2025-12-31", test: "2026-01-01 through 2026-06-30" }
  },
  topCandidates: results.slice(0, 20),
  passingCandidates: results.filter((item) => item.researchGate.passed).slice(0, 20)
};
await writeFile(OUTPUT_FILE, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({
  generatedAt: result.generatedAt,
  evaluated: results.length,
  passing: result.passingCandidates.length,
  top: result.topCandidates.slice(0, 5)
}, null, 2));
if (REQUIRE_PASS && !result.passingCandidates.length) process.exitCode = 1;
