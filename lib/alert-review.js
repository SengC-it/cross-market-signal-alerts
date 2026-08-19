import { getTradeSpecForAlert, intervalMilliseconds } from "./trading/trade-spec.js";

export function reviewAlertWithCandles(alert, candles, now = Date.now()) {
  const tradeSpec = getTradeSpecForAlert(alert);
  const entry = Number(tradeSpec?.entry?.referencePrice ?? tradeSpec?.referencePrice);
  if (!tradeSpec || !Number.isFinite(entry)) {
    return pendingReview("复盘数据缺失");
  }
  if (!Number.isFinite(Number(tradeSpec.stopLoss)) || !Number.isFinite(Number(tradeSpec.takeProfit))) {
    return pendingReview("缺少止损止盈");
  }

  const intervalMs = intervalMilliseconds(tradeSpec.interval || alert?.interval || "1h");
  const firstEligibleOpenTime = Number(tradeSpec.entryEligibleAt);
  if (!Number.isFinite(firstEligibleOpenTime)) {
    return pendingReview("缺少下一根K线入场时间");
  }
  const sentAt = toTimestamp(
    alert?.sent_at
      ?? alert?.sentAt
      ?? alert?.payload?.sentAt
      ?? alert?.payload?.sent_at
  );
  const firstCandleCloseTime = firstEligibleOpenTime + intervalMs;
  const reviewStartTime = Number.isFinite(sentAt) && sentAt > firstEligibleOpenTime
    ? sentAt
    : firstEligibleOpenTime;
  const partialCandle = Number.isFinite(sentAt) && sentAt > firstEligibleOpenTime
    ? candles.find((candle) => {
      const openTime = Number(candle.openTime);
      return openTime >= firstEligibleOpenTime
        && openTime < sentAt
        && sentAt < openTime + intervalMs;
    })
    : null;
  if (partialCandle || (sentAt > firstEligibleOpenTime && sentAt < firstCandleCloseTime)) {
    const partialCloseTime = Number(partialCandle?.openTime) + intervalMs || firstCandleCloseTime;
    return pendingPartialCandleReview(now < partialCloseTime ? partialCloseTime : null, firstEligibleOpenTime);
  }
  const windowCandles = candles
    .filter((candle) => Number(candle.openTime) >= reviewStartTime && Number(candle.openTime) + intervalMs <= now)
    .sort((a, b) => a.openTime - b.openTime);
  if (!windowCandles.length) return pendingReview("等待止盈止损K线", firstEligibleOpenTime + intervalMs);

  const isShort = tradeSpec.side === "SHORT";
  const timeStopAt = tradeSpec.maxHoldingTime != null && Number.isFinite(Number(tradeSpec.maxHoldingTime))
    ? Number(tradeSpec.maxHoldingTime)
    : null;
  for (const candle of windowCandles) {
    const hitStop = isShort ? candle.high >= tradeSpec.stopLoss : candle.low <= tradeSpec.stopLoss;
    const hitTarget = isShort ? candle.low <= tradeSpec.takeProfit : candle.high >= tradeSpec.takeProfit;
    if (hitStop) {
      const gapAwareExit = isShort
        ? Math.max(Number(candle.open), tradeSpec.stopLoss)
        : Math.min(Number(candle.open), tradeSpec.stopLoss);
      const exitPrice = Number.isFinite(gapAwareExit) ? gapAwareExit : tradeSpec.stopLoss;
      return finishedReview("止损", exitPrice, entry, isShort, candle.openTime, now, tradeSpec);
    }
    if (hitTarget) return finishedReview("止盈", tradeSpec.takeProfit, entry, isShort, candle.openTime, now, tradeSpec);
    if (Number.isFinite(timeStopAt) && Number(candle.openTime) + intervalMs >= timeStopAt) {
      return finishedReview("时间退出", Number(candle.close), entry, isShort, candle.openTime, now, tradeSpec);
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

function finishedReview(outcome, exitPrice, entry, isShort, exitTime, reviewedAt, plan) {
  const grossReturnPct = returnPct(entry, exitPrice, isShort);
  const modeledCostPct = Number(plan?.modeledRoundTripCostPct) || 0;
  return {
    status: "reviewed",
    outcome,
    exitPrice,
    exitTime,
    referencePrice: entry,
    entryEligibleAt: plan?.entryEligibleAt ?? null,
    tradeSpecVersion: plan?.version || null,
    returnPct: Number.isFinite(grossReturnPct) ? grossReturnPct - modeledCostPct : null,
    grossReturnPct,
    modeledCostPct,
    netOfCosts: modeledCostPct > 0,
    method: plan?.modelVersion || plan?.version || "legacy",
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

function pendingPartialCandleReview(reviewAfter, entryEligibleAt) {
  return {
    status: "pending",
    state: "ambiguous",
    reason: "pending_partial_candle",
    entryEligibleAt,
    reviewAfter,
    note: "M1 cannot use full OHLC for a candle that was already in progress when the alert was sent; lower-timeframe replay is deferred to M2."
  };
}

function toTimestamp(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value instanceof Date) return value.getTime();
  if (value == null || value === "") return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}
