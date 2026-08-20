import { CONFIG, intervalHours } from "../config.js";

export const DYNAMIC_STRATEGY_IDS = Object.freeze([
  "dynamic_relative_strength_breakout",
  "dynamic_relative_weakness_breakdown"
]);

export const DYNAMIC_PRODUCTION_HOLD_HOURS = 8;

export const DYNAMIC_PRODUCTION_POLICIES = Object.freeze({
  CORE_SIGNAL_POLICY: "CORE_SIGNAL_POLICY",
  FULL_PRODUCTION_POLICY: "FULL_PRODUCTION_POLICY"
});

export const DYNAMIC_STRATEGY_DEFINITIONS = Object.freeze({
  dynamic_relative_strength_breakout: Object.freeze({
    id: "dynamic_relative_strength_breakout",
    direction: "LONG",
    family: "dynamic_strength"
  }),
  dynamic_relative_weakness_breakdown: Object.freeze({
    id: "dynamic_relative_weakness_breakdown",
    direction: "SHORT",
    family: "dynamic_weakness"
  })
});

export function isDynamicProductionStrategy(strategyId) {
  return DYNAMIC_STRATEGY_IDS.includes(String(strategyId || ""));
}

export function getDynamicProductionDefinition(strategyId) {
  return DYNAMIC_STRATEGY_DEFINITIONS[String(strategyId || "")] || null;
}

export function evaluateDynamicProductionOpportunity({
  strategyId,
  momentum24h,
  relativeStrength,
  relativeWeakness,
  volumeMultiple,
  breakout,
  breakdown,
  hasOrderBook = false
} = {}) {
  if (strategyId === "dynamic_relative_weakness_breakdown") {
    return evaluateDynamicWeaknessOpportunity({
      momentum24h,
      relativeWeakness,
      volumeMultiple,
      breakdown,
      hasOrderBook
    });
  }
  return evaluateDynamicStrengthOpportunity({
    momentum24h,
    relativeStrength,
    volumeMultiple,
    breakout,
    hasOrderBook
  });
}

export function evaluateDynamicStrengthOpportunity({
  momentum24h,
  relativeStrength,
  volumeMultiple,
  breakout,
  hasOrderBook = false
} = {}) {
  if (!Number.isFinite(momentum24h) || momentum24h < CONFIG.relativeStrengthMinMomentum24h) {
    return { passed: false, score: 0, reason: "insufficient_momentum" };
  }
  if (Number.isFinite(CONFIG.relativeStrengthMaxMomentum24h) && momentum24h > CONFIG.relativeStrengthMaxMomentum24h) {
    return { passed: false, score: 0, reason: "overheated_momentum" };
  }
  if (!Number.isFinite(relativeStrength) || relativeStrength < CONFIG.relativeStrengthMinRelativeStrength24h) {
    return { passed: false, score: 0, reason: "insufficient_relative_strength" };
  }
  if (!breakout) {
    return { passed: false, score: 0, reason: "no_breakout" };
  }
  if (!Number.isFinite(volumeMultiple) || volumeMultiple < CONFIG.relativeStrengthMinVolumeMultiple) {
    return { passed: false, score: 0, reason: "insufficient_volume" };
  }
  if (Number.isFinite(CONFIG.relativeStrengthMaxVolumeMultiple) && volumeMultiple > CONFIG.relativeStrengthMaxVolumeMultiple) {
    return {
      passed: false,
      score: 0,
      reason: volumeMultiple <= 4 ? "weak_edge_volume" : "overheated_volume"
    };
  }

  const momentumCenter = (CONFIG.relativeStrengthMinMomentum24h + CONFIG.relativeStrengthMaxMomentum24h) / 2;
  const momentumWidth = Math.max(0.01, CONFIG.relativeStrengthMaxMomentum24h - CONFIG.relativeStrengthMinMomentum24h);
  const momentumScore = clampScore(10 - Math.abs(momentum24h - momentumCenter) / momentumWidth * 6);
  const relativeScore = Math.min(4, Math.max(0, Number(relativeStrength) * 30));
  const volumeCenter = (CONFIG.relativeStrengthMinVolumeMultiple + CONFIG.relativeStrengthMaxVolumeMultiple) / 2;
  const volumeWidth = Math.max(0.1, CONFIG.relativeStrengthMaxVolumeMultiple - CONFIG.relativeStrengthMinVolumeMultiple);
  const volumeScore = clampScore(5 - Math.abs(volumeMultiple - volumeCenter) / volumeWidth * 4);
  const score = Math.min(
    CONFIG.dynamicObservationMaxScore,
    clampScore(70 + momentumScore + relativeScore + volumeScore + (hasOrderBook ? 2 : 0))
  );

  return { passed: true, score, reason: null };
}

