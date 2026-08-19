import {
  applyEntryExecution,
  applyExitExecution,
  createExecutionModel,
  feePctForLeg
} from "./execution-model.js";
import { isTradeSpec } from "../trading/trade-spec.js";
import {
  prepareTradeSpecForExecution,
  roundExecutionPrice,
  validateExecutionQuantity
} from "../trading/exchange-filters.js";
import {
  BASE_BAR_REPLAY,
  INCOMPLETE_INTRABAR_DATA,
  boundedExitExcursion,
  candleExcursion,
  resolveIntrabarExit,
  resolveTimeStop
} from "../trading/replay-engine.js";

const HOUR_MS = 3600 * 1000;
export const NO_ENTRY = "NO_ENTRY";
export const MISSED_ENTRY = "MISSED_ENTRY";
export const MODELED_EXECUTION = "MODELED_EXECUTION";
export const BAR_BOUNDED_CONSERVATIVE = "BAR_BOUNDED_CONSERVATIVE";

export function validateEntryGeometry({ tradeSpec, entryFillPrice, entryTime = null }) {
  if (!isTradeSpec(tradeSpec) || !Number.isFinite(Number(entryFillPrice))) {
    return { valid: false, status: NO_ENTRY, reason: "invalid_trade_spec_or_entry_price" };
  }

  const normalizedEntryTime = Number(entryTime);
  const frozenMaxHoldingTime = Number(tradeSpec.maxHoldingTime);
  if (Number.isFinite(normalizedEntryTime)
    && Number.isFinite(frozenMaxHoldingTime)
    && normalizedEntryTime >= frozenMaxHoldingTime) {
    return { valid: false, status: MISSED_ENTRY, reason: "trade_spec_expired_before_entry" };
  }

  const entry = Number(entryFillPrice);
  const stopLoss = Number(tradeSpec.stopLoss);
  const takeProfit = Number(tradeSpec.takeProfit);
  const validGeometry = tradeSpec.side === "SHORT"
    ? takeProfit < entry && entry < stopLoss
    : stopLoss < entry && entry < takeProfit;
  if (!validGeometry) {
    return { valid: false, status: NO_ENTRY, reason: "entry_fill_outside_trade_spec_geometry" };
  }

  return { valid: true, status: "ENTRY", reason: null };
}

