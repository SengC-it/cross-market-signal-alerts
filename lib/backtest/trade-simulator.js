import {
  applyEntryExecution,
  applyExitExecution,
  createExecutionModel,
  feePctForLeg
} from "./execution-model.js";
import { isTradeSpec } from "../trading/trade-spec.js";

const HOUR_MS = 3600 * 1000;

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
  const maxHoldingTime = resolveMaxHoldingTime(tradeSpec, entryTime);
  let exit = null;
  let mfePct = 0;
  let maePct = 0;

  for (let index = entryIndex; index < candles.length; index++) {
    const candle = candles[index];
    const candleOpenTime = Number(candle.openTime);
    const candleCloseTime = candleOpenTime + intervalMilliseconds(tradeSpec.interval);
    if (!Number.isFinite(candleOpenTime) || !Number.isFinite(candleCloseTime)) continue;

    const excursion = candleExcursion(candle, entryExecution.fillPrice, side);
    mfePct = Math.max(mfePct, excursion.mfePct);
    maePct = Math.min(maePct, excursion.maePct);

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
      exit = {
        index,
        time: candleOpenTime,
        reason: exitReason,
        marketPrice: exitMarketPrice,
        execution: exitExecution,
        ambiguousIntrabar,
        executionQuality: ambiguousIntrabar
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
        executionQuality: "time_stop"
      };
      break;
    }
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
      executionQuality: "end_of_data"
    };
  }

  return buildTradeResult({
    tradeSpec,
    strategyId,
    asset,
    entryCandle,
    entryTime,
    entryExecution,
    exit,
    candles,
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
  candles,
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
  const entryFeePct = feePctForLeg(executionModel, "entry");
  const exitFeePct = feePctForLeg(executionModel, "exit");
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
    maxHoldingTime: resolveMaxHoldingTime(tradeSpec, entryTime),
    exitTime: exit.time,
    exitMarketPrice,
    exitFillPrice,
    exitReason: exit.reason,
    grossReturnPct,
    entryFeePct,
    exitFeePct,
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
    executionQuality: exit.executionQuality,
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
      mfePct: entryPrice / low - 1,
      maePct: entryPrice / high - 1
    };
  }
  return {
    mfePct: high / entryPrice - 1,
    maePct: low / entryPrice - 1
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

function resolveMaxHoldingTime(tradeSpec, entryTime) {
  if (Number.isFinite(Number(tradeSpec.maxHoldingTime)) && Number(tradeSpec.maxHoldingTime) > entryTime) {
    return Number(tradeSpec.maxHoldingTime);
  }
  const hours = Number(tradeSpec.maxHoldingHours);
  return Number.isFinite(hours) && hours > 0 ? entryTime + hours * HOUR_MS : null;
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
