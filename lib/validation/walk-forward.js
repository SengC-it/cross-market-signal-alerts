import { runBacktest } from "../backtest/backtest-engine.js";
import { buildFundingCoverage } from "../market-data/funding-history.js";
import { intervalMilliseconds } from "../trading/trade-spec.js";
import {
  ELIGIBLE_OOS,
  boundaryRecordKey,
  isSignalInTestWindow,
  partitionByOosBoundary
} from "./purge.js";
import {
  aggregateValidationMetrics,
  buildValidationStability,
  VALIDATION_FLAGS
} from "./validation-metrics.js";

export function splitChronologicalData(candles, {
  holdoutPct = 0.2,
  interval = "1h"
} = {}) {
  const sortedCandles = [...(Array.isArray(candles) ? candles : [])]
    .sort((left, right) => Number(left?.openTime) - Number(right?.openTime));
  if (sortedCandles.length < 2) {
    throw new Error("M3 validation requires at least two chronological candles");
  }
  const requestedHoldoutPct = Number(holdoutPct);
  if (!Number.isFinite(requestedHoldoutPct)
    || requestedHoldoutPct <= 0
    || requestedHoldoutPct >= 1) {
    throw new Error("holdoutPct must be between 0 and 1");
  }
  const holdoutStartIndex = Math.min(
    sortedCandles.length - 1,
    Math.max(1, Math.floor(sortedCandles.length * (1 - requestedHoldoutPct)))
  );
  const holdoutStart = Number(sortedCandles[holdoutStartIndex].openTime);
  const holdoutEnd = Number(sortedCandles.at(-1).openTime) + intervalMilliseconds(interval);
  return {
    candles: sortedCandles,
    developmentCandles: sortedCandles.slice(0, holdoutStartIndex),
    holdoutCandles: sortedCandles.slice(holdoutStartIndex),
    developmentStart: Number(sortedCandles[0].openTime),
    developmentEnd: holdoutStart,
    holdoutStart,
    holdoutEnd,
    holdoutStartIndex,
    holdoutPct: (sortedCandles.length - holdoutStartIndex) / sortedCandles.length,
    requestedHoldoutPct,
    interval
  };
}

export function buildExpandingFolds({
  candles,
  folds = 5,
  interval = "1h"
} = {}) {
  const developmentCandles = Array.isArray(candles) ? candles : [];
  if (developmentCandles.length < 2) {
    throw new Error("M3 walk-forward requires development candles");
  }
  const requestedFolds = Math.max(1, Math.floor(Number(folds) || 1));
  const foldCount = Math.min(requestedFolds, developmentCandles.length - 1);
  const testSize = Math.max(1, Math.floor(developmentCandles.length / (foldCount + 1)));
  const initialTrainEndIndex = developmentCandles.length - testSize * foldCount;
  if (initialTrainEndIndex < 1) {
    throw new Error("M3 walk-forward cannot create a non-empty warmup window");
  }

  return Array.from({ length: foldCount }, (_, offset) => {
    const testStartIndex = initialTrainEndIndex + offset * testSize;
    const testEndIndex = Math.min(developmentCandles.length, testStartIndex + testSize);
    const testStart = Number(developmentCandles[testStartIndex].openTime);
    const testEnd = testEndIndex < developmentCandles.length
      ? Number(developmentCandles[testEndIndex].openTime)
      : Number(developmentCandles.at(-1).openTime) + intervalMilliseconds(interval);
    return {
      foldId: "fold-" + (offset + 1),
      contextStartIndex: 0,
      contextEndIndex: testStartIndex,
      testStartIndex,
      testEndIndex,
      contextStart: Number(developmentCandles[0].openTime),
      contextEnd: testStart,
      testStart,
      testEnd,
      trainEnd: testStart
    };
  });
}

