import assert from "node:assert/strict";
import { buildFundingCoverage } from "../lib/market-data/funding-history.js";
import {
  aggregateValidationMetrics,
  buildValidationStability,
  determineValidationVerdict,
  VALIDATION_VERDICTS
} from "../lib/validation/validation-metrics.js";
import {
  boundBacktestOptionsToEnd,
  buildExpandingFolds,
  runWalkForwardValidation,
  splitChronologicalData
} from "../lib/validation/walk-forward.js";
import { runFinalHoldoutValidation } from "../lib/validation/holdout.js";
import {
  ELIGIBLE_OOS,
  OUTSIDE_TEST_WINDOW,
  PURGED_BOUNDARY,
  classifyOosBoundary,
  partitionByOosBoundary
} from "../lib/validation/purge.js";

const HOUR = 3600 * 1000;
const BASE = Date.UTC(2026, 0, 1);

function candle(openTime, high = 101, low = 99) {
  return {
    openTime,
    open: 100,
    high,
    low,
    close: 100,
    markPrice: 100
  };
}

function history(count = 60) {
  return Array.from({ length: count }, (_, index) => {
    const cycle = index % 6;
    return candle(BASE + index * HOUR, cycle === 4 ? 106 : 101, 99);
  });
}

function observedStrategy(observations = []) {
  return {
    id: "m3_test_strategy",
    direction: "LONG",
    holdHours: 4,
    evaluate(candles, index) {
      observations.push({
        index,
        maxVisibleOpenTime: Number(candles.at(-1)?.openTime)
      });
      return { passed: index >= 2 && index % 6 === 2 };
    }
  };
}

function completeTrade({
  netReturnPct = 0.01,
  realizedR = 1,
  asset = "BTCUSDT",
  side = "LONG",
  foldId = "fold-1"
} = {}) {
  return {
    strategyId: "m3_test",
    asset,
    side,
    foldId,
    dataQuality: "COMPLETE",
    ambiguousIntrabar: false,
    netReturnPct,
    realizedR,
    totalFeePct: 0.001,
    spreadCostPct: 0.0005,
    slippageCostPct: 0.0005,
    fundingPct: 0
  };
}

function specTimes({
  signalAvailableAt = BASE + 10 * HOUR,
  entryEligibleAt = signalAvailableAt,
  maxHoldingTime = BASE + 20 * HOUR
} = {}) {
  return {
    signalAvailableAt,
    entryEligibleAt,
    maxHoldingTime
  };
}

function testChronologicalSplitAndFolds() {
  const candles = history(10).reverse();
  const split = splitChronologicalData(candles, { holdoutPct: 0.2, interval: "1h" });
  assert.deepEqual(
    split.candles.map((row) => row.openTime),
    history(10).map((row) => row.openTime),
    "split must sort chronologically without shuffling"
  );
  assert.equal(split.developmentCandles.length, 8);
  assert.equal(split.holdoutCandles.length, 2);
  assert.equal(split.holdoutPct, 0.2);
  assert.equal(split.developmentStart, BASE);
  assert.equal(split.developmentEnd, split.holdoutStart);
  assert.equal(split.holdoutEnd, BASE + 10 * HOUR);

  const folds = buildExpandingFolds({
    candles: split.developmentCandles,
    folds: 5,
    interval: "1h"
  });
  assert.equal(folds.length, 5);
  for (let index = 0; index < folds.length; index++) {
    assert.ok(folds[index].contextStart <= folds[index].testStart);
    assert.equal(folds[index].contextEnd, folds[index].testStart);
    assert.ok(folds[index].testStart < folds[index].testEnd);
    if (index > 0) {
      assert.ok(folds[index - 1].testEnd <= folds[index].testStart);
      assert.ok(folds[index - 1].testStart < folds[index].testStart);
    }
  }
}