export function evaluateDynamicWeaknessOpportunity({
  momentum24h,
  relativeWeakness,
  volumeMultiple,
  breakdown,
  hasOrderBook = false
} = {}) {
  if (
    momentum24h > CONFIG.relativeWeaknessMaxMomentum24h ||
    momentum24h < CONFIG.relativeWeaknessMinMomentum24h ||
    relativeWeakness > CONFIG.relativeWeaknessMaxRelativeStrength24h ||
    !breakdown ||
    !Number.isFinite(volumeMultiple) ||
    volumeMultiple < CONFIG.relativeWeaknessMinVolumeMultiple ||
    (Number.isFinite(CONFIG.relativeWeaknessMaxVolumeMultiple) && volumeMultiple > CONFIG.relativeWeaknessMaxVolumeMultiple)
  ) {
    return { passed: false, score: 0, reason: "weakness_gate" };
  }

  const score = clampScore(
    Math.min(
      CONFIG.dynamicObservationMaxScore,
      62 +
        Math.min(12, Math.abs(momentum24h) * 100) +
        Math.min(8, Math.abs(relativeWeakness) * 100) +
        Math.min(8, (volumeMultiple - 1) * 4) +
        (hasOrderBook ? 4 : 0)
    )
  );
  return { passed: true, score, reason: null };
}

export function evaluateDynamicProductionSignal({
  strategyId,
  candles = [],
  signalIndex = candles.length - 2,
  benchmarkChange24h = null,
  hasOrderBook = false
} = {}) {
  const definition = getDynamicProductionDefinition(strategyId);
  if (!definition) {
    return {
      passed: false,
      scoreGatePassed: false,
      reason: "unknown_dynamic_strategy",
      features: null,
      opportunity: { passed: false, score: 0, reason: "unknown_dynamic_strategy" }
    };
  }
  const features = computeDynamicProductionFeatures({
    strategyId,
    candles,
    signalIndex,
    benchmarkChange24h
  });
  const opportunity = evaluateDynamicProductionOpportunity({
    strategyId,
    ...features,
    hasOrderBook
  });
  const scoreGatePassed = opportunity.passed && opportunity.score >= CONFIG.dynamicTradeMinRecommendationScore;
  return {
    passed: scoreGatePassed,
    scoreGatePassed,
    reason: scoreGatePassed ? null : opportunity.reason || "recommendation_score_below_floor",
    score: opportunity.score,
    features,
    opportunity
  };
}

export function computeDynamicProductionFeatures({
  strategyId,
  candles = [],
  signalIndex = candles.length - 2,
  benchmarkChange24h = null
} = {}) {
  const index = Number(signalIndex);
  const latest = candles[index];
  const previous = candles[index - 24];
  if (!latest || !previous || !Number.isFinite(Number(latest.close)) || !Number.isFinite(Number(previous.close))) {
    return {
      latest: latest || null,
      momentum24h: null,
      benchmarkChange24h: Number.isFinite(benchmarkChange24h) ? benchmarkChange24h : null,
      relativeStrength: null,
      relativeWeakness: null,
      volumeMultiple: null,
      recentHigh: null,
      recentLow: null,
      breakout: false,
      breakdown: false
    };
  }

  const volumes = candles.map((candle) => Number(candle?.volume)).filter(Number.isFinite);
  const recentCandles = candles.slice(Math.max(0, index - 20), index);
  const recentHigh = recentCandles.length
    ? Math.max(...recentCandles.map((candle) => Number(candle?.high)).filter(Number.isFinite))
    : null;
  const recentLow = recentCandles.length
    ? Math.min(...recentCandles.map((candle) => Number(candle?.low)).filter(Number.isFinite))
    : null;
  const volume20 = average(volumesForRange(candles, Math.max(0, index - 20), index));
  const momentum24h = Number(latest.close) / Number(previous.close) - 1;
  const volumeMultiple = volume20 > 0 ? Number(latest.volume) / volume20 : null;
  const effectiveBenchmark = Number.isFinite(benchmarkChange24h) ? benchmarkChange24h : null;
  const relative = Number.isFinite(effectiveBenchmark)
    ? momentum24h - effectiveBenchmark
    : momentum24h;
  const breakout = Number.isFinite(recentHigh) && Number(latest.close) >= recentHigh * 0.995;
  const breakdown = Number.isFinite(recentLow) && Number(latest.close) <= recentLow * 1.005;

  return {
    latest,
    momentum24h,
    benchmarkChange24h: effectiveBenchmark,
    relativeStrength: strategyId === "dynamic_relative_strength_breakout" ? relative : null,
    relativeWeakness: strategyId === "dynamic_relative_weakness_breakdown" ? relative : null,
    volumeMultiple,
    recentHigh,
    recentLow,
    breakout,
    breakdown,
    historyBars: index + 1,
    benchmarkAvailable: Number.isFinite(effectiveBenchmark),
    quoteVolume24h: reconstructQuoteVolume24h(candles, index)
  };
}