export function runWalkForwardValidation({
  candles,
  split = null,
  strategy,
  interval = "1h",
  holdoutPct = 0.2,
  folds = 5,
  asset = null,
  assetUniverseSize = null,
  evaluatedAssets = [],
  backtestOptions = {}
} = {}) {
  const chronologicalSplit = split || splitChronologicalData(candles, { holdoutPct, interval });
  const foldDefinitions = buildExpandingFolds({
    candles: chronologicalSplit.developmentCandles,
    folds,
    interval
  });
  const foldResults = foldDefinitions.map((fold) => runOneFold({
    fold,
    split: chronologicalSplit,
    strategy,
    interval,
    asset,
    backtestOptions
  }));
  const allTradeResults = foldResults.flatMap((fold) => fold.tradeResults);
  const allMissedEntries = foldResults.flatMap((fold) => fold.missedEntryRecords);
  const aggregate = aggregateValidationMetrics(allTradeResults, {
    signals: sumField(foldResults, "signals"),
    plannedEntries: sumField(foldResults, "plannedEntries"),
    noEntries: sumField(foldResults, "noEntries"),
    missedEntryCount: sumField(foldResults, "missedEntries"),
    purgedBoundarySignals: sumField(foldResults, "purgedBoundarySignals"),
    purgedBoundaryPlannedEntries: sumField(foldResults, "purgedBoundaryPlannedEntries"),
    rawSignals: sumField(foldResults, "rawSignals"),
    rawPlannedEntries: sumField(foldResults, "rawPlannedEntries"),
    eligibleOosSignals: sumField(foldResults, "eligibleOosSignals"),
    eligibleOosPlannedEntries: sumField(foldResults, "eligibleOosPlannedEntries"),
    missedEntries: allMissedEntries
  });
  const positiveFoldCount = foldResults.filter((fold) => Number(fold.expectancyR) > 0).length;
  const negativeFoldCount = foldResults.filter((fold) => Number(fold.expectancyR) < 0).length;
  const expectancyValues = foldResults
    .map((fold) => Number(fold.expectancyR))
    .filter(Number.isFinite);
  const profitFactorValues = foldResults
    .map((fold) => Number(fold.profitFactor))
    .filter(Number.isFinite);
  const stability = buildValidationStability({
    tradeResults: allTradeResults,
    folds: foldResults,
    assetUniverseSize,
    evaluatedAssets: evaluatedAssets.length ? evaluatedAssets : asset ? [asset] : []
  });

  return {
    split: chronologicalSplit,
    folds: foldResults,
    aggregate: {
      ...aggregate,
      positiveFolds: positiveFoldCount,
      negativeFolds: negativeFoldCount,
      meanExpectancyR: mean(expectancyValues),
      medianExpectancyR: median(expectancyValues),
      worstExpectancyR: expectancyValues.length ? Math.min(...expectancyValues) : null,
      bestExpectancyR: expectancyValues.length ? Math.max(...expectancyValues) : null,
      meanProfitFactor: mean(profitFactorValues),
      medianProfitFactor: median(profitFactorValues)
    },
    stability,
    flags: { ...VALIDATION_FLAGS },
    tradeResults: allTradeResults,
    missedEntries: allMissedEntries
  };
}

export function createNoLookaheadStrategy(strategy) {
  if (!strategy || typeof strategy.evaluate !== "function") return strategy;
  return {
    ...strategy,
    evaluate(candles, index, context) {
      const visibleCandles = Array.isArray(candles)
        ? candles.slice(0, Math.max(0, Number(index) + 1))
        : candles;
      return strategy.evaluate(visibleCandles, index, context);
    }
  };
}