export function simulateTrade({
  tradeSpec,
  candles,
  entryIndex,
  strategyId = null,
  asset = null,
  executionModel = createExecutionModel(),
  lowerTimeframeCandles,
  lowerTimeframe = null,
  sentAt = null,
  exchangeFilters = null,
  requestedQty = null,
  orderType = "MARKET"
}) {
  if (!isTradeSpec(tradeSpec) || !Array.isArray(candles)) return null;

  const prepared = prepareTradeSpecForExecution(tradeSpec, exchangeFilters);
  if (!prepared.valid || !isTradeSpec(prepared.tradeSpec)) return null;
  const effectiveTradeSpec = prepared.tradeSpec;
  const entryCandle = candles[entryIndex];
  if (!entryCandle || !Number.isFinite(Number(entryCandle.open))) return null;

  const entryTime = Number(entryCandle.openTime);
  const entryEligibleAt = Number(effectiveTradeSpec.entryEligibleAt);
  if (!Number.isFinite(entryTime) || !Number.isFinite(entryEligibleAt) || entryTime < entryEligibleAt) return null;

  const rawEntryExecution = applyEntryExecution({
    marketPrice: Number(entryCandle.open),
    side: effectiveTradeSpec.side,
    executionModel
  });
  const entryFillPrice = roundExecutionPrice({
    price: rawEntryExecution.fillPrice,
    side: effectiveTradeSpec.side,
    role: "entry",
    exchangeFilters: prepared.filters
  });
  const entryExecution = {
    ...rawEntryExecution,
    rawFillPrice: rawEntryExecution.fillPrice,
    fillPrice: entryFillPrice
  };
  const entryValidation = validateEntryGeometry({
    tradeSpec: effectiveTradeSpec,
    entryFillPrice,
    entryTime
  });
  if (!entryValidation.valid) return null;

  let quantityValidation = null;
  if (requestedQty != null) {
    if (!prepared.filters) return null;
    quantityValidation = validateExecutionQuantity({
      quantity: requestedQty,
      price: entryFillPrice,
      exchangeFilters: prepared.filters,
      orderType
    });
    if (!quantityValidation.valid) return null;
  }

  const maxHoldingTime = resolveFrozenMaxHoldingTime(effectiveTradeSpec);
  let exit = null;
  let mfePct = 0;
  let maePct = 0;
  let intrabarQuality = BASE_BAR_REPLAY;
  let excursionQuality = BAR_BOUNDED_CONSERVATIVE;

  for (let index = entryIndex; index < candles.length; index++) {
    const candle = candles[index];
    const candleOpenTime = Number(candle?.openTime);
    const candleCloseTime = candleOpenTime + intervalMilliseconds(effectiveTradeSpec.interval);
    if (!Number.isFinite(candleOpenTime) || !Number.isFinite(candleCloseTime)) continue;

    const replayStart = Math.max(
      candleOpenTime,
      entryTime,
      Number.isFinite(Number(sentAt)) ? Number(sentAt) : candleOpenTime
    );
    const intrabarExit = resolveIntrabarExit({
      tradeSpec: effectiveTradeSpec,
      baseCandle: candle,
      lowerTimeframeCandles,
      lowerTimeframe,
      replayStart
    });
    intrabarQuality = preferReplayQuality(intrabarQuality, intrabarExit.dataQuality);
    if (intrabarExit.lowerTimeframeReplayed) excursionQuality = intrabarExit.dataQuality;

    if (intrabarExit.resolved) {
      const exitDecision = buildExitDecision({
        decision: intrabarExit,
        index,
        candle,
        tradeSpec: effectiveTradeSpec,
        side: effectiveTradeSpec.side,
        exchangeFilters: prepared.filters,
        entryFillPrice,
        executionModel,
        mfePct,
        maePct
      });
      mfePct = exitDecision.mfePct;
      maePct = exitDecision.maePct;
      exit = exitDecision.exit;
      if (exit) break;
    }

    const timeStop = resolveTimeStop({
      tradeSpec: effectiveTradeSpec,
      baseCandle: candle,
      lowerTimeframeCandles,
      lowerTimeframe,
      replayStart
    });
    if (timeStop.resolved && Number.isFinite(maxHoldingTime) && maxHoldingTime <= candleCloseTime) {
      intrabarQuality = preferReplayQuality(intrabarQuality, timeStop.dataQuality);
      if (timeStop.lowerTimeframeReplayed) excursionQuality = timeStop.dataQuality;
      const timeDecision = buildExitDecision({
        decision: timeStop,
        index,
        candle,
        tradeSpec: effectiveTradeSpec,
        side: effectiveTradeSpec.side,
        exchangeFilters: prepared.filters,
        entryFillPrice,
        executionModel,
        mfePct,
        maePct
      });
      mfePct = timeDecision.mfePct;
      maePct = timeDecision.maePct;
      exit = timeDecision.exit;
      if (exit) break;
    }
    if (!intrabarExit.resolved) {
      const noExitExcursion = replayExcursion({
        candle,
        decision: intrabarExit,
        entryFillPrice,
        side: effectiveTradeSpec.side
      });
      mfePct = Math.max(mfePct, noExitExcursion.mfePct);
      maePct = Math.min(maePct, noExitExcursion.maePct);
    }
  }

  if (!exit) {
    const lastIndex = candles.length - 1;
    const lastCandle = candles[lastIndex];
    if (!lastCandle || !Number.isFinite(Number(lastCandle.close))) return null;
    const lastCloseTime = Number(lastCandle.openTime) + intervalMilliseconds(effectiveTradeSpec.interval);
    const rawExitMarketPrice = Number(lastCandle.close);
    const exitMarketPrice = roundExecutionPrice({
      price: rawExitMarketPrice,
      side: effectiveTradeSpec.side,
      role: "end_of_data",
      exchangeFilters: prepared.filters
    });
    exit = {
      index: lastIndex,
      time: lastCloseTime,
      reason: "end_of_data",
      marketPrice: exitMarketPrice,
      rawMarketPrice: rawExitMarketPrice,
      execution: applyExitExecution({
        marketPrice: exitMarketPrice,
        side: effectiveTradeSpec.side,
        executionModel
      }),
      ambiguousIntrabar: false,
      exitResolution: "end_of_data",
      dataQuality: intrabarQuality,
      lowerTimeframeReplayed: false
    };
  }

  const quality = buildDataQuality({
    executionModel,
    intrabarQuality,
    exchangeFilters: prepared.filters
  });
  return buildTradeResult({
    tradeSpec: effectiveTradeSpec,
    rawTradeSpec: tradeSpec,
    strategyId,
    asset,
    entryCandle,
    entryTime,
    entryExecution,
    exit,
    entryIndex,
    mfePct,
    maePct,
    executionModel,
    quality,
    excursionQuality,
    rounding: prepared.rounding,
    quantityValidation
  });
}

