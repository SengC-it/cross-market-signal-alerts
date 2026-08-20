import { CONFIG } from "../config.js";
import { intervalMilliseconds } from "../trading/trade-spec.js";
import {
  DYNAMIC_PRODUCTION_HOLD_HOURS,
  DYNAMIC_PRODUCTION_POLICIES,
  DYNAMIC_STRATEGY_IDS,
  benchmarkMomentum24hAsOf,
  evaluateDynamicProductionSignal,
  getDynamicProductionDefinition,
  rankDynamicPoolTickers,
  reconstructQuoteVolume24h,
  resolveDynamicPoolExistingAssets
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

export const DYNAMIC_REPLAY_EXCLUSION_REASONS = Object.freeze([
  "incomplete_candle_history",
  "incomplete_ticker_window",
  "incomplete_benchmark",
  "incomplete_universe",
  "survivorship_bias",
  "stale_data",
  "gap_detected"
]);

export const { CORE_SIGNAL_POLICY, FULL_PRODUCTION_POLICY } = DYNAMIC_PRODUCTION_POLICIES;

export function createDynamicProductionReplayStrategy({
  strategyId,
  signalTimeline = [],
  holdHours = DYNAMIC_PRODUCTION_HOLD_HOURS,
  primaryOnly = true
} = {}) {
  const definition = getDynamicProductionDefinition(strategyId);
  if (!definition) throw new Error("DYNAMIC_STRATEGY_NOT_FOUND: " + strategyId);
  const eventsByOpenTime = new Map(
    signalTimeline
      .filter((event) => !primaryOnly || event?.primaryEligible === true)
      .filter((event) => Number.isFinite(Number(event?.signalCandleOpenTime)))
      .map((event) => [Number(event.signalCandleOpenTime), event])
  );
  return {
    id: definition.id,
    name: definition.id,
    direction: definition.direction,
    holdHours,
    primaryOnly,
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
  dataSource = "historical_validation_input",
  productionGroup = "all",
  productionPolicy = CORE_SIGNAL_POLICY,
  historicalAlertReviewState = null,
  dynamicSpotAssets = [],
  selected = null
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
    ...resolveDynamicPoolExistingAssets({
      group: productionGroup,
      selected,
      dynamicSpotAssets
    }),
    ...toStringArray(existingAssets)
  ]);
  const knownFuturesSymbols = futuresSymbols == null
    ? new Set(allAssets)
    : new Set(toStringArray(futuresSymbols));
  const symbolUniverseComplete = Array.isArray(futuresSymbols) && futuresSymbols.length > 0;
  const survivorshipBiasRisk = universeSource !== "historical_listed_universe"
    || !historicalUniverse;
  const signals = [];
  const tickerDiagnostics = [];
  const benchmarkDiagnostics = [];
  const lastSignalByAsset = new Map();
  const timestamps = collectReplayTimes(normalizedDatasets, interval);

  for (const signalAvailableAt of timestamps) {
    const tickerRows = normalizedDatasets
      .map((dataset) => historicalTickerAt(dataset, signalAvailableAt, interval))
      .filter(Boolean);
    tickerDiagnostics.push(...tickerRows
      .filter((row) => !row.primaryTickerComplete)
      .map((row) => ({
        asset: row.symbol,
        signalAvailableAt,
        quality: row.tickerReconstructionQuality,
        reasons: row.exclusionReasons
      })));
    const visibleRows = tickerRows.filter((row) => row.currentCandleAvailable && row.ticker);
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
    const benchmarkResult = benchmarkMomentum24hAsOf({
      candles: benchmark,
      asOf: signalAvailableAt,
      interval: benchmarkInterval
    });
    benchmarkDiagnostics.push({ signalAvailableAt, ...benchmarkResult });

    for (const dataset of normalizedDatasets) {
      const row = tickerRows.find((candidate) => candidate.symbol === dataset.asset);
      if (!row || !universeAssets.has(dataset.asset)) continue;
      if (!row.currentCandleAvailable || !row.ticker) continue;
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
          benchmarkChange24h: benchmarkResult.value,
          hasOrderBook: availableOrderBook
        });
        if (!evaluation.scoreGatePassed) continue;
        const quality = buildSignalQuality({
          row,
          benchmarkResult,
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
            benchmarkMomentum24h: benchmarkResult.value,
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
    benchmarkDiagnostics,
    tickerDiagnostics,
    historicalUniverse,
    universeSource,
    symbolUniverseComplete,
    orderBookAvailability: normalizedOrderBookAvailability,
    survivorshipBiasRisk,
    signals
  });
  const replayDiagnostics = summarizeReplayDiagnostics({
    signals,
    tickerDiagnostics,
    benchmarkDiagnostics
  });
  const policy = resolveProductionPolicy({ productionPolicy, historicalAlertReviewState });
  return {
    strategyId,
    strategyFamily: getDynamicProductionDefinition(strategyId).family,
    dynamicPoolReplay: true,
    dataSource,
    interval,
    signals,
    byAsset,
    quality,
    replayDiagnostics,
    replaySignalsTotal: replayDiagnostics.replaySignalsTotal,
    replaySignalsPrimaryEligible: replayDiagnostics.replaySignalsPrimaryEligible,
    replaySignalsExcluded: replayDiagnostics.replaySignalsExcluded,
    excludedByReason: replayDiagnostics.excludedByReason,
    productionGroup,
    productionPolicy: policy.name,
    productionPolicyComplete: policy.complete,
    productionPolicyReason: policy.reason,
    poolReconstructionQuality: quality.tickerReconstruction,
    tickerReconstructionQuality: quality.tickerReconstruction,
    orderBookAvailabilityAssumption: normalizedOrderBookAvailability,
    universeSource,
    survivorshipBiasRisk,
    validationVerdict: survivorshipBiasRisk || !policy.complete ? "PROVISIONAL" : null
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
  const timestamp = toTimestamp(asOf);
  const intervalMs = intervalMilliseconds(interval);
  const rows = dataset.candles.map((candle, index) => ({
    candle,
    index,
    closeTime: candleCloseTime(candle, interval)
  }));
  const visible = rows.filter((row) => Number.isFinite(row.closeTime) && row.closeTime <= timestamp);
  const exact = visible.filter((row) => row.closeTime === timestamp);
  const current = exact.at(-1) || null;
  const latest = visible.at(-1) || null;
  const reasons = [];

  if (!current) {
    reasons.push(latest ? "stale_data" : "incomplete_ticker_window");
    return {
      symbol: dataset.asset,
      index: latest?.index ?? -1,
      candle: latest?.candle || null,
      ticker: null,
      currentCandleAvailable: false,
      primaryTickerComplete: false,
      historyComplete: false,
      tickerReconstructionQuality: latest ? "STALE_AT_DECISION_TIME" : DYNAMIC_REPLAY_QUALITY.INCOMPLETE,
      exclusionReasons: reasons.includes("stale_data") ? ["stale_data"] : ["incomplete_ticker_window"]
    };
  }

  const index = current.index;
  const candle = current.candle;
  const window = index >= 24 ? dataset.candles.slice(index - 24, index + 1) : [];
  const volumeWindow = index >= 23 ? dataset.candles.slice(index - 23, index + 1) : [];
  const historyComplete = index >= 24;
  if (!historyComplete) reasons.push("incomplete_candle_history");
  if (historyComplete && (exact.length !== 1 || window.length !== 25 || !isContinuousWindow(window, intervalMs))) {
    reasons.push("gap_detected");
  }
  if (volumeWindow.length !== 24 || !volumeWindow.every(hasQuoteVolume)) {
    reasons.push("incomplete_ticker_window");
  }
  const previous = dataset.candles[index - 24];
  const close = Number(candle?.close);
  const previousClose = Number(previous?.close);
  const quoteVolume24h = reconstructQuoteVolume24h(dataset.candles, index);
  if (!Number.isFinite(close) || !Number.isFinite(previousClose) || previousClose === 0
    || !Number.isFinite(quoteVolume24h)) {
    reasons.push("incomplete_ticker_window");
  }
  const uniqueReasons = [...new Set(reasons)];
  const ticker = Number.isFinite(close) && Number.isFinite(previousClose) && previousClose !== 0
    && Number.isFinite(quoteVolume24h)
    ? {
      symbol: dataset.asset,
      priceChangePercent: (close / previousClose - 1) * 100,
      quoteVolume: quoteVolume24h
    }
    : null;
  const tickerReconstructionQuality = uniqueReasons.includes("gap_detected")
    ? "INCOMPLETE_GAP"
    : uniqueReasons.includes("incomplete_candle_history") || uniqueReasons.includes("incomplete_ticker_window")
      ? DYNAMIC_REPLAY_QUALITY.INCOMPLETE
      : interval === "1h" ? DYNAMIC_REPLAY_QUALITY.HOURLY_RECONSTRUCTED : "CANDLE_RECONSTRUCTED";
  return {
    symbol: dataset.asset,
    index,
    candle,
    ticker,
    currentCandleAvailable: true,
    primaryTickerComplete: uniqueReasons.length === 0,
    historyComplete,
    tickerReconstructionQuality,
    exclusionReasons: normalizeTickerExclusionReasons(uniqueReasons)
  };
}

function isContinuousWindow(rows, intervalMs) {
  if (!Array.isArray(rows) || rows.length < 2 || !Number.isFinite(intervalMs)) return false;
  for (let index = 1; index < rows.length; index++) {
    const previous = Number(rows[index - 1]?.openTime);
    const current = Number(rows[index]?.openTime);
    if (!Number.isFinite(previous) || !Number.isFinite(current) || current - previous !== intervalMs) {
      return false;
    }
  }
  return true;
}

function hasQuoteVolume(candle) {
  const quoteVolume = Number(candle?.quoteVolume);
  if (Number.isFinite(quoteVolume)) return true;
  const volume = Number(candle?.volume);
  const close = Number(candle?.close);
  return Number.isFinite(volume) && Number.isFinite(close);
}

function normalizeTickerExclusionReasons(reasons = []) {
  const normalized = [];
  for (const reason of reasons) {
    if (reason === "incomplete_candle_history") normalized.push(reason);
    else if (reason === "stale_data") normalized.push(reason);
    else if (reason === "gap_detected") normalized.push(reason);
    else normalized.push("incomplete_ticker_window");
  }
  return [...new Set(normalized)];
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
  benchmarkResult,
  universe,
  symbolUniverseComplete,
  interval,
  orderBookAvailability,
  survivorshipBiasRisk
}) {
  const benchmarkComplete = benchmarkResult?.complete === true;
  const benchmark = benchmarkComplete ? "COMPLETE" : "INCOMPLETE";
  const candleHistory = row.historyComplete ? "COMPLETE" : "INCOMPLETE";
  const tickerReconstruction = row.tickerReconstructionQuality;
  const exclusionReasons = new Set(row.exclusionReasons || []);
  if (candleHistory !== "COMPLETE") exclusionReasons.add("incomplete_candle_history");
  if (tickerReconstruction === "INCOMPLETE_GAP") exclusionReasons.add("gap_detected");
  else if (tickerReconstruction !== DYNAMIC_REPLAY_QUALITY.HOURLY_RECONSTRUCTED
    && tickerReconstruction !== "CANDLE_RECONSTRUCTED") {
    exclusionReasons.add("incomplete_ticker_window");
  }
  if (!benchmarkComplete) {
    exclusionReasons.add("incomplete_benchmark");
    for (const reason of benchmarkResult?.reasons || []) {
      if (reason === "gap_detected" || reason === "stale_data") exclusionReasons.add(reason);
    }
  }
  if (!symbolUniverseComplete || !universe.complete) exclusionReasons.add("incomplete_universe");
  if (survivorshipBiasRisk) exclusionReasons.add("survivorship_bias");
  const primaryEligible = exclusionReasons.size === 0;
  return {
    candleHistory,
    tickerReconstruction,
    benchmark,
    benchmarkValue: Number.isFinite(benchmarkResult?.value) ? benchmarkResult.value : null,
    benchmarkReason: benchmarkResult?.reason || null,
    symbol: symbolUniverseComplete ? "COMPLETE" : "INCOMPLETE",
    universe: universe.complete ? "COMPLETE" : "INCOMPLETE",
    universeSource: universe.source,
    orderBookAvailability: orderBookAvailability === ORDER_BOOK_AVAILABILITY.AVAILABLE
      ? "AVAILABLE"
      : "UNAVAILABLE",
    interval,
    exclusionReasons: [...exclusionReasons],
    primaryEligible,
    dataQuality: primaryEligible ? DYNAMIC_REPLAY_QUALITY.COMPLETE : DYNAMIC_REPLAY_QUALITY.PROVISIONAL,
    survivorshipBiasRisk
  };
}

