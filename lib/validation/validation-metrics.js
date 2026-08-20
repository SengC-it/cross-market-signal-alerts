import { aggregateMetrics } from "../backtest/metrics.js";
import {
  INCOMPLETE_EXCHANGE_FILTERS,
  INCOMPLETE_FUNDING
} from "../backtest/execution-model.js";
import { INCOMPLETE_INTRABAR_DATA } from "../trading/replay-engine.js";

export const VALIDATION_VERDICTS = Object.freeze({
  INSUFFICIENT_DATA: "INSUFFICIENT_DATA",
  NEGATIVE_EDGE: "NEGATIVE_EDGE",
  UNSTABLE: "UNSTABLE",
  PROMISING_EDGE: "PROMISING_EDGE"
});

export const VALIDATION_FLAGS = Object.freeze({
  holdoutUsedForOptimization: false,
  strategyParametersChanged: false,
  parameterSearchPerformed: false
});

export function isPrimaryOosTrade(trade) {
  return Boolean(
    trade
    && trade.dataQuality === "COMPLETE"
    && trade.ambiguousIntrabar !== true
  );
}

export function aggregateValidationMetrics(tradeResults = [], diagnostics = {}) {
  const trades = Array.isArray(tradeResults) ? tradeResults : [];
  const primaryTrades = trades.filter(isPrimaryOosTrade);
  const degradedTrades = trades.filter((trade) => !isPrimaryOosTrade(trade));
  const missedEntries = Array.isArray(diagnostics.missedEntries)
    ? diagnostics.missedEntries
    : [];
  const noEntries = Number.isFinite(Number(diagnostics.noEntries))
    ? Number(diagnostics.noEntries)
    : missedEntries.filter((entry) => entry?.status === "NO_ENTRY").length;
  const missedEntryCount = Number.isFinite(Number(diagnostics.missedEntryCount))
    ? Number(diagnostics.missedEntryCount)
    : missedEntries.filter((entry) => entry?.status === "MISSED_ENTRY").length;
  const purgedBoundarySignals = Number(diagnostics.purgedBoundarySignals) || 0;
  const signals = Number(diagnostics.signals) || 0;
  const primary = aggregateMetrics(primaryTrades, {
    signals,
    missedEntries: noEntries + missedEntryCount
  });

  const qualityCounts = {
    completeTrades: primaryTrades.length,
    degradedTrades: degradedTrades.length,
    ambiguousTrades: trades.filter((trade) => trade?.ambiguousIntrabar === true).length,
    fundingIncompleteTrades: trades.filter(isFundingIncomplete).length,
    intrabarIncompleteTrades: trades.filter(isIntrabarIncomplete).length,
    exchangeFilterIncompleteTrades: trades.filter(isExchangeFilterIncomplete).length
  };
  const assetCount = new Set(primaryTrades.map((trade) => trade.asset || "UNKNOWN")).size;
  const longTrades = primaryTrades.filter((trade) => trade.side === "LONG").length;
  const shortTrades = primaryTrades.filter((trade) => trade.side === "SHORT").length;

  return {
    ...primary,
    completeTrades: qualityCounts.completeTrades,
    degradedTrades: qualityCounts.degradedTrades,
    ambiguousTrades: qualityCounts.ambiguousTrades,
    fundingIncompleteTrades: qualityCounts.fundingIncompleteTrades,
    intrabarIncompleteTrades: qualityCounts.intrabarIncompleteTrades,
    exchangeFilterIncompleteTrades: qualityCounts.exchangeFilterIncompleteTrades,
    assetCount,
    longTrades,
    shortTrades,
    noEntries,
    missedEntries: missedEntryCount,
    entryFailures: noEntries + missedEntryCount,
    noEntryRate: signals > 0 ? (noEntries + missedEntryCount) / signals : null,
    purgedBoundarySignals,
    signals,
    plannedEntries: Number(diagnostics.plannedEntries) || 0,
    dataQuality: degradedTrades.length ? "DEGRADED" : "COMPLETE"
  };
}

export function buildValidationStability({ tradeResults = [], folds = [] } = {}) {
  const completeTrades = (Array.isArray(tradeResults) ? tradeResults : [])
    .filter(isPrimaryOosTrade);
  const byAsset = summarizeGroups(completeTrades, (trade) => trade.asset || "UNKNOWN");
  const bySide = summarizeGroups(completeTrades, (trade) => trade.side || "UNKNOWN");
  const byFold = summarizeGroups(completeTrades, (trade) => trade.foldId || "UNKNOWN");
  const positiveNetTotal = completeTrades
    .map((trade) => Math.max(0, Number(trade.netReturnPct) || 0))
    .reduce((sum, value) => sum + value, 0);
  const assetPositiveConcentration = concentration(byAsset, positiveNetTotal);
  const foldPositiveConcentration = concentration(byFold, positiveNetTotal);
  const largestSide = maxGroup(bySide, "tradeCount");
  const largestAsset = maxGroup(byAsset, "tradeCount");
  const largestFold = maxGroup(byFold, "tradeCount");
  const negativeFoldCount = (Array.isArray(folds) ? folds : [])
    .filter((fold) => Number(fold?.expectancyR) < 0).length;
  const positiveFoldCount = (Array.isArray(folds) ? folds : [])
    .filter((fold) => Number(fold?.expectancyR) > 0).length;

  return {
    byAsset,
    bySide,
    byFold,
    positiveReturnConcentration: assetPositiveConcentration,
    flags: {
      singleAssetDominance: largestAsset?.tradeCount > completeTrades.length / 2,
      singleFoldDominance: largestFold?.tradeCount > completeTrades.length / 2
        || foldPositiveConcentration.maxShare > 0.5,
      sideDominance: largestSide?.tradeCount > completeTrades.length * 0.75,
      concentrationRisk: assetPositiveConcentration.maxShare > 0.5
        || foldPositiveConcentration.maxShare > 0.5
    },
    foldCounts: {
      positive: positiveFoldCount,
      negative: negativeFoldCount,
      total: Array.isArray(folds) ? folds.length : 0
    }
  };
}

