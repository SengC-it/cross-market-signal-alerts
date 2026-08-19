import { createExecutionModel } from "./execution-model.js";
import { aggregateMetrics } from "./metrics.js";
import { simulateTrade } from "./trade-simulator.js";
import { buildTradePlan } from "../trading/trade-plan.js";

export function runBacktest({
  candles,
  strategy,
  interval,
  marketType = "futures",
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
  if (!Array.isArray(candles) || !strategy || candles.length < 2) {
    return buildBacktestResult({ strategy, interval, marketType, asset, tradeResults, model });
  }

  for (let index = Math.max(1, Number(startIndex) || 0); index < candles.length - 1 && tradeResults.length < maxTrades;) {
    const context = { interval };
    const signal = strategy.evaluate(candles, index, context);
    const previous = strategy.evaluate(candles, index - 1, context);
    if (!signal?.passed || previous?.passed) {
      index++;
      continue;
    }

    const signalCandle = candles[index];
    const signalCandleCloseTime = Number(signalCandle.openTime) + intervalMilliseconds(interval);
    const plan = buildTradePlan({
      marketType,
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
      index++;
      continue;
    }

    const entryIndex = findEntryIndex(candles, index + 1, plan.tradeSpec.entryEligibleAt);
    const trade = simulateTrade({
      tradeSpec: plan.tradeSpec,
      candles,
      entryIndex,
      strategyId: strategy.id,
      asset,
      executionModel: model
    });
    if (!trade) {
      index++;
      continue;
    }
    tradeResults.push(trade);
    if (!Number.isFinite(trade.exitIndex) || trade.exitIndex >= candles.length - 1) break;
    index = Math.max(index + 1, trade.exitIndex + 1);
  }

  return buildBacktestResult({ strategy, interval, marketType, asset, tradeResults, model });
}

function buildBacktestResult({ strategy, interval, marketType, asset, tradeResults, model }) {
  return {
    strategyId: strategy?.id || null,
    asset,
    side: strategy?.direction || null,
    interval,
    marketType,
    tradeResults,
    metrics: aggregateMetrics(tradeResults),
    dataQuality: model.dataQuality,
    executionModel: model
  };
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
