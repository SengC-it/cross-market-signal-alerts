import { runFinalHoldoutValidation } from "./holdout.js";
import {
  aggregateValidationMetrics,
  buildValidationStability,
  determineValidationVerdict,
  VALIDATION_FLAGS
} from "./validation-metrics.js";
import {
  runWalkForwardValidation,
  splitChronologicalData
} from "./walk-forward.js";
import {
  compareDynamicOrderBookAvailability,
  createDynamicProductionReplayStrategy,
  FULL_PRODUCTION_POLICY,
  ORDER_BOOK_AVAILABILITY,
  signalTimelineForAsset
} from "./dynamic-production-replay.js";

export function runM3Validation({
  candles,
  strategy,
  interval = "1h",
  holdoutPct = 0.2,
  folds = 5,
  asset = null,
  backtestOptions = {}
} = {}) {
  return runM3UniverseValidation({
    datasets: [{
      asset,
      candles,
      backtestOptions
    }],
    strategy,
    interval,
    holdoutPct,
    folds
  });
}

export function runM3UniverseValidation({
  datasets = [],
  strategy,
  strategyFactory = null,
  interval = "1h",
  holdoutPct = 0.2,
  folds = 5
} = {}) {
  const normalizedDatasets = normalizeDatasets(datasets);
  const evaluatedAssets = [...new Set(
    normalizedDatasets
      .map((dataset) => dataset.asset)
      .filter((asset) => asset != null && String(asset).length > 0)
      .map((asset) => String(asset))
  )];
  const splits = normalizedDatasets.map((dataset) =>
    splitChronologicalData(dataset.candles, { holdoutPct, interval })
  );
  assertAlignedSplits(splits);

  // Run every development fold for every asset before touching final holdout data.
  const walkForwards = normalizedDatasets.map((dataset, index) =>
    runWalkForwardValidation({
      split: splits[index],
      strategy: resolveDatasetStrategy({ strategy, strategyFactory, dataset }),
      interval,
      folds,
      asset: dataset.asset,
      assetUniverseSize: evaluatedAssets.length,
      evaluatedAssets,
      backtestOptions: dataset.backtestOptions
    })
  );
  const mergedFolds = mergeFolds(walkForwards);
  const allTradeResults = mergedFolds.flatMap((fold) => fold.tradeResults);
  const allMissedEntries = mergedFolds.flatMap((fold) => fold.missedEntryRecords);
  const aggregate = summarizeAggregate(
    allTradeResults,
    mergedFolds,
    allMissedEntries
  );
  const stability = buildValidationStability({
    tradeResults: allTradeResults,
    folds: mergedFolds,
    assetUniverseSize: evaluatedAssets.length,
    evaluatedAssets
  });

  const holdouts = normalizedDatasets.map((dataset, index) =>
    runFinalHoldoutValidation({
      split: splits[index],
      strategy: resolveDatasetStrategy({ strategy, strategyFactory, dataset }),
      interval,
      asset: dataset.asset,
      backtestOptions: dataset.backtestOptions
    })
  );
  const holdoutTradeResults = holdouts.flatMap((holdout) => holdout.tradeResults);
  const holdoutMissedEntries = holdouts.flatMap((holdout) => holdout.missedEntryRecords);
  const holdoutMetrics = aggregateValidationMetrics(
    holdoutTradeResults,
    aggregateDiagnostics(holdouts, holdoutMissedEntries)
  );
  const verdict = determineValidationVerdict({
    aggregate,
    holdout: holdoutMetrics,
    folds: mergedFolds,
    stability
  });
  const split = splits[0];

  return {
    assets: evaluatedAssets,
    assetUniverseSize: evaluatedAssets.length,
    development: {
      start: split.developmentStart,
      end: split.developmentEnd,
      candleCount: split.developmentCandles.length
    },
    holdout: {
      start: split.holdoutStart,
      end: split.holdoutEnd,
      pct: split.holdoutPct,
      candleCount: split.holdoutCandles.length,
      metrics: holdoutMetrics
    },
    folds: mergedFolds,
    aggregate,
    stability,
    holdoutMetrics,
    verdict,
    flags: { ...VALIDATION_FLAGS },
    tradeResults: allTradeResults,
    missedEntries: allMissedEntries,
    holdoutTradeResults,
    holdoutMissedEntries,
    perAsset: normalizedDatasets.map((dataset, index) => ({
      asset: dataset.asset,
      walkForward: walkForwards[index],
      holdout: holdouts[index]
    }))
  };
}

