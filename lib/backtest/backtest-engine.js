import { createExecutionModel, resolveEntryExecution } from "./execution-model.js";
import { INCOMPLETE_EXCHANGE_FILTERS } from "./execution-model.js";
import { aggregateMetrics } from "./metrics.js";
import { MISSED_ENTRY, NO_ENTRY, simulateTrade } from "./trade-simulator.js";
import { buildTradePlan } from "../trading/trade-plan.js";
import {
  prepareTradeSpecForExecution,
  validateExecutionQuantity
} from "../trading/exchange-filters.js";

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
  fundingCoverage,
  lowerTimeframeCandles,
  lowerTimeframe = null,
  exchangeFilters = null,
  requestedQty = null,
  orderType = "MARKET",
  maxTrades = Infinity
}) {
  const model = createExecutionModel({
    marketType,
    ...executionModel,
    ...(fundingEvents !== undefined ? { fundingEvents } : {}),
    ...(fundingDataComplete !== undefined ? { fundingDataComplete } : {}),
    ...(fundingCoverage !== undefined ? { fundingCoverage } : {})
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
    return buildBacktestResult({
      strategy,
      interval,
      marketType,
      tradePlanType,
      asset,
      tradeResults,
      model,
      exchangeFilters,
      missedEntries,
      entryStats
    });
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

    const prepared = prepareTradeSpecForExecution(plan.tradeSpec, exchangeFilters);
    if (!prepared.valid || !prepared.tradeSpec) {
      recordMissedEntry({
        missedEntries,
        entryStats,
        status: NO_ENTRY,
        reason: prepared.reason || "invalid_exchange_filters",
        strategy,
        asset,
        signalCandle,
        tradeSpec: plan.tradeSpec
      });
      index++;
      continue;
    }

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
    const entryResolution = resolveEntryExecution({
      tradeSpec: prepared.tradeSpec,
      entryCandle,
      executionModel: model,
      exchangeFilters: prepared.filters
    });
    const entryTime = entryResolution.entryTime ?? Number(entryCandle.openTime);
    const entryFillPrice = entryResolution.fillPrice ?? entryResolution.execution?.fillPrice ?? null;
    if (!entryResolution.valid) {
      recordMissedEntry({
        missedEntries,
        entryStats,
        status: entryResolution.status,
        reason: entryResolution.reason,
        strategy,
        asset,
        signalCandle,
        tradeSpec: prepared.tradeSpec,
        entryIndex,
        entryTime,
        entryMarketPrice: Number(entryCandle.open),
        entryFillPrice
      });
      index++;
      continue;
    }
    if (requestedQty != null) {
      if (!prepared.filters) {
        recordMissedEntry({
          missedEntries,
          entryStats,
          status: NO_ENTRY,
          reason: "exchange_filters_missing",
          strategy,
          asset,
          signalCandle,
          tradeSpec: prepared.tradeSpec,
          entryIndex,
          entryTime,
          entryMarketPrice: Number(entryCandle.open),
          entryFillPrice
        });
        index++;
        continue;
      }
      const quantityValidation = validateExecutionQuantity({
        quantity: requestedQty,
        price: entryFillPrice,
        exchangeFilters: prepared.filters,
        orderType
      });
      if (!quantityValidation.valid) {
        recordMissedEntry({
          missedEntries,
          entryStats,
          status: NO_ENTRY,
          reason: quantityValidation.reason,
          strategy,
          asset,
          signalCandle,
          tradeSpec: prepared.tradeSpec,
          entryIndex,
          entryTime,
          entryMarketPrice: Number(entryCandle.open),
          entryFillPrice
        });
        index++;
        continue;
      }
    }
    const trade = simulateTrade({
      tradeSpec: plan.tradeSpec,
      candles,
      entryIndex,
      strategyId: strategy.id,
      asset,
      executionModel: model,
      resolvedEntryExecution: entryResolution,
      lowerTimeframeCandles,
      lowerTimeframe,
      exchangeFilters,
      requestedQty,
      orderType
    });
    if (!trade) {
      recordMissedEntry({
        missedEntries,
        entryStats,
        status: NO_ENTRY,
        reason: "entry_simulation_rejected",
        strategy,
        asset,
        signalCandle,
        tradeSpec: prepared.tradeSpec,
        entryIndex,
        entryTime,
        entryMarketPrice: Number(entryCandle.open),
        entryFillPrice
      });
      index++;
      continue;
    }
    entryStats.entries++;
    tradeResults.push(trade);
    if (!Number.isFinite(trade.exitIndex) || trade.exitIndex >= candles.length - 1) break;
    index = Math.max(index + 1, trade.exitIndex + 1);
  }

  return buildBacktestResult({ strategy, interval, marketType, tradePlanType, asset, tradeResults, model, exchangeFilters, missedEntries, entryStats });
}

function buildBacktestResult({ strategy, interval, marketType, tradePlanType, asset, tradeResults, model, exchangeFilters, missedEntries, entryStats }) {
  const metrics = aggregateMetrics(tradeResults, { missedEntries, entryStats });
  const exchangeQuality = model.exchangeRulesRequired && !exchangeFilters
    ? INCOMPLETE_EXCHANGE_FILTERS
    : null;
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
    metrics,
    dataQuality: model.dataQuality !== "COMPLETE" ? model.dataQuality : exchangeQuality || metrics.dataQuality,
    dataQualityComponents: tradeResults.map((trade) => trade.dataQualityComponents).filter(Boolean),
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
