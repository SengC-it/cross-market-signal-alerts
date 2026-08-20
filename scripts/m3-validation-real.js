import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DYNAMIC_STRATEGY_IDS } from "../lib/strategies/dynamic-production.js";
import { runM3DynamicProductionValidation } from "../lib/validation/validation-engine.js";
import {
  CORE_SIGNAL_POLICY,
  ORDER_BOOK_AVAILABILITY
} from "../lib/validation/dynamic-production-replay.js";
import { loadM3RealInput, M3_REAL_DATA_WINDOW } from "../lib/validation/real-data.js";

const dataDir = argumentValue("--data-dir") || process.env.M3_REAL_DATA_DIR || ".local/m3-data";
const strategyArgument = argumentValue("--strategy");
const strategies = strategyArgument ? [strategyArgument] : DYNAMIC_STRATEGY_IDS;

if (!existsSync(resolve(dataDir, "index.json"))) {
  failClosed("M3_REAL_DATA_REQUIRED");
} else {
  try {
    const input = await loadM3RealInput({ dataDir });
    validateRealInput(input);
    if (strategies.some((strategyId) => !DYNAMIC_STRATEGY_IDS.includes(strategyId))) {
      throw new Error("M3_VALIDATION_STRATEGY_NOT_FOUND");
    }
    const results = strategies.map((strategyId) => runStrategy(input, strategyId));
    console.log(JSON.stringify({
      dataSource: input.dataSource,
      datasetId: input.datasetId,
      windowStart: M3_REAL_DATA_WINDOW.start,
      windowEnd: M3_REAL_DATA_WINDOW.end,
      policyScope: CORE_SIGNAL_POLICY,
      fullProductionPolicyValidated: false,
      strategies: results
    }, null, 2));
  } catch (error) {
    failClosed(error?.message || String(error));
  }
}

function runStrategy(input, strategyId) {
  const validationDatasets = input.datasets.filter((dataset) => isCompleteHourlyDataset(dataset));
  if (!validationDatasets.length) throw new Error("M3_REAL_DATA_INSUFFICIENT_COMPLETE_1H");
  const common = {
    datasets: validationDatasets,
    strategyId,
    interval: input.interval || "1h",
    holdoutPct: 0.2,
    folds: 5,
    benchmarkCandles: input.benchmarkCandles,
    benchmarkInterval: input.benchmarkInterval || "4h",
    existingAssets: input.existingAssets || [],
    futuresSymbols: input.universeProvenance?.assets || input.datasets.map((dataset) => dataset.asset),
    historicalUniverse: input.historicalUniverse,
    universeSource: input.universeSource,
    dataSource: input.dataSource,
    productionGroup: input.productionGroup || "all",
    productionPolicy: CORE_SIGNAL_POLICY,
    dynamicSpotAssets: input.dynamicSpotAssets || [],
    selected: input.selected || null
  };
  const result = runM3DynamicProductionValidation({
    ...common,
    orderBookAvailability: ORDER_BOOK_AVAILABILITY.UNAVAILABLE,
    includeOrderBookSensitivityMetrics: true
  });
  return formatStrategyResult({
    strategyId,
    result,
    input,
    validationDatasetCount: validationDatasets.length
  });
}

function formatStrategyResult({ strategyId, result, input, validationDatasetCount }) {
  return {
    strategyId,
    dataSource: input.dataSource,
    assets: result.assets,
    developmentStart: result.development.start,
    developmentEnd: result.development.end,
    holdoutStart: result.holdout.start,
    holdoutEnd: result.holdout.end,
    productionPolicy: result.productionPolicy,
    fullProductionPolicyValidated: false,
    productionPolicyReason: result.productionPolicyReason,
    universeSource: result.universeSource,
    survivorshipBiasRisk: result.survivorshipBiasRisk,
    folds: result.folds.map(formatFold),
    aggregateMetrics: result.aggregate,
    holdoutMetrics: result.holdoutMetrics,
    statisticalVerdict: result.statisticalVerdict || result.verdict,
    validationVerdict: result.validationVerdict || result.verdict,
    orderBookSensitivity: {
      orderBookAvailabilitySensitive: result.orderBookAvailabilitySensitive,
      unavailable: result.orderBookSensitivityMetrics?.unavailable || sensitivityMetrics(result),
      available: result.orderBookSensitivityMetrics?.available || sensitivityMetrics(result)
    },
    replayDiagnostics: summarizeReplayDiagnostics(result.replayDiagnostics),
    dataQuality: result.dynamicQuality,
    inputDataQualityExclusions: input.datasets.length - validationDatasetCount,
    flags: result.flags
  };
}