function buildExitDecision({
  decision,
  index,
  candle,
  tradeSpec,
  side,
  exchangeFilters,
  entryFillPrice,
  executionModel,
  mfePct,
  maePct
}) {
  const exitReason = decision.exitReason;
  const role = exitReason === "take_profit"
    ? "take_profit"
    : exitReason === "stop_loss"
      ? "stop_loss"
      : "exit";
  const marketPrice = roundExecutionPrice({
    price: decision.exitMarketPrice,
    side,
    role,
    exchangeFilters
  });
  const execution = applyExitExecution({
    marketPrice,
    side,
    executionModel
  });
  const excursion = excursionThroughExit({
    decision,
    candle,
    interval: tradeSpec.interval,
    entryFillPrice,
    side
  });
  const exit = {
    index,
    time: Number(decision.exitTime),
    reason: exitReason,
    marketPrice,
    rawMarketPrice: Number(decision.exitMarketPrice),
    execution,
    ambiguousIntrabar: Boolean(decision.ambiguousIntrabar),
    exitResolution: normalizeExitResolution(decision),
    dataQuality: decision.dataQuality,
    lowerTimeframeReplayed: Boolean(decision.lowerTimeframeReplayed),
    coverage: decision.coverage || null
  };
  return {
    exit,
    mfePct: Math.max(mfePct, excursion.mfePct),
    maePct: Math.min(maePct, excursion.maePct)
  };
}

function buildDataQuality({ executionModel, intrabarQuality, exchangeFilters }) {
  const funding = executionModel.marketType === "futures"
    ? executionModel.fundingDataComplete
      ? executionModel.fundingStatus || "COMPLETE"
      : "INCOMPLETE_FUNDING"
    : "NOT_APPLICABLE";
  const components = Object.freeze({
    funding,
    intrabar: intrabarQuality || INCOMPLETE_INTRABAR_DATA,
    exchangeFilters: exchangeFilters ? "COMPLETE" : "NOT_PROVIDED",
    execution: MODELED_EXECUTION
  });
  const dataQuality = funding === "INCOMPLETE_FUNDING"
    ? "INCOMPLETE_FUNDING"
    : intrabarQuality === INCOMPLETE_INTRABAR_DATA
      ? INCOMPLETE_INTRABAR_DATA
      : "COMPLETE";
  return { dataQuality, components };
}

