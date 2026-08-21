import assert from "node:assert/strict";
import { buildFundingCoverage } from "../lib/market-data/funding-history.js";
import { validateFundingCoverageForTrade } from "../lib/backtest/execution-model.js";
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
import { runM3UniverseValidation } from "../lib/validation/validation-engine.js";
import { runFinalHoldoutValidation } from "../lib/validation/holdout.js";
import {
  ELIGIBLE_OOS,
  NOT_APPLICABLE,
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
    maxHoldingTime,
    referencePrice: 100,
    stopLoss: 95,
    takeProfit: 105
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

function testInvalidPlanAndPurgedDenominator() {
  const bounds = { testStart: BASE + 10 * HOUR, testEnd: BASE + 20 * HOUR };
  const invalidPlan = {
    status: "NO_ENTRY",
    reason: "invalid_trade_plan",
    signalCandleOpenTime: BASE + 12 * HOUR,
    signalAvailableAt: null,
    entryEligibleAt: null,
    maxHoldingTime: null
  };
  const invalidClassification = classifyOosBoundary(invalidPlan, bounds);
  assert.equal(invalidClassification.status, NOT_APPLICABLE);
  assert.equal(invalidClassification.inTestWindow, true);
  const invalidPartition = partitionByOosBoundary([invalidPlan], bounds);
  assert.equal(invalidPartition.purged.length, 0);
  assert.equal(invalidPartition.notApplicable.length, 1);

  const invalidFrozenPlan = {
    status: "NO_ENTRY",
    reason: "invalid_trade_plan",
    tradeSpec: {
      signalAvailableAt: BASE + 12 * HOUR,
      entryEligibleAt: BASE + 12 * HOUR,
      maxHoldingTime: null,
      referencePrice: 100,
      stopLoss: 95,
      takeProfit: 105
    }
  };
  assert.equal(classifyOosBoundary(invalidFrozenPlan, bounds).status, NOT_APPLICABLE);
  assert.equal(partitionByOosBoundary([invalidFrozenPlan], bounds).purged.length, 0);

  const frozenSpecCrossingEnd = specTimes({ maxHoldingTime: BASE + 21 * HOUR });
  assert.equal(classifyOosBoundary({ tradeSpec: frozenSpecCrossingEnd }, bounds).status, PURGED_BOUNDARY);

  const denominatorMetrics = aggregateValidationMetrics([], {
    rawSignals: 100,
    rawPlannedEntries: 90,
    eligibleOosSignals: 90,
    eligibleOosPlannedEntries: 80,
    purgedBoundarySignals: 10,
    noEntries: 9,
    missedEntryCount: 0
  });
  assert.equal(denominatorMetrics.rawSignals, 100);
  assert.equal(denominatorMetrics.eligibleOosSignals, 90);
  assert.equal(denominatorMetrics.purgedBoundarySignals, 10);
  assert.equal(denominatorMetrics.noEntryRate, 0.1);

  const eligibleTrade = completeTrade({ netReturnPct: 0.1, realizedR: 1 });
  const unaffected = aggregateValidationMetrics([eligibleTrade], {
    rawSignals: 2,
    eligibleOosSignals: 1,
    purgedBoundarySignals: 1
  });
  assert.equal(unaffected.completeTrades, 1);
  assert.equal(unaffected.expectancyR, 1);
  assert.equal(unaffected.profitFactor, Infinity);
  assert.equal(unaffected.winRate, 1);
  assert.equal(unaffected.noEntryRate, 0);
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

function testFundingCoverageIsTradeScoped() {
  const completeCoverage = buildFundingCoverage({
    requestedStart: BASE,
    requestedEnd: BASE + 10 * HOUR,
    events: [
      { time: BASE + 5 * HOUR, rate: 0.001 },
      { time: BASE + 8 * HOUR, rate: -0.001 }
    ],
    complete: true
  });
  const boundedToFold = boundBacktestOptionsToEnd({
    fundingEvents: [
      { time: BASE + 5 * HOUR, rate: 0.001 },
      { time: BASE + 8 * HOUR, rate: -0.001 },
      { time: BASE + 30 * HOUR, rate: 0.003 }
    ],
    fundingCoverage: completeCoverage
  }, BASE + 20 * HOUR);
  assert.equal(boundedToFold.fundingCoverage.requestedEnd, BASE + 10 * HOUR);
  assert.equal(boundedToFold.fundingCoverage.complete, true);
  assert.equal(validateFundingCoverageForTrade({
    fundingCoverage: boundedToFold.fundingCoverage,
    entryTime: BASE + 2 * HOUR,
    exitTime: BASE + 8 * HOUR
  }).valid, true, "a complete [0h,10h] window must cover a [2h,8h] trade");
  assert.equal(validateFundingCoverageForTrade({
    fundingCoverage: boundedToFold.fundingCoverage,
    entryTime: BASE + 9 * HOUR,
    exitTime: BASE + 12 * HOUR
  }).valid, false, "a trade beyond coverage must remain incomplete");
  assert.equal(boundedToFold.fundingEvents.length, 2, "future funding must not enter a bounded fold");

  const boundedToFiveHours = boundBacktestOptionsToEnd({
    fundingEvents: completeCoverage ? [
      { time: BASE + 5 * HOUR, rate: 0.001 },
      { time: BASE + 8 * HOUR, rate: -0.001 }
    ] : [],
    fundingCoverage: completeCoverage
  }, BASE + 5 * HOUR);
  assert.equal(boundedToFiveHours.fundingCoverage.requestedEnd, BASE + 5 * HOUR);
  assert.ok(boundedToFiveHours.fundingEvents.every((event) => event.time <= BASE + 5 * HOUR));
  assert.equal(boundedToFiveHours.fundingEvents.some((event) => event.time === BASE + 8 * HOUR), false);

  const shortCoverageEnd = boundBacktestOptionsToEnd({
    fundingEvents: completeCoverage ? [{ time: BASE + 5 * HOUR, rate: 0.001 }] : [],
    fundingCoverage: { ...completeCoverage, coverageEnd: BASE + 9 * HOUR }
  }, BASE + 20 * HOUR);
  assert.equal(shortCoverageEnd.fundingCoverage.complete, false, "coverageEnd below requestedEnd must be incomplete");

  const withoutFutureSignal = boundBacktestOptionsToEnd({
    fundingEvents: [{ time: BASE + 5 * HOUR, rate: 0.001 }],
    fundingCoverage: completeCoverage
  }, BASE + 20 * HOUR);
  const withFutureSignal = boundBacktestOptionsToEnd({
    fundingEvents: [
      { time: BASE + 5 * HOUR, rate: 0.001 },
      { time: BASE + 50 * HOUR, rate: 0.5 }
    ],
    fundingCoverage: completeCoverage
  }, BASE + 20 * HOUR);
  assert.deepEqual(
    validateFundingCoverageForTrade({
      fundingCoverage: withoutFutureSignal.fundingCoverage,
      entryTime: BASE + 2 * HOUR,
      exitTime: BASE + 8 * HOUR
    }),
    validateFundingCoverageForTrade({
      fundingCoverage: withFutureSignal.fundingCoverage,
      entryTime: BASE + 2 * HOUR,
      exitTime: BASE + 8 * HOUR
    }),
    "future signals/events must not change historical trade coverage"
  );

  const holdoutCoverage = buildFundingCoverage({
    requestedStart: BASE,
    requestedEnd: BASE + 110 * HOUR,
    events: [{ time: BASE + 104 * HOUR, rate: 0.001 }],
    complete: true
  });
  const boundedHoldout = boundBacktestOptionsToEnd({
    fundingEvents: holdoutCoverage ? [{ time: BASE + 104 * HOUR, rate: 0.001 }] : [],
    fundingCoverage: holdoutCoverage
  }, BASE + 200 * HOUR);
  assert.equal(boundedHoldout.fundingCoverage.complete, true);
  assert.equal(validateFundingCoverageForTrade({
    fundingCoverage: boundedHoldout.fundingCoverage,
    entryTime: BASE + 100 * HOUR,
    exitTime: BASE + 108 * HOUR
  }).valid, true, "holdout trade inside coverage must remain complete");

  const overlappingGap = buildFundingCoverage({
    ...completeCoverage,
    gaps: [{ start: BASE + 6 * HOUR, end: BASE + 7 * HOUR, reason: "gap" }]
  });
  const boundedOverlappingGap = boundBacktestOptionsToEnd({
    fundingEvents: [{ time: BASE + 5 * HOUR, rate: 0.001 }],
    fundingCoverage: overlappingGap
  }, BASE + 20 * HOUR);
  assert.equal(validateFundingCoverageForTrade({
    fundingCoverage: boundedOverlappingGap.fundingCoverage,
    entryTime: BASE + 2 * HOUR,
    exitTime: BASE + 8 * HOUR
  }).valid, false, "a funding gap overlapping the trade must fail closed");

  const nonOverlappingGap = buildFundingCoverage({
    ...completeCoverage,
    gaps: [{ start: BASE + 12 * HOUR, end: BASE + 13 * HOUR, reason: "gap" }]
  });
  const boundedNonOverlappingGap = boundBacktestOptionsToEnd({
    fundingEvents: [{ time: BASE + 5 * HOUR, rate: 0.001 }],
    fundingCoverage: nonOverlappingGap
  }, BASE + 20 * HOUR);
  assert.equal(validateFundingCoverageForTrade({
    fundingCoverage: boundedNonOverlappingGap.fundingCoverage,
    entryTime: BASE + 2 * HOUR,
    exitTime: BASE + 8 * HOUR
  }).valid, true, "a funding gap outside the trade must not fail it");
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
      rawSignals: 8,
      rawPlannedEntries: 6,
      eligibleOosSignals: 6,
      eligibleOosPlannedEntries: 4,
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
  assert.equal(metrics.rawSignals, 8);
  assert.equal(metrics.eligibleOosSignals, 6);
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
  const oneAssetTrades = Array.from({ length: 60 }, (_, index) =>
    completeTrade({
      asset: "ONLY",
      foldId: "fold-" + (index % 5 + 1),
      netReturnPct: 0.01,
      realizedR: 0.2
    })
  );
  const oneAssetStability = buildValidationStability({
    tradeResults: oneAssetTrades,
    assetUniverseSize: 1,
    evaluatedAssets: ["ONLY"],
    folds: Array.from({ length: 5 }, (_, index) => ({
      foldId: "fold-" + (index + 1),
      expectancyR: 0.2
    }))
  });
  assert.equal(oneAssetStability.assetConcentrationApplicable, false);
  assert.equal(oneAssetStability.assetConcentration, "NOT_APPLICABLE_SINGLE_ASSET");
  assert.equal(oneAssetStability.flags.singleAssetDominance, false);
  assert.equal(
    determineValidationVerdict({
      aggregate: { completeTrades: 60, expectancyR: 0.2, profitFactor: 1.5 },
      holdout: { completeTrades: 20, expectancyR: 0.1, profitFactor: 1.2 },
      folds: goodFolds,
      stability: oneAssetStability
    }),
    VALIDATION_VERDICTS.PROMISING_EDGE
  );

  const threeAssetTrades = ["A", "B", "C"].flatMap((asset) =>
    Array.from({ length: 20 }, (_, index) =>
      completeTrade({
        asset,
        foldId: "fold-" + (index % 5 + 1),
        netReturnPct: 0.01,
        realizedR: 0.2
      })
    )
  );
  const threeAssetStability = buildValidationStability({
    tradeResults: threeAssetTrades,
    assetUniverseSize: 3,
    evaluatedAssets: ["A", "B", "C"],
    folds: goodFolds
  });
  assert.equal(threeAssetStability.assetConcentrationApplicable, true);
  assert.equal(threeAssetStability.flags.singleAssetDominance, false);
  assert.equal(threeAssetStability.flags.concentrationRisk, false);

  const dominatedTrades = [
    ...Array.from({ length: 40 }, (_, index) => completeTrade({
      asset: "A",
      foldId: "fold-" + (index % 5 + 1),
      netReturnPct: 0.02,
      realizedR: 0.2
    })),
    ...Array.from({ length: 10 }, (_, index) => completeTrade({
      asset: "B",
      foldId: "fold-" + (index % 5 + 1),
      netReturnPct: 0.01,
      realizedR: 0.2
    })),
    ...Array.from({ length: 10 }, (_, index) => completeTrade({
      asset: "C",
      foldId: "fold-" + (index % 5 + 1),
      netReturnPct: 0.01,
      realizedR: 0.2
    }))
  ];
  const dominatedStability = buildValidationStability({
    tradeResults: dominatedTrades,
    assetUniverseSize: 3,
    evaluatedAssets: ["A", "B", "C"],
    folds: goodFolds
  });
  assert.equal(dominatedStability.flags.singleAssetDominance, true);
  assert.equal(dominatedStability.flags.concentrationRisk, true);
  assert.equal(
    determineValidationVerdict({
      aggregate: { completeTrades: 60, expectancyR: 0.2, profitFactor: 1.5 },
      holdout: { completeTrades: 20, expectancyR: 0.1, profitFactor: 1.2 },
      folds: goodFolds,
      stability: dominatedStability
    }),
    VALIDATION_VERDICTS.UNSTABLE
  );

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

function testMultiAssetOrchestration() {
  const result = runM3UniverseValidation({
    datasets: ["A", "B", "C"].map((asset) => ({
      asset,
      candles: history(60),
      backtestOptions: {
        marketType: "spot",
        tradePlanType: "spot",
        executionModel: { exchangeRulesRequired: false }
      }
    })),
    strategy: observedStrategy([]),
    interval: "1h",
    folds: 5,
    holdoutPct: 0.2
  });
  assert.deepEqual(result.assets, ["A", "B", "C"]);
  assert.equal(result.assetUniverseSize, 3);
  assert.equal(result.stability.assetUniverseSize, 3);
  assert.equal(result.stability.assetConcentrationApplicable, true);
  assert.equal(result.stability.flags.singleAssetDominance, false);
  assert.equal(result.stability.flags.concentrationRisk, false);
  assert.equal(result.flags.holdoutUsedForOptimization, false);
}

testChronologicalSplitAndFolds();
testPurgeRules();
testInvalidPlanAndPurgedDenominator();
testBoundedContextAndNoFutureInputs();
testFundingCoverageIsTradeScoped();
testQualityAndMetricRecomputation();
testStabilityAndVerdicts();
testHoldoutRunsAfterDevelopmentOnly();
testMultiAssetOrchestration();

console.log("M3 validation tests passed");