export function determineValidationVerdict({
  aggregate,
  holdout,
  folds = [],
  stability = {}
} = {}) {
  const aggregateTrades = Number(aggregate?.completeTrades ?? aggregate?.trades) || 0;
  const holdoutTrades = Number(holdout?.completeTrades ?? holdout?.trades) || 0;
  if (aggregateTrades < 60 || holdoutTrades < 1) {
    return VALIDATION_VERDICTS.INSUFFICIENT_DATA;
  }

  const aggregateExpectancy = Number(aggregate?.expectancyR);
  const holdoutExpectancy = Number(holdout?.expectancyR);
  if (!Number.isFinite(aggregateExpectancy)
    || !Number.isFinite(holdoutExpectancy)
    || aggregateExpectancy <= 0
    || holdoutExpectancy <= 0) {
    return VALIDATION_VERDICTS.NEGATIVE_EDGE;
  }

  const foldList = Array.isArray(folds) ? folds : [];
  const negativeFolds = foldList.filter((fold) => Number(fold?.expectancyR) < 0).length;
  const majorityNegative = foldList.length > 0 && negativeFolds > foldList.length / 2;
  const severeConcentration = Boolean(
    stability?.flags?.singleAssetDominance
    || stability?.flags?.singleFoldDominance
    || stability?.flags?.concentrationRisk
  );
  if (majorityNegative || severeConcentration) {
    return VALIDATION_VERDICTS.UNSTABLE;
  }

  const aggregateProfitFactor = Number(aggregate?.profitFactor);
  const holdoutProfitFactor = Number(holdout?.profitFactor);
  const positiveFoldCount = foldList.filter((fold) => Number(fold?.expectancyR) > 0).length;
  const majorityPositive = foldList.length > 0 && positiveFoldCount > foldList.length / 2;
  if (majorityPositive
    && aggregateProfitFactor >= 1.2
    && holdoutProfitFactor >= 1.1) {
    return VALIDATION_VERDICTS.PROMISING_EDGE;
  }
  return VALIDATION_VERDICTS.UNSTABLE;
}

function summarizeGroups(trades, keyFn) {
  const groups = new Map();
  for (const trade of trades) {
    const key = String(keyFn(trade));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(trade);
  }
  return [...groups.entries()].map(([key, group]) => ({
    key,
    ...groupSummary(group)
  }));
}

function groupSummary(trades) {
  const metrics = aggregateMetrics(trades);
  return {
    tradeCount: trades.length,
    expectancyR: metrics.expectancyR,
    profitFactor: metrics.profitFactor,
    winRate: metrics.winRate,
    totalNetReturn: metrics.totalNetReturn,
    positiveNetReturn: trades
      .map((trade) => Math.max(0, Number(trade.netReturnPct) || 0))
      .reduce((sum, value) => sum + value, 0)
  };
}

function concentration(groups, totalPositive) {
  const ranked = (Array.isArray(groups) ? groups : [])
    .map((group) => ({
      key: group.key,
      positiveNetReturn: group.positiveNetReturn,
      share: totalPositive > 0 ? group.positiveNetReturn / totalPositive : 0
    }))
    .sort((a, b) => b.share - a.share);
  return {
    maxShare: ranked[0]?.share || 0,
    dominantKey: ranked[0]?.key || null,
    groups: ranked
  };
}

function maxGroup(groups, field) {
  return (Array.isArray(groups) ? groups : [])
    .reduce((best, group) => !best || Number(group[field]) > Number(best[field]) ? group : best, null);
}

function isFundingIncomplete(trade) {
  return trade?.dataQuality === INCOMPLETE_FUNDING
    || trade?.dataQualityComponents?.funding === INCOMPLETE_FUNDING;
}

function isIntrabarIncomplete(trade) {
  return trade?.dataQuality === INCOMPLETE_INTRABAR_DATA
    || trade?.dataQualityComponents?.intrabar === INCOMPLETE_INTRABAR_DATA;
}

function isExchangeFilterIncomplete(trade) {
  return trade?.dataQuality === INCOMPLETE_EXCHANGE_FILTERS
    || trade?.dataQualityComponents?.exchangeFilters === INCOMPLETE_EXCHANGE_FILTERS;
}
