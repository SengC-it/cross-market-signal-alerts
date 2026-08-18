import { CONFIG, intervalHours } from "../config.js";

export const TRADE_SPEC_VERSION = "trade_spec_v1";
export const NEXT_BAR_ENTRY_POLICY = "next_bar_open_eligible";
export const DEFAULT_SPOT_STOP_PCT = 0.03;

const HOUR_MS = 3600 * 1000;

export function intervalMilliseconds(interval) {
  return intervalHours(interval) * HOUR_MS;
}

export function createTradeSpec({
  side,
  direction,
  interval,
  signalCandleOpenTime,
  signalCandleCloseTime,
  signalAvailableAt,
  entryEligibleAt,
  referencePrice,
  stopLoss,
  takeProfit,
  rewardRiskRatio,
  maxHoldingHours,
  modeledRoundTripCostPct,
  modelVersion = null,
  source = "signal"
}) {
  const normalizedSide = normalizeSide(side || direction);
  const normalizedInterval = String(interval || "1h");
  const candleOpen = toTimestamp(signalCandleOpenTime);
  const candleClose = toTimestamp(signalCandleCloseTime)
    ?? (Number.isFinite(candleOpen) ? candleOpen + intervalMilliseconds(normalizedInterval) : null);
  const availableAt = toTimestamp(signalAvailableAt) ?? candleClose;
  const eligibleAt = toTimestamp(entryEligibleAt) ?? candleClose;
  const normalizedReferencePrice = toNumber(referencePrice);
  const normalizedStopLoss = toNumber(stopLoss);
  const normalizedTakeProfit = toNumber(takeProfit);
  const normalizedMaxHoldingHours = positiveNumber(maxHoldingHours);
  const normalizedRewardRiskRatio = positiveNumber(rewardRiskRatio)
    ?? inferRewardRiskRatio({
      side: normalizedSide,
      referencePrice: normalizedReferencePrice,
      stopLoss: normalizedStopLoss,
      takeProfit: normalizedTakeProfit
    });
  const maxHoldingTime = Number.isFinite(eligibleAt) && Number.isFinite(normalizedMaxHoldingHours)
    ? eligibleAt + normalizedMaxHoldingHours * HOUR_MS
    : null;

  return Object.freeze({
    version: TRADE_SPEC_VERSION,
    source,
    modelVersion: modelVersion || null,
    side: normalizedSide,
    interval: normalizedInterval,
    signalCandleOpenTime: candleOpen,
    signalCandleCloseTime: candleClose,
    signalAvailableAt: availableAt,
    entryEligibleAt: eligibleAt,
    entryPolicy: NEXT_BAR_ENTRY_POLICY,
    referencePrice: normalizedReferencePrice,
    entry: Object.freeze({
      policy: NEXT_BAR_ENTRY_POLICY,
      referencePrice: normalizedReferencePrice,
      eligibleAt
    }),
    stopLoss: normalizedStopLoss,
    takeProfit: normalizedTakeProfit,
    rewardRiskRatio: normalizedRewardRiskRatio,
    maxHoldingHours: normalizedMaxHoldingHours,
    maxHoldingTime,
    modeledRoundTripCostPct: nonNegativeNumber(modeledRoundTripCostPct)
  });
}

export function isTradeSpec(value) {
  return Boolean(
    value
    && value.version === TRADE_SPEC_VERSION
    && normalizeSide(value.side)
    && Number.isFinite(toNumber(value.referencePrice ?? value.entry?.referencePrice))
    && Number.isFinite(toNumber(value.stopLoss))
    && Number.isFinite(toNumber(value.takeProfit))
    && value.entry
    && value.entry.policy === NEXT_BAR_ENTRY_POLICY
  );
}

export function getTradeSpecForSignal(signal) {
  if (isTradeSpec(signal?.tradeSpec)) return signal.tradeSpec;
  return tradeSpecFromLegacyPayload(signal, {
    interval: signal?.interval,
    triggerTime: signal?.signalCandleOpenTime ?? signal?.triggerTime,
    direction: signal?.direction,
    strategyId: signal?.strategyId,
    strategyHoldHours: signal?.holdHours
  });
}

export function getTradeSpecForAlert(alert) {
  const payload = alert?.payload || alert || {};
  if (isTradeSpec(payload.tradeSpec)) return payload.tradeSpec;
  return tradeSpecFromLegacyPayload(payload, {
    interval: alert?.interval || payload.interval,
    triggerTime: alert?.trigger_time ?? payload.triggerTime,
    direction: alert?.signal_direction || payload.direction,
    strategyId: alert?.strategy_id || payload.strategyId,
    strategyHoldHours: payload.holdHours
  });
}

