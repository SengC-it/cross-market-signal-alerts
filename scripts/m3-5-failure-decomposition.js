import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DYNAMIC_STRATEGY_IDS } from "../lib/strategies/dynamic-production.js";
import {
  CORE_SIGNAL_POLICY,
  ORDER_BOOK_AVAILABILITY
} from "../lib/validation/dynamic-production-replay.js";
import { runM3DynamicProductionValidation } from "../lib/validation/validation-engine.js";
import {
  buildFailureDecompositionReport,
  decomposeFrozenValidation
} from "../lib/validation/failure-decomposition.js";
import {
  loadM3RealInput,
  M3_REAL_DATA_WINDOW,
  M3_REAL_MANIFEST_SHA256
} from "../lib/validation/real-data.js";

const FROZEN_BASE_SHA = "4e74aa8bd37025195f46c5c2adc9bc0ca130646e";
const dataDir = argumentValue("--data-dir") || process.env.M3_REAL_DATA_DIR || ".local/m3-data";
const manifestPath = argumentValue("--manifest") || process.env.M3_REAL_MANIFEST || "artifacts/m3/manifest.json";
const frozenReportPath = argumentValue("--frozen-report") || "artifacts/m3/m3-real-validation-report.json";
const outputPath = argumentValue("--output") || "artifacts/m3/m3-5-failure-decomposition.json";

if (!existsSync(resolve(dataDir, "index.json"))) {
  failClosed("M3_REAL_DATA_REQUIRED");
} else {
  try {
    const input = await loadM3RealInput({ dataDir, manifestPath });
    const frozenReport = JSON.parse(await readFile(resolve(frozenReportPath), "utf8"));
    assert.equal(input.manifestSha256, M3_REAL_MANIFEST_SHA256, "frozen manifest SHA must remain unchanged");
    assert.equal(input.manifestSha256, frozenReport.dataset?.manifestSha256, "frozen report must use the frozen manifest");
    assert.equal(input.windowStart, M3_REAL_DATA_WINDOW.start);
    assert.equal(input.windowEnd, M3_REAL_DATA_WINDOW.end);

    const validationDatasets = input.datasets.filter(isCompleteHourlyDataset);
    assert.ok(validationDatasets.length > 0, "frozen M3 requires complete hourly datasets");
    const strategyAnalyses = [];
    for (const strategyId of DYNAMIC_STRATEGY_IDS) {
      const validation = runFrozenStrategy({ input, validationDatasets, strategyId });
      assertFrozenParity({ validation, frozenReport: frozenReport.strategies?.[strategyId], strategyId });
      strategyAnalyses.push(decomposeFrozenValidation({
        strategyId,
        validationResult: validation,
        replaySignals: validation.replaySignals,
        pipelineDiagnostics: validation.pipelineDiagnostics,
        datasets: validationDatasets,
        benchmarkCandles: input.benchmarkCandles
      }));
    }

    const report = buildFailureDecompositionReport({
      frozenBaseSha: FROZEN_BASE_SHA,
      manifestSha256: input.manifestSha256,
      window: M3_REAL_DATA_WINDOW,
      strategyAnalyses,
      source: {
        dataSource: input.dataSource,
        dataDir: resolve(dataDir),
        validationDatasetCount: validationDatasets.length,
        historicalUniverse: input.universeSource,
        validationFolds: 5,
        holdoutPct: 0.2,
        orderBookAvailability: ORDER_BOOK_AVAILABILITY.UNAVAILABLE,
        productionPolicy: CORE_SIGNAL_POLICY
      }
    });
    await mkdir(dirname(resolve(outputPath)), { recursive: true });
    await writeFile(resolve(outputPath), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({
      analysisPath: resolve(outputPath),
      frozenBaseSha: report.frozenBaseSha,
      manifestSha256: report.manifestSha256,
      strategies: Object.fromEntries([report.strong, report.weak].map((analysis) => [analysis.strategyId, {
        replaySignals: analysis.replaySignals,
        primaryEligible: analysis.primaryEligible,
        completeTrades: analysis.completeTrades,
        grossExpectancyR: analysis.costDecomposition.grossExpectancyR,
        netExpectancyR: analysis.costDecomposition.netExpectancyR,
        profitFactor: analysis.costDecomposition.netPnl?.profitFactor ?? null,
        recommendedStatus: analysis.recommendedStatus.status
      }]))
    }, null, 2));
  } catch (error) {
    failClosed(error?.message || String(error));
  }
}

function runFrozenStrategy({ input, validationDatasets, strategyId }) {
  return runM3DynamicProductionValidation({
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
    historicalUniverseComplete: input.historicalUniverseComplete,
    universeSource: input.universeSource,
    dataSource: input.dataSource,
    productionGroup: input.productionGroup || "all",
    productionPolicy: CORE_SIGNAL_POLICY,
    dynamicSpotAssets: input.dynamicSpotAssets || [],
    selected: input.selected || null,
    orderBookAvailability: ORDER_BOOK_AVAILABILITY.UNAVAILABLE,
    includeOrderBookSensitivityMetrics: true,
    includePipelineDiagnostics: true
  });
}

function assertFrozenParity({ validation, frozenReport, strategyId }) {
  assert.ok(frozenReport, `${strategyId} frozen report is required`);
  assert.equal(validation.replaySignalsTotal, frozenReport.replayDiagnostics?.replaySignalsTotal);
  assert.equal(validation.replaySignalsPrimaryEligible, frozenReport.replayDiagnostics?.replaySignalsPrimaryEligible);
  assert.equal(validation.aggregate?.completeTrades, frozenReport.aggregateOOS?.completeTrades);
  assert.equal(validation.aggregate?.positiveFolds, frozenReport.aggregateOOS?.positiveFolds);
  assert.equal(validation.aggregate?.negativeFolds, frozenReport.aggregateOOS?.negativeFolds);
  assertClose(validation.aggregate?.expectancyR, frozenReport.aggregateOOS?.expectancyR, `${strategyId} expectancyR`);
  assertClose(validation.aggregate?.profitFactor, frozenReport.aggregateOOS?.profitFactor, `${strategyId} profitFactor`);
  assert.equal(validation.holdoutMetrics?.completeTrades, frozenReport.holdout?.completeTrades);
  assert.equal(validation.flags?.strategyParametersChanged, false);
  assert.equal(validation.flags?.parameterSearchPerformed, false);
  assert.equal(validation.flags?.holdoutUsedForOptimization, false);
}

function assertClose(actual, expected, message) {
  if (actual == null || expected == null) {
    assert.equal(actual, expected, message);
    return;
  }
  assert.ok(Math.abs(Number(actual) - Number(expected)) < 1e-12, message);
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