export function boundBacktestOptionsToEnd(backtestOptions = {}, testEnd) {
  const end = toTimestamp(testEnd);
  const options = { ...backtestOptions };
  delete options.candles;
  delete options.strategy;
  delete options.startIndex;
  if (!Number.isFinite(end)) return options;

  const originalExecutionModel = backtestOptions.executionModel
    && typeof backtestOptions.executionModel === "object"
    ? { ...backtestOptions.executionModel }
    : {};
  const originalFundingEvents = backtestOptions.fundingEvents
    ?? originalExecutionModel.fundingEvents;
  const originalCoverage = backtestOptions.fundingCoverage
    ?? originalExecutionModel.fundingCoverage;
  const originalRequestedEnd = toTimestamp(originalCoverage?.requestedEnd);
  const clippedFundingEnd = Number.isFinite(originalRequestedEnd)
    ? Math.min(originalRequestedEnd, end)
    : end;
  const boundedFundingEvents = filterTimestampedRows(originalFundingEvents, clippedFundingEnd, "time");
  if (Array.isArray(originalFundingEvents)) {
    options.fundingEvents = boundedFundingEvents;
    originalExecutionModel.fundingEvents = boundedFundingEvents;
  }
  if (Array.isArray(backtestOptions.lowerTimeframeCandles)) {
    options.lowerTimeframeCandles = backtestOptions.lowerTimeframeCandles
      .filter((candle) => Number(candle?.openTime) < end);
  }
  if (originalCoverage) {
    const coverageEvents = Array.isArray(originalFundingEvents)
      ? boundedFundingEvents
      : [];
    const clippedCoverage = clipFundingCoverage(originalCoverage, coverageEvents, end);
    options.fundingCoverage = clippedCoverage;
    originalExecutionModel.fundingCoverage = clippedCoverage;
  }
  options.executionModel = originalExecutionModel;
  return options;
}

function runOneFold({
  fold,
  split,
  strategy,
  interval,
  asset,
  backtestOptions
}) {
  const foldCandles = split.candles.slice(0, split.holdoutStartIndex)
    .slice(0, fold.testEndIndex);
  const boundedOptions = boundBacktestOptionsToEnd(backtestOptions, fold.testEnd);
  const backtest = runBacktest({
    ...boundedOptions,
    candles: foldCandles,
    strategy: createNoLookaheadStrategy(strategy),
    interval,
    asset: asset ?? backtestOptions.asset ?? null,
    startIndex: fold.testStartIndex
  });
  const tradePartition = partitionByOosBoundary(backtest.tradeResults, fold);
  const missedPartition = partitionByOosBoundary(backtest.missedEntries, fold);
  const purgedKeys = new Set([
    ...tradePartition.purged.map(({ record }) => boundaryRecordKey(record)),
    ...missedPartition.purged.map(({ record }) => boundaryRecordKey(record))
  ]);
  const tradeResults = tradePartition.eligible
    .map(({ record }) => ({ ...record, foldId: fold.foldId }));
  const missedEntries = [
    ...missedPartition.eligible,
    ...missedPartition.notApplicable.filter(({ record, inTestWindow }) =>
      inTestWindow ?? isSignalInTestWindow(record, fold)
    )
  ].map(({ record }) => record);
  const noEntries = missedEntries.filter((entry) => entry.status === "NO_ENTRY").length;
  const missedEntryCount = missedEntries.filter((entry) => entry.status === "MISSED_ENTRY").length;
  const rawSignals = Number(backtest.entryStats?.signals) || 0;
  const rawPlannedEntries = Number(backtest.entryStats?.planned) || 0;
  const purgedBoundarySignals = purgedKeys.size;
  const purgedBoundaryPlannedEntries = purgedBoundarySignals;
  const eligibleOosSignals = Math.max(0, rawSignals - purgedBoundarySignals);
  const eligibleOosPlannedEntries = Math.max(0, rawPlannedEntries - purgedBoundaryPlannedEntries);
  const metrics = aggregateValidationMetrics(tradeResults, {
    rawSignals,
    rawPlannedEntries,
    eligibleOosSignals,
    eligibleOosPlannedEntries,
    noEntries,
    missedEntryCount,
    purgedBoundarySignals,
    purgedBoundaryPlannedEntries,
    missedEntries
  });
  return {
    ...fold,
    rawSignals,
    rawPlannedEntries,
    eligibleOosSignals,
    eligibleOosPlannedEntries,
    signals: eligibleOosSignals,
    plannedEntries: eligibleOosPlannedEntries,
    noEntries,
    missedEntries: missedEntryCount,
    purgedBoundarySignals,
    purgedBoundaryPlannedEntries,
    completeTrades: metrics.completeTrades,
    degradedTrades: metrics.degradedTrades,
    ambiguousTrades: metrics.ambiguousTrades,
    fundingIncompleteTrades: metrics.fundingIncompleteTrades,
    intrabarIncompleteTrades: metrics.intrabarIncompleteTrades,
    exchangeFilterIncompleteTrades: metrics.exchangeFilterIncompleteTrades,
    assetCount: metrics.assetCount,
    longTrades: metrics.longTrades,
    shortTrades: metrics.shortTrades,
    winRate: metrics.winRate,
    avgWinR: metrics.avgWinR,
    avgLossR: metrics.avgLossR,
    payoffRatio: metrics.payoffRatio,
    profitFactor: metrics.profitFactor,
    expectancyR: metrics.expectancyR,
    averageNetReturn: metrics.averageNetReturn,
    totalNetReturn: metrics.totalNetReturn,
    maxDrawdown: metrics.maxDrawdown,
    feeDrag: metrics.feeDrag,
    spreadDrag: metrics.spreadDrag,
    slippageDrag: metrics.slippageDrag,
    fundingDrag: metrics.fundingDrag,
    dataQuality: metrics.dataQuality,
    tradeResults,
    missedEntryRecords: missedEntries,
    backtestDataQuality: backtest.dataQuality
  };
}

