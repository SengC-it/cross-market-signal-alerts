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
  "incomplete_funding",
  "incomplete_lower_timeframe",
  "exchange_filter_unavailable",
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
  historicalUniverseComplete = null,
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
  const normalizedDatasets = normalizeDatasets(datasets, interval);
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
  const survivorshipBiasRisk = !isHistoricalUniverseSource(universeSource)
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
      historicalUniverseComplete,
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
          dataset,
          benchmarkResult,
          universe,
          symbolUniverseComplete,
          interval,
          signalAvailableAt,
          holdHours: DYNAMIC_PRODUCTION_HOLD_HOURS,
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
    historicalUniverseComplete,
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
    coreSignalPolicyComplete: policy.coreSignalPolicyComplete,
    fullProductionPolicyValidated: policy.fullProductionPolicyValidated,
    poolReconstructionQuality: quality.tickerReconstruction,
    tickerReconstructionQuality: quality.tickerReconstruction,
    orderBookAvailabilityAssumption: normalizedOrderBookAvailability,
    universeSource,
    historicalUniverseComplete,
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

function normalizeDatasets(datasets, interval = "1h") {
  return (Array.isArray(datasets) ? datasets : [])
    .filter((dataset) => dataset && String(dataset.asset || "").trim() && Array.isArray(dataset.candles))
    .map((dataset) => {
      const candles = normalizeCandles(dataset.candles);
      const replayOpenTimes = candles.map((candle) => Number(candle.openTime));
      const intervalMs = intervalMilliseconds(interval);
      const replayQuoteVolumes = [];
      const replayVolumeInvalidPrefix = [0];
      const replayGapPrefix = [0];
      let rollingQuoteVolume = 0;
      let rollingInvalidVolume = 0;
      for (let index = 0; index < candles.length; index++) {
        const quoteVolume = quoteVolumeForCandle(candles[index]);
        if (Number.isFinite(quoteVolume)) rollingQuoteVolume += quoteVolume;
        else rollingInvalidVolume++;
        if (index >= 24) {
          const outgoing = quoteVolumeForCandle(candles[index - 24]);
          if (Number.isFinite(outgoing)) rollingQuoteVolume -= outgoing;
          else rollingInvalidVolume--;
        }
        replayQuoteVolumes.push(index >= 23 && rollingInvalidVolume === 0
          ? rollingQuoteVolume
          : null);
        replayVolumeInvalidPrefix.push(replayVolumeInvalidPrefix.at(-1) + (Number.isFinite(quoteVolume) ? 0 : 1));
        const previousOpenTime = replayOpenTimes[index - 1];
        replayGapPrefix.push(replayGapPrefix.at(-1)
          + (index > 0 && previousOpenTime + intervalMs !== replayOpenTimes[index] ? 1 : 0));
      }
      return {
        ...dataset,
        asset: String(dataset.asset),
        candles,
        replayOpenTimes,
        replayQuoteVolumes,
        replayVolumeInvalidPrefix,
        replayGapPrefix,
        replayIntervalMs: intervalMs
      };
    })
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
  const openTimes = dataset.replayOpenTimes || dataset.candles.map((candle) => Number(candle.openTime));
  const exactIndex = findOpenTime(openTimes, timestamp - intervalMs);
  const latestIndex = findLastOpenTimeAtOrBefore(openTimes, timestamp - intervalMs);
  const current = exactIndex >= 0 ? {
    candle: dataset.candles[exactIndex],
    index: exactIndex,
    openTime: openTimes[exactIndex],
    closeTime: timestamp
  } : null;
  const latest = latestIndex >= 0 ? {
    candle: dataset.candles[latestIndex],
    index: latestIndex,
    openTime: openTimes[latestIndex],
    closeTime: Number(openTimes[latestIndex]) + intervalMs
  } : null;
  const exact = current ? [current] : [];
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
  const historyComplete = index >= 24;
  const historyContinuous = historyComplete
    && (dataset.replayGapPrefix
      ? dataset.replayGapPrefix[index + 1] - dataset.replayGapPrefix[index - 24] === 0
      : isContinuousWindow(dataset.candles.slice(index - 24, index + 1), intervalMs));
  const volumeWindowComplete = index >= 23
    && (dataset.replayVolumeInvalidPrefix
      ? dataset.replayVolumeInvalidPrefix[index + 1] - dataset.replayVolumeInvalidPrefix[index - 23] === 0
      : dataset.candles.slice(index - 23, index + 1).every(hasQuoteVolume));
  if (!historyComplete) reasons.push("incomplete_candle_history");
  if (historyComplete && (exact.length !== 1 || !historyContinuous)) {
    reasons.push("gap_detected");
  }
  if (!volumeWindowComplete) {
    reasons.push("incomplete_ticker_window");
  }
  const previous = dataset.candles[index - 24];
  const close = Number(candle?.close);
  const previousClose = Number(previous?.close);
  const quoteVolume24h = dataset.replayQuoteVolumes
    ? dataset.replayQuoteVolumes[index]
    : reconstructQuoteVolume24h(dataset.candles, index);
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

function quoteVolumeForCandle(candle) {
  const quoteVolume = Number(candle?.quoteVolume);
  if (Number.isFinite(quoteVolume)) return quoteVolume;
  const volume = Number(candle?.volume);
  const close = Number(candle?.close);
  return Number.isFinite(volume) && Number.isFinite(close) ? volume * close : null;
}

function findOpenTime(openTimes, openTime) {
  let low = 0;
  let high = openTimes.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const value = Number(openTimes[middle]);
    if (value === openTime) return middle;
    if (value < openTime) low = middle + 1;
    else high = middle - 1;
  }
  return -1;
}