export function runM3DynamicProductionValidation({
  datasets = [],
  strategyId,
  interval = "1h",
  holdoutPct = 0.2,
  folds = 5,
  benchmarkCandles = null,
  benchmarkInterval = "4h",
  orderBookAvailability = ORDER_BOOK_AVAILABILITY.UNAVAILABLE,
  existingAssets = [],
  futuresSymbols = null,
  historicalUniverse = null,
  historicalUniverseComplete = null,
  universeSource = "current_configured_futures",
  dataSource = "historical_validation_input",
  productionGroup = "all",
  productionPolicy = FULL_PRODUCTION_POLICY,
  historicalAlertReviewState = null,
  dynamicSpotAssets = [],
  selected = null,
  includeOrderBookSensitivityMetrics = false
} = {}) {
  const comparison = compareDynamicOrderBookAvailability({
    datasets,
    strategyId,
    interval,
    benchmarkCandles,
    benchmarkInterval,
    existingAssets,
    futuresSymbols,
    historicalUniverse,
    historicalUniverseComplete,
    universeSource,
    dataSource,
    productionGroup,
    productionPolicy,
    historicalAlertReviewState,
    dynamicSpotAssets,
    selected
  });
  const replay = orderBookAvailability === ORDER_BOOK_AVAILABILITY.AVAILABLE
    ? comparison.available
    : comparison.unavailable;
  const result = runM3UniverseValidation({
    datasets,
    strategyFactory: ({ asset }) => createDynamicProductionReplayStrategy({
      strategyId,
      signalTimeline: signalTimelineForAsset(replay, asset),
      primaryOnly: true
    }),
    interval,
    holdoutPct,
    folds
  });
  let orderBookSensitivityMetrics = null;
  if (includeOrderBookSensitivityMetrics) {
    const alternateReplay = orderBookAvailability === ORDER_BOOK_AVAILABILITY.AVAILABLE
      ? comparison.unavailable
      : comparison.available;
    const alternateResult = runM3UniverseValidation({
      datasets,
      strategyFactory: ({ asset }) => createDynamicProductionReplayStrategy({
        strategyId,
        signalTimeline: signalTimelineForAsset(alternateReplay, asset),
        primaryOnly: true
      }),
      interval,
      holdoutPct,
      folds
    });
    const selectedByAvailability = orderBookAvailability === ORDER_BOOK_AVAILABILITY.AVAILABLE
      ? { available: result, unavailable: alternateResult }
      : { available: alternateResult, unavailable: result };
    orderBookSensitivityMetrics = Object.fromEntries(Object.entries(selectedByAvailability).map(([assumption, validation]) => [
      assumption,
      {
        signals: (assumption === ORDER_BOOK_AVAILABILITY.AVAILABLE
          ? comparison.available
          : comparison.unavailable).replaySignalsTotal,
        primaryEligibleSignals: (assumption === ORDER_BOOK_AVAILABILITY.AVAILABLE
          ? comparison.available
          : comparison.unavailable).replaySignalsPrimaryEligible,
        completeTrades: validation.aggregate?.completeTrades ?? null,
        expectancyR: validation.aggregate?.expectancyR ?? null,
        profitFactor: validation.aggregate?.profitFactor ?? null,
        holdoutExpectancyR: validation.holdoutMetrics?.expectancyR ?? null,
        holdoutProfitFactor: validation.holdoutMetrics?.profitFactor ?? null,
        validationVerdict: validation.verdict
      }
    ]));
  }
  const qualityBlocked = replay.quality.dataQuality !== "COMPLETE"
    || replay.survivorshipBiasRisk
    || replay.productionPolicyComplete !== true
    || comparison.orderBookAvailabilitySensitive;
  const validationVerdict = qualityBlocked ? "PROVISIONAL" : result.verdict;
  return {
    ...result,
    strategyId,
    strategyFamily: replay.strategyFamily,
    dynamicPoolReplay: true,
    poolReconstructionQuality: replay.poolReconstructionQuality,
    orderBookAvailabilityAssumption: orderBookAvailability,
    orderBookAvailabilitySensitive: comparison.orderBookAvailabilitySensitive,
    orderBookSensitivityMetrics,
    sensitivityWarning: comparison.sensitivityWarning,
    dynamicQuality: replay.quality,
    universeSource: replay.universeSource,
    survivorshipBiasRisk: replay.survivorshipBiasRisk,
    dataSource: replay.dataSource,
    replayDiagnostics: replay.replayDiagnostics,
    replaySignalsTotal: replay.replaySignalsTotal,
    replaySignalsPrimaryEligible: replay.replaySignalsPrimaryEligible,
    replaySignalsExcluded: replay.replaySignalsExcluded,
    excludedByReason: replay.excludedByReason,
    productionGroup: replay.productionGroup,
    productionPolicy: replay.productionPolicy,
    productionPolicyComplete: replay.productionPolicyComplete,
    productionPolicyReason: replay.productionPolicyReason,
    coreSignalPolicyComplete: replay.coreSignalPolicyComplete,
    fullProductionPolicyValidated: replay.fullProductionPolicyValidated,
    statisticalVerdict: result.verdict,
    validationVerdict,
    verdict: validationVerdict
  };
}

function normalizeDatasets(datasets) {
  if (!Array.isArray(datasets) || datasets.length === 0) {
    throw new Error("M3_VALIDATION_DATA_REQUIRED");
  }
  return datasets.map((dataset) => ({
    asset: dataset?.asset ?? null,
    candles: dataset?.candles,
    strategy: dataset?.strategy || null,
    backtestOptions: normalizeBacktestOptions(dataset)
  }));
}