function summarizeReplayQuality({
  normalizedDatasets,
  benchmark,
  benchmarkDiagnostics = [],
  tickerDiagnostics = [],
  historicalUniverse,
  universeSource,
  symbolUniverseComplete,
  orderBookAvailability,
  survivorshipBiasRisk,
  signals
}) {
  const signalTimes = new Set(signals.map((signal) => signal.signalAvailableAt));
  const relevantBenchmarks = benchmarkDiagnostics.filter((row) => signalTimes.has(row.signalAvailableAt));
  const benchmarkRows = relevantBenchmarks.length ? relevantBenchmarks : benchmarkDiagnostics;
  const benchmarkQuality = (benchmarkRows.length
    ? benchmarkRows.every((row) => row.complete === true)
    : benchmark.length >= 25)
    ? "COMPLETE"
    : "INCOMPLETE";
  const universeQuality = historicalUniverse && universeSource === "historical_listed_universe"
    ? "COMPLETE"
    : "INCOMPLETE";
  const signalCandleQualities = signals.map((signal) => signal.quality?.candleHistory);
  const candleHistoryQuality = signalCandleQualities.length
    ? signalCandleQualities.every((value) => value === "COMPLETE")
    : normalizedDatasets.every((dataset) => dataset.candles.length >= 25)
    ? "COMPLETE"
    : "INCOMPLETE";
  const signalTickerQualities = signals.map((signal) => signal.quality?.tickerReconstruction);
  const tickerQuality = tickerDiagnostics.some((row) => row.quality === "INCOMPLETE_GAP")
    ? "INCOMPLETE_GAP"
    : tickerDiagnostics.some((row) => row.quality === "STALE_AT_DECISION_TIME")
      ? "STALE_AT_DECISION_TIME"
      : signalTickerQualities.length
    ? signalTickerQualities.every((value) => value === DYNAMIC_REPLAY_QUALITY.HOURLY_RECONSTRUCTED
      || value === "CANDLE_RECONSTRUCTED")
      ? DYNAMIC_REPLAY_QUALITY.HOURLY_RECONSTRUCTED
      : signalTickerQualities.includes("INCOMPLETE_GAP") ? "INCOMPLETE_GAP" : DYNAMIC_REPLAY_QUALITY.INCOMPLETE
      : normalizedDatasets.length && normalizedDatasets.every((dataset) => dataset.candles.length >= 25)
        ? DYNAMIC_REPLAY_QUALITY.HOURLY_RECONSTRUCTED
        : DYNAMIC_REPLAY_QUALITY.INCOMPLETE;
  const primaryEligibleSignals = signals.filter((signal) => signal.primaryEligible).length;
  const replayInputsComplete = candleHistoryQuality === "COMPLETE"
    && tickerQuality !== DYNAMIC_REPLAY_QUALITY.INCOMPLETE
    && tickerQuality !== "INCOMPLETE_GAP"
    && tickerQuality !== "STALE_AT_DECISION_TIME"
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
    benchmarkLatestCloseTime: relevantBenchmarks.at(-1)?.latestCloseTime || null,
    dataQuality: replayInputsComplete && primaryEligibleSignals === signals.length
      ? DYNAMIC_REPLAY_QUALITY.COMPLETE
      : DYNAMIC_REPLAY_QUALITY.PROVISIONAL
  };
}

