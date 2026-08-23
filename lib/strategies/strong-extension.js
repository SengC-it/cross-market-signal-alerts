import { CONFIG } from "../config.js";
import { computeDynamicProductionFeatures } from "./dynamic-production.js";

export const STRONG_CORE_VARIANT = "STRONG_CORE_8_10";
export const STRONG_EXTENSION_VARIANT = "STRONG_EXTENSION_10_15";

export const STRONG_CORE_PROFILE = Object.freeze({
  variant: STRONG_CORE_VARIANT,
  momentumMin: 0.08,
  momentumMax: 0.10,
  relativeStrengthMin: 0.12,
  volumeMin: 1.5,
  volumeMax: 2,
  quoteVolumeMin: 50_000_000,
  breakoutRequired: true,
  cooldownHours: 24
});

export const STRONG_EXTENSION_PROFILE = Object.freeze({
  variant: STRONG_EXTENSION_VARIANT,
  momentumMin: 0.10,
  momentumMax: 0.15,
  momentumLowerExclusive: true,
  relativeStrengthMin: STRONG_CORE_PROFILE.relativeStrengthMin,
  volumeMin: STRONG_CORE_PROFILE.volumeMin,
  volumeMax: STRONG_CORE_PROFILE.volumeMax,
  quoteVolumeMin: STRONG_CORE_PROFILE.quoteVolumeMin,
  breakoutRequired: STRONG_CORE_PROFILE.breakoutRequired,
  cooldownHours: STRONG_CORE_PROFILE.cooldownHours
});

export function isStrongExtensionPoolCandidate(
  ticker = {},
  existing = new Set(),
  futuresSymbols = null
) {
  const symbol = String(ticker.symbol || "");
  const priceChangePercent = Number(ticker.priceChangePercent);
  if (!symbol.endsWith("USDT")) return false;
  if (existing.has(symbol)) return false;
  if (futuresSymbols && !futuresSymbols.has(symbol)) return false;
  if (CONFIG.dynamicSpotPoolExcludedPatterns.some((pattern) => symbol.includes(pattern))) return false;
  if (!Number.isFinite(priceChangePercent)
    || priceChangePercent <= STRONG_EXTENSION_PROFILE.momentumMin * 100
    || priceChangePercent > STRONG_EXTENSION_PROFILE.momentumMax * 100) return false;
  if (!Number.isFinite(Number(ticker.quoteVolume))
    || Number(ticker.quoteVolume) < STRONG_EXTENSION_PROFILE.quoteVolumeMin) return false;
  return true;
}

export function rankStrongExtensionPoolTickers({
  tickers = [],
  existing = new Set(),
  futuresSymbols = null,
  maxAssets = 25
} = {}) {
  return tickers
    .filter((ticker) => isStrongExtensionPoolCandidate(ticker, existing, futuresSymbols))
    .sort((left, right) => poolScore(right) - poolScore(left))
    .slice(0, Math.max(0, Number(maxAssets) || 0))
    .map((ticker) => ticker.symbol);
}

export function evaluateStrongExtensionProductionSignal({
  candles = [],
  signalIndex = candles.length - 2,
  benchmarkChange24h = null,
  hasOrderBook = false
} = {}) {
  const features = computeDynamicProductionFeatures({
    strategyId: "dynamic_relative_strength_breakout",
    candles,
    signalIndex,
    benchmarkChange24h
  });
  const opportunity = evaluateStrongExtensionOpportunity({ features, hasOrderBook });
  const momentumBoundaryPassed = opportunity.reason !== "extension_momentum_boundary";
  const liquidityPassed = Number(features.quoteVolume24h) >= STRONG_EXTENSION_PROFILE.quoteVolumeMin;
  const scoreGatePassed = momentumBoundaryPassed
    && opportunity.passed
    && liquidityPassed
    && opportunity.score >= CONFIG.dynamicTradeMinRecommendationScore;
  return {
    passed: scoreGatePassed,
    scoreGatePassed,
    reason: !momentumBoundaryPassed
      ? "extension_momentum_boundary"
      : !liquidityPassed
      ? "insufficient_quote_volume"
      : scoreGatePassed ? null : opportunity.reason || "recommendation_score_below_floor",
    score: opportunity.score,
    features,
    opportunity
  };
}

function poolScore(ticker) {
  return Math.abs(Number(ticker.priceChangePercent))
    * Math.log10(Math.max(10, Number(ticker.quoteVolume)));
}

export function evaluateStrongExtensionOpportunity({ features = {}, hasOrderBook = false } = {}) {
  const {
    momentum24h,
    relativeStrength,
    volumeMultiple,
    breakout
  } = features;
  if (!Number.isFinite(momentum24h)
    || momentum24h <= STRONG_EXTENSION_PROFILE.momentumMin
    || momentum24h > STRONG_EXTENSION_PROFILE.momentumMax) {
    return { passed: false, score: 0, reason: "extension_momentum_boundary" };
  }
  if (!Number.isFinite(relativeStrength) || relativeStrength < STRONG_EXTENSION_PROFILE.relativeStrengthMin) {
    return { passed: false, score: 0, reason: "insufficient_relative_strength" };
  }
  if (!breakout) return { passed: false, score: 0, reason: "no_breakout" };
  if (!Number.isFinite(volumeMultiple) || volumeMultiple < STRONG_EXTENSION_PROFILE.volumeMin) {
    return { passed: false, score: 0, reason: "insufficient_volume" };
  }
  if (volumeMultiple > STRONG_EXTENSION_PROFILE.volumeMax) {
    return {
      passed: false,
      score: 0,
      reason: volumeMultiple <= 4 ? "weak_edge_volume" : "overheated_volume"
    };
  }

  const momentumCenter = (STRONG_EXTENSION_PROFILE.momentumMin + STRONG_EXTENSION_PROFILE.momentumMax) / 2;
  const momentumWidth = Math.max(0.01, STRONG_EXTENSION_PROFILE.momentumMax - STRONG_EXTENSION_PROFILE.momentumMin);
  const momentumScore = clampScore(10 - Math.abs(momentum24h - momentumCenter) / momentumWidth * 6);
  const relativeScore = Math.min(4, Math.max(0, Number(relativeStrength) * 30));
  const volumeCenter = (STRONG_EXTENSION_PROFILE.volumeMin + STRONG_EXTENSION_PROFILE.volumeMax) / 2;
  const volumeWidth = Math.max(0.1, STRONG_EXTENSION_PROFILE.volumeMax - STRONG_EXTENSION_PROFILE.volumeMin);
  const volumeScore = clampScore(5 - Math.abs(volumeMultiple - volumeCenter) / volumeWidth * 4);
  const score = Math.min(
    CONFIG.dynamicObservationMaxScore,
    clampScore(70 + momentumScore + relativeScore + volumeScore + (hasOrderBook ? 2 : 0))
  );
  return { passed: true, score, reason: null };
}

function clampScore(value) {
  return Math.max(0, Math.min(100, Math.round(Number.isFinite(value) ? value : 0)));
}
