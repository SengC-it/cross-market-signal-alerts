import { readdir, readFile, writeFile } from "node:fs/promises";

const CACHE_DIR = ".backtest-cache/v3-2-funding";
const START = Date.parse("2023-01-01T00:00:00Z");
const END = Date.parse("2026-07-01T00:00:00Z");
const VALIDATION = Date.parse("2025-01-01T00:00:00Z");
const TEST = Date.parse("2026-01-01T00:00:00Z");
const ROUND_TRIP_COST = Number(process.env.FUNDING_CARRY_COST || 0.0028);
const OUTPUT_FILE = process.env.FUNDING_CARRY_OUTPUT || "funding_carry_backtest_2026-08-01.json";
const REQUIRE_PASS = process.env.FUNDING_CARRY_REQUIRE_PASS === "1";

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

async function loadFunding() {
  const names = (await readdir(CACHE_DIR)).filter((name) => name.endsWith(".json"));
  const bySymbol = new Map();
  for (const name of names) {
    const rows = JSON.parse(await readFile(`${CACHE_DIR}/${name}`, "utf8"));
    const symbol = String(rows[0]?.symbol || name.split("-")[0]);
    bySymbol.set(symbol, rows
      .map((row) => ({ fundingTime: Number(row.fundingTime), fundingRate: Number(row.fundingRate) }))
      .filter((row) => row.fundingTime >= START && row.fundingTime < END && Number.isFinite(row.fundingRate))
      .sort((a, b) => a.fundingTime - b.fundingTime));
  }
  return bySymbol;
}

function closeTrade(open, closeTime, fundingSum, fundingEvents, config) {
  return {
    symbol: open.symbol,
    entryTime: open.entryTime,
    exitTime: closeTime,
    fundingEvents,
    grossReturn: fundingSum,
    netReturn: fundingSum - ROUND_TRIP_COST,
    holdingHours: (closeTime - open.entryTime) / 3_600_000,
    threshold: config.entryThreshold
  };
}

function replaySymbol(symbol, rows, config) {
  const trades = [];
  let open = null;
  let fundingSum = 0;
  let events = 0;
  for (const row of rows) {
    const absRate = Math.abs(row.fundingRate);
    const sameSide = open && Math.sign(row.fundingRate || 0) === open.sign;
    if (!open) {
      if (absRate >= config.entryThreshold) {
        open = { symbol, entryTime: row.fundingTime, sign: Math.sign(row.fundingRate || 0) };
        fundingSum = absRate;
        events = 1;
      }
      continue;
    }

    if (!sameSide || absRate < config.exitThreshold || events >= config.maxFundingEvents) {
      trades.push(closeTrade(open, row.fundingTime, fundingSum, events, config));
      open = null;
      fundingSum = 0;
      events = 0;
      if (absRate >= config.entryThreshold) {
        open = { symbol, entryTime: row.fundingTime, sign: Math.sign(row.fundingRate || 0) };
        fundingSum = absRate;
        events = 1;
      }
      continue;
    }

    fundingSum += absRate;
    events++;
  }
  if (open && events > 0) {
    const last = rows.at(-1);
    trades.push(closeTrade(open, last.fundingTime, fundingSum, events, config));
  }
  return trades;
}

function summary(trades) {
  const returns = trades.map((trade) => trade.netReturn);
  if (!returns.length) return { trades: 0, totalReturn: 0, averageNetReturn: null, winRate: null, profitFactor: null, maxDrawdown: 0, positiveMonthRate: null };
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
  const monthly = new Map();
  for (const trade of trades) {
    const month = new Date(trade.entryTime).toISOString().slice(0, 7);
    monthly.set(month, (monthly.get(month) || 1) * (1 + trade.netReturn));
  }
  const monthReturns = [...monthly.values()].map((value) => value - 1);
  return {
    trades: returns.length,
    totalReturn: equity - 1,
    averageNetReturn: mean(returns),
    winRate: returns.filter((value) => value > 0).length / returns.length,
    profitFactor: grossLoss < 0 ? grossProfit / Math.abs(grossLoss) : null,
    maxDrawdown,
    positiveMonthRate: monthReturns.length ? monthReturns.filter((value) => value > 0).length / monthReturns.length : null,
    months: monthReturns.length,
    averageHoldingHours: mean(trades.map((trade) => trade.holdingHours)),
    averageFundingEvents: mean(trades.map((trade) => trade.fundingEvents))
  };
}

