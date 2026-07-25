import { CONFIG, intervalHours } from "./config.js";

const DEFAULT_SPOT_STOP_PCT = 0.03;
const DEFAULT_REWARD_RISK = CONFIG.futuresRewardRiskRatio || 1.5;

export function reviewAlertWithCandles(alert, candles, now = Date.now()) {
  const payload = alert?.payload || {};
  const triggerTime = new Date(alert?.trigger_time || payload.triggerTime).getTime();
  const sentTime = new Date(alert?.sent_at || payload.sentAt || payload.sent_at || triggerTime).getTime();
  const entry = Number(payload.executionPlan?.entryReference ?? payload.close);
  if (!Number.isFinite(triggerTime) || !Number.isFinite(entry)) {
    return pendingReview("复盘数据缺失");
  }

  const plan = tradePlan(payload, entry);
  if (!plan) return pendingReview("缺少止损止盈");

  const intervalMs = intervalHours(alert?.interval || payload.interval || "1h") * 3600 * 1000;

  const reviewStartTime = Number.isFinite(sentTime) ? Math.max(triggerTime, sentTime) : triggerTime;
  const firstEligibleOpenTime = Math.ceil(reviewStartTime / intervalMs) * intervalMs;
  const windowCandles = candles
    .filter((candle) => candle.openTime >= firstEligibleOpenTime && candle.openTime + intervalMs <= now)
    .sort((a, b) => a.openTime - b.openTime);
  if (!windowCandles.length) return pendingReview("等待止盈止损K线", firstEligibleOpenTime + intervalMs);

  const isShort = isShortSignal(payload);
  const timeStopAt = Number.isFinite(plan.maxHoldingHours)
    ? firstEligibleOpenTime + plan.maxHoldingHours * 3600 * 1000
    : null;
  for (const candle of windowCandles) {
    const hitStop = isShort ? candle.high >= plan.stopLoss : candle.low <= plan.stopLoss;
    const hitTarget = isShort ? candle.low <= plan.takeProfit : candle.high >= plan.takeProfit;
    if (hitStop) {
      const gapAwareExit = isShort
        ? Math.max(Number(candle.open), plan.stopLoss)
        : Math.min(Number(candle.open), plan.stopLoss);
      const exitPrice = Number.isFinite(gapAwareExit) ? gapAwareExit : plan.stopLoss;
      return finishedReview("止损", exitPrice, entry, isShort, candle.openTime, now, plan);
    }
    if (hitTarget) return finishedReview("止盈", plan.takeProfit, entry, isShort, candle.openTime, now, plan);
    if (Number.isFinite(timeStopAt) && candle.openTime + intervalMs >= timeStopAt) {
      return finishedReview("时间退出", Number(candle.close), entry, isShort, candle.openTime, now, plan);
    }
  }

  return pendingReview("等待止盈止损触发", now + intervalMs);
}

export function reviewArbitrageAlert(alert, now = Date.now()) {
  const payload = alert?.payload || {};
  const details = payload.details || {};
  const validUntil = Number(payload.validUntil || details.nextFundingTime);
  if (Number.isFinite(validUntil) && now < validUntil) {
    return pendingReview("等待资金费结算", validUntil);
  }

  const funding = Number(details.fundingRate);
  const dailyFunding = Number(details.estimatedDailyFunding);
  return {
    status: "reviewed",
    outcome: "已结算",
    exitPrice: Number(payload.close),
    exitTime: Number.isFinite(validUntil) ? validUntil : now,
    returnPct: Number.isFinite(dailyFunding) ? dailyFunding : Math.abs(funding) * 3,
    reviewedAt: now,
    note: "套利复盘仅按资金费估算，未包含实际滑点、手续费和两边成交差"
  };
}

function tradePlan(payload, entry) {
  const executionPlan = payload.executionPlan || {};
  const stopLoss = Number(executionPlan.stopLoss);
  const takeProfit = Number(executionPlan.takeProfit);
  if (Number.isFinite(stopLoss) && Number.isFinite(takeProfit)) {
    const maxHoldingHours = Number(executionPlan.maxHoldingHours);
    const modeledCostPct = Number(executionPlan.modeledRoundTripCostPct);
    return {
      stopLoss,
      takeProfit,
      maxHoldingHours: Number.isFinite(maxHoldingHours) && maxHoldingHours > 0 ? maxHoldingHours : null,
      modeledCostPct: Number.isFinite(modeledCostPct) && modeledCostPct >= 0 ? modeledCostPct : 0,
      modelVersion: executionPlan.modelVersion || payload.modelVersion || "legacy"
    };
  }

  const stopDistance = entry * DEFAULT_SPOT_STOP_PCT;
  const targetDistance = stopDistance * DEFAULT_REWARD_RISK;
  const isShort = isShortSignal(payload);
  return {
    stopLoss: isShort ? entry + stopDistance : entry - stopDistance,
    takeProfit: isShort ? entry - targetDistance : entry + targetDistance,
    maxHoldingHours: null,
    modeledCostPct: 0,
    modelVersion: "legacy"
  };
}

function finishedReview(outcome, exitPrice, entry, isShort, exitTime, reviewedAt, plan) {
  const grossReturnPct = returnPct(entry, exitPrice, isShort);
  const modeledCostPct = Number(plan?.modeledCostPct) || 0;
  return {
    status: "reviewed",
    outcome,
    exitPrice,
    exitTime,
    returnPct: Number.isFinite(grossReturnPct) ? grossReturnPct - modeledCostPct : null,
    grossReturnPct,
    modeledCostPct,
    netOfCosts: modeledCostPct > 0,
    method: plan?.modelVersion || "legacy",
    reviewedAt
  };
}

function returnPct(entry, exitPrice, isShort) {
  if (!Number.isFinite(entry) || !Number.isFinite(exitPrice) || entry === 0) return null;
  const raw = exitPrice / entry - 1;
  return isShort ? -raw : raw;
}

function pendingReview(reason, reviewAfter = null) {
  return {
    status: "pending",
    reason,
    reviewAfter
  };
}

function isShortSignal(payload) {
  const text = `${payload.direction || ""} ${payload.strategyId || ""} ${payload.strategy_id || ""}`;
  return text.includes("SHORT") || text.includes("空") || text.includes("下跌");
}
