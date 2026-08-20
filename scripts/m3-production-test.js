import assert from "node:assert/strict";
import { CONFIG } from "../lib/config.js";
import {
  evaluateDynamicProductionOpportunity,
  evaluateDynamicProductionSignal,
  isDynamicStrongPoolCandidate,
  isDynamicWeakPoolCandidate,
  rankDynamicPoolTickers
} from "../lib/strategies/dynamic-production.js";
import {
  evaluateDynamicProductionSignalForStrategy,
  evaluateDynamicSpotOpportunity,
  isDynamicSpotCandidate,
  isDynamicWeakSpotCandidate
} from "../lib/scanner.js";
import { runBacktest } from "../lib/backtest/backtest-engine.js";
import {
  compareDynamicOrderBookAvailability,
  createDynamicProductionReplayStrategy,
  ORDER_BOOK_AVAILABILITY,
  replayDynamicProductionSignals
} from "../lib/validation/dynamic-production-replay.js";
import { runM3DynamicProductionValidation } from "../lib/validation/validation-engine.js";

const HOUR = 3600 * 1000;
const BASE = Date.UTC(2026, 0, 1);

function makeCandles(kind = "strong", length = 80) {
  return Array.from({ length }, (_, index) => {
    const openTime = BASE + index * HOUR;
    const isTarget = index === 48;
    const isEntry = index === 49;
    const close = isTarget
      ? kind === "strong" ? 108 : 91.9
      : isEntry
        ? kind === "strong" ? 108 : 91.9
        : 100;
    const open = isEntry ? close : 100;
    return {
      openTime,
      open,
      high: isTarget
        ? kind === "strong" ? 109 : 101
        : isEntry
          ? kind === "strong" ? 109 : 93
          : 101,
      low: isTarget
        ? kind === "strong" ? 99 : 91
        : isEntry
          ? kind === "strong" ? 107 : 91
          : 99,
      close,
      volume: isTarget
        ? kind === "strong" ? 150000 : 275000
        : 100000
    };
  });
}

function makeBenchmarkCandles(change = 0, length = 30) {
  return Array.from({ length }, (_, index) => ({
    openTime: BASE + index * 4 * HOUR,
    open: index === 11 ? 100 * (1 + change) : 100,
    high: index === 11 ? 101 * (1 + change) : 101,
    low: index === 11 ? 99 * (1 + change) : 99,
    close: index === 11 ? 100 * (1 + change) : 100,
    volume: 100000
  }));
}

function makeReplayOptions({
  kind = "strong",
  asset = kind === "strong" ? "DYNSTRONGUSDT" : "DYNWEAKUSDT",
  orderBookAvailability = ORDER_BOOK_AVAILABILITY.AVAILABLE,
  benchmark = null,
  historicalUniverse = [{ time: BASE, assets: [asset] }],
  universeSource = "historical_listed_universe"
} = {}) {
  return {
    datasets: [{ asset, candles: makeCandles(kind) }],
    strategyId: kind === "strong"
      ? "dynamic_relative_strength_breakout"
      : "dynamic_relative_weakness_breakdown",
    interval: "1h",
    benchmarkCandles: benchmark || makeBenchmarkCandles(kind === "strong" ? -0.04 : 0),
    benchmarkInterval: "4h",
    orderBookAvailability,
    existingAssets: [],
    futuresSymbols: [asset],
    historicalUniverse,
    universeSource,
    dataSource: "deterministic_test_fixture"
  };
}

function signalTimes(replay) {
  return replay.signals.map((signal) => [
    signal.asset,
    signal.strategyId,
    signal.signalCandleOpenTime,
    signal.recommendationScore
  ]);
}

function testSharedStrongWeakParity() {
  const strongInput = {
    strategyId: "dynamic_relative_strength_breakout",
    momentum24h: 0.08,
    relativeStrength: 0.08,
    volumeMultiple: 1.75,
    breakout: true,
    hasOrderBook: true
  };
  assert.deepEqual(
    evaluateDynamicSpotOpportunity({
      momentum24h: strongInput.momentum24h,
      relativeStrength: strongInput.relativeStrength,
      volumeMultiple: strongInput.volumeMultiple,
      breakout: strongInput.breakout,
      hasOrderBook: strongInput.hasOrderBook
    }),
    evaluateDynamicProductionOpportunity(strongInput)
  );
  assert.equal(
    isDynamicSpotCandidate({ symbol: "DYNUSDT", priceChangePercent: 9, quoteVolume: 60_000_000 }, new Set(), new Set(["DYNUSDT"])),
    isDynamicStrongPoolCandidate({ symbol: "DYNUSDT", priceChangePercent: 9, quoteVolume: 60_000_000 }, new Set(), new Set(["DYNUSDT"]))
  );

  const weakInput = {
    strategyId: "dynamic_relative_weakness_breakdown",
    momentum24h: -0.08,
    relativeWeakness: -0.08,
    volumeMultiple: 2.75,
    breakdown: true,
    hasOrderBook: false
  };
  assert.deepEqual(
    evaluateDynamicProductionSignalForStrategy({
      strategyId: weakInput.strategyId,
      candles: makeCandles("weak"),
      signalIndex: 48,
      benchmarkChange24h: 0,
      hasOrderBook: weakInput.hasOrderBook
    }),
    evaluateDynamicProductionSignal({
      strategyId: weakInput.strategyId,
      candles: makeCandles("weak"),
      signalIndex: 48,
      benchmarkChange24h: 0,
      hasOrderBook: weakInput.hasOrderBook
    })
  );
  assert.equal(
    isDynamicWeakSpotCandidate({ symbol: "DYNUSDT", priceChangePercent: -9, quoteVolume: 60_000_000 }, new Set(), new Set(["DYNUSDT"])),
    isDynamicWeakPoolCandidate({ symbol: "DYNUSDT", priceChangePercent: -9, quoteVolume: 60_000_000 }, new Set(), new Set(["DYNUSDT"]))
  );
}