function findLastOpenTimeAtOrBefore(openTimes, openTime) {
  let low = 0;
  let high = openTimes.length - 1;
  let result = -1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const value = Number(openTimes[middle]);
    if (value <= openTime) {
      result = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return result;
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

function resolveUniverseAt({
  historicalUniverse,
  historicalUniverseComplete,
  universeSource,
  asOf,
  fallbackAssets
}) {
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
    complete: Boolean(eligible)
      && (!isHistoricalUniverseSource(universeSource)
        || historicalUniverseComplete === true
        || (historicalUniverseComplete == null && universeSource === "historical_listed_universe")),
    source: universeSource,
    survivorshipBiasRisk: !isHistoricalUniverseSource(universeSource)
  };
}

function buildSignalQuality({
  row,
  dataset,
  benchmarkResult,
  universe,
  symbolUniverseComplete,
  interval,
  signalAvailableAt,
  holdHours,
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
  const lowerTimeframe = assessLowerTimeframeCoverage({
    candles: dataset?.lowerTimeframeCandles,
    startTime: signalAvailableAt,
    endTime: Number(signalAvailableAt) + Number(holdHours || 0) * 3600 * 1000
  });
  const funding = assessFundingCoverage({
    coverage: dataset?.fundingCoverage,
    startTime: signalAvailableAt,
    endTime: Number(signalAvailableAt) + Number(holdHours || 0) * 3600 * 1000
  });
  const exchangeFilters = hasExchangeFilters(dataset?.exchangeFilters);
  const executionDataRequired = [
    "lowerTimeframeCandles",
    "fundingCoverage",
    "exchangeFilters"
  ].some((field) => Object.prototype.hasOwnProperty.call(dataset || {}, field));
  if (executionDataRequired) {
    if (!lowerTimeframe.complete) exclusionReasons.add("incomplete_lower_timeframe");
    if (!funding.complete) exclusionReasons.add("incomplete_funding");
    if (!exchangeFilters) exclusionReasons.add("exchange_filter_unavailable");
  }
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
    lowerTimeframe: executionDataRequired
      ? lowerTimeframe.complete ? "COMPLETE" : "INCOMPLETE"
      : "NOT_PROVIDED",
    lowerTimeframeCoverage: lowerTimeframe,
    funding: executionDataRequired ? funding.complete ? "COMPLETE" : "INCOMPLETE" : "NOT_PROVIDED",
    fundingCoverage: funding,
    exchangeFilters: executionDataRequired ? exchangeFilters ? "AVAILABLE" : "UNAVAILABLE" : "NOT_PROVIDED",
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
  historicalUniverseComplete,
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
  const universeQuality = historicalUniverse
    && isHistoricalUniverseSource(universeSource)
    && (historicalUniverseComplete === true
      || (historicalUniverseComplete == null && universeSource === "historical_listed_universe"))
    ? "COMPLETE"
    : "INCOMPLETE";
  const signalCandleQualities = signals.map((signal) => signal.quality?.candleHistory);
  const candleHistoryQuality = signalCandleQualities.length
    ? signalCandleQualities.every((value) => value === "COMPLETE") ? "COMPLETE" : "INCOMPLETE"
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
  const relevantFunding = summarizeSignalQuality(signals, "funding");
  const relevantLowerTimeframe = summarizeSignalQuality(signals, "lowerTimeframe");
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
    signalRelevantFundingCoverage: relevantFunding,
    signalRelevantLowerTfCoverage: relevantLowerTimeframe,
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
    primaryExcludedByFunding: signals.filter((signal) => signal.quality?.exclusionReasons?.includes("incomplete_funding")).length,
    primaryExcludedByLowerTf: signals.filter((signal) => signal.quality?.exclusionReasons?.includes("incomplete_lower_timeframe")).length,
    inputExcludedByReason,
    tickerDiagnostics,
    benchmarkDiagnostics
  };
}

function resolveProductionPolicy({ productionPolicy, historicalAlertReviewState }) {
  const name = productionPolicy === FULL_PRODUCTION_POLICY
    ? FULL_PRODUCTION_POLICY
    : CORE_SIGNAL_POLICY;
  // CORE signal evaluation is available, but it is not the FULL production
  // policy. Records alone do not prove a timestamp-causal live-performance
  // replay and the scanner's penalty gate were executed.
  void historicalAlertReviewState;
  return {
    name,
    complete: false,
    reason: "LIVE_PERFORMANCE_HISTORY_UNAVAILABLE",
    coreSignalPolicyComplete: name === CORE_SIGNAL_POLICY || name === FULL_PRODUCTION_POLICY,
    fullProductionPolicyValidated: false
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

function isHistoricalUniverseSource(source) {
  return source === "historical_binance_vision_archive"
    || source === "historical_listed_universe";
}

function hasExchangeFilters(filters) {
  return Number(filters?.tickSize) > 0 && Number(filters?.stepSize) > 0;
}

function assessLowerTimeframeCoverage({ candles, startTime, endTime }) {
  const start = toTimestamp(startTime);
  const end = toTimestamp(endTime);
  const intervalMs = 5 * 60 * 1000;
  const rows = (Array.isArray(candles) ? candles : [])
    .filter((candle) => Number.isFinite(Number(candle?.openTime)))
    .sort((left, right) => Number(left.openTime) - Number(right.openTime));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !rows.length) {
    return { complete: false, start, end, bars: 0, gaps: ["missing_lower_timeframe"] };
  }
  const byOpenTime = new Set(rows.map((candle) => Number(candle.openTime)));
  const gaps = [];
  for (let openTime = start; openTime < end; openTime += intervalMs) {
    if (!byOpenTime.has(openTime)) gaps.push(openTime);
  }
  const relevant = rows.filter((candle) => {
    const openTime = Number(candle.openTime);
    return openTime >= start && openTime < end;
  });
  return {
    complete: gaps.length === 0 && relevant.length === Math.ceil((end - start) / intervalMs),
    start,
    end,
    bars: relevant.length,
    gaps: gaps.slice(0, 10)
  };
}

function assessFundingCoverage({ coverage, startTime, endTime }) {
  const start = toTimestamp(startTime);
  const end = toTimestamp(endTime);
  const coverageStart = toTimestamp(coverage?.coverageStart);
  const coverageEnd = toTimestamp(coverage?.coverageEnd);
  const gaps = (Array.isArray(coverage?.gaps) ? coverage.gaps : [])
    .filter((gap) => {
      const gapStart = toTimestamp(gap?.start ?? gap?.requestedStart);
      const gapEnd = toTimestamp(gap?.end ?? gap?.requestedEnd);
      return Number.isFinite(gapStart) && Number.isFinite(gapEnd)
        && gapStart < end && gapEnd > start;
    });
  return {
    complete: coverage?.complete === true
      && Number.isFinite(start)
      && Number.isFinite(end)
      && Number.isFinite(coverageStart)
      && Number.isFinite(coverageEnd)
      && coverageStart <= start
      && coverageEnd >= end
      && gaps.length === 0,
    start,
    end,
    coverageStart,
    coverageEnd,
    gaps: gaps.slice(0, 10)
  };
}

function summarizeSignalQuality(signals, field) {
  const values = (Array.isArray(signals) ? signals : [])
    .map((signal) => signal?.quality?.[field])
    .filter(Boolean);
  if (!values.length) return "INCOMPLETE";
  if (values.every((value) => value === "COMPLETE")) return "COMPLETE";
  return "PARTIAL";
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
