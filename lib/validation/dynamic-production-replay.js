import { CONFIG } from "../config.js";
import { intervalMilliseconds } from "../trading/trade-spec.js";
import {
  DYNAMIC_PRODUCTION_HOLD_HOURS,
  DYNAMIC_STRATEGY_IDS,
  benchmarkMomentum24hAsOf,
  evaluateDynamicProductionSignal,
  getDynamicProductionDefinition,
  rankDynamicPoolTickers,
  reconstructQuoteVolume24h
} from "../strategies/dynamic-production.js";

export const ORDER_BOOK_AVAILABILITY = Object.freeze({
  AVAILABLE: "AVAILABLE",
  UNAVAILABLE: "UNAVAILABLE"
});

export const DYNAMIC_REPLAY_QUALITY = Object.freeze({
  HOURLY_RECONSTRUCTED: "HOURLY_RECONSTRUCTED",
  COMPLETE: "COMPLETE",
  INCOMPLETE: "INCOMPLETE",
  PROVISIONAL: "PROVISIONAL"
});

export function createDynamicProductionReplayStrategy({
  strategyId,
  signalTimeline = [],
  holdHours = DYNAMIC_PRODUCTION_HOLD_HOURS
} = {}) {
  const definition = getDynamicProductionDefinition(strategyId);
  if (!definition) throw new Error("DYNAMIC_STRATEGY_NOT_FOUND: " + strategyId);
  const eventsByOpenTime = new Map(
    signalTimeline
      .filter((event) => Number.isFinite(Number(event?.signalCandleOpenTime)))
      .map((event) => [Number(event.signalCandleOpenTime), event])
  );
  return {
    id: definition.id,
    name: definition.id,
    direction: definition.direction,
    holdHours,
    evaluate(candles, index) {
      const candle = candles?.[index];
      const event = eventsByOpenTime.get(Number(candle?.openTime));
      return event
        ? { passed: true, details: event.details, dynamicSignal: event }
        : { passed: false, details: {} };
    }
  };
}

