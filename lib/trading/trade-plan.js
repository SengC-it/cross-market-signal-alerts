import { CONFIG } from "../config.js";
import { atr } from "../indicators.js";
import {
  createTradeSpec,
  DEFAULT_SPOT_STOP_PCT,
  intervalMilliseconds
} from "./trade-spec.js";

export function maxHoldingHoursForStrategy(strategy, marketType = "spot") {
  const strategyHours = positiveNumber(strategy?.holdHours);
  if (!Number.isFinite(strategyHours)) return null;
  if (marketType === "futures") {
    return Math.min(strategyHours, CONFIG.futuresMaxHoldingHours);
  }
  return strategyHours;
}

export function buildTradePlan({ marketType = "spot", tradePlanType = marketType, ...options }) {
  return tradePlanType === "futures"
    ? buildFuturesTradePlan(options)
    : buildSpotTradePlan(options);
}

export function buildSpotTradePlan({
  signal = {},
  strategy = {},
  interval,
  referencePrice = signal.close,
  modelVersion = "spot_signal_v1"
}) {
  const normalizedReferencePrice = Number(referencePrice);
  const stopDistance = normalizedReferencePrice * DEFAULT_SPOT_STOP_PCT;
  const isShort = strategy.direction === "SHORT";
  const maxHoldingHours = maxHoldingHoursForStrategy(strategy, "spot");
  const timing = resolveSignalTiming({ signal, interval });
  const tradeSpec = createTradeSpec({
    side: strategy.direction || signal.direction,
    interval: timing.interval,
    signalCandleOpenTime: timing.signalCandleOpenTime,
    signalCandleCloseTime: timing.signalCandleCloseTime,
    signalAvailableAt: timing.signalAvailableAt,
    entryEligibleAt: timing.entryEligibleAt,
    referencePrice: normalizedReferencePrice,
    stopLoss: isShort ? normalizedReferencePrice + stopDistance : normalizedReferencePrice - stopDistance,
    takeProfit: isShort
      ? normalizedReferencePrice - stopDistance * (CONFIG.futuresRewardRiskRatio || 1.5)
      : normalizedReferencePrice + stopDistance * (CONFIG.futuresRewardRiskRatio || 1.5),
    rewardRiskRatio: CONFIG.futuresRewardRiskRatio || 1.5,
    maxHoldingHours,
    modelVersion
  });

  return {
    tradeSpec,
    executionPlan: {
      modelVersion,
      tradePlanType: "spot",
      entryPolicy: "next_full_candle",
      entryReference: normalizedReferencePrice,
      stopLoss: tradeSpec?.stopLoss ?? null,
      takeProfit: tradeSpec?.takeProfit ?? null,
      rewardRiskRatio: CONFIG.futuresRewardRiskRatio || 1.5,
      maxHoldingHours,
      modeledRoundTripCostPct: null
    }
  };
}

