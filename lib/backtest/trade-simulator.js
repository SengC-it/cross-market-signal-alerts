import {
  applyEntryExecution,
  applyExitExecution,
  createExecutionModel,
  feePctForLeg
} from "./execution-model.js";
import { isTradeSpec } from "../trading/trade-spec.js";

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
  executionModel = createExecutionModel()
}) {
  if (!isTradeSpec(tradeSpec) || !Array.isArray(candles)) return null;
  const entryCandle = candles[entryIndex];
  if (!entryCandle || !Number.isFinite(Number(entryCandle.open))) return null;

  const entryTime = Number(entryCandle.openTime);
  const entryEligibleAt = Number(tradeSpec.entryEligibleAt);
  if (!Number.isFinite(entryTime) || entryTime < entryEligibleAt) return null;

  const side = tradeSpec.side;
  const entryExecution = applyEntryExecution({
    marketPrice: Number(entryCandle.open),
    side,
    executionModel
  });
  const entryValidation = validateEntryGeometry({
    tradeSpec,
    entryFillPrice: entryExecution.fillPrice,
    entryTime
  });
  if (!entryValidation.valid) return null;

  const maxHoldingTime = resolveMaxHoldingTime(tradeSpec);
  let exit = null;
  let mfePct = 0;
  let maePct = 0;

  for (let index = entryIndex; index < candles.length; index++) {
    const candle = candles[index];
    const candleOpenTime = Number(candle.openTime);
    const candleCloseTime = candleOpenTime + intervalMilliseconds(tradeSpec.interval);
    if (!Number.isFinite(candleOpenTime) || !Number.isFinite(candleCloseTime)) continue;

    const hitStop = side === "SHORT"
      ? Number(candle.high) >= Number(tradeSpec.stopLoss)
      : Number(candle.low) <= Number(tradeSpec.stopLoss);
    const hitTarget = side === "SHORT"
      ? Number(candle.low) <= Number(tradeSpec.takeProfit)
      : Number(candle.high) >= Number(tradeSpec.takeProfit);

    if (hitStop || hitTarget) {
      const ambiguousIntrabar = hitStop && hitTarget;
      const exitReason = hitStop ? "stop_loss" : "take_profit";
      const exitMarketPrice = hitStop
        ? gapAdjustedStopPrice(candle, side, Number(tradeSpec.stopLoss))
        : Number(tradeSpec.takeProfit);
      const exitExecution = applyExitExecution({
        marketPrice: exitMarketPrice,
        side,
        executionModel
      });
      const excursion = boundedExitExcursion(
        candle,
        entryExecution.fillPrice,
        side,
        exitMarketPrice,
        exitReason,
        ambiguousIntrabar
      );
      mfePct = Math.max(mfePct, excursion.mfePct);
      maePct = Math.min(maePct, excursion.maePct);
      exit = {
        index,
        time: candleOpenTime,
        reason: exitReason,
        marketPrice: exitMarketPrice,
        execution: exitExecution,
        ambiguousIntrabar,
        exitResolution: ambiguousIntrabar
          ? "pessimistic_stop_first"
          : hitStop
            ? isGapThroughStop(candle, side, Number(tradeSpec.stopLoss))
              ? "gap_stop_worse_fill"
              : "stop_loss"
            : isGapThroughTarget(candle, side, Number(tradeSpec.takeProfit))
              ? "take_profit_conservative"
              : "take_profit"
      };
      break;
    }

    if (Number.isFinite(maxHoldingTime) && candleCloseTime >= maxHoldingTime) {
      const exitMarketPrice = Number(candle.close);
      const excursion = candleCloseTime <= maxHoldingTime
        ? candleExcursion(candle, entryExecution.fillPrice, side)
        : boundedExitExcursion(candle, entryExecution.fillPrice, side, exitMarketPrice, "time_stop");
      mfePct = Math.max(mfePct, excursion.mfePct);
      maePct = Math.min(maePct, excursion.maePct);
      exit = {
        index,
        time: Math.min(maxHoldingTime, candleCloseTime),
        reason: "time_stop",
        marketPrice: exitMarketPrice,
        execution: applyExitExecution({
          marketPrice: exitMarketPrice,
          side,
          executionModel
        }),
        ambiguousIntrabar: false,
        exitResolution: "time_stop"
      };
      break;
    }

    const excursion = candleExcursion(candle, entryExecution.fillPrice, side);
    mfePct = Math.max(mfePct, excursion.mfePct);
    maePct = Math.min(maePct, excursion.maePct);
  }

  if (!exit) {
    const lastIndex = candles.length - 1;
    const lastCandle = candles[lastIndex];
    if (!lastCandle || !Number.isFinite(Number(lastCandle.close))) return null;
    const lastCloseTime = Number(lastCandle.openTime) + intervalMilliseconds(tradeSpec.interval);
    exit = {
      index: lastIndex,
      time: lastCloseTime,
      reason: "end_of_data",
      marketPrice: Number(lastCandle.close),
      execution: applyExitExecution({
        marketPrice: Number(lastCandle.close),
        side,
        executionModel
      }),
      ambiguousIntrabar: false,
      exitResolution: "end_of_data"
    };
    const excursion = candleExcursion(lastCandle, entryExecution.fillPrice, side);
    mfePct = Math.max(mfePct, excursion.mfePct);
    maePct = Math.min(maePct, excursion.maePct);
  }

  return buildTradeResult({
    tradeSpec,
    strategyId,
    asset,
    entryCandle,
    entryTime,
    entryExecution,
    exit,
    entryIndex,
    mfePct,
    maePct,
    executionModel
  });
}