export function replayDynamicProductionSignals({
  datasets = [],
  strategyId,
  interval = "1h",
  benchmarkCandles = null,
  benchmarkInterval = "4h",
  orderBookAvailability = ORDER_BOOK_AVAILABILITY.UNAVAILABLE,
  existingAssets = [],
  futuresSymbols = null,
  historicalUniverse = null,
  universeSource = "current_configured_futures",
  dataSource = "historical_validation_input"
} = {}) {
  if (!DYNAMIC_STRATEGY_IDS.includes(strategyId)) {
    throw new Error("DYNAMIC_STRATEGY_NOT_FOUND: " + strategyId);
  }
  const normalizedDatasets = normalizeDatasets(datasets);
  if (!normalizedDatasets.length) throw new Error("DYNAMIC_REPLAY_DATA_REQUIRED");
  const benchmark = normalizeCandles(
    benchmarkCandles
      || normalizedDatasets[0]?.benchmarkCandles
      || normalizedDatasets.find((dataset) => dataset.asset === "BTCUSDT")?.candles
      || []
  );
  const normalizedOrderBookAvailability = normalizeOrderBookAvailability(orderBookAvailability);
  const availableOrderBook = normalizedOrderBookAvailability === ORDER_BOOK_AVAILABILITY.AVAILABLE;
  const allAssets = normalizedDatasets.map((dataset) => dataset.asset);
  const excludedAssets = new Set([
    ...defaultProductionExcludedAssets(),
    ...toStringArray(existingAssets)
  ]);
  const knownFuturesSymbols = futuresSymbols == null
    ? new Set(allAssets)
    : new Set(toStringArray(futuresSymbols));
  const symbolUniverseComplete = Array.isArray(futuresSymbols) && futuresSymbols.length > 0;
  const survivorshipBiasRisk = universeSource !== "historical_listed_universe"
    || !historicalUniverse;
  const signals = [];
  const lastSignalByAsset = new Map();
  const timestamps = collectReplayTimes(normalizedDatasets, interval);

  for (const signalAvailableAt of timestamps) {
    const visibleRows = normalizedDatasets
      .map((dataset) => historicalTickerAt(dataset, signalAvailableAt, interval))
      .filter(Boolean);
    const universe = resolveUniverseAt({
      historicalUniverse,
      universeSource,
      asOf: signalAvailableAt,
      fallbackAssets: allAssets
    });
    const universeAssets = new Set(universe.assets);
    const poolTickers = visibleRows
      .filter((row) => universeAssets.has(row.symbol))
      .map((row) => row.ticker);
    const strongPool = rankDynamicPoolTickers({
      tickers: poolTickers,
      direction: "strong",
      existing: excludedAssets,
      futuresSymbols: knownFuturesSymbols,
      maxAssets: CONFIG.dynamicSpotPoolMaxAssets
    });
    const weakPool = rankDynamicPoolTickers({
      tickers: poolTickers,
      direction: "weak",
      existing: new Set([...excludedAssets, ...strongPool]),
      futuresSymbols: knownFuturesSymbols,
      maxAssets: CONFIG.dynamicWeakSpotPoolMaxAssets
    });
    const benchmarkChange24h = benchmarkMomentum24hAsOf({
      candles: benchmark,
      asOf: signalAvailableAt,
      interval: benchmarkInterval
    });

    for (const dataset of normalizedDatasets) {
      const row = visibleRows.find((candidate) => candidate.symbol === dataset.asset);
      if (!row || !universeAssets.has(dataset.asset)) continue;
      const inStrongPool = strongPool.includes(dataset.asset);
      const inWeakPool = weakPool.includes(dataset.asset);
      const strategyIds = [];
      if (strategyId === "dynamic_relative_strength_breakout" && inStrongPool) strategyIds.push(strategyId);
      if (strategyId === "dynamic_relative_weakness_breakdown" && inWeakPool) strategyIds.push(strategyId);
      for (const selectedStrategyId of strategyIds) {
        const lastSignalAt = lastSignalByAsset.get(`${dataset.asset}:${selectedStrategyId}`);
        if (Number.isFinite(lastSignalAt)
          && signalAvailableAt - lastSignalAt < CONFIG.assetSignalCooldownHours * 3600 * 1000) {
          continue;
        }
        const evaluation = evaluateDynamicProductionSignal({
          strategyId: selectedStrategyId,
          candles: dataset.candles,
          signalIndex: row.index,
          benchmarkChange24h,
          hasOrderBook: availableOrderBook
        });
        if (!evaluation.scoreGatePassed) continue;
        const quality = buildSignalQuality({
          row,
          benchmarkChange24h,
          universe,
          symbolUniverseComplete,
          interval,
          orderBookAvailability: normalizedOrderBookAvailability,
          survivorshipBiasRisk
        });
        const signalCandleOpenTime = Number(row.candle.openTime);
        const signalCandleCloseTime = signalAvailableAt;
        signals.push({
          signalKey: `${dataset.asset}:DYNAMIC_REPLAY:${interval}:${selectedStrategyId}:${signalCandleOpenTime}`,
          asset: dataset.asset,
          strategyId: selectedStrategyId,
          direction: getDynamicProductionDefinition(selectedStrategyId).direction,
          interval,
          signalCandleOpenTime,
          signalCandleCloseTime,
          signalAvailableAt,
          entryEligibleAt: signalAvailableAt,
          triggerTime: signalAvailableAt,
          validUntil: signalAvailableAt + 4 * 3600 * 1000,
          referencePrice: Number(row.candle.close),
          close: Number(row.candle.close),
          recommendationScore: evaluation.score,
          opportunityScore: evaluation.score,
          details: {
            ...evaluation.features,
            benchmarkMomentum24h: benchmarkChange24h,
            pool: selectedStrategyId === "dynamic_relative_strength_breakout" ? "strong" : "weak",
            poolRank: (selectedStrategyId === "dynamic_relative_strength_breakout" ? strongPool : weakPool)
              .indexOf(dataset.asset) + 1
          },
          tradePlanInputs: {
            side: getDynamicProductionDefinition(selectedStrategyId).direction,
            holdHours: DYNAMIC_PRODUCTION_HOLD_HOURS
          },
          quality,
          tickerReconstructionQuality: row.tickerReconstructionQuality,
          primaryEligible: quality.primaryEligible,
          orderBookAvailabilityAssumption: normalizedOrderBookAvailability,
          survivorshipBiasRisk
        });
        lastSignalByAsset.set(`${dataset.asset}:${selectedStrategyId}`, signalAvailableAt);
      }
    }
  }

  const byAsset = Object.fromEntries(allAssets.map((asset) => [
    asset,
    signals.filter((signal) => signal.asset === asset)
  ]));
  const quality = summarizeReplayQuality({
    normalizedDatasets,
    benchmark,
    historicalUniverse,
    universeSource,
    symbolUniverseComplete,
    orderBookAvailability: normalizedOrderBookAvailability,
    survivorshipBiasRisk,
    signals
  });
  return {
    strategyId,
    strategyFamily: getDynamicProductionDefinition(strategyId).family,
    dynamicPoolReplay: true,
    dataSource,
    interval,
    signals,
    byAsset,
    quality,
    poolReconstructionQuality: quality.tickerReconstruction,
    tickerReconstructionQuality: quality.tickerReconstruction,
    orderBookAvailabilityAssumption: normalizedOrderBookAvailability,
    universeSource,
    survivorshipBiasRisk,
    validationVerdict: survivorshipBiasRisk ? "PROVISIONAL" : null
  };
}