export function buildFuturesTradePlan({
  signal = {},
  candles = [],
  signalIndex = candles.length - 2,
  strategy = {},
  interval,
  funding = null,
  openInterest = null,
  sentiment = null,
  modelVersion = "trade_plan_v2"
}) {
  const latest = candles[signalIndex];
  const referencePrice = Number(signal.close ?? latest?.close);
  if (!latest || !Number.isFinite(referencePrice)) {
    return { tradeSpec: null, executionPlan: {} };
  }

  const latestAtr = atr(candles, 14, signalIndex);
  const fallbackStopDistance = referencePrice * CONFIG.futuresFallbackStopPct;
  const stopDistance = Number.isFinite(latestAtr)
    ? Math.max(latestAtr * CONFIG.futuresStopAtrMultiplier, referencePrice * CONFIG.futuresMinStopPct)
    : fallbackStopDistance;
  const isShort = strategy.direction === "SHORT";
  const stopLoss = isShort ? referencePrice + stopDistance : referencePrice - stopDistance;
  const takeProfit = isShort
    ? referencePrice - stopDistance * CONFIG.futuresRewardRiskRatio
    : referencePrice + stopDistance * CONFIG.futuresRewardRiskRatio;
  const stopPct = Math.abs(stopDistance / referencePrice);
  const leverageCapByStop = stopPct > 0
    ? Math.max(1, Math.floor(CONFIG.futuresMaxLeveragedStopPct / stopPct))
    : 1;
  const suggestedLeverage = Math.max(1, Math.min(CONFIG.futuresMaxSuggestedLeverage, leverageCapByStop));
  const maxPositionPct = stopPct > 0
    ? Math.min(1, CONFIG.futuresMaxPositionRiskPct / stopPct)
    : 0;
  const fundingRate = Number.isFinite(funding?.fundingRate) ? funding.fundingRate : null;
  const accountRatio = sentiment?.accounts?.ratio ?? null;
  const topRatio = sentiment?.topPositions?.ratio ?? null;
  const maxHoldingHours = maxHoldingHoursForStrategy(strategy, "futures");
  const timing = resolveSignalTiming({
    signal: {
      ...signal,
      signalCandleOpenTime: signal.signalCandleOpenTime ?? latest.openTime
    },
    interval
  });
  const executionPlan = {
    modelVersion,
    tradePlanType: "futures",
    entryPolicy: "next_full_candle",
    style: interval === "1h" ? "短线观察" : interval === "2h" || interval === "4h" ? "波段观察" : "慢周期观察",
    scanCadence: interval === "1h" ? "建议每 1 小时复核一次" : interval === "2h" || interval === "4h" ? "建议每 4 小时复核一次" : "建议每天复核一次",
    validFor: interval === "1h" ? "约 2-4 小时" : interval === "2h" ? "约 4-8 小时" : interval === "4h" ? "约 8-16 小时" : "约 1-3 天",
    entryReference: referencePrice,
    stopLoss,
    takeProfit,
    stopPct,
    rewardRiskRatio: CONFIG.futuresRewardRiskRatio,
    maxHoldingHours,
    modeledRoundTripCostPct: CONFIG.futuresTradingCost,
    suggestedLeverage,
    maxPositionPct,
    fundingRate,
    openInterest: Number.isFinite(openInterest?.openInterest) ? openInterest.openInterest : null,
    accountLongShortRatio: Number.isFinite(accountRatio) ? accountRatio : null,
    topTraderLongShortRatio: Number.isFinite(topRatio) ? topRatio : null
  };
  const tradeSpec = createTradeSpec({
    side: strategy.direction,
    interval: timing.interval,
    signalCandleOpenTime: timing.signalCandleOpenTime,
    signalCandleCloseTime: timing.signalCandleCloseTime,
    signalAvailableAt: timing.signalAvailableAt,
    entryEligibleAt: timing.entryEligibleAt,
    referencePrice,
    stopLoss,
    takeProfit,
    rewardRiskRatio: CONFIG.futuresRewardRiskRatio,
    maxHoldingHours,
    modeledRoundTripCostPct: CONFIG.futuresTradingCost,
    modelVersion
  });

  return { tradeSpec, executionPlan };
}

function resolveSignalTiming({ signal = {}, interval }) {
  const normalizedInterval = String(interval || signal.interval || "1h");
  const signalCandleOpenTime = toTimestamp(signal.signalCandleOpenTime ?? signal.candle?.openTime);
  const signalCandleCloseTime = toTimestamp(signal.signalCandleCloseTime)
    ?? (Number.isFinite(signalCandleOpenTime) ? signalCandleOpenTime + intervalMilliseconds(normalizedInterval) : null);
  return {
    interval: normalizedInterval,
    signalCandleOpenTime,
    signalCandleCloseTime,
    signalAvailableAt: toTimestamp(signal.signalAvailableAt) ?? signalCandleCloseTime,
    entryEligibleAt: toTimestamp(signal.entryEligibleAt) ?? signalCandleCloseTime
  };
}

function toTimestamp(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value instanceof Date) return value.getTime();
  if (value == null || value === "") return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function positiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