function testPurgeRules() {
  const bounds = { testStart: BASE + 10 * HOUR, testEnd: BASE + 20 * HOUR };
  assert.equal(
    classifyOosBoundary(specTimes(), bounds).status,
    ELIGIBLE_OOS
  );
  assert.equal(
    classifyOosBoundary(specTimes({
      signalAvailableAt: BASE + 9 * HOUR,
      entryEligibleAt: BASE + 10 * HOUR
    }), bounds).status,
    PURGED_BOUNDARY,
    "pre-test signal must not become an OOS trade"
  );
  assert.equal(
    classifyOosBoundary(specTimes({
      maxHoldingTime: BASE + 21 * HOUR
    }), bounds).status,
    PURGED_BOUNDARY,
    "a frozen holding period crossing testEnd must be purged"
  );
  assert.equal(
    classifyOosBoundary(specTimes({
      signalAvailableAt: BASE + 20 * HOUR,
      entryEligibleAt: BASE + 20 * HOUR
    }), bounds).status,
    OUTSIDE_TEST_WINDOW
  );
  const partition = partitionByOosBoundary([
    specTimes(),
    specTimes({ maxHoldingTime: BASE + 21 * HOUR })
  ], bounds);
  assert.equal(partition.eligible.length, 1);
  assert.equal(partition.purged.length, 1);
}

function testBoundedContextAndNoFutureInputs() {
  const testEnd = BASE + 10 * HOUR;
  const coverage = buildFundingCoverage({
    requestedStart: BASE,
    requestedEnd: BASE + 50 * HOUR,
    events: [
      { time: BASE + 5 * HOUR, rate: 0.001 },
      { time: BASE + 30 * HOUR, rate: 0.002 }
    ],
    complete: true
  });
  const bounded = boundBacktestOptionsToEnd({
    fundingEvents: coverage ? [
      { time: BASE + 5 * HOUR, rate: 0.001 },
      { time: BASE + 30 * HOUR, rate: 0.002 }
    ] : [],
    fundingCoverage: coverage,
    lowerTimeframeCandles: [
      candle(BASE + 9 * HOUR),
      candle(BASE + 10 * HOUR),
      candle(BASE + 30 * HOUR)
    ]
  }, testEnd);
  assert.ok(bounded.fundingEvents.every((event) => event.time <= testEnd));
  assert.ok(bounded.lowerTimeframeCandles.every((row) => row.openTime < testEnd));
  assert.equal(bounded.fundingCoverage.requestedEnd, testEnd);

  const observations = [];
  const split = splitChronologicalData(history(), { holdoutPct: 0.2, interval: "1h" });
  const result = runWalkForwardValidation({
    split,
    strategy: observedStrategy(observations),
    interval: "1h",
    folds: 5,
    backtestOptions: {
      marketType: "spot",
      tradePlanType: "spot",
      executionModel: { exchangeRulesRequired: false },
      fundingEvents: [{ time: BASE + 1000 * HOUR, rate: 0.5 }],
      lowerTimeframeCandles: [candle(BASE + 1000 * HOUR)]
    }
  });
  assert.ok(result.folds.length);
  assert.ok(observations.length);
  assert.ok(observations.every((row) => row.maxVisibleOpenTime < split.holdoutStart));
  assert.ok(observations.every((row) =>
    row.maxVisibleOpenTime <= BASE + row.index * HOUR
  ), "strategy evaluation must not see candles after the current index");
}

function testQualityAndMetricRecomputation() {
  const longWin = completeTrade({ netReturnPct: 0.1, realizedR: 1, side: "LONG" });
  const shortLoss = completeTrade({
    netReturnPct: -0.05,
    realizedR: -0.5,
    side: "SHORT",
    asset: "ETHUSDT",
    foldId: "fold-2"
  });
  const fundingDegraded = {
    ...completeTrade({ netReturnPct: 0.2, realizedR: 2 }),
    dataQuality: "INCOMPLETE_FUNDING",
    dataQualityComponents: { funding: "INCOMPLETE_FUNDING" }
  };
  const ambiguous = {
    ...completeTrade({ netReturnPct: 0.3, realizedR: 3 }),
    ambiguousIntrabar: true
  };
  const metrics = aggregateValidationMetrics(
    [longWin, shortLoss, fundingDegraded, ambiguous],
    {
      signals: 6,
      plannedEntries: 6,
      missedEntries: [{ status: "NO_ENTRY" }, { status: "MISSED_ENTRY" }],
      purgedBoundarySignals: 2
    }
  );
  assert.equal(metrics.trades, 2);
  assert.equal(metrics.completeTrades, 2);
  assert.equal(metrics.degradedTrades, 2);
  assert.equal(metrics.fundingIncompleteTrades, 1);
  assert.equal(metrics.ambiguousTrades, 1);
  assert.equal(metrics.noEntries, 1);
  assert.equal(metrics.missedEntries, 1);
  assert.equal(metrics.purgedBoundarySignals, 2);
  assert.equal(metrics.profitFactor, 2);
  assert.equal(metrics.expectancyR, 0.25);
  assert.equal(metrics.noEntryRate, 2 / 6);
  assert.equal(metrics.trades, 2, "NO_ENTRY/MISSED_ENTRY must not become losses");
}

