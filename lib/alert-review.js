import { intervalHours } from "./config.js";

const DEFAULT_SPOT_STOP_PCT = 0.03;
const DEFAULT_REWARD_RISK = 1.8;

export function reviewAlertWithCandles(alert, candles, now = Date.now()) {
  const payload = alert?.payload || {};
  const triggerTime = new Date(alert?.trigger_time || payload.triggerTime).getTime();
  const entry = Number(payload.executionPlan?.entryReference ?? payload.close);
  if (!Number.isFinite(triggerTime) || !Number.isFinite(entry)) {
    return pendingReview("复盘数据缺失");
  }

  const plan = tradePlan(payload, entry);
  if (!plan) return pendingReview("缺少止损止盈");

  const validUntil = Number(payload.validUntil) || triggerTime + intervalHours(alert?.interval || payload.interval || "1h") * 3600 * 1000;
  if (now < validUntil) return pendingReview("等待有效期结束", validUntil);

  const windowCandles = candles
    .filter((candle) => candle.openTime > triggerTime && candle.openTime <= validUntil)
    .sort((a, b) => a.openTime - b.openTime);
  if (!windowCandles.length) return pendingReview("等待退出K线", validUntil);

  const isShort = isShortSignal(payload);
  for (const candle of windowCandles) {
    const hitStop = isShort ? candle.high >= plan.stopLoss : candle.low <= plan.stopLoss;
    const hitTarget = isShort ? candle.low <= plan.takeProfit : candle.high >= plan.takeProfit;
    if (hitStop) return finishedReview("止损", plan.stopLoss, entry, isShort, candle.openTime, now);
    if (hitTarget) return finishedReview("止盈", plan.takeProfit, entry, isShort, candle.openTime, now);
  }

  const exitCandle = windowCandles.at(-1);
  const exitPrice = Number(exitCandle.close);
  const result = returnPct(entry, exitPrice, isShort);
  return {
    status: "reviewed",
    outcome: result >= 0 ? "盈利" : "亏损",
    exitPrice,
    exitTime: exitCandle.openTime,
    returnPct: result,
    reviewedAt: now
  };
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
  const stopLoss = Number(payload.executionPlan?.stopLoss);
  const takeProfit = Number(payload.executionPlan?.takeProfit);
  if (Number.isFinite(stopLoss) && Number.isFinite(takeProfit)) {
    return { stopLoss, takeProfit };
  }

  const stopDistance = entry * DEFAULT_SPOT_STOP_PCT;
  const targetDistance = stopDistance * DEFAULT_REWARD_RISK;
  const isShort = isShortSignal(payload);
  return {
    stopLoss: isShort ? entry + stopDistance : entry - stopDistance,
    takeProfit: isShort ? entry - targetDistance : entry + targetDistance
  };
}

function finishedReview(outcome, exitPrice, entry, isShort, exitTime, reviewedAt) {
  return {
    status: "reviewed",
    outcome,
    exitPrice,
    exitTime,
    returnPct: returnPct(entry, exitPrice, isShort),
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