function summarizeReplayDiagnostics({ signals, tickerDiagnostics, benchmarkDiagnostics }) {
  const excludedByReason = Object.fromEntries(DYNAMIC_REPLAY_EXCLUSION_REASONS.map((reason) => [reason, 0]));
  for (const signal of signals) {
    if (signal.primaryEligible === true) continue;
    const reasons = signal.quality?.exclusionReasons?.length
      ? signal.quality.exclusionReasons
      : ["incomplete_ticker_window"];
    for (const reason of reasons) {
      if (Object.prototype.hasOwnProperty.call(excludedByReason, reason)) excludedByReason[reason] += 1;
    }
  }
  const inputExcludedByReason = Object.fromEntries(DYNAMIC_REPLAY_EXCLUSION_REASONS.map((reason) => [reason, 0]));
  for (const row of tickerDiagnostics || []) {
    for (const reason of row.reasons || []) {
      if (Object.prototype.hasOwnProperty.call(inputExcludedByReason, reason)) inputExcludedByReason[reason] += 1;
    }
  }
  for (const row of benchmarkDiagnostics || []) {
    if (row.complete === true) continue;
    inputExcludedByReason.incomplete_benchmark += 1;
    for (const reason of row.reasons || []) {
      if (Object.prototype.hasOwnProperty.call(inputExcludedByReason, reason)) inputExcludedByReason[reason] += 1;
    }
  }
  const replaySignalsTotal = signals.length;
  const replaySignalsPrimaryEligible = signals.filter((signal) => signal.primaryEligible === true).length;
  return {
    replaySignalsTotal,
    replaySignalsPrimaryEligible,
    replaySignalsExcluded: replaySignalsTotal - replaySignalsPrimaryEligible,
    excludedByReason,
    inputExcludedByReason,
    tickerDiagnostics,
    benchmarkDiagnostics
  };
}

function resolveProductionPolicy({ productionPolicy, historicalAlertReviewState }) {
  const name = productionPolicy === FULL_PRODUCTION_POLICY
    ? FULL_PRODUCTION_POLICY
    : CORE_SIGNAL_POLICY;
  if (name === CORE_SIGNAL_POLICY) {
    return { name, complete: true, reason: null };
  }
  // Records alone do not prove that a timestamp-causal live-performance
  // replay and the scanner's penalty gate were executed. M3-R1 has no such
  // replay implementation, so FULL policy remains fail-closed.
  return {
    name,
    complete: false,
    reason: "LIVE_PERFORMANCE_REPLAY_NOT_IMPLEMENTED"
  };
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