export function reconstructQuoteVolume24h(candles = [], signalIndex = candles.length - 1) {
  const start = Math.max(0, Number(signalIndex) - 23);
  const rows = candles.slice(start, Number(signalIndex) + 1);
  if (rows.length < 24) return null;
  const total = rows.reduce((sum, candle) => {
    const quoteVolume = Number(candle?.quoteVolume);
    if (Number.isFinite(quoteVolume)) return sum + quoteVolume;
    const volume = Number(candle?.volume);
    const close = Number(candle?.close);
    return Number.isFinite(volume) && Number.isFinite(close) ? sum + volume * close : sum;
  }, 0);
  return Number.isFinite(total) ? total : null;
}

export function benchmarkMomentum24hAsOf({
  candles = [],
  asOf,
  interval = "4h"
} = {}) {
  const timestamp = toTimestamp(asOf);
  const intervalMs = Math.max(1, intervalHours(interval) * 3600 * 1000);
  const normalized = (Array.isArray(candles) ? candles : [])
    .filter((candle) => Number.isFinite(toTimestamp(candle?.openTime)))
    .sort((left, right) => Number(left.openTime) - Number(right.openTime));
  const visible = normalized
    .map((candle, index) => ({ candle, index, closeTime: candleCloseTime(candle, interval) }))
    .filter(({ closeTime }) => Number.isFinite(closeTime) && closeTime <= timestamp);
  const future = normalized
    .map((candle, index) => ({ candle, index, closeTime: candleCloseTime(candle, interval) }))
    .find(({ closeTime }) => Number.isFinite(closeTime) && closeTime > timestamp);
  const latest = visible.at(-1) || null;
  const lookback = Math.max(1, Math.round(24 / Math.max(0.25, intervalHours(interval))));
  const previous = latest ? normalized[latest.index - lookback] : null;
  const latestCloseTime = latest?.closeTime ?? null;
  const lookbackStartTime = latestCloseTime != null
    ? latestCloseTime - 24 * 3600 * 1000
    : null;
  const reasons = [];

  if (!Number.isFinite(timestamp) || !latest) {
    reasons.push(future ? "future_candle_not_allowed" : "incomplete_benchmark");
  } else if (timestamp - latestCloseTime > intervalMs) {
    reasons.push("stale_data");
  }
  if (!latest || latest.index < lookback || !previous) {
    reasons.push("incomplete_benchmark");
  }

  const window = latest && latest.index >= lookback
    ? normalized.slice(latest.index - lookback, latest.index + 1)
    : [];
  if (window.length !== lookback + 1 || !isContinuousWindow(window, intervalMs)) {
    reasons.push("gap_detected");
  }
  const latestClose = Number(latest?.candle?.close);
  const previousClose = Number(previous?.close);
  const value = Number.isFinite(latestClose)
    && Number.isFinite(previousClose)
    && previousClose !== 0
    && !reasons.includes("future_candle_not_allowed")
    ? latestClose / previousClose - 1
    : null;
  const uniqueReasons = [...new Set(reasons)];
  return {
    value,
    complete: uniqueReasons.length === 0,
    reason: uniqueReasons[0] || null,
    reasons: uniqueReasons,
    latestCloseTime,
    lookbackStartTime,
    interval
  };
}

export function benchmarkMomentum24hAsOfDetailed(options = {}) {
  return benchmarkMomentum24hAsOf(options);
}

export function benchmarkMomentum24h(candles = []) {
  if (!Array.isArray(candles) || candles.length < 8) return null;
  const latestIndex = candles.length - 2;
  const lookback = Math.max(1, Math.round(24 / 4));
  const previousIndex = Math.max(0, latestIndex - lookback);
  const latestClose = Number(candles[latestIndex]?.close);
  const previousClose = Number(candles[previousIndex]?.close);
  if (!Number.isFinite(latestClose) || !Number.isFinite(previousClose) || previousClose === 0) return null;
  return latestClose / previousClose - 1;
}