export function compareDynamicOrderBookAvailability(options = {}) {
  const available = replayDynamicProductionSignals({
    ...options,
    orderBookAvailability: ORDER_BOOK_AVAILABILITY.AVAILABLE
  });
  const unavailable = replayDynamicProductionSignals({
    ...options,
    orderBookAvailability: ORDER_BOOK_AVAILABILITY.UNAVAILABLE
  });
  const availableSet = new Set(available.signals.map(signalSignature));
  const unavailableSet = new Set(unavailable.signals.map(signalSignature));
  const materiallyDifferent = availableSet.size !== unavailableSet.size
    || [...availableSet].some((signature) => !unavailableSet.has(signature))
    || [...unavailableSet].some((signature) => !availableSet.has(signature));
  return {
    available,
    unavailable,
    orderBookAvailabilitySensitive: materiallyDifferent,
    sensitivityWarning: materiallyDifferent
      ? "Dynamic signal set changes with historical order-book availability assumption"
      : null
  };
}

export function signalTimelineForAsset(replay, asset) {
  return replay?.byAsset?.[asset] || [];
}

function normalizeDatasets(datasets) {
  return (Array.isArray(datasets) ? datasets : [])
    .filter((dataset) => dataset && String(dataset.asset || "").trim() && Array.isArray(dataset.candles))
    .map((dataset) => ({
      ...dataset,
      asset: String(dataset.asset),
      candles: normalizeCandles(dataset.candles)
    }))
    .filter((dataset) => dataset.candles.length > 0);
}

function normalizeCandles(candles) {
  return (Array.isArray(candles) ? candles : [])
    .filter((candle) => Number.isFinite(Number(candle?.openTime)))
    .sort((left, right) => Number(left.openTime) - Number(right.openTime));
}

function collectReplayTimes(datasets, interval) {
  return [...new Set(datasets.flatMap((dataset) => dataset.candles
    .map((candle) => candleCloseTime(candle, interval))
    .filter(Number.isFinite)))]
    .sort((left, right) => left - right);
}

function historicalTickerAt(dataset, asOf, interval) {
  let index = -1;
  for (let candidate = 0; candidate < dataset.candles.length; candidate++) {
    if (candleCloseTime(dataset.candles[candidate], interval) <= asOf) index = candidate;
    else break;
  }
  if (index < 24) return null;
  const candle = dataset.candles[index];
  const previous = dataset.candles[index - 24];
  const close = Number(candle.close);
  const previousClose = Number(previous?.close);
  const quoteVolume24h = reconstructQuoteVolume24h(dataset.candles, index);
  if (!Number.isFinite(close) || !Number.isFinite(previousClose) || previousClose === 0) return null;
  if (!Number.isFinite(quoteVolume24h)) return null;
  return {
    symbol: dataset.asset,
    index,
    candle,
    ticker: {
      symbol: dataset.asset,
      priceChangePercent: (close / previousClose - 1) * 100,
      quoteVolume: quoteVolume24h
    },
    historyComplete: index >= 24,
    tickerReconstructionQuality: interval === "1h"
      ? DYNAMIC_REPLAY_QUALITY.HOURLY_RECONSTRUCTED
      : "CANDLE_RECONSTRUCTED"
  };
}

function resolveUniverseAt({ historicalUniverse, universeSource, asOf, fallbackAssets }) {
  if (!historicalUniverse) {
    return {
      assets: fallbackAssets,
      complete: false,
      source: universeSource,
      survivorshipBiasRisk: true
    };
  }
  const rows = Array.isArray(historicalUniverse)
    ? historicalUniverse
    : Object.entries(historicalUniverse).map(([time, assets]) => ({ time, assets }));
  const eligible = rows
    .map((row) => ({
      time: toTimestamp(row?.time ?? row?.asOf ?? row?.timestamp),
      assets: toStringArray(row?.assets ?? row?.symbols ?? row?.universe)
    }))
    .filter((row) => Number.isFinite(row.time) && row.time <= asOf)
    .sort((left, right) => left.time - right.time)
    .at(-1);
  return {
    assets: eligible?.assets || [],
    complete: Boolean(eligible),
    source: universeSource,
    survivorshipBiasRisk: universeSource !== "historical_listed_universe"
  };
}

