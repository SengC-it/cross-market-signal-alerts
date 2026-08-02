import { readFile, writeFile } from "node:fs/promises";

const OUTPUT_FILE = process.env.POLICY_SEARCH_OUTPUT || "tiered_policy_search_2026-08-01.json";
const SPLIT_TIME = Date.parse("2025-01-01T00:00:00Z");
const REQUIRE_PASS = process.env.POLICY_REQUIRE_PASS === "1";

function load(file) {
  return readFile(file, "utf8").then((raw) => JSON.parse(raw).trades || []);
}

function pass(trade, cfg) {
  if (trade.side === "long") {
    return trade.momentum24h >= 0.08
      && trade.momentum24h <= 0.10
      && trade.relative >= cfg.longRelMin
      && trade.volumeMultiple >= 1.5
      && trade.volumeMultiple <= cfg.longVolMax;
  }
  return trade.momentum24h >= cfg.shortMomMin
    && trade.momentum24h <= -0.08
    && trade.relative <= cfg.shortRelMax
    && trade.volumeMultiple >= cfg.shortVolMin
    && trade.volumeMultiple <= cfg.shortVolMax;
}

function summary(trades) {
  const returns = trades.map((trade) => Number(trade.netReturn)).filter(Number.isFinite);
  const gains = returns.filter((value) => value > 0);
  const losses = returns.filter((value) => value <= 0);
  return {
    signals: returns.length,
    winRate: returns.length ? gains.length / returns.length : null,
    averageNetReturn: returns.length ? returns.reduce((sum, value) => sum + value, 0) / returns.length : null,
    profitFactor: losses.length
      ? gains.reduce((sum, value) => sum + value, 0) / Math.abs(losses.reduce((sum, value) => sum + value, 0))
      : null
  };
}

const [longHistory, productionLike] = await Promise.all([
  load("production_dynamic_backtest.json"),
  load("production_dynamic_email_backtest_latest_tp_sl_only_2026-01_06.json")
]);

const configs = [];
for (const longRelMin of [0.08, 0.10, 0.12, 0.14, 0.16]) {
  for (const longVolMax of [1.8, 2, 2.2, 2.5]) {
    for (const shortMomMin of [-0.13, -0.12, -0.11, -0.10]) {
      for (const shortRelMax of [-0.05, -0.03, -0.01]) {
        for (const shortVolMin of [2.5, 2.75, 3, 3.25]) {
          for (const shortVolMax of [3.25, 3.5, 4]) {
            configs.push({ longRelMin, longVolMax, shortMomMin, shortRelMax, shortVolMin, shortVolMax });
          }
        }
      }
    }
  }
}

const rows = configs.map((config) => {
  const history = longHistory.filter((trade) => pass(trade, config));
  const historyTrain = history.filter((trade) => trade.entryTime < SPLIT_TIME);
  const historyHoldout = history.filter((trade) => trade.entryTime >= SPLIT_TIME);
  const production = productionLike.filter((trade) => pass(trade, config));
  const productionQ2 = production.filter((trade) => new Date(trade.entryTime).getUTCMonth() >= 3);
  const train = summary(historyTrain);
  const holdout = summary(historyHoldout);
  const productionSummary = summary(production);
  const productionQ2Summary = summary(productionQ2);
  const checks = {
    historyTrainSignals: train.signals >= 40,
    historyHoldoutSignals: holdout.signals >= 30,
    productionSignals: productionSummary.signals >= 100,
    historyTrainPositive: train.averageNetReturn > 0 && train.profitFactor > 1,
    holdoutPositive: holdout.averageNetReturn > 0 && holdout.profitFactor > 1,
    productionPositive: productionSummary.averageNetReturn > 0 && productionSummary.profitFactor > 1,
    productionQ2Positive: productionQ2Summary.signals >= 30
      && productionQ2Summary.averageNetReturn > 0
      && productionQ2Summary.profitFactor > 1
  };
  const passedChecks = Object.values(checks).filter(Boolean).length;
  const score = passedChecks * 10
    + Math.min(20, (holdout.profitFactor || 0) * 5)
    + Math.min(20, (productionSummary.profitFactor || 0) * 5)
    + Math.min(10, productionSummary.signals / 20);
  return { config, historyTrain: train, historyHoldout: holdout, production: productionSummary, productionQ2: productionQ2Summary, checks, passedChecks, score };
}).sort((a, b) => b.score - a.score);

const result = {
  generatedAt: new Date().toISOString(),
  purpose: "Search a fixed signal policy across long history and 2026 production-like data; this is a research filter, not a deployment approval.",
  split: "2025-01-01",
  candidates: rows.slice(0, 20),
  passingCandidates: rows.filter((row) => Object.values(row.checks).every(Boolean)).slice(0, 20)
};

await writeFile(OUTPUT_FILE, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
if (REQUIRE_PASS && !result.passingCandidates.length) process.exitCode = 1;
