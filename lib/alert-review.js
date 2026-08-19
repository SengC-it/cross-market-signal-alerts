import { getTradeSpecForAlert, intervalMilliseconds } from "./trading/trade-spec.js";
import { prepareTradeSpecForExecution } from "./trading/exchange-filters.js";
import {
  INCOMPLETE_INTRABAR_DATA,
  resolveIntrabarExit,
  resolveTimeStop
} from "./trading/replay-engine.js";

export function reviewAlertWithCandles(alert, candles, now = Date.now(), options = {}) {
  const tradeSpec = getTradeSpecForAlert(alert);
  const entry = Number(tradeSpec?.entry?.referencePrice ?? tradeSpec?.referencePrice);
  if (!tradeSpec || !Number.isFinite(entry)) {
    return pendingReview("复盘数据缺失");
  }
  if (!Number.isFinite(Number(tradeSpec.stopLoss)) || !Number.isFinite(Number(tradeSpec.takeProfit))) {
    return pendingReview("缺少止损止盈");
  }
  const prepared = prepareTradeSpecForExecution(tradeSpec, options.exchangeFilters || null);
  if (!prepared.valid || !prepared.tradeSpec) {
    return pendingReview("交易所过滤器数据缺失", null, {
      dataQuality: "INCOMPLETE_EXCHANGE_FILTERS",
      exchangeFilterReason: prepared.reason
    });
  }
  const effectiveTradeSpec = prepared.tradeSpec;

  const intervalMs = intervalMilliseconds(effectiveTradeSpec.interval || alert?.interval || "1h");
  const firstEligibleOpenTime = Number(effectiveTradeSpec.entryEligibleAt);
  if (!Number.isFinite(firstEligibleOpenTime)) {
    return pendingReview("缺少下一根K线入场时间");
  }
  const sentAt = toTimestamp(
    alert?.sent_at
      ?? alert?.sentAt
      ?? alert?.payload?.sentAt
      ?? alert?.payload?.sent_at
  );
  const reviewStartTime = Number.isFinite(sentAt) && sentAt > firstEligibleOpenTime
    ? sentAt
    : firstEligibleOpenTime;
  const lowerTimeframeCandles = options.lowerTimeframeCandles || options.lowerCandles;
  const lowerTimeframe = options.lowerTimeframe || null;
  if (Number.isFinite(sentAt) && sentAt > firstEligibleOpenTime) {
    const partialCandle = candles.find((candle) => {
      const openTime = Number(candle.openTime);
      return Number.isFinite(openTime)
        && openTime < sentAt
        && sentAt < openTime + intervalMs;
    });
    if (partialCandle && now < Number(partialCandle.openTime) + intervalMs) {
      return pendingPartialCandleReview(
        Number(partialCandle.openTime) + intervalMs,
        firstEligibleOpenTime
      );
    }
  }
  const windowCandles = candles
    .filter((candle) => {
      const openTime = Number(candle.openTime);
      const closeTime = openTime + intervalMs;
      return Number.isFinite(openTime)
        && closeTime > reviewStartTime
        && closeTime <= now;
    })
    .sort((a, b) => a.openTime - b.openTime);
  if (!windowCandles.length) return pendingReview("等待止盈止损K线", firstEligibleOpenTime + intervalMs);

  for (const candle of windowCandles) {
    const replayStart = Math.max(reviewStartTime, Number(candle.openTime));
    const intrabarExit = resolveIntrabarExit({
      tradeSpec: effectiveTradeSpec,
      baseCandle: candle,
      lowerTimeframeCandles,
      lowerTimeframe,
      replayStart
    });
    if (intrabarExit.resolved) {
      if (intrabarExit.requiresLowerTimeframe && !intrabarExit.lowerTimeframeReplayed) {
        return pendingPartialCandleReview(
          now,
          firstEligibleOpenTime,
          intrabarExit.reason === "INCOMPLETE_PARTIAL_CANDLE"
            ? "pending_partial_candle"
            : intrabarExit.reason || "ambiguous_intrabar"
        );
      }
      return finishedReview(
        outcomeForExit(intrabarExit.exitReason),
        intrabarExit.exitMarketPrice,
        entry,
        effectiveTradeSpec.side === "SHORT",
        intrabarExit.exitTime,
        now,
        effectiveTradeSpec,
        {
          exitResolution: normalizeExitResolution(intrabarExit),
          ambiguousIntrabar: Boolean(intrabarExit.ambiguousIntrabar),
          dataQuality: intrabarExit.dataQuality,
          lowerTimeframeReplayed: Boolean(intrabarExit.lowerTimeframeReplayed)
        }
      );
    }
    if (intrabarExit.requiresLowerTimeframe) {
      return pendingPartialCandleReview(
        now,
        firstEligibleOpenTime,
        intrabarExit.reason === "INCOMPLETE_PARTIAL_CANDLE"
          ? "pending_partial_candle"
          : intrabarExit.reason || "ambiguous_intrabar"
      );
    }

    const timeStop = resolveTimeStop({
      tradeSpec: effectiveTradeSpec,
      baseCandle: candle,
      lowerTimeframeCandles,
      lowerTimeframe,
      replayStart
    });
    if (timeStop.resolved) {
      if (timeStop.requiresLowerTimeframe && !timeStop.lowerTimeframeReplayed) {
        return pendingPartialCandleReview(now, firstEligibleOpenTime, "time_stop_requires_lower_timeframe");
      }
      return finishedReview(
        "时间退出",
        timeStop.exitMarketPrice,
        entry,
        effectiveTradeSpec.side === "SHORT",
        timeStop.exitTime,
        now,
        effectiveTradeSpec,
        {
          exitResolution: "time_stop",
          ambiguousIntrabar: false,
          dataQuality: timeStop.dataQuality,
          lowerTimeframeReplayed: Boolean(timeStop.lowerTimeframeReplayed)
        }
      );
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

function finishedReview(outcome, exitPrice, entry, isShort, exitTime, reviewedAt, plan, extra = {}) {
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
    reviewedAt,
    netReturnPct: Number.isFinite(grossReturnPct) ? grossReturnPct - modeledCostPct : null,
    ...extra
  };
}

function returnPct(entry, exitPrice, isShort) {
  if (!Number.isFinite(entry) || !Number.isFinite(exitPrice) || entry === 0) return null;
  const raw = exitPrice / entry - 1;
  return isShort ? -raw : raw;
}

function pendingReview(reason, reviewAfter = null, extra = {}) {
  return {
    status: "pending",
    reason,
    reviewAfter,
    ...extra
  };
}

function pendingPartialCandleReview(reviewAfter, entryEligibleAt, reason = "pending_partial_candle") {
  return {
    status: "pending",
    state: "ambiguous",
    reason,
    entryEligibleAt,
    reviewAfter,
    dataQuality: INCOMPLETE_INTRABAR_DATA,
    note: "This review cannot use full base-candle OHLC for a candle whose replay started after its open; lower-timeframe coverage is required."
  };
}

function outcomeForExit(exitReason) {
  if (exitReason === "stop_loss") return "止损";
  if (exitReason === "take_profit") return "止盈";
  return "时间退出";
}

function normalizeExitResolution(decision) {
  const resolution = String(decision.resolution || "").toLowerCase();
  if (decision.resolution === "take_profit_conservative") return "take_profit_conservative";
  if (decision.resolution === "gap_stop_worse_fill") return "gap_stop_worse_fill";
  if (resolution === "pessimistic_stop_first") return "pessimistic_stop_first";
  if (decision.exitReason === "take_profit") return "take_profit";
  if (decision.exitReason === "stop_loss") return "stop_loss";
  return "time_stop";
}

function toTimestamp(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value instanceof Date) return value.getTime();
  if (value == null || value === "") return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}