export function tradeSpecFromLegacyPayload(payload = {}, context = {}) {
  const executionPlan = payload.executionPlan || {};
  const interval = String(context.interval || payload.interval || "1h");
  const intervalMs = intervalMilliseconds(interval);
  const explicitOpenTime = toTimestamp(
    payload.signalCandleOpenTime
      ?? payload.signal_candle_open_time
      ?? payload.signalCandle?.openTime
  );
  const explicitCloseTime = toTimestamp(
    payload.signalCandleCloseTime
      ?? payload.signal_candle_close_time
      ?? payload.signalCandle?.closeTime
  );
  const legacyTriggerTime = toTimestamp(context.triggerTime ?? payload.triggerTime);
  const signalCandleOpenTime = explicitOpenTime
    ?? (Number.isFinite(explicitCloseTime) ? explicitCloseTime - intervalMs : legacyTriggerTime);
  const signalCandleCloseTime = explicitCloseTime
    ?? (Number.isFinite(signalCandleOpenTime) ? signalCandleOpenTime + intervalMs : null);
  const referencePrice = toNumber(
    executionPlan.referencePrice
      ?? executionPlan.entryReference
      ?? payload.referencePrice
      ?? payload.close
  );
  if (!Number.isFinite(referencePrice)) return null;

  const normalizedSide = normalizeSide(
    executionPlan.side
      ?? payload.side
      ?? context.direction
      ?? payload.direction
      ?? context.strategyId
      ?? payload.strategyId
  ) || "LONG";

  const explicitStopLoss = toNumber(executionPlan.stopLoss ?? payload.stopLoss);
  const explicitTakeProfit = toNumber(executionPlan.takeProfit ?? payload.takeProfit);
  const stopDistance = referencePrice * DEFAULT_SPOT_STOP_PCT;
  const fallbackRewardRiskRatio = CONFIG.futuresRewardRiskRatio || 1.5;
  const stopLoss = Number.isFinite(explicitStopLoss)
    ? explicitStopLoss
    : normalizedSide === "SHORT" ? referencePrice + stopDistance : referencePrice - stopDistance;
  const takeProfit = Number.isFinite(explicitTakeProfit)
    ? explicitTakeProfit
    : normalizedSide === "SHORT"
      ? referencePrice - stopDistance * fallbackRewardRiskRatio
      : referencePrice + stopDistance * fallbackRewardRiskRatio;
  const maxHoldingHours = executionPlan.maxHoldingHours
    ?? payload.maxHoldingHours
    ?? context.strategyHoldHours
    ?? null;

  return createTradeSpec({
    side: normalizedSide,
    interval,
    signalCandleOpenTime,
    signalCandleCloseTime,
    signalAvailableAt: signalCandleCloseTime,
    entryEligibleAt: signalCandleCloseTime,
    referencePrice,
    stopLoss,
    takeProfit,
    rewardRiskRatio: executionPlan.rewardRiskRatio ?? fallbackRewardRiskRatio,
    maxHoldingHours,
    modeledRoundTripCostPct: executionPlan.modeledRoundTripCostPct,
    modelVersion: executionPlan.modelVersion || payload.modelVersion || "legacy",
    source: "legacy_adapter"
  });
}

export function legacyExecutionPlanFromTradeSpec(tradeSpec, extra = {}) {
  if (!isTradeSpec(tradeSpec)) return { ...extra };
  return {
    ...extra,
    entryPolicy: tradeSpec.entryPolicy,
    entryReference: tradeSpec.referencePrice,
    referencePrice: tradeSpec.referencePrice,
    stopLoss: tradeSpec.stopLoss,
    takeProfit: tradeSpec.takeProfit,
    rewardRiskRatio: tradeSpec.rewardRiskRatio,
    maxHoldingHours: tradeSpec.maxHoldingHours,
    modeledRoundTripCostPct: tradeSpec.modeledRoundTripCostPct,
    signalCandleOpenTime: tradeSpec.signalCandleOpenTime,
    signalCandleCloseTime: tradeSpec.signalCandleCloseTime,
    signalAvailableAt: tradeSpec.signalAvailableAt,
    entryEligibleAt: tradeSpec.entryEligibleAt,
    modelVersion: tradeSpec.modelVersion || extra.modelVersion || null
  };
}

export function attachTradeSpec(signal, tradeSpec, legacyExecutionPlan = {}) {
  if (!isTradeSpec(tradeSpec)) return signal;
  return {
    ...signal,
    signalCandleOpenTime: tradeSpec.signalCandleOpenTime,
    signalCandleCloseTime: tradeSpec.signalCandleCloseTime,
    signalAvailableAt: tradeSpec.signalAvailableAt,
    entryEligibleAt: tradeSpec.entryEligibleAt,
    triggerTime: tradeSpec.signalAvailableAt,
    tradeSpec,
    executionPlan: legacyExecutionPlanFromTradeSpec(tradeSpec, legacyExecutionPlan)
  };
}

function normalizeSide(value) {
  const text = String(value || "").toUpperCase();
  if (text.includes("SHORT") || text.includes("做空") || text.includes("空") || text.includes("下跌")) return "SHORT";
  if (text.includes("LONG") || text.includes("做多") || text.includes("多") || text.includes("上涨")) return "LONG";
  return null;
}

function inferRewardRiskRatio({ side, referencePrice, stopLoss, takeProfit }) {
  if (!side || !Number.isFinite(referencePrice) || !Number.isFinite(stopLoss) || !Number.isFinite(takeProfit)) return null;
  const stopDistance = Math.abs(stopLoss - referencePrice);
  const targetDistance = Math.abs(takeProfit - referencePrice);
  return stopDistance > 0 ? targetDistance / stopDistance : null;
}

function toTimestamp(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value instanceof Date) return value.getTime();
  if (value == null || value === "") return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function toNumber(value) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function positiveNumber(value) {
  const parsed = toNumber(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function nonNegativeNumber(value) {
  const parsed = toNumber(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
