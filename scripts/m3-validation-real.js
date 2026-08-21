import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DYNAMIC_STRATEGY_IDS } from "../lib/strategies/dynamic-production.js";
import { runM3DynamicProductionValidation } from "../lib/validation/validation-engine.js";
import {
  CORE_SIGNAL_POLICY,
  ORDER_BOOK_AVAILABILITY
} from "../lib/validation/dynamic-production-replay.js";
import { loadM3RealInput, M3_REAL_DATA_WINDOW } from "../lib/validation/real-data.js";

const dataDir = argumentValue("--data-dir") || process.env.M3_REAL_DATA_DIR || ".local/m3-data";
const manifestPath = argumentValue("--manifest") || process.env.M3_REAL_MANIFEST || "artifacts/m3/manifest.json";
const reportPath = argumentValue("--report") || process.env.M3_REAL_REPORT || "artifacts/m3/m3-real-validation-report.json";
const strategyArgument = argumentValue("--strategy");
const strategies = strategyArgument ? [strategyArgument] : DYNAMIC_STRATEGY_IDS;

if (!existsSync(resolve(dataDir, "index.json"))) {
  failClosed("M3_REAL_DATA_REQUIRED");
} else {
  try {
    const input = await loadM3RealInput({ dataDir, manifestPath });
    validateRealInput(input);
    if (strategies.some((strategyId) => !DYNAMIC_STRATEGY_IDS.includes(strategyId))) {
      throw new Error("M3_VALIDATION_STRATEGY_NOT_FOUND");
    }
    const results = strategies.map((strategyId) => runStrategy(input, strategyId));
    const report = buildValidationReport({ input, results });
    await writeJson(reportPath, report);
    console.log(JSON.stringify({ ...report, reportPath: resolve(reportPath) }, null, 2));
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
    dynamicPoolReplay: result.dynamicPoolReplay,
    folds: result.folds.map(formatFold),
    aggregateMetrics: result.aggregate,
    holdoutMetrics: result.holdoutMetrics,
    stability: formatStability(result.stability),
    productionPolicyComplete: result.productionPolicyComplete,
    productionPolicy: result.productionPolicy,
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

function buildValidationReport({ input, results }) {
  const manifest = input.manifest;
  const quality = buildQualitySummary({ input, results });
  const validationFlags = {
    strategyParametersChanged: results.some((result) => result.flags?.strategyParametersChanged === true),
    parameterSearchPerformed: results.some((result) => result.flags?.parameterSearchPerformed === true),
    holdoutUsedForOptimization: results.some((result) => result.flags?.holdoutUsedForOptimization === true),
    dynamicPoolReplay: results.every((result) => result.dynamicPoolReplay === true)
  };
  return {
    dataset: {
      datasetId: input.datasetId,
      manifestSha256: input.manifestSha256,
      generatedAt: manifest.generatedAt,
      windowStart: manifest.windowStart,
      windowEnd: manifest.windowEnd,
      universeSource: input.universeSource,
      assetCount: manifest.assetCount,
      benchmark: manifest.benchmark,
      primaryInterval: manifest.intervals?.candles,
      lowerTimeframeInterval: manifest.intervals?.lowerTimeframe,
      fundingSource: manifest.sources?.funding,
      exchangeFilterSource: manifest.sources?.futuresExchangeInfo
    },
    validationFlags,
    quality,
    strategies: Object.fromEntries(results.map((result) => [
      result.strategyId,
      formatReportStrategy(result, quality)
    ])),
    policyScope: CORE_SIGNAL_POLICY,
    fullProductionPolicyValidated: false
  };
}

function buildQualitySummary({ input, results }) {
  const manifest = input.manifest;
  const completeCoverage = (rows, field) => {
    const values = (Array.isArray(rows) ? rows : [])
      .map((row) => row?.[field] === true)
      .filter((value) => value != null);
    if (!values.length || values.every((value) => value === false)) return "INCOMPLETE";
    return values.every((value) => value === true) ? "COMPLETE" : "PARTIAL";
  };
  const qualityValue = (field) => {
    const values = results.map((result) => result.dataQuality?.[field]).filter(Boolean);
    return values.length && values.every((value) => value === values[0]) ? values[0] : "MIXED";
  };
  const coverageValue = (row, field) => field === "fundingCoverage"
    ? row?.fundingCoverage?.complete === true
    : row?.[field]?.complete === true;
  const productionPolicyComplete = results.length > 0
    && results.every((result) => result.productionPolicyComplete === true);
  return {
    survivorshipBiasRisk: Boolean(manifest.universeProvenance?.survivorshipBiasRisk),
    tickerReconstructionQuality: qualityValue("tickerReconstruction"),
    benchmarkQuality: qualityValue("benchmark"),
    universeQuality: qualityValue("universe"),
    exchangeFilterTemporalQuality: manifest.exchangeFilterProvenance?.exchangeFilterProvenance
      || "UNKNOWN",
    fundingCoverageQuality: completeCoverage(manifest.assets.map((row) => ({ complete: coverageValue(row, "fundingCoverage") })), "complete"),
    lowerTimeframeQuality: completeCoverage(manifest.assets.map((row) => ({ complete: coverageValue(row, "candles5m") })), "complete"),
    orderBookAvailabilitySensitive: results.some((result) => result.orderBookSensitivity?.orderBookAvailabilitySensitive === true),
    productionPolicyComplete,
    productionPolicyIncompleteReason: productionPolicyComplete
      ? "FULL_PRODUCTION_POLICY_NOT_VALIDATED"
      : results.find((result) => result.productionPolicyReason)?.productionPolicyReason
        || "PRODUCTION_POLICY_NOT_COMPLETE",
    fullProductionPolicyValidated: false
  };
}

function formatReportStrategy(result, quality) {
  const validationVerdict = result.validationVerdict || result.statisticalVerdict;
  return {
    strategyId: result.strategyId,
    developmentStart: result.developmentStart,
    developmentEnd: result.developmentEnd,
    holdoutStart: result.holdoutStart,
    holdoutEnd: result.holdoutEnd,
    walkForward: {
      folds: result.folds.map(formatReportFold)
    },
    aggregateOOS: formatAggregateMetrics(result.aggregateMetrics),
    holdout: formatHoldoutMetrics(result.holdoutMetrics),
    stability: result.stability,
    productionPolicy: result.productionPolicy,
    productionPolicyComplete: result.productionPolicyComplete,
    statisticalVerdict: result.statisticalVerdict,
    validationVerdict,
    promotableToM4: canPromoteToM4({ result, quality, validationVerdict }),
    orderBookAvailabilitySensitive: result.orderBookSensitivity?.orderBookAvailabilitySensitive === true,
    flags: result.flags,
    replayDiagnostics: result.replayDiagnostics
  };
}

function formatReportFold(fold) {
  return {
    foldId: fold.foldId,
    testStart: fold.testStart,
    testEnd: fold.testEnd,
    rawSignals: fold.rawSignals,
    eligibleSignals: fold.eligibleOosSignals,
    rawPlannedEntries: fold.rawPlannedEntries,
    plannedEntries: fold.eligibleOosPlannedEntries,
    completeTrades: fold.completeTrades,
    degradedTrades: fold.degradedTrades,
    noEntries: fold.noEntries,
    missedEntries: fold.missedEntries,
    purgedBoundary: fold.purgedBoundarySignals,
    purgedBoundaryPlannedEntries: fold.purgedBoundaryPlannedEntries,
    winRate: fold.winRate,
    avgWinR: fold.avgWinR,
    avgLossR: fold.avgLossR,
    payoffRatio: fold.payoffRatio,
    profitFactor: fold.profitFactor,
    expectancyR: fold.expectancyR,
    avgNetReturn: fold.averageNetReturn,
    totalNetReturn: fold.totalNetReturn,
    maxDrawdown: fold.maxDrawdown,
    feeDrag: fold.feeDrag,
    spreadDrag: fold.spreadDrag,
    slippageDrag: fold.slippageDrag,
    fundingDrag: fold.fundingDrag,
    longTrades: fold.longTrades,
    shortTrades: fold.shortTrades,
    assetCount: fold.assetCount,
    dataQuality: fold.dataQuality
  };
}

function formatStability(stability = {}) {
  const flags = stability.flags || {};
  return {
    byAsset: stability.byAsset || [],
    bySide: stability.bySide || [],
    byFold: stability.byFold || [],
    assetUniverseSize: stability.assetUniverseSize,
    assetConcentrationApplicable: stability.assetConcentrationApplicable,
    assetConcentration: stability.assetConcentration,
    singleAssetDominance: flags.singleAssetDominance === true,
    singleFoldDominance: flags.singleFoldDominance === true,
    sideDominance: flags.sideDominance === true,
    concentrationRisk: flags.concentrationRisk === true,
    foldCounts: stability.foldCounts || {}
  };
}

function formatAggregateMetrics(metrics = {}) {
  return {
    completeTrades: metrics.completeTrades,
    positiveFolds: metrics.positiveFolds,
    negativeFolds: metrics.negativeFolds,
    winRate: metrics.winRate,
    avgWinR: metrics.avgWinR,
    avgLossR: metrics.avgLossR,
    payoffRatio: metrics.payoffRatio,
    profitFactor: metrics.profitFactor,
    expectancyR: metrics.expectancyR,
    totalNetReturn: metrics.totalNetReturn,
    maxDrawdown: metrics.maxDrawdown,
    totalFeeDrag: metrics.feeDrag,
    totalSpreadDrag: metrics.spreadDrag,
    totalSlippageDrag: metrics.slippageDrag,
    totalFundingDrag: metrics.fundingDrag
  };
}

function formatHoldoutMetrics(metrics = {}) {
  return {
    completeTrades: metrics.completeTrades,
    winRate: metrics.winRate,
    profitFactor: metrics.profitFactor,
    expectancyR: metrics.expectancyR,
    totalNetReturn: metrics.totalNetReturn,
    maxDrawdown: metrics.maxDrawdown
  };
}

function canPromoteToM4({ result, quality, validationVerdict }) {
  const aggregate = result.aggregateMetrics || {};
  const holdout = result.holdoutMetrics || {};
  return validationVerdict === "PROMISING_EDGE"
    && Number(aggregate.completeTrades) >= 60
    && Number(aggregate.expectancyR) > 0
    && Number(holdout.expectancyR) > 0
    && Number(aggregate.profitFactor) >= 1.2
    && Number(holdout.profitFactor) >= 1.1
    && quality.survivorshipBiasRisk === false
    && quality.orderBookAvailabilitySensitive === false
    && quality.productionPolicyComplete === true
    && quality.exchangeFilterTemporalQuality === "HISTORICAL_COMPLETE"
    && quality.benchmarkQuality === "COMPLETE"
    && quality.universeQuality === "COMPLETE"
    && quality.fundingCoverageQuality === "COMPLETE"
    && quality.lowerTimeframeQuality === "COMPLETE";
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
    winRate: fold.winRate,
    avgWinR: fold.avgWinR,
    avgLossR: fold.avgLossR,
    payoffRatio: fold.payoffRatio,
    profitFactor: fold.profitFactor,
    averageNetReturn: fold.averageNetReturn,
    totalNetReturn: fold.totalNetReturn,
    maxDrawdown: fold.maxDrawdown,
    feeDrag: fold.feeDrag,
    spreadDrag: fold.spreadDrag,
    slippageDrag: fold.slippageDrag,
    fundingDrag: fold.fundingDrag,
    longTrades: fold.longTrades,
    shortTrades: fold.shortTrades,
    assetCount: fold.assetCount,
    purgedBoundaryPlannedEntries: fold.purgedBoundaryPlannedEntries,
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

async function writeJson(path, value) {
  await mkdir(dirname(resolve(path)), { recursive: true });
  await writeFile(resolve(path), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function failClosed(message) {
  console.error(message);
  process.exitCode = 1;
}
