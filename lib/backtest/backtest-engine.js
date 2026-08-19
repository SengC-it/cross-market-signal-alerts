import { applyEntryExecution, createExecutionModel } from "./execution-model.js";
import { aggregateMetrics } from "./metrics.js";
import { MISSED_ENTRY, NO_ENTRY, simulateTrade, validateEntryGeometry } from "./trade-simulator.js";
import { buildTradePlan } from "../trading/trade-plan.js";

export function runBacktest({
  candles,
  strategy,
  interval,
  marketType = "futures",
  tradePlanType = marketType,
  asset = null,
  startIndex = 220,
  executionModel = {},
  fundingEvents,
  fundingDataComplete,
  maxTrades = Infinity
}) {
  const model = createExecutionModel({
    marketType,
    ...executionModel,
    ...(fundingEvents !== undefined ? { fundingEvents } : {}),
    ...(fundingDataComplete !== undefined ? { fundingDataComplete } : {})
  });
  const tradeResults = [];
  const missedEntries = [];
  const entryStats = {
    signals: 0,
    planned: 0,
    entries: 0,
    noEntry: 0,
    missedEntry: 0
  };
  if (!Array.isArray(candles) || !strategy || candles.length < 2) {
    return buildBacktestResult({ strategy, interval, marketType, tradePlanType, asset, tradeResults, model, missedEntries, entryStats });
  }

  for (let index = Math.max(1, Number(startIndex) || 0); index < candles.length - 1 && tradeResults.length < maxTrades;) {
    const context = { interval };
    const signal = strategy.evaluate(candles, index, context);
    const previous = strategy.evaluate(candles, index - 1, context);
    if (!signal?.passed || previous?.passed) {
      index++;
      continue;
    }
    entryStats.signals++;

    const signalCandle = candles[index];
    const signalCandleCloseTime = Number(signalCandle.openTime) + intervalMilliseconds(interval);
    const plan = buildTradePlan({
      marketType,
      tradePlanType,
      signal: {
        interval,
        close: signalCandle.close,
        signalCandleOpenTime: signalCandle.openTime,
        signalCandleCloseTime,
        signalAvailableAt: signalCandleCloseTime,
        entryEligibleAt: signalCandleCloseTime
      },
      candles,
      signalIndex: index,
      strategy,
      interval
    });
    if (!plan.tradeSpec) {
      recordMissedEntry({
        missedEntries,
        entryStats,
        status: NO_ENTRY,
        reason: "invalid_trade_plan",
        strategy,
        asset,
        signalCandle
      });
      index++;
      continue;
    }
    entryStats.planned++;

    const entryIndex = findEntryIndex(candles, index + 1, plan.tradeSpec.entryEligibleAt);
    if (entryIndex == null) {
      recordMissedEntry({
        missedEntries,
        entryStats,
        status: MISSED_ENTRY,
        reason: "no_eligible_candle",
        strategy,
        asset,
        signalCandle,
        tradeSpec: plan.tradeSpec
      });
      index++;
      continue;
    }
    const entryCandle = candles[entryIndex];
    const entryTime = Number(entryCandle.openTime);
    const entryExecution = applyEntryExecution({
      marketPrice: Number(entryCandle.open),
      side: plan.tradeSpec.side,
      executionModel: model
    });
    const entryValidation = validateEntryGeometry({
      tradeSpec: plan.tradeSpec,
      entryFillPrice: entryExecution.fillPrice,
      entryTime
    });
    if (!entryValidation.valid) {
      recordMissedEntry({
        missedEntries,
        entryStats,
        status: entryValidation.status,
        reason: entryValidation.reason,
        strategy,
        asset,
        signalCandle,
        tradeSpec: plan.tradeSpec,
        entryIndex,
        entryTime,
        entryMarketPrice: Number(entryCandle.open),
        entryFillPrice: entryExecution.fillPrice
      });
      index++;
      continue;
    }
    const trade = simulateTrade({
      tradeSpec: plan.tradeSpec,
      candles,
      entryIndex,
      strategyId: strategy.id,
      asset,
      executionModel: model
    });
    if (!trade) {
      recordMissedEntry({
        missedEntries,
        entryStats,
        status: MISSED_ENTRY,
        reason: "entry_simulation_rejected",
        strategy,
        asset,
        signalCandle,
        tradeSpec: plan.tradeSpec,
        entryIndex,
        entryTime,
        entryMarketPrice: Number(entryCandle.open),
        entryFillPrice: entryExecution.fillPrice
      });
      index++;
      continue;
    }
    entryStats.entries++;
    tradeResults.push(trade);
    if (!Number.isFinite(trade.exitIndex) || trade.exitIndex >= candles.length - 1) break;
    index = Math.max(index + 1, trade.exitIndex + 1);
  }

  return buildBacktestResult({ strategy, interval, marketType, tradePlanType, asset, tradeResults, model, missedEntries, entryStats });
}

function buildBacktestResult({ strategy, interval, marketType, tradePlanType, asset, tradeResults, model, missedEntries, entryStats }) {
  return {
    strategyId: strategy?.id || null,
    asset,
    side: strategy?.direction || null,
    interval,
    marketType,
    tradePlanType,
    tradeResults,
    missedEntries,
    entryStats,
    metrics: aggregateMetrics(tradeResults),
    dataQuality: model.dataQuality,
    executionModel: model
  };
}

function recordMissedEntry({
  missedEntries,
  entryStats,
  status,
  reason,
  strategy,
  asset,
  signalCandle,
  tradeSpec = null,
  entryIndex = null,
  entryTime = null,
  entryMarketPrice = null,
  entryFillPrice = null
}) {
  if (status === NO_ENTRY) entryStats.noEntry++;
  if (status === MISSED_ENTRY) entryStats.missedEntry++;
  missedEntries.push({
    status,
    reason,
    strategyId: strategy?.id || null,
    asset,
    signalCandleOpenTime: Number(signalCandle?.openTime),
    signalAvailableAt: tradeSpec?.signalAvailableAt ?? null,
    entryEligibleAt: tradeSpec?.entryEligibleAt ?? null,
    entryIndex,
    entryTime,
    referencePrice: tradeSpec?.referencePrice ?? null,
    entryMarketPrice,
    entryFillPrice,
    stopLoss: tradeSpec?.stopLoss ?? null,
    takeProfit: tradeSpec?.takeProfit ?? null,
    maxHoldingTime: tradeSpec?.maxHoldingTime ?? null
  });
}

function findEntryIndex(candles, startIndex, entryEligibleAt) {
  for (let index = startIndex; index < candles.length; index++) {
    if (Number(candles[index].openTime) >= Number(entryEligibleAt)) return index;
  }
  return null;
}

function intervalMilliseconds(interval) {
  const map = {
    "15m": 15 * 60 * 1000,
    "30m": 30 * 60 * 1000,
    "1h": 3600 * 1000,
    "2h": 2 * 3600 * 1000,
    "4h": 4 * 3600 * 1000,
    "1d": 24 * 3600 * 1000
  };
  return map[interval] || 24 * 3600 * 1000;
}