function formatFold(fold) {
  return {
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
  };
}

function sensitivityMetrics(result) {
  return {
    assumption: result.orderBookAvailabilityAssumption,
    signals: result.replaySignalsTotal,
    primaryEligibleSignals: result.replaySignalsPrimaryEligible,
    completeTrades: result.aggregate?.completeTrades ?? null,
    expectancyR: result.aggregate?.expectancyR ?? null,
    profitFactor: result.aggregate?.profitFactor ?? null,
    holdoutExpectancyR: result.holdoutMetrics?.expectancyR ?? null,
    holdoutProfitFactor: result.holdoutMetrics?.profitFactor ?? null,
    validationVerdict: result.validationVerdict || result.verdict
  };
}

function summarizeReplayDiagnostics(diagnostics = {}) {
  return {
    replaySignalsTotal: diagnostics.replaySignalsTotal ?? null,
    replaySignalsPrimaryEligible: diagnostics.replaySignalsPrimaryEligible ?? null,
    replaySignalsExcluded: diagnostics.replaySignalsExcluded ?? null,
    excludedByReason: diagnostics.excludedByReason || null,
    inputExcludedByReason: diagnostics.inputExcludedByReason || null,
    tickerDiagnostics: summarizeDiagnosticRows(diagnostics.tickerDiagnostics),
    benchmarkDiagnostics: summarizeDiagnosticRows(diagnostics.benchmarkDiagnostics)
  };
}

function summarizeDiagnosticRows(rows) {
  const normalized = Array.isArray(rows) ? rows : [];
  return {
    count: normalized.length,
    sample: normalized.slice(0, 5),
    last: normalized.at(-1) || null
  };
}

function validateRealInput(input) {
  if (input.windowStart !== M3_REAL_DATA_WINDOW.start || input.windowEnd !== M3_REAL_DATA_WINDOW.end) {
    throw new Error("M3_REAL_DATA_WINDOW_INVALID");
  }
  if (!Array.isArray(input.datasets) || !input.datasets.length || !Array.isArray(input.benchmarkCandles)) {
    throw new Error("M3_REAL_DATA_REQUIRED");
  }
  for (const [index, dataset] of input.datasets.entries()) {
    if (!dataset?.asset
      || !Array.isArray(dataset.candles)
      || !Array.isArray(dataset.lowerTimeframeCandles)
      || !Array.isArray(dataset.fundingEvents)
      || !dataset.fundingCoverage
      || !dataset.exchangeFilters
      || dataset.marketType !== "futures") {
      throw new Error(`M3_REAL_DATA_REQUIRED: dataset_${index}`);
    }
  }
}

function isCompleteHourlyDataset(dataset) {
  const candles = dataset?.candles;
  if (!Array.isArray(candles) || candles.length !== 8760) return false;
  return Number(candles[0]?.openTime) === Date.parse(M3_REAL_DATA_WINDOW.start)
    && Number(candles.at(-1)?.openTime) + 3600 * 1000 === Date.parse(M3_REAL_DATA_WINDOW.end)
    && candles.every((candle, index) => index === 0
      || Number(candle?.openTime) - Number(candles[index - 1]?.openTime) === 3600 * 1000);
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || null : null;
}

function failClosed(message) {
  console.error(message);
  process.exitCode = 1;
}