function testPoolEligibilityRankingAndMaxAssets() {
  const tickers = [
    { symbol: "AUSDT", priceChangePercent: 9, quoteVolume: 100_000_000 },
    { symbol: "BUSDT", priceChangePercent: 8.5, quoteVolume: 200_000_000 },
    { symbol: "CUSDT", priceChangePercent: 7.9, quoteVolume: 900_000_000 },
    { symbol: "UPUSDT", priceChangePercent: 9, quoteVolume: 100_000_000 },
    { symbol: "EXISTINGUSDT", priceChangePercent: 9, quoteVolume: 100_000_000 }
  ];
  assert.deepEqual(
    rankDynamicPoolTickers({
      tickers,
      direction: "strong",
      existing: new Set(["EXISTINGUSDT"]),
      futuresSymbols: new Set(tickers.map((ticker) => ticker.symbol)),
      maxAssets: 2
    }),
    ["AUSDT", "BUSDT"]
  );
  assert.equal(CONFIG.dynamicSpotPoolMaxAssets, 10);
  assert.equal(CONFIG.dynamicWeakSpotPoolMaxAssets, 10);
}

function testCausalHourlyReconstruction() {
  const options = makeReplayOptions();
  const replay = replayDynamicProductionSignals(options);
  const targetTime = BASE + 49 * HOUR;
  assert.ok(replay.signals.some((signal) => signal.signalAvailableAt === targetTime));
  assert.equal(replay.signals[0].quality.tickerReconstruction, "HOURLY_RECONSTRUCTED");
  assert.equal(replay.signals[0].quality.benchmark, "COMPLETE");
  assert.equal(replay.signals[0].quality.universe, "COMPLETE");
  assert.equal(replay.signals[0].primaryEligible, true);

  const futureChangedCandles = makeCandles("strong");
  futureChangedCandles[49] = {
    ...futureChangedCandles[49],
    close: 250,
    high: 260,
    volume: 9_000_000
  };
  const changed = replayDynamicProductionSignals({
    ...options,
    datasets: [{ asset: "DYNSTRONGUSDT", candles: futureChangedCandles }]
  });
  assert.deepEqual(
    signalTimes(replay).filter((row) => row[2] <= targetTime),
    signalTimes(changed).filter((row) => row[2] <= targetTime)
  );
}

function testNoFutureHighVolumeCoinEntersHistoricalPool() {
  const baseAsset = makeCandles("strong");
  const futureAsset = makeCandles("strong");
  futureAsset[48] = { ...futureAsset[48], close: 100, high: 101, volume: 100000 };
  const replay = replayDynamicProductionSignals({
    ...makeReplayOptions({ asset: "DYNSTRONGUSDT" }),
    datasets: [
      { asset: "DYNSTRONGUSDT", candles: baseAsset },
      { asset: "FUTUREHIGHUSDT", candles: futureAsset }
    ],
    futuresSymbols: ["DYNSTRONGUSDT", "FUTUREHIGHUSDT"],
    historicalUniverse: [{ time: BASE, assets: ["DYNSTRONGUSDT", "FUTUREHIGHUSDT"] }]
  });
  assert.equal(
    replay.signals.some((signal) => signal.asset === "FUTUREHIGHUSDT" && signal.signalAvailableAt <= BASE + 49 * HOUR),
    false
  );
}

function testStrongAndWeakHistoricalSignals() {
  const strong = replayDynamicProductionSignals(makeReplayOptions({ kind: "strong" }));
  const weak = replayDynamicProductionSignals(makeReplayOptions({ kind: "weak" }));
  assert.ok(strong.signals.some((signal) => signal.strategyId === "dynamic_relative_strength_breakout"));
  assert.ok(weak.signals.some((signal) => signal.strategyId === "dynamic_relative_weakness_breakdown"));
  assert.equal(strong.signals[0].recommendationScore >= CONFIG.dynamicTradeMinRecommendationScore, true);
  assert.equal(weak.signals[0].recommendationScore >= CONFIG.dynamicTradeMinRecommendationScore, true);
}