function resolveDatasetStrategy({ strategy, strategyFactory, dataset }) {
  if (typeof strategyFactory === "function") {
    const resolved = strategyFactory({
      asset: dataset?.asset ?? null,
      dataset
    });
    if (resolved) return resolved;
  }
  if (dataset?.strategy) return dataset.strategy;
  return strategy;
}

function normalizeBacktestOptions(dataset) {
  const source = dataset?.backtestOptions && typeof dataset.backtestOptions === "object"
    ? dataset.backtestOptions
    : {};
  return {
    ...source,
    marketType: dataset?.marketType ?? source.marketType ?? "futures",
    tradePlanType: dataset?.tradePlanType ?? source.tradePlanType
      ?? dataset?.marketType
      ?? source.marketType
      ?? "futures",
    ...(dataset && Object.prototype.hasOwnProperty.call(dataset, "lowerTimeframeCandles")
      ? { lowerTimeframeCandles: dataset.lowerTimeframeCandles }
      : {}),
    ...(dataset && Object.prototype.hasOwnProperty.call(dataset, "fundingEvents")
      ? { fundingEvents: dataset.fundingEvents }
      : {}),
    ...(dataset && Object.prototype.hasOwnProperty.call(dataset, "fundingCoverage")
      ? { fundingCoverage: dataset.fundingCoverage }
      : {}),
    ...(dataset && Object.prototype.hasOwnProperty.call(dataset, "exchangeFilters")
      ? { exchangeFilters: dataset.exchangeFilters }
      : {})
  };
}

function assertAlignedSplits(splits) {
  const reference = splits[0];
  for (const split of splits.slice(1)) {
    for (const field of ["developmentStart", "developmentEnd", "holdoutStart", "holdoutEnd"]) {
      if (split[field] !== reference[field]) {
        throw new Error("M3_VALIDATION_DATASET_BOUNDARIES_MISMATCH");
      }
    }
  }
}

function mergeFolds(walkForwards) {
  const referenceFolds = walkForwards[0]?.folds || [];
  return referenceFolds.map((referenceFold, index) => {
    const sourceFolds = walkForwards.map((walkForward) => walkForward.folds[index]);
    const tradeResults = sourceFolds.flatMap((fold) => fold.tradeResults);
    const missedEntryRecords = sourceFolds.flatMap((fold) => fold.missedEntryRecords);
    const metrics = aggregateValidationMetrics(
      tradeResults,
      aggregateDiagnostics(sourceFolds, missedEntryRecords)
    );
    return {
      ...referenceFold,
      ...metrics,
      rawSignals: metrics.rawSignals,
      rawPlannedEntries: metrics.rawPlannedEntries,
      eligibleOosSignals: metrics.eligibleOosSignals,
      eligibleOosPlannedEntries: metrics.eligibleOosPlannedEntries,
      noEntries: metrics.noEntries,
      missedEntries: metrics.missedEntries,
      purgedBoundarySignals: metrics.purgedBoundarySignals,
      purgedBoundaryPlannedEntries: metrics.purgedBoundaryPlannedEntries,
      tradeResults,
      missedEntryRecords
    };
  });
}

function summarizeAggregate(tradeResults, folds, missedEntries) {
  const aggregate = aggregateValidationMetrics(
    tradeResults,
    aggregateDiagnostics(folds, missedEntries)
  );
  const expectancyValues = folds
    .map((fold) => Number(fold.expectancyR))
    .filter(Number.isFinite);
  const profitFactorValues = folds
    .map((fold) => Number(fold.profitFactor))
    .filter(Number.isFinite);
  return {
    ...aggregate,
    positiveFolds: folds.filter((fold) => Number(fold.expectancyR) > 0).length,
    negativeFolds: folds.filter((fold) => Number(fold.expectancyR) < 0).length,
    meanExpectancyR: mean(expectancyValues),
    medianExpectancyR: median(expectancyValues),
    worstExpectancyR: expectancyValues.length ? Math.min(...expectancyValues) : null,
    bestExpectancyR: expectancyValues.length ? Math.max(...expectancyValues) : null,
    meanProfitFactor: mean(profitFactorValues),
    medianProfitFactor: median(profitFactorValues)
  };
}

function aggregateDiagnostics(rows, missedEntries) {
  return {
    rawSignals: sumField(rows, "rawSignals"),
    rawPlannedEntries: sumField(rows, "rawPlannedEntries"),
    eligibleOosSignals: sumField(rows, "eligibleOosSignals"),
    eligibleOosPlannedEntries: sumField(rows, "eligibleOosPlannedEntries"),
    noEntries: sumField(rows, "noEntries"),
    missedEntryCount: sumField(rows, "missedEntries"),
    purgedBoundarySignals: sumField(rows, "purgedBoundarySignals"),
    purgedBoundaryPlannedEntries: sumField(rows, "purgedBoundaryPlannedEntries"),
    missedEntries
  };
}

function sumField(rows, field) {
  return (Array.isArray(rows) ? rows : [])
    .reduce((sum, row) => sum + (Number(row?.[field]) || 0), 0);
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}
