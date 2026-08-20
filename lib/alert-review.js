import { getTradeSpecForAlert, intervalMilliseconds } from "./trading/trade-spec.js";
import { applyExitExecution, createExecutionModel, resolveEntryExecution } from "./backtest/execution-model.js";
import { prepareTradeSpecForExecution, roundExecutionPrice } from "./trading/exchange-filters.js";
import {
  INCOMPLETE_INTRABAR_DATA,
  resolveIntrabarExit,
  resolveTimeStop
} from "./trading/replay-engine.js";
import { calculateTradeEconomics, MODELED_EXECUTION } from "./trading/trade-economics.js";

export function reviewAlertWithCandles(alert, candles, now = Date.now(), options = {}) {
  const tradeSpec = getTradeSpecForAlert(alert);
  if (!tradeSpec) {
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
  const lowerTimeframeCandles = options.lowerTimeframeCandles || options.lowerCandles;
  const lowerTimeframe = options.lowerTimeframe || null;
  const entryObservation = resolveReviewEntryObservation({
    candles,
    entryEligibleAt: firstEligibleOpenTime,
    sentAt,
    now,
    intervalMs,
    lowerTimeframeCandles
  });
  if (entryObservation.pending) {
    return pendingPartialCandleReview(
      entryObservation.reviewAfter,
      firstEligibleOpenTime,
      entryObservation.reason
    );
  }
  const executionModel = buildReviewExecutionModel(alert, effectiveTradeSpec, options);
  const entryResolution = resolveEntryExecution({
    tradeSpec: effectiveTradeSpec,
    entryCandle: entryObservation.candle,
    entryTime: entryObservation.entryTime,
    marketPrice: entryObservation.marketPrice,
    executionModel,
    exchangeFilters: prepared.filters
  });
  if (!entryResolution.valid) {
    return noEntryReview({
      entryResolution,
      tradeSpec: effectiveTradeSpec,
      reviewedAt: now
    });
  }
  const entryExecution = {
    ...entryResolution.execution,
    entryTime: entryResolution.entryTime
  };
  const entryTime = entryResolution.entryTime;
  const windowCandles = candles
    .filter((candle) => {
      const openTime = Number(candle.openTime);
      const closeTime = openTime + intervalMs;
      return Number.isFinite(openTime)
        && closeTime > entryTime
        && closeTime <= now;
    })
    .sort((a, b) => a.openTime - b.openTime);
  if (!windowCandles.length) return pendingReview("等待止盈止损K线", firstEligibleOpenTime + intervalMs);

  for (const candle of windowCandles) {
    const replayStart = Math.max(entryTime, Number(candle.openTime));
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
        intrabarExit,
        entryExecution,
        now,
        effectiveTradeSpec,
        executionModel,
        prepared.filters
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
        timeStop,
        entryExecution,
        now,
        effectiveTradeSpec,
        executionModel,
        prepared.filters
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

function resolveReviewEntryObservation({
  candles,
  entryEligibleAt,
  sentAt,
  now,
  intervalMs,
  lowerTimeframeCandles
}) {
  const sorted = (Array.isArray(candles) ? candles : [])
    .filter((candle) => Number.isFinite(Number(candle?.openTime)))
    .sort((a, b) => Number(a.openTime) - Number(b.openTime));
  const firstEligible = sorted.find((candle) => Number(candle.openTime) >= entryEligibleAt);
  if (!firstEligible) {
    return { pending: true, reason: "等待下一根可执行K线", reviewAfter: entryEligibleAt };
  }
  if (!Number.isFinite(sentAt) || sentAt <= entryEligibleAt) {
    return Number(firstEligible.openTime) <= now
      ? {
        candle: firstEligible,
        entryTime: Number(firstEligible.openTime),
        marketPrice: Number(firstEligible.open ?? firstEligible.close)
      }
      : { pending: true, reason: "等待下一根可执行K线", reviewAfter: Number(firstEligible.openTime) };
  }

  const partialCandle = sorted.find((candle) => {
    const openTime = Number(candle.openTime);
    return openTime < sentAt && sentAt < openTime + intervalMs;
  });
  if (partialCandle) {
    const partialClose = Number(partialCandle.openTime) + intervalMs;
    const postSentLower = (Array.isArray(lowerTimeframeCandles) ? lowerTimeframeCandles : [])
      .filter((candle) => Number(candle?.openTime) >= sentAt
        && Number(candle.openTime) < partialClose
        && Number(candle.openTime) <= now)
      .sort((a, b) => Number(a.openTime) - Number(b.openTime));
    const firstLower = postSentLower[0];
    if (!firstLower) {
      return { pending: true, reason: "pending_partial_candle", reviewAfter: partialClose };
    }
    return {
      candle: firstLower,
      baseCandle: partialCandle,
      entryTime: Number(firstLower.openTime),
      marketPrice: Number(firstLower.open ?? firstLower.close)
    };
  }

  const firstPostSent = sorted.find((candle) => Number(candle.openTime) >= Math.max(entryEligibleAt, sentAt));
  if (!firstPostSent || Number(firstPostSent.openTime) > now) {
    return {
      pending: true,
      reason: "等待发信后的第一根可执行K线",
      reviewAfter: Number(firstPostSent?.openTime || sentAt)
    };
  }
  return {
    candle: firstPostSent,
    entryTime: Number(firstPostSent.openTime),
    marketPrice: Number(firstPostSent.open ?? firstPostSent.close)
  };
}

function buildReviewExecutionModel(alert, tradeSpec, options) {
  const payload = alert?.payload || {};
  const marketText = `${alert?.market || ""} ${payload.market || ""}`;
  const inferredMarketType = /USDT|合约|futures|perpetual/i.test(marketText) ? "futures" : "spot";
  const modelOptions = {
    marketType: options.marketType || inferredMarketType,
    ...(options.executionModel || {})
  };
  if (options.fundingEvents !== undefined) modelOptions.fundingEvents = options.fundingEvents;
  if (options.fundingCoverage !== undefined) modelOptions.fundingCoverage = options.fundingCoverage;
  if (options.exchangeRulesRequired !== undefined) modelOptions.exchangeRulesRequired = options.exchangeRulesRequired;
  if (tradeSpec.source === "legacy_adapter"
    && modelOptions.legacyRoundTripCostPct == null
    && Number.isFinite(Number(tradeSpec.modeledRoundTripCostPct))) {
    modelOptions.legacyRoundTripCostPct = Number(tradeSpec.modeledRoundTripCostPct);
  }
  return createExecutionModel(modelOptions);
}

function noEntryReview({ entryResolution, tradeSpec, reviewedAt }) {
  return {
    status: entryResolution.status || "NO_ENTRY",
    state: "missed_entry",
    reason: entryResolution.reason,
    reviewedAt,
    referencePrice: tradeSpec.referencePrice,
    entryEligibleAt: tradeSpec.entryEligibleAt,
    entryTime: entryResolution.entryTime ?? null,
    entryMarketPrice: entryResolution.marketPrice ?? null,
    entryFillPrice: entryResolution.fillPrice ?? entryResolution.execution?.fillPrice ?? null,
    tradeSpecVersion: tradeSpec.version,
    method: tradeSpec.modelVersion || tradeSpec.version
  };
}

function finishedReview(outcome, decision, entryExecution, reviewedAt, plan, executionModel, exchangeFilters) {
  const role = decision.exitReason === "take_profit"
    ? "take_profit"
    : decision.exitReason === "stop_loss"
      ? "stop_loss"
      : "exit";
  const rawExitExecution = applyExitExecution({
    marketPrice: Number(decision.exitMarketPrice),
    side: plan.side,
    executionModel
  });
  const exitFillPrice = roundExecutionPrice({
    price: rawExitExecution.fillPrice,
    side: plan.side,
    role,
    exchangeFilters
  });
  const exitExecution = {
    ...rawExitExecution,
    rawFillPrice: rawExitExecution.fillPrice,
    fillPrice: exitFillPrice
  };
  const economics = calculateTradeEconomics({
    tradeSpec: plan,
    entryExecution,
    exitExecution,
    exitTime: decision.exitTime,
    executionModel,
    intrabarQuality: decision.dataQuality,
    exchangeFilters,
    exchangeRulesRequired: executionModel.exchangeRulesRequired
  });
  return {
    status: "reviewed",
    outcome,
    exitPrice: Number(decision.exitMarketPrice),
    exitTime: Number(decision.exitTime),
    referencePrice: plan.referencePrice,
    entryEligibleAt: plan?.entryEligibleAt ?? null,
    entryTime: entryExecution.entryTime,
    entryMarketPrice: entryExecution.marketPrice,
    entryFillPrice: entryExecution.fillPrice,
    exitMarketPrice: Number(decision.exitMarketPrice),
    exitFillPrice,
    exitReason: decision.exitReason,
    tradeSpecVersion: plan?.version || null,
    ...economics,
    returnPct: economics.netReturnPct,
    netOfCosts: Number(economics.totalFeePct) > 0
      || Number(economics.spreadCostPct) > 0
      || Number(economics.slippageCostPct) > 0,
    method: plan?.modelVersion || plan?.version || "legacy",
    reviewedAt,
    executionQuality: MODELED_EXECUTION,
    exitResolution: normalizeExitResolution(decision),
    ambiguousIntrabar: Boolean(decision.ambiguousIntrabar),
    lowerTimeframeReplayed: Boolean(decision.lowerTimeframeReplayed)
  };
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