export function rankDynamicPoolTickers({
  tickers = [],
  direction = "strong",
  existing = new Set(),
  futuresSymbols = null,
  maxAssets = direction === "weak"
    ? CONFIG.dynamicWeakSpotPoolMaxAssets
    : CONFIG.dynamicSpotPoolMaxAssets
} = {}) {
  const eligible = tickers.filter((ticker) => direction === "weak"
    ? isDynamicWeakPoolCandidate(ticker, existing, futuresSymbols)
    : isDynamicStrongPoolCandidate(ticker, existing, futuresSymbols));
  return [...eligible]
    .sort((left, right) => {
      const leftScore = Math.abs(Number(left.priceChangePercent)) * Math.log10(Math.max(10, Number(left.quoteVolume)));
      const rightScore = Math.abs(Number(right.priceChangePercent)) * Math.log10(Math.max(10, Number(right.quoteVolume)));
      return rightScore - leftScore;
    })
    .slice(0, maxAssets)
    .map((ticker) => ticker.symbol);
}

/**
 * Resolve the same existing-asset set used by the live scanner and the
 * historical dynamic-pool replay.
 */
export function resolveDynamicPoolExistingAssets({
  group = "all",
  selected = null,
  dynamicSpotAssets = []
} = {}) {
  const groupId = String(group || "all");
  const configured = selected || (groupId === "all"
    ? {
      cryptoAssets: CONFIG.cryptoAssets,
      futuresAssets: CONFIG.futuresAssets,
      arbitrageAssets: CONFIG.futuresArbitrageAssets
    }
    : {});
  const existing = [
    ...(Array.isArray(configured.cryptoAssets) ? configured.cryptoAssets : []),
    ...(Array.isArray(configured.futuresAssets) ? configured.futuresAssets : []),
    ...(Array.isArray(configured.arbitrageAssets) ? configured.arbitrageAssets : [])
  ];
  if (groupId === "all" || groupId === "dynamic-weak-spot") {
    existing.push(...(Array.isArray(dynamicSpotAssets) ? dynamicSpotAssets : []));
  }
  return new Set(existing.map((asset) => String(asset)).filter(Boolean));
}

export function isDynamicStrongPoolCandidate(ticker = {}, existing = new Set(), futuresSymbols = null) {
  const symbol = ticker.symbol || "";
  if (!symbol.endsWith("USDT")) return false;
  if (existing.has(symbol)) return false;
  if (futuresSymbols && !futuresSymbols.has(symbol)) return false;
  if (CONFIG.dynamicSpotPoolExcludedPatterns.some((pattern) => symbol.includes(pattern))) return false;
  if (!Number.isFinite(ticker.priceChangePercent) || ticker.priceChangePercent < CONFIG.dynamicSpotPoolMinPriceChangePercent) return false;
  if (ticker.priceChangePercent > CONFIG.dynamicSpotPoolMaxPriceChangePercent) return false;
  if (!Number.isFinite(ticker.quoteVolume) || ticker.quoteVolume < CONFIG.dynamicSpotPoolMinQuoteVolume) return false;
  return true;
}

export function isDynamicWeakPoolCandidate(ticker = {}, existing = new Set(), futuresSymbols = null) {
  const symbol = ticker.symbol || "";
  if (!symbol.endsWith("USDT")) return false;
  if (existing.has(symbol)) return false;
  if (futuresSymbols && !futuresSymbols.has(symbol)) return false;
  if (CONFIG.dynamicSpotPoolExcludedPatterns.some((pattern) => symbol.includes(pattern))) return false;
  if (!Number.isFinite(ticker.priceChangePercent) || ticker.priceChangePercent > CONFIG.dynamicWeakSpotPoolMaxPriceChangePercent) return false;
  if (ticker.priceChangePercent < CONFIG.dynamicWeakSpotPoolMinPriceChangePercent) return false;
  if (!Number.isFinite(ticker.quoteVolume) || ticker.quoteVolume < CONFIG.dynamicWeakSpotPoolMinQuoteVolume) return false;
  return true;
}

function volumesForRange(candles, start, end) {
  return candles.slice(start, end)
    .map((candle) => Number(candle?.volume))
    .filter(Number.isFinite);
}

function average(values) {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return 0;
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function isContinuousWindow(rows, intervalMs) {
  if (!Array.isArray(rows) || rows.length < 2) return false;
  for (let index = 1; index < rows.length; index++) {
    const previous = Number(rows[index - 1]?.openTime);
    const current = Number(rows[index]?.openTime);
    if (!Number.isFinite(previous) || !Number.isFinite(current) || current - previous !== intervalMs) {
      return false;
    }
  }
  return true;
}

function clampScore(value) {
  return Math.max(0, Math.min(100, Math.round(Number.isFinite(value) ? value : 0)));
}

function candleCloseTime(candle, interval) {
  const openTime = toTimestamp(candle?.openTime);
  return Number.isFinite(openTime) ? openTime + intervalHours(interval) * 3600 * 1000 : Infinity;
}

function toTimestamp(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value instanceof Date) return value.getTime();
  if (value == null || value === "") return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}
