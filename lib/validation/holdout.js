import { runBacktest } from "../backtest/backtest-engine.js";
import {
  ELIGIBLE_OOS,
  boundaryRecordKey,
  partitionByOosBoundary
} from "./purge.js";
import {
  aggregateValidationMetrics,
  VALIDATION_FLAGS
} from "./validation-metrics.js";
import {
  boundBacktestOptionsToEnd,
  createNoLookaheadStrategy
} from "./walk-forward.js";

export function runFinalHoldoutValidation({
  split,
  strategy,
  interval = split?.interval || "1h",
  asset = null,
  backtestOptions = {}
} = {}) {
  if (!split?.candles?.length || !Number.isFinite(split.holdoutStartIndex)) {
    throw new Error("Final holdout validation requires a chronological split");
  }
  const boundedOptions = boundBacktestOptionsToEnd(backtestOptions, split.holdoutEnd);
  const backtest = runBacktest({
    ...boundedOptions,
    candles: split.candles,
    strategy: createNoLookaheadStrategy(strategy),
    interval,
    asset: asset ?? backtestOptions.asset ?? null,
    startIndex: split.holdoutStartIndex
  });
  const tradePartition = partitionByOosBoundary(backtest.tradeResults, {
    testStart: split.holdoutStart,
    testEnd: split.holdoutEnd
  });
  const missedPartition = partitionByOosBoundary(backtest.missedEntries, {
    testStart: split.holdoutStart,
    testEnd: split.holdoutEnd
  });
  const purgedKeys = new Set([
    ...tradePartition.purged.map(({ record }) => boundaryRecordKey(record)),
    ...missedPartition.purged.map(({ record }) => boundaryRecordKey(record))
  ]);
  const tradeResults = tradePartition.eligible
    .filter(({ status }) => status === ELIGIBLE_OOS)
    .map(({ record }) => ({ ...record, foldId: "holdout" }));
  const missedEntries = missedPartition.eligible
    .filter(({ status }) => status === ELIGIBLE_OOS)
    .map(({ record }) => record);
  const noEntries = missedEntries.filter((entry) => entry.status === "NO_ENTRY").length;
  const missedEntryCount = missedEntries.filter((entry) => entry.status === "MISSED_ENTRY").length;
  const holdoutMetrics = aggregateValidationMetrics(tradeResults, {
    signals: backtest.entryStats?.signals,
    plannedEntries: backtest.entryStats?.planned,
    noEntries,
    missedEntryCount,
    purgedBoundarySignals: purgedKeys.size,
    missedEntries
  });

  return {
    holdoutStart: split.holdoutStart,
    holdoutEnd: split.holdoutEnd,
    holdoutPct: split.holdoutPct,
    signals: Number(backtest.entryStats?.signals) || 0,
    plannedEntries: Number(backtest.entryStats?.planned) || 0,
    noEntries,
    missedEntries: missedEntryCount,
    purgedBoundarySignals: purgedKeys.size,
    holdoutMetrics,
    tradeResults,
    missedEntryRecords: missedEntries,
    backtestDataQuality: backtest.dataQuality,
    flags: { ...VALIDATION_FLAGS }
  };
}