function clipFundingCoverage(coverage, events, testEnd) {
  const requestedStart = toTimestamp(coverage?.requestedStart);
  const originalEnd = toTimestamp(coverage?.requestedEnd);
  const requestedEnd = Number.isFinite(originalEnd)
    ? Math.min(originalEnd, testEnd)
    : testEnd;
  const originalCoverageStart = toTimestamp(coverage?.coverageStart);
  const originalCoverageEnd = toTimestamp(coverage?.coverageEnd);
  const requestedRangeValid = Number.isFinite(requestedStart)
    && Number.isFinite(requestedEnd)
    && requestedEnd >= requestedStart;
  const coverageWindowCoversRequestedRange = Number.isFinite(originalCoverageStart)
    && Number.isFinite(originalCoverageEnd)
    && originalCoverageStart <= requestedStart
    && originalCoverageEnd >= requestedEnd;
  const normalizedGaps = (Array.isArray(coverage?.gaps) ? coverage.gaps : [])
    .map((gap) => ({
      ...gap,
      start: toTimestamp(gap?.start ?? gap?.requestedStart),
      end: toTimestamp(gap?.end ?? gap?.requestedEnd)
    }))
    .filter((gap) => Number.isFinite(gap.start)
      && Number.isFinite(gap.end)
      && gap.end > gap.start
      && gap.start < requestedEnd
      && (!Number.isFinite(requestedStart) || gap.end > requestedStart))
    .map((gap) => ({
      ...gap,
      start: Number.isFinite(requestedStart) ? Math.max(gap.start, requestedStart) : gap.start,
      end: Math.min(gap.end, requestedEnd)
    }));
  const coverageCanBeComplete = coverage?.complete === true
    && requestedRangeValid
    && coverageWindowCoversRequestedRange
    && normalizedGaps.length === 0;
  return buildFundingCoverage({
    requestedStart,
    requestedEnd,
    events,
    complete: coverageCanBeComplete,
    gaps: normalizedGaps,
    source: coverage?.source || "m3_bounded",
    status: coverage?.status
  });
}

function filterTimestampedRows(rows, end, field) {
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => Number(row?.[field]) <= end)
    .map((row) => ({ ...row }));
}

function sumField(rows, field) {
  return rows.reduce((sum, row) => sum + (Number(row?.[field]) || 0), 0);
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

function toTimestamp(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value instanceof Date) return value.getTime();
  if (value == null || value === "") return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}