function buildSignalQuality({
  row,
  benchmarkChange24h,
  universe,
  symbolUniverseComplete,
  interval,
  orderBookAvailability,
  survivorshipBiasRisk
}) {
  const benchmark = Number.isFinite(benchmarkChange24h) ? "COMPLETE" : "INCOMPLETE";
  const candleHistory = row.historyComplete ? "COMPLETE" : "INCOMPLETE";
  const tickerReconstruction = row.tickerReconstructionQuality;
  const primaryEligible = candleHistory === "COMPLETE"
    && benchmark === "COMPLETE"
    && symbolUniverseComplete
    && universe.complete
    && !survivorshipBiasRisk;
  return {
    candleHistory,
    tickerReconstruction,
    benchmark,
    symbol: symbolUniverseComplete ? "COMPLETE" : "INCOMPLETE",
    universe: universe.complete ? "COMPLETE" : "INCOMPLETE",
    universeSource: universe.source,
    orderBookAvailability: orderBookAvailability === ORDER_BOOK_AVAILABILITY.AVAILABLE
      ? "AVAILABLE"
      : "UNAVAILABLE",
    interval,
    primaryEligible,
    dataQuality: primaryEligible ? DYNAMIC_REPLAY_QUALITY.COMPLETE : DYNAMIC_REPLAY_QUALITY.PROVISIONAL,
    survivorshipBiasRisk
  };
}

function summarizeReplayQuality({
  normalizedDatasets,
  benchmark,
  historicalUniverse,
  universeSource,
  symbolUniverseComplete,
  orderBookAvailability,
  survivorshipBiasRisk,
  signals
}) {
  const benchmarkQuality = benchmark.length >= 25 ? "COMPLETE" : "INCOMPLETE";
  const universeQuality = historicalUniverse && universeSource === "historical_listed_universe"
    ? "COMPLETE"
    : "INCOMPLETE";
  const candleHistoryQuality = normalizedDatasets.every((dataset) => dataset.candles.length >= 25)
    ? "COMPLETE"
    : "INCOMPLETE";
  const tickerQuality = normalizedDatasets.length && normalizedDatasets.every((dataset) => dataset.candles.length >= 25)
    ? DYNAMIC_REPLAY_QUALITY.HOURLY_RECONSTRUCTED
    : DYNAMIC_REPLAY_QUALITY.INCOMPLETE;
  const primaryEligibleSignals = signals.filter((signal) => signal.primaryEligible).length;
  const replayInputsComplete = candleHistoryQuality === "COMPLETE"
    && tickerQuality !== DYNAMIC_REPLAY_QUALITY.INCOMPLETE
    && benchmarkQuality === "COMPLETE"
    && symbolUniverseComplete
    && universeQuality === "COMPLETE"
    && !survivorshipBiasRisk;
  return {
    candleHistory: candleHistoryQuality,
    tickerReconstruction: tickerQuality,
    benchmark: benchmarkQuality,
    symbol: symbolUniverseComplete ? "COMPLETE" : "INCOMPLETE",
    universe: universeQuality,
    universeSource,
    orderBookAvailability,
    primaryEligibleSignals,
    signalCount: signals.length,
    dataQuality: replayInputsComplete && primaryEligibleSignals === signals.length
      ? DYNAMIC_REPLAY_QUALITY.COMPLETE
      : DYNAMIC_REPLAY_QUALITY.PROVISIONAL
  };
}

function defaultProductionExcludedAssets() {
  return [
    ...(CONFIG.cryptoAssets || []),
    ...(CONFIG.futuresAssets || []),
    ...(CONFIG.futuresArbitrageAssets || [])
  ];
}

function signalSignature(signal) {
  return [signal.asset, signal.strategyId, signal.signalCandleOpenTime, signal.recommendationScore].join(":");
}

function normalizeOrderBookAvailability(value) {
  if (value === true || String(value || "").toUpperCase() === ORDER_BOOK_AVAILABILITY.AVAILABLE) {
    return ORDER_BOOK_AVAILABILITY.AVAILABLE;
  }
  return ORDER_BOOK_AVAILABILITY.UNAVAILABLE;
}

function candleCloseTime(candle, interval) {
  const openTime = toTimestamp(candle?.openTime);
  return Number.isFinite(openTime)
    ? openTime + intervalMilliseconds(interval)
    : null;
}

function toStringArray(values) {
  return Array.isArray(values)
    ? values.map((value) => String(value)).filter(Boolean)
    : [];
}

function toTimestamp(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value instanceof Date) return value.getTime();
  if (value == null || value === "") return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}