function testOrderBookModesAndSensitivity() {
  const comparison = compareDynamicOrderBookAvailability(makeReplayOptions({ kind: "strong" }));
  assert.equal(comparison.available.orderBookAvailabilityAssumption, "AVAILABLE");
  assert.equal(comparison.unavailable.orderBookAvailabilityAssumption, "UNAVAILABLE");
  assert.ok(comparison.available.signals.length > comparison.unavailable.signals.length);
  assert.equal(comparison.orderBookAvailabilitySensitive, true);
  assert.match(comparison.sensitivityWarning, /order-book/i);
}

function testIncompleteHistoryBenchmarkAndUniverse() {
  const insufficient = replayDynamicProductionSignals({
    ...makeReplayOptions(),
    datasets: [{ asset: "SHORTUSDT", candles: makeCandles("strong", 20) }],
    futuresSymbols: ["SHORTUSDT"],
    historicalUniverse: [{ time: BASE, assets: ["SHORTUSDT"] }]
  });
  assert.equal(insufficient.signals.length, 0);
  assert.equal(insufficient.quality.tickerReconstruction, "INCOMPLETE");

  const incompleteBenchmark = replayDynamicProductionSignals({
    ...makeReplayOptions({ kind: "weak", benchmark: [] }),
    benchmarkCandles: []
  });
  assert.ok(incompleteBenchmark.signals.length > 0);
  assert.equal(incompleteBenchmark.signals[0].quality.benchmark, "INCOMPLETE");
  assert.equal(incompleteBenchmark.signals[0].primaryEligible, false);

  const incompleteUniverse = replayDynamicProductionSignals({
    ...makeReplayOptions(),
    historicalUniverse: null,
    universeSource: "current_configured_futures"
  });
  assert.equal(incompleteUniverse.survivorshipBiasRisk, true);
  assert.equal(incompleteUniverse.universeSource, "current_configured_futures");
  assert.equal(incompleteUniverse.signals[0].quality.universe, "INCOMPLETE");
  assert.equal(incompleteUniverse.signals[0].primaryEligible, false);
  assert.equal(incompleteUniverse.validationVerdict, "PROVISIONAL");
}

function testSignalEntersExistingM2BExecution() {
  const replay = replayDynamicProductionSignals(makeReplayOptions({ kind: "strong" }));
  const dataset = makeCandles("strong");
  const event = replay.signals.find((signal) => signal.signalCandleOpenTime === BASE + 48 * HOUR);
  const strategy = createDynamicProductionReplayStrategy({
    strategyId: replay.strategyId,
    signalTimeline: replay.signals
  });
  assert.equal(strategy.evaluate(dataset, 47).passed, false);
  assert.equal(strategy.evaluate(dataset, 48).passed, true);
  const backtest = runBacktest({
    candles: dataset,
    strategy,
    interval: "1h",
    marketType: "futures",
    tradePlanType: "futures",
    startIndex: 48,
    executionModel: { exchangeRulesRequired: false },
    maxTrades: 1
  });
  assert.equal(backtest.entryStats.signals, 1);
  assert.ok(event);
  assert.equal(backtest.tradeResults.length, 1);
  assert.equal(backtest.tradeResults[0].entryTime, BASE + 49 * HOUR);
  assert.equal(backtest.tradeResults[0].strategyId, replay.strategyId);
}

function testM3ProductionAdapterMetadataAndNoOptimization() {
  const options = makeReplayOptions({ kind: "strong" });
  const result = runM3DynamicProductionValidation({
    ...options,
    folds: 2,
    holdoutPct: 0.2
  });
  assert.equal(result.dynamicPoolReplay, true);
  assert.equal(result.strategyFamily, "dynamic_strength");
  assert.equal(result.flags.holdoutUsedForOptimization, false);
  assert.equal(result.flags.strategyParametersChanged, false);
  assert.equal(result.flags.parameterSearchPerformed, false);
  assert.equal(result.orderBookAvailabilitySensitive, true);
  assert.equal(result.validationVerdict, "PROVISIONAL");
}

testSharedStrongWeakParity();
testPoolEligibilityRankingAndMaxAssets();
testCausalHourlyReconstruction();
testNoFutureHighVolumeCoinEntersHistoricalPool();
testStrongAndWeakHistoricalSignals();
testOrderBookModesAndSensitivity();
testIncompleteHistoryBenchmarkAndUniverse();
testSignalEntersExistingM2BExecution();
testM3ProductionAdapterMetadataAndNoOptimization();

console.log("M3 production dynamic adapter tests passed");