function testStabilityAndVerdicts() {
  const concentrationTrades = [
    completeTrade({ asset: "A", side: "LONG", foldId: "fold-1" }),
    completeTrade({ asset: "A", side: "SHORT", foldId: "fold-2" }),
    completeTrade({ asset: "A", side: "LONG", foldId: "fold-3" }),
    completeTrade({ asset: "B", side: "SHORT", foldId: "fold-4" })
  ];
  const stability = buildValidationStability({
    tradeResults: concentrationTrades,
    folds: [
      { foldId: "fold-1", expectancyR: 1 },
      { foldId: "fold-2", expectancyR: 1 },
      { foldId: "fold-3", expectancyR: 1 },
      { foldId: "fold-4", expectancyR: 1 }
    ]
  });
  assert.equal(stability.byAsset.length, 2);
  assert.equal(stability.bySide.length, 2);
  assert.equal(stability.flags.singleAssetDominance, true);
  assert.equal(stability.flags.concentrationRisk, true);
  assert.equal(stability.positiveReturnConcentration.dominantKey, "A");

  const goodFolds = Array.from({ length: 5 }, (_, index) => ({
    foldId: "fold-" + (index + 1),
    expectancyR: 0.2,
    profitFactor: 2
  }));
  const baseAggregate = {
    completeTrades: 60,
    expectancyR: 0.2,
    profitFactor: 1.5
  };
  const baseHoldout = {
    completeTrades: 20,
    expectancyR: 0.1,
    profitFactor: 1.2
  };
  const noConcentration = { flags: {} };
  assert.equal(
    determineValidationVerdict({
      aggregate: { ...baseAggregate, completeTrades: 59 },
      holdout: baseHoldout,
      folds: goodFolds,
      stability: noConcentration
    }),
    VALIDATION_VERDICTS.INSUFFICIENT_DATA
  );
  assert.equal(
    determineValidationVerdict({
      aggregate: { ...baseAggregate, expectancyR: 0 },
      holdout: baseHoldout,
      folds: goodFolds,
      stability: noConcentration
    }),
    VALIDATION_VERDICTS.NEGATIVE_EDGE
  );
  assert.equal(
    determineValidationVerdict({
      aggregate: baseAggregate,
      holdout: baseHoldout,
      folds: [
        { expectancyR: -0.1 },
        { expectancyR: -0.1 },
        { expectancyR: -0.1 },
        { expectancyR: 0.2 },
        { expectancyR: 0.2 }
      ],
      stability: noConcentration
    }),
    VALIDATION_VERDICTS.UNSTABLE
  );
  assert.equal(
    determineValidationVerdict({
      aggregate: baseAggregate,
      holdout: baseHoldout,
      folds: goodFolds,
      stability: noConcentration
    }),
    VALIDATION_VERDICTS.PROMISING_EDGE
  );
}

function testHoldoutRunsAfterDevelopmentOnly() {
  const observations = [];
  const split = splitChronologicalData(history(60), { holdoutPct: 0.2, interval: "1h" });
  const strategy = observedStrategy(observations);
  const development = runWalkForwardValidation({
    split,
    strategy,
    interval: "1h",
    folds: 5,
    backtestOptions: {
      marketType: "spot",
      tradePlanType: "spot",
      executionModel: { exchangeRulesRequired: false }
    }
  });
  const developmentObservationCount = observations.length;
  const holdout = runFinalHoldoutValidation({
    split,
    strategy,
    interval: "1h",
    backtestOptions: {
      marketType: "spot",
      tradePlanType: "spot",
      executionModel: { exchangeRulesRequired: false }
    }
  });
  assert.ok(developmentObservationCount > 0);
  assert.ok(observations.slice(0, developmentObservationCount)
    .every((row) => row.maxVisibleOpenTime < split.holdoutStart));
  assert.equal(holdout.holdoutStart, split.holdoutStart);
  assert.equal(holdout.flags.holdoutUsedForOptimization, false);
}

testChronologicalSplitAndFolds();
testPurgeRules();
testBoundedContextAndNoFutureInputs();
testQualityAndMetricRecomputation();
testStabilityAndVerdicts();
testHoldoutRunsAfterDevelopmentOnly();

console.log("M3 validation tests passed");
