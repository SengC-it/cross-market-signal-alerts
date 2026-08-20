import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { FUTURES_STRATEGIES } from "../lib/strategies.js";
import { runM3UniverseValidation } from "../lib/validation/validation-engine.js";

function main() {
  const inputPath = argumentValue("--input") || process.env.M3_VALIDATION_INPUT;
  if (!inputPath) {
    return failClosed("M3_VALIDATION_DATA_REQUIRED");
  }

  let input;
  try {
    input = JSON.parse(readFileSync(resolve(inputPath), "utf8"));
  } catch (error) {
    return failClosed("M3_VALIDATION_DATA_REQUIRED: " + error.message);
  }

  const datasets = Array.isArray(input?.datasets)
    ? input.datasets
    : input && typeof input === "object"
      ? [input]
      : [];
  const validationError = validateDatasets(datasets);
  if (validationError) return failClosed(validationError);

  const strategyId = argumentValue("--strategy") || input.strategyId;
  if (!strategyId) return failClosed("M3_VALIDATION_STRATEGY_REQUIRED");
  const strategy = FUTURES_STRATEGIES.find((candidate) => candidate.id === strategyId);
  if (!strategy) return failClosed("M3_VALIDATION_STRATEGY_NOT_FOUND: " + strategyId);

  let result;
  try {
    result = runM3UniverseValidation({
      datasets: datasets.map(normalizeDataset),
      strategy,
      interval: input.interval || datasets[0]?.interval || "1h",
      holdoutPct: input.holdoutPct ?? 0.2,
      folds: input.folds ?? 5
    });
  } catch (error) {
    return failClosed(error.message || "M3_VALIDATION_FAILED");
  }

  console.log(JSON.stringify({
    dataSource: input.dataSource || resolve(inputPath),
    strategyId: strategy.id,
    assets: result.assets,
    developmentStart: result.development.start,
    developmentEnd: result.development.end,
    holdoutStart: result.holdout.start,
    holdoutEnd: result.holdout.end,
    folds: result.folds.map((fold) => ({
      foldId: fold.foldId,
      testStart: fold.testStart,
      testEnd: fold.testEnd,
      rawSignals: fold.rawSignals,
      rawPlannedEntries: fold.rawPlannedEntries,
      eligibleOosSignals: fold.eligibleOosSignals,
      eligibleOosPlannedEntries: fold.eligibleOosPlannedEntries,
      purgedBoundarySignals: fold.purgedBoundarySignals,
      completeTrades: fold.completeTrades,
      degradedTrades: fold.degradedTrades,
      noEntries: fold.noEntries,
      missedEntries: fold.missedEntries,
      expectancyR: fold.expectancyR,
      profitFactor: fold.profitFactor,
      dataQuality: fold.dataQuality
    })),
    aggregateMetrics: result.aggregate,
    holdoutMetrics: result.holdoutMetrics,
    validationVerdict: result.verdict,
    flags: result.flags
  }, null, 2));
  return 0;
}

function validateDatasets(datasets) {
  if (!Array.isArray(datasets) || datasets.length === 0) {
    return "M3_VALIDATION_DATA_REQUIRED";
  }
  const requiredFields = [
    "asset",
    "candles",
    "lowerTimeframeCandles",
    "fundingEvents",
    "fundingCoverage",
    "exchangeFilters",
    "marketType"
  ];
  for (const [index, dataset] of datasets.entries()) {
    if (!dataset || typeof dataset !== "object") {
      return "M3_VALIDATION_DATA_REQUIRED: dataset_" + index;
    }
    const missing = requiredFields.filter((field) =>
      !Object.prototype.hasOwnProperty.call(dataset, field)
    );
    if (missing.length) {
      return "M3_VALIDATION_DATA_REQUIRED: dataset_" + index
        + " missing " + missing.join(",");
    }
    if (!String(dataset.asset || "").trim()
      || !Array.isArray(dataset.candles)
      || dataset.candles.length < 2
      || !Array.isArray(dataset.lowerTimeframeCandles)
      || !Array.isArray(dataset.fundingEvents)
      || !dataset.fundingCoverage
      || !dataset.exchangeFilters
      || !String(dataset.marketType || "").trim()) {
      return "M3_VALIDATION_DATA_REQUIRED: dataset_" + index
        + " has invalid required fields";
    }
  }
  return null;
}

function normalizeDataset(dataset) {
  return {
    ...dataset,
    backtestOptions: {
      ...(dataset.backtestOptions || {}),
      ...(dataset.executionModel ? { executionModel: dataset.executionModel } : {}),
      marketType: dataset.marketType,
      tradePlanType: dataset.tradePlanType || dataset.marketType,
      lowerTimeframeCandles: dataset.lowerTimeframeCandles,
      fundingEvents: dataset.fundingEvents,
      fundingCoverage: dataset.fundingCoverage,
      exchangeFilters: dataset.exchangeFilters
    }
  };
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || null : null;
}

function failClosed(message) {
  console.error(message);
  return 1;
}

const exitCode = main();
if (exitCode) process.exitCode = exitCode;