function buildTradeResult({
  tradeSpec,
  rawTradeSpec,
  strategyId,
  asset,
  entryCandle,
  entryTime,
  entryExecution,
  exit,
  entryIndex,
  mfePct,
  maePct,
  executionModel,
  quality,
  excursionQuality,
  rounding,
  quantityValidation
}) {
  const exitMarketPrice = exit.marketPrice;
  const exitFillPrice = exit.execution?.fillPrice;
  const spreadOnlyModel = {
    ...executionModel,
    entrySlippagePct: 0,
    exitSlippagePct: 0
  };
  const spreadOnlyEntry = applyEntryExecution({
    marketPrice: entryExecution.marketPrice,
    side: tradeSpec.side,
    executionModel: spreadOnlyModel
  });
  const spreadOnlyExit = applyExitExecution({
    marketPrice: exitMarketPrice,
    side: tradeSpec.side,
    executionModel: spreadOnlyModel
  });
  const grossReturnPct = directionalReturn(
    entryExecution.marketPrice,
    exitMarketPrice,
    tradeSpec.side
  );
  const spreadAdjustedReturnPct = directionalReturn(
    spreadOnlyEntry.fillPrice,
    spreadOnlyExit.fillPrice,
    tradeSpec.side
  );
  const fillReturnPct = directionalReturn(
    entryExecution.fillPrice,
    exitFillPrice,
    tradeSpec.side
  );
  const spreadCostPct = finiteDifference(grossReturnPct, spreadAdjustedReturnPct);
  const slippageCostPct = finiteDifference(spreadAdjustedReturnPct, fillReturnPct);
  const entryFeeRate = feePctForLeg(executionModel, "entry");
  const exitFeeRate = feePctForLeg(executionModel, "exit");
  const entryFeePct = entryFeeRate;
  const exitFeePct = Number.isFinite(entryExecution.fillPrice) && entryExecution.fillPrice !== 0
    ? exitFeeRate * exitFillPrice / entryExecution.fillPrice
    : null;
  const totalFeePct = Number.isFinite(entryFeePct) && Number.isFinite(exitFeePct)
    ? entryFeePct + exitFeePct
    : null;
  const fundingPct = fundingReturn({
    side: tradeSpec.side,
    entryTime,
    exitTime: exit.time,
    executionModel
  });
  const netReturnPct = Number.isFinite(fillReturnPct) && Number.isFinite(totalFeePct)
    ? fillReturnPct - totalFeePct + fundingPct
    : null;
  const initialRiskPct = initialRisk(tradeSpec.side, entryExecution.fillPrice, tradeSpec.stopLoss);
  const holdingHours = Math.max(0, (exit.time - entryTime) / HOUR_MS);

  return {
    strategyId,
    asset,
    side: tradeSpec.side,
    signalCandleOpenTime: tradeSpec.signalCandleOpenTime,
    signalCandleCloseTime: tradeSpec.signalCandleCloseTime,
    signalAvailableAt: tradeSpec.signalAvailableAt,
    entryEligibleAt: tradeSpec.entryEligibleAt,
    entryTime,
    referencePrice: tradeSpec.referencePrice,
    entryMarketPrice: entryExecution.marketPrice,
    entryRawFillPrice: entryExecution.rawFillPrice,
    entryFillPrice: entryExecution.fillPrice,
    stopLoss: tradeSpec.stopLoss,
    takeProfit: tradeSpec.takeProfit,
    rawStopLoss: rawTradeSpec?.stopLoss ?? tradeSpec.stopLoss,
    rawTakeProfit: rawTradeSpec?.takeProfit ?? tradeSpec.takeProfit,
    roundedStopLoss: tradeSpec.stopLoss,
    roundedTakeProfit: tradeSpec.takeProfit,
    levelRounding: rounding,
    quantity: quantityValidation?.roundedQty ?? null,
    quantityValidation,
    maxHoldingTime: resolveFrozenMaxHoldingTime(tradeSpec),
    exitTime: exit.time,
    exitMarketPrice,
    rawExitMarketPrice: exit.rawMarketPrice ?? exitMarketPrice,
    exitFillPrice,
    exitReason: exit.reason,
    grossReturnPct,
    entryFeePct,
    exitFeePct,
    entryFeeRate,
    exitFeeRate,
    totalFeePct,
    spreadCostPct,
    slippageCostPct,
    fundingPct,
    netReturnPct,
    initialRiskPct,
    realizedR: Number.isFinite(initialRiskPct) && initialRiskPct > 0 && Number.isFinite(netReturnPct)
      ? netReturnPct / initialRiskPct
      : null,
    mfePct,
    maePct,
    mfeR: Number.isFinite(initialRiskPct) && initialRiskPct > 0 ? mfePct / initialRiskPct : null,
    maeR: Number.isFinite(initialRiskPct) && initialRiskPct > 0 ? maePct / initialRiskPct : null,
    holdingHours,
    ambiguousIntrabar: Boolean(exit.ambiguousIntrabar),
    executionQuality: MODELED_EXECUTION,
    exitResolution: exit.exitResolution,
    excursionQuality: excursionQuality || (exit.lowerTimeframeReplayed
      ? exit.dataQuality
      : BAR_BOUNDED_CONSERVATIVE),
    dataQuality: quality.dataQuality,
    dataQualityComponents: quality.components,
    dataQualityDetail: quality.components,
    fundingCoverage: executionModel.fundingCoverage || null,
    fundingStatus: executionModel.fundingStatus || null,
    entryIndex,
    exitIndex: exit.index,
    entryCandleOpenTime: Number(entryCandle.openTime)
  };
}