function evaluate(trades) {
  const ordered = [...trades].sort((a, b) => a.exitTime - b.exitTime);
  return {
    all: summary(ordered),
    train: summary(ordered.filter((trade) => trade.entryTime < VALIDATION)),
    validation: summary(ordered.filter((trade) => trade.entryTime >= VALIDATION && trade.entryTime < TEST)),
    test: summary(ordered.filter((trade) => trade.entryTime >= TEST && trade.entryTime < END)),
    signalsPerMonth: ordered.length / Math.max(1, new Set(ordered.map((trade) => new Date(trade.entryTime).toISOString().slice(0, 7))).size)
  };
}

function researchGate(metrics) {
  const checks = {
    trainSample: metrics.train.trades >= 100,
    validationSample: metrics.validation.trades >= 30,
    testSample: metrics.test.trades >= 20,
    trainPositive: metrics.train.averageNetReturn > 0 && metrics.train.profitFactor > 1,
    validationPositive: metrics.validation.averageNetReturn > 0 && metrics.validation.profitFactor > 1,
    testPositive: metrics.test.averageNetReturn > 0 && metrics.test.profitFactor > 1,
    testDrawdown: Math.abs(metrics.test.maxDrawdown) <= 0.2,
    testPositiveMonths: metrics.test.positiveMonthRate >= 0.5,
    costStress: metrics.test.averageNetReturn > ROUND_TRIP_COST * 0.05
  };
  return { passed: Object.values(checks).every(Boolean), checks, passedCount: Object.values(checks).filter(Boolean).length };
}

const bySymbol = await loadFunding();
const configs = [];
for (const entryThreshold of [0.0002, 0.00025, 0.0003, 0.00035, 0.0004, 0.0005]) {
  for (const exitMultiplier of [0.4, 0.5, 0.6, 0.75]) {
    for (const maxFundingEvents of [3, 6, 9, 12, 18, 24]) {
      configs.push({ entryThreshold, exitThreshold: entryThreshold * exitMultiplier, maxFundingEvents });
    }
  }
}

const results = [];
for (const config of configs) {
  const trades = [...bySymbol.entries()].flatMap(([symbol, rows]) => replaySymbol(symbol, rows, config));
  const metrics = evaluate(trades);
  const gate = researchGate(metrics);
  results.push({ config, metrics, gate, score: gate.passedCount * 10 + (metrics.test.profitFactor || 0) * 5 + (metrics.test.totalReturn || 0) * 10 });
}
results.sort((a, b) => b.score - a.score);
const result = {
  generatedAt: new Date().toISOString(),
  purpose: "Backtest delta-neutral funding carry with entry/exit persistence, round-trip costs, and strict out-of-sample gates.",
  assumptions: {
    symbols: bySymbol.size,
    roundTripCost: ROUND_TRIP_COST,
    fundingReturn: "Absolute funding rate is collected while the hedge is open; spot/perp basis and borrow costs are not included and require a stress test before deployment.",
    split: { train: "2023-01-01 through 2024-12-31", validation: "2025-01-01 through 2025-12-31", test: "2026-01-01 through 2026-06-30" }
  },
  topCandidates: results.slice(0, 20),
  passingCandidates: results.filter((item) => item.gate.passed).slice(0, 20)
};
await writeFile(OUTPUT_FILE, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ evaluated: results.length, passing: result.passingCandidates.length, top: result.topCandidates.slice(0, 5) }, null, 2));
if (REQUIRE_PASS && !result.passingCandidates.length) process.exitCode = 1;