function buildTradeResult({
  tradeSpec,
  strategyId,
  asset,
  entryCandle,
  entryTime,
  entryExecution,
  exit,
  entryIndex,
  mfePct,
  maePct,
  executionModel
}) {
  const exitMarketPrice = exit.marketPrice;
  const exitFillPrice = exit.execution.fillPrice;
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
  const spreadCostPct = grossReturnPct - spreadAdjustedReturnPct;
  const slippageCostPct = spreadAdjustedReturnPct - fillReturnPct;
  const entryFeeRate = feePctForLeg(executionModel, "entry");
  const exitFeeRate = feePctForLeg(executionModel, "exit");
  const entryFeePct = entryFeeRate;
  const exitFeePct = Number.isFinite(entryExecution.fillPrice) && entryExecution.fillPrice !== 0
    ? exitFeeRate * exitFillPrice / entryExecution.fillPrice
    : null;
  const totalFeePct = entryFeePct + exitFeePct;
  const fundingPct = fundingReturn({
    side: tradeSpec.side,
    entryTime,
    exitTime: exit.time,
    executionModel
  });
  const netReturnPct = fillReturnPct - totalFeePct + fundingPct;
  const initialRiskPct = initialRisk(tradeSpec.side, entryExecution.fillPrice, tradeSpec.stopLoss);
  const holdingHours = Math.max(0, (exit.time - entryTime) / HOUR_MS);

  return {
    strategyId,
    asset,
    side: tradeSpec.side,
    signalCandleOpenTime: tradeSpec.signalCandleOpenTime,
    signalAvailableAt: tradeSpec.signalAvailableAt,
    entryEligibleAt: tradeSpec.entryEligibleAt,
    entryTime,
    referencePrice: tradeSpec.referencePrice,
    entryMarketPrice: entryExecution.marketPrice,
    entryFillPrice: entryExecution.fillPrice,
    stopLoss: tradeSpec.stopLoss,
    takeProfit: tradeSpec.takeProfit,
    maxHoldingTime: resolveMaxHoldingTime(tradeSpec),
    exitTime: exit.time,
    exitMarketPrice,
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
    realizedR: Number.isFinite(initialRiskPct) && initialRiskPct > 0
      ? netReturnPct / initialRiskPct
      : null,
    mfePct,
    maePct,
    mfeR: Number.isFinite(initialRiskPct) && initialRiskPct > 0 ? mfePct / initialRiskPct : null,
    maeR: Number.isFinite(initialRiskPct) && initialRiskPct > 0 ? maePct / initialRiskPct : null,
    holdingHours,
    ambiguousIntrabar: exit.ambiguousIntrabar,
    executionQuality: MODELED_EXECUTION,
    exitResolution: exit.exitResolution,
    excursionQuality: BAR_BOUNDED_CONSERVATIVE,
    dataQuality: executionModel.dataQuality,
    entryIndex,
    exitIndex: exit.index,
    entryCandleOpenTime: Number(entryCandle.openTime)
  };
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

function candleExcursion(candle, entryPrice, side) {
  const high = Number(candle.high);
  const low = Number(candle.low);
  if (!Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(entryPrice) || entryPrice === 0) {
    return { mfePct: 0, maePct: 0 };
  }
  if (side === "SHORT") {
    return {
      mfePct: 1 - low / entryPrice,
      maePct: 1 - high / entryPrice
    };
  }
  return {
    mfePct: high / entryPrice - 1,
    maePct: low / entryPrice - 1
  };
}

function boundedExitExcursion(candle, entryPrice, side, exitPrice, exitReason, ambiguousIntrabar = false) {
  const open = Number(candle.open);
  if (!Number.isFinite(open) || !Number.isFinite(exitPrice) || !Number.isFinite(entryPrice) || entryPrice === 0) {
    return { mfePct: 0, maePct: 0 };
  }
  if (ambiguousIntrabar) {
    return side === "SHORT"
      ? {
        mfePct: 0,
        maePct: Math.min(0, 1 - exitPrice / entryPrice)
      }
      : {
        mfePct: 0,
        maePct: Math.min(0, exitPrice / entryPrice - 1)
      };
  }
  const isTakeProfit = exitReason === "take_profit";
  if (side === "SHORT") {
    const favorableBoundary = isTakeProfit ? exitPrice : Math.min(open, exitPrice);
    const adverseBoundary = isTakeProfit ? Math.max(open, exitPrice) : exitPrice;
    return {
      mfePct: Math.max(0, 1 - favorableBoundary / entryPrice),
      maePct: Math.min(0, 1 - adverseBoundary / entryPrice)
    };
  }
  const favorableBoundary = isTakeProfit ? exitPrice : Math.max(open, exitPrice);
  const adverseBoundary = isTakeProfit ? Math.min(open, exitPrice) : exitPrice;
  return {
    mfePct: Math.max(0, favorableBoundary / entryPrice - 1),
    maePct: Math.min(0, adverseBoundary / entryPrice - 1)
  };
}

function gapAdjustedStopPrice(candle, side, stopLoss) {
  const open = Number(candle.open);
  if (!Number.isFinite(open)) return stopLoss;
  if (side === "SHORT") return open >= stopLoss ? open : stopLoss;
  return open <= stopLoss ? open : stopLoss;
}

function isGapThroughStop(candle, side, stopLoss) {
  const open = Number(candle.open);
  if (!Number.isFinite(open)) return false;
  return side === "SHORT" ? open >= stopLoss : open <= stopLoss;
}

function isGapThroughTarget(candle, side, takeProfit) {
  const open = Number(candle.open);
  if (!Number.isFinite(open)) return false;
  return side === "SHORT" ? open <= takeProfit : open >= takeProfit;
}

function resolveMaxHoldingTime(tradeSpec) {
  const maxHoldingTime = Number(tradeSpec.maxHoldingTime);
  return Number.isFinite(maxHoldingTime) ? maxHoldingTime : null;
}

function intervalMilliseconds(interval) {
  const map = {
    "15m": 15 * 60 * 1000,
    "30m": 30 * 60 * 1000,
    "1h": HOUR_MS,
    "2h": 2 * HOUR_MS,
    "4h": 4 * HOUR_MS,
    "1d": 24 * HOUR_MS
  };
  return map[interval] || 24 * HOUR_MS;
}