function excursionThroughExit({ decision, candle, interval, entryFillPrice, side }) {
  const replayCandles = Array.isArray(decision.replayCandles) && decision.replayCandles.length
    ? decision.replayCandles
    : [candle];
  const exitIndex = Number.isFinite(Number(decision.replayCandleIndex))
    ? Number(decision.replayCandleIndex)
    : replayCandles.length - 1;
  let mfePct = 0;
  let maePct = 0;
  for (let index = 0; index < Math.max(0, exitIndex); index++) {
    const excursion = candleExcursion(replayCandles[index], entryFillPrice, side);
    mfePct = Math.max(mfePct, excursion.mfePct);
    maePct = Math.min(maePct, excursion.maePct);
  }
  const exitCandle = replayCandles[Math.min(exitIndex, replayCandles.length - 1)] || candle;
  const exitCloseTime = Number(exitCandle?.openTime) + intervalMilliseconds(interval);
  const shouldUseFullTimeStopCandle = decision.exitReason === "time_stop"
    && Number(decision.exitTime) >= exitCloseTime;
  const exitExcursion = shouldUseFullTimeStopCandle
    ? candleExcursion(exitCandle, entryFillPrice, side)
    : boundedExitExcursion(
      exitCandle,
      entryFillPrice,
      side,
      Number(decision.exitMarketPrice),
      decision.exitReason,
      decision.ambiguousIntrabar
    );
  return {
    mfePct: Math.max(mfePct, exitExcursion.mfePct),
    maePct: Math.min(maePct, exitExcursion.maePct)
  };
}

function replayExcursion({ candle, decision, entryFillPrice, side }) {
  if (decision.lowerTimeframeReplayed && Array.isArray(decision.replayCandles)) {
    return decision.replayCandles.reduce((total, replayCandle) => {
      const excursion = candleExcursion(replayCandle, entryFillPrice, side);
      return {
        mfePct: Math.max(total.mfePct, excursion.mfePct),
        maePct: Math.min(total.maePct, excursion.maePct)
      };
    }, { mfePct: 0, maePct: 0 });
  }
  if (decision.dataQuality === BASE_BAR_REPLAY) {
    return candleExcursion(candle, entryFillPrice, side);
  }
  return { mfePct: 0, maePct: 0 };
}

function normalizeExitResolution(decision) {
  const resolution = String(decision.resolution || "").toLowerCase();
  if (decision.resolution === "take_profit_conservative") return "take_profit_conservative";
  if (decision.resolution === "gap_stop_worse_fill") return "gap_stop_worse_fill";
  if (resolution === "pessimistic_stop_first") return "pessimistic_stop_first";
  if (decision.exitReason === "time_stop") return "time_stop";
  if (decision.exitReason === "take_profit") return "take_profit";
  if (decision.exitReason === "stop_loss") return "stop_loss";
  return decision.resolution || "end_of_data";
}

function preferReplayQuality(current, next) {
  if (next === INCOMPLETE_INTRABAR_DATA) return next;
  if (current === INCOMPLETE_INTRABAR_DATA) return current;
  if (next && next !== BASE_BAR_REPLAY) return next;
  return current || BASE_BAR_REPLAY;
}

function fundingReturn({ side, entryTime, exitTime, executionModel }) {
  return executionModel.fundingEvents
    .filter((event) => event.time > entryTime && event.time <= exitTime)
    .reduce((total, event) => total + (side === "LONG" ? -event.rate : event.rate), 0);
}

function directionalReturn(entryPrice, exitPrice, side) {
  if (!Number.isFinite(entryPrice) || !Number.isFinite(exitPrice) || entryPrice === 0) return null;
  const raw = exitPrice / entryPrice - 1;
  return side === "SHORT" ? -raw : raw;
}

function initialRisk(side, entryPrice, stopLoss) {
  if (!Number.isFinite(entryPrice) || !Number.isFinite(stopLoss) || entryPrice === 0) return null;
  return Math.abs(entryPrice - stopLoss) / entryPrice;
}

function finiteDifference(first, second) {
  return Number.isFinite(first) && Number.isFinite(second) ? first - second : null;
}

function resolveFrozenMaxHoldingTime(tradeSpec) {
  const maxHoldingTime = Number(tradeSpec?.maxHoldingTime);
  return Number.isFinite(maxHoldingTime) ? maxHoldingTime : null;
}

function intervalMilliseconds(interval) {
  const map = {
    "1m": 60 * 1000,
    "3m": 3 * 60 * 1000,
    "5m": 5 * 60 * 1000,
    "15m": 15 * 60 * 1000,
    "30m": 30 * 60 * 1000,
    "1h": HOUR_MS,
    "2h": 2 * HOUR_MS,
    "4h": 4 * HOUR_MS,
    "1d": 24 * HOUR_MS
  };
  return map[interval] || 24 * HOUR_MS;
}
