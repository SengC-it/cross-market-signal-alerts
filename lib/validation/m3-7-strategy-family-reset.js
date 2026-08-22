import { createHash } from "node:crypto";
import { CONFIG } from "../config.js";
import { atr } from "../indicators.js";
import { aggregateMetrics } from "../backtest/metrics.js";
import {
  createExecutionModel,
  resolveEntryExecution
} from "../backtest/execution-model.js";
import {
  MISSED_ENTRY,
  NO_ENTRY,
  simulateTrade,
  validateEntryGeometry
} from "../backtest/trade-simulator.js";
import { buildTradePlan } from "../trading/trade-plan.js";
import {
  createTradeSpec,
  intervalMilliseconds
} from "../trading/trade-spec.js";
import { prepareTradeSpecForExecution } from "../trading/exchange-filters.js";
import { isPrimaryOosTrade } from "./validation-metrics.js";

export const M37_BASE_SHA = "be1cd5e2ad2f53b90f309677932fa00124d289cd";
export const M37_OLD_WINDOW_ROLE = "RESEARCH_ONLY_AFTER_MULTIPLE_INSPECTIONS";
export const M37_RESEARCH_STATUS = "RESEARCH_ONLY";

export const M37_OLD_WINDOW = Object.freeze({
  start: "2025-08-01T00:00:00.000Z",
  endExclusive: "2026-08-01T00:00:00.000Z"
});

export const M37_FORWARD_SPEC = Object.freeze({
  datasetId: "M37_FORWARD_2026_08_2026_12",
  start: "2026-08-01T00:00:00.000Z",
  endExclusive: "2026-12-01T00:00:00.000Z"
});

export const M37_RESEARCH_GATE = Object.freeze({
  minCompleteTrades: 30,
  netExpectancyRGreaterThan: 0,
  profitFactorAtLeast: 1.10,
  positiveResearchFoldsAtLeast: 3,
  researchFoldCount: 5,
  maxAssetTradeShare: 0.25,
  maxFoldTradeShare: 0.40,
  maxSideTradeShare: 0.85,
  grossExpectancyRGreaterThan: 0
});

export const M37_FORMAL_FORWARD_GATE = Object.freeze({
  minCompleteOosTrades: 60,
  aggregateExpectancyRGreaterThan: 0,
  aggregateProfitFactorAtLeast: 1.20,
  majorityPositiveFolds: true,
  concentrationControls: true
});

export const M37_FAMILY_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: "cross_sectional_relative_momentum_v1",
    family: "Cross-sectional Relative Momentum",
    hypothesis: "Cross-sectional relative strength/weakness, not absolute move chasing.",
    sides: Object.freeze(["LONG", "SHORT"]),
    features: Object.freeze(["return24h", "return6h", "BTC return24h", "relative24h", "historical-universe percentile"]),
    fixedRules: Object.freeze({
      longRelativePercentileAtLeast: 0.90,
      shortRelativePercentileAtMost: 0.10,
      longReturn6hGreaterThan: 0,
      shortReturn6hLessThan: 0
    }),
    execution: Object.freeze({
      interval: "1h",
      entry: "next eligible 1h bar",
      holdHours: 8,
      tradePlan: "existing futures TradeSpec builder + M2-B execution"
    }),
    selection: "historical_universe_cross_sectional_rank",
    recommendationScoreGate: false
  }),
  Object.freeze({
    id: "atr_dislocation_mean_reversion_v1",
    family: "Short-horizon Dislocation Mean Reversion",
    hypothesis: "Extreme short-horizon displacement plus wick rejection mean reverts.",
    sides: Object.freeze(["LONG", "SHORT"]),
    features: Object.freeze(["ATR14", "displacement6h", "lower/upper wick ratio", "close location value"]),
    fixedRules: Object.freeze({
      displacementAtrLongAtMost: -3,
      displacementAtrShortAtLeast: 3,
      wickRatioAtLeast: 0.35,
      longCloseLocationAtLeast: 0,
      shortCloseLocationAtMost: 0
    }),
    risk: Object.freeze({ stopDistanceAtr: 1, rewardRiskRatio: 1.5 }),
    execution: Object.freeze({
      interval: "1h",
      entry: "next eligible 1h bar",
      holdHours: 4,
      tradePlan: "fixed 1 ATR / 1.5R TradeSpec + M2-B execution"
    }),
    selection: "causal_price_dislocation",
    recommendationScoreGate: false
  }),
  Object.freeze({
    id: "funding_extreme_crowding_reversal_v1",
    family: "Funding Crowding Reversal",
    hypothesis: "Funding crowding and price extension in the same direction reverse.",
    sides: Object.freeze(["LONG", "SHORT"]),
    features: Object.freeze(["latest settled funding rate", "funding percentile", "return8h"]),
    fixedRules: Object.freeze({
      longFundingPercentileAtMost: 0.10,
      shortFundingPercentileAtLeast: 0.90,
      longFundingRateLessThan: 0,
      shortFundingRateGreaterThan: 0,
      longReturn8hLessThan: 0,
      shortReturn8hGreaterThan: 0
    }),
    execution: Object.freeze({
      interval: "1h",
      entry: "next eligible 1h bar",
      holdHours: 8,
      tradePlan: "existing futures TradeSpec builder + M2-B execution"
    }),
    selection: "post_settlement_historical_universe_funding_rank",
    recommendationScoreGate: false
  })
]);

export function familyDefinitions() {
  return M37_FAMILY_DEFINITIONS.map((definition) => clone(definition));
}

export function candidateDefinitionsHash(definitions = familyDefinitions()) {
  return createHash("sha256")
    .update(JSON.stringify(definitions))
    .digest("hex");
}

export function historicalUniverseAssetsAt(historicalUniverse, time) {
  const timestamp = toTimestamp(time);
  if (!Number.isFinite(timestamp)) return new Set();
  const rows = normalizeUniverseRows(historicalUniverse);
  let left = 0;
  let right = rows.length - 1;
  let selected = null;
  while (left <= right) {
    const middle = Math.floor((left + right) / 2);
    if (rows[middle].time <= timestamp) {
      selected = rows[middle];
      left = middle + 1;
    } else {
      right = middle - 1;
    }
  }
  return new Set(selected?.assets || []);
}

export function crossSectionalPercentile(value, values) {
  const target = Number(value);
  const sortedValues = (Array.isArray(values) ? values : [])
    .map(Number)
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  return percentileFromSorted(target, sortedValues);
}

function percentileFromSorted(target, sortedValues) {
  if (!Number.isFinite(target) || sortedValues.length === 0) return null;
  if (sortedValues.length === 1) return 0.5;
  const lower = lowerBound(sortedValues, target);
  const equal = upperBound(sortedValues, target) - lower;
  if (!equal) return null;
  const midrank = lower + (equal - 1) / 2;
  return midrank / (sortedValues.length - 1);
}

export function buildM37MarketContext({
  datasets = [],
  benchmarkCandles = [],
  historicalUniverse = [],
  window = M37_OLD_WINDOW
} = {}) {
  const start = toTimestamp(window.start);
  const end = toTimestamp(window.endExclusive ?? window.end);
  const normalizedDatasets = (Array.isArray(datasets) ? datasets : [])
    .map((dataset) => {
      const candles = (Array.isArray(dataset?.candles) ? dataset.candles : [])
        .filter((candle) => Number.isFinite(Number(candle?.openTime)))
        .sort((left, right) => Number(left.openTime) - Number(right.openTime));
      return {
        ...dataset,
        asset: String(dataset?.asset || ""),
        candles,
        fundingEvents: normalizeFundingEventsForM37(dataset?.fundingEvents),
        candleByTime: new Map(candles.map((candle, index) => [Number(candle.openTime), index]))
      };
    })
    .filter((dataset) => dataset.asset && dataset.candles.length > 0);
  const completeTimeline = normalizedDatasets.find((dataset) => dataset.candles.length > 1000);
  const timeline = completeTimeline
    ? completeTimeline.candles
      .map((candle) => Number(candle.openTime))
      .filter((time) => (!Number.isFinite(start) || time >= start)
        && (!Number.isFinite(end) || time < end))
    : [...new Set(normalizedDatasets
      .flatMap((dataset) => dataset.candles
        .map((candle) => Number(candle.openTime))
        .filter((time) => (!Number.isFinite(start) || time >= start)
          && (!Number.isFinite(end) || time < end))))]
      .sort((left, right) => left - right);
  const benchmark = (Array.isArray(benchmarkCandles) ? benchmarkCandles : [])
    .filter((candle) => Number.isFinite(Number(candle?.openTime)))
    .sort((left, right) => Number(left.openTime) - Number(right.openTime));
  const universeRows = normalizeUniverseRows(historicalUniverse);
  return {
    datasets: normalizedDatasets,
    datasetsByAsset: new Map(normalizedDatasets.map((dataset) => [dataset.asset, dataset])),
    benchmark,
    universeRows,
    timeline,
    window: { start: window.start, endExclusive: window.endExclusive ?? window.end },
    assetsAt(time) {
      return assetsAtNormalizedRows(universeRows, time);
    }
  };
}

export function buildM37FamilySignals({ familyId, context } = {}) {
  const definition = M37_FAMILY_DEFINITIONS.find((candidate) => candidate.id === familyId);
  if (!definition || !context) return [];
  if (familyId === "cross_sectional_relative_momentum_v1") {
    return buildRelativeMomentumSignals({ context, definition });
  }
  if (familyId === "atr_dislocation_mean_reversion_v1") {
    return buildDislocationSignals({ context, definition });
  }
  if (familyId === "funding_extreme_crowding_reversal_v1") {
    return buildFundingCrowdingSignals({ context, definition });
  }
  return [];
}

export function buildM37SignalStrategy({ familyId, side, signals = [] } = {}) {
  const definition = M37_FAMILY_DEFINITIONS.find((candidate) => candidate.id === familyId);
  const signalByTime = new Map((Array.isArray(signals) ? signals : [])
    .filter((signal) => signal?.side === side)
    .map((signal) => [Number(signal.signalCandleOpenTime), signal]));
  return {
    id: familyId,
    direction: side,
    holdHours: definition?.execution?.holdHours ?? null,
    evaluate(candles, index) {
      const signal = signalByTime.get(Number(candles?.[index]?.openTime));
      return signal
        ? { passed: true, details: signal.details, m37Signal: signal }
        : { passed: false, details: {} };
    }
  };
}

export function buildM37TradePlan({ familyId, signal, candles = [], signalIndex } = {}) {
  const definition = M37_FAMILY_DEFINITIONS.find((candidate) => candidate.id === familyId);
  if (!definition || !signal || !Array.isArray(candles)) return { tradeSpec: null, executionPlan: {} };
  const interval = definition.execution.interval;
  if (familyId !== "atr_dislocation_mean_reversion_v1") {
    return buildTradePlan({
      marketType: "futures",
      tradePlanType: "futures",
      signal: {
        interval,
        close: signal.referencePrice,
        signalCandleOpenTime: signal.signalCandleOpenTime,
        signalCandleCloseTime: signal.signalCandleCloseTime,
        signalAvailableAt: signal.signalAvailableAt,
        entryEligibleAt: signal.entryEligibleAt
      },
      candles,
      signalIndex,
      strategy: {
        direction: signal.side,
        holdHours: definition.execution.holdHours
      },
      interval
    });
  }

  const current = candles[signalIndex];
  const latestAtr = atr(candles, 14, signalIndex);
  const referencePrice = Number(signal.referencePrice ?? current?.close);
  if (!current || !Number.isFinite(latestAtr) || latestAtr <= 0 || !Number.isFinite(referencePrice)) {
    return { tradeSpec: null, executionPlan: {} };
  }
  const stopLoss = signal.side === "SHORT"
    ? referencePrice + latestAtr
    : referencePrice - latestAtr;
  const takeProfit = signal.side === "SHORT"
    ? referencePrice - latestAtr * 1.5
    : referencePrice + latestAtr * 1.5;
  const tradeSpec = createTradeSpec({
    source: "m3_7_family",
    modelVersion: "m3_7_atr_dislocation_v1",
    side: signal.side,
    interval,
    signalCandleOpenTime: signal.signalCandleOpenTime,
    signalCandleCloseTime: signal.signalCandleCloseTime,
    signalAvailableAt: signal.signalAvailableAt,
    entryEligibleAt: signal.entryEligibleAt,
    referencePrice,
    stopLoss,
    takeProfit,
    rewardRiskRatio: 1.5,
    maxHoldingHours: 4,
    modeledRoundTripCostPct: CONFIG.futuresTradingCost
  });
  return {
    tradeSpec,
    executionPlan: {
      tradePlanType: "futures",
      entryPolicy: "next_full_candle",
      entryReference: referencePrice,
      stopLoss,
      takeProfit,
      rewardRiskRatio: 1.5,
      maxHoldingHours: 4
    }
  };
}

export function runM37FamilyBacktest({
  familyId,
  dataset,
  signals = [],
  executionModel = {},
  fundingEvents,
  fundingCoverage,
  lowerTimeframeCandles,
  lowerTimeframe = "5m",
  exchangeFilters,
  startIndex = 1
} = {}) {
  const candles = Array.isArray(dataset?.candles) ? dataset.candles : [];
  const side = signals[0]?.side;
  const strategy = buildM37SignalStrategy({ familyId, side, signals });
  const model = createExecutionModel({
    marketType: "futures",
    ...executionModel,
    exchangeRulesRequired: true,
    ...(fundingEvents !== undefined ? { fundingEvents } : {}),
    ...(fundingCoverage !== undefined ? { fundingCoverage } : {})
  });
  const tradeResults = [];
  const missedEntries = [];
  const entryStats = { signals: 0, planned: 0, entries: 0, noEntry: 0, missedEntry: 0 };
  const signalByTime = new Map((Array.isArray(signals) ? signals : [])
    .map((signal) => [Number(signal.signalCandleOpenTime), signal]));

  for (let index = Math.max(1, Number(startIndex) || 0); index < candles.length - 1;) {
    const signal = signalByTime.get(Number(candles[index]?.openTime));
    const previousSignal = signalByTime.get(Number(candles[index - 1]?.openTime));
    if (!signal || previousSignal) {
      index++;
      continue;
    }
    entryStats.signals++;
    const plan = buildM37TradePlan({ familyId, signal, candles, signalIndex: index });
    if (!plan.tradeSpec) {
      recordM37MissedEntry({ missedEntries, entryStats, status: NO_ENTRY, reason: "invalid_trade_plan", dataset, signal });
      index++;
      continue;
    }
    entryStats.planned++;
    const prepared = prepareTradeSpecForExecution(plan.tradeSpec, exchangeFilters);
    if (!prepared.valid || !prepared.tradeSpec) {
      recordM37MissedEntry({ missedEntries, entryStats, status: NO_ENTRY, reason: prepared.reason || "invalid_exchange_filters", dataset, signal, tradeSpec: plan.tradeSpec });
      index++;
      continue;
    }
    const entryIndex = findEntryIndex(candles, index + 1, prepared.tradeSpec.entryEligibleAt);
    if (entryIndex == null) {
      recordM37MissedEntry({ missedEntries, entryStats, status: MISSED_ENTRY, reason: "no_eligible_candle", dataset, signal, tradeSpec: prepared.tradeSpec });
      index++;
      continue;
    }
    const entryResolution = resolveEntryExecution({
      tradeSpec: prepared.tradeSpec,
      entryCandle: candles[entryIndex],
      executionModel: model,
      exchangeFilters: prepared.filters
    });
    const geometry = validateEntryGeometry({
      tradeSpec: prepared.tradeSpec,
      entryFillPrice: entryResolution.entryFillPrice ?? entryResolution.fillPrice,
      entryTime: entryResolution.entryTime
    });
    if (!entryResolution.valid || !geometry.valid) {
      recordM37MissedEntry({
        missedEntries,
        entryStats,
        status: geometry.status || entryResolution.status || NO_ENTRY,
        reason: geometry.reason || entryResolution.reason || "invalid_entry",
        dataset,
        signal,
        tradeSpec: prepared.tradeSpec
      });
      index++;
      continue;
    }
    const trade = simulateTrade({
      tradeSpec: plan.tradeSpec,
      candles,
      entryIndex,
      strategyId: familyId,
      asset: dataset.asset,
      executionModel: model,
      resolvedEntryExecution: entryResolution,
      lowerTimeframeCandles,
      lowerTimeframe,
      exchangeFilters
    });
    if (!trade) {
      recordM37MissedEntry({ missedEntries, entryStats, status: NO_ENTRY, reason: "entry_simulation_rejected", dataset, signal, tradeSpec: prepared.tradeSpec });
      index++;
      continue;
    }
    entryStats.entries++;
    tradeResults.push({
      ...trade,
      familyId,
      marketRegime: signal.details?.marketRegime || "unknown"
    });
    if (!Number.isFinite(trade.exitIndex) || trade.exitIndex >= candles.length - 1) break;
    index = Math.max(index + 1, trade.exitIndex + 1);
  }

  return {
    strategyId: familyId,
    asset: dataset?.asset || null,
    tradeResults,
    missedEntries,
    entryStats,
    metrics: aggregateMetrics(tradeResults.filter(isPrimaryOosTrade), {
      signals: entryStats.signals,
      missedEntries
    }),
    executionModel: model
  };
}

export function summarizeM37Research({
  familyId,
  signals = [],
  tradeResults = [],
  missedEntries = [],
  window = M37_OLD_WINDOW
} = {}) {
  const completeTrades = (Array.isArray(tradeResults) ? tradeResults : [])
    .filter(isPrimaryOosTrade)
    .sort((left, right) => Number(left.exitTime) - Number(right.exitTime));
  const degradedTrades = (Array.isArray(tradeResults) ? tradeResults : [])
    .filter((trade) => !isPrimaryOosTrade(trade));
  const folds = fixedResearchFolds(completeTrades, window);
  const metrics = aggregateMetrics(completeTrades, {
    signals: Array.isArray(signals) ? signals.length : 0,
    missedEntries
  });
  const grossR = completeTrades.map((trade) => ratio(trade.grossReturnPct, trade.initialRiskPct));
  const summary = {
    familyId,
    researchClassification: M37_RESEARCH_STATUS,
    signals: Array.isArray(signals) ? signals.length : 0,
    rawTradeRows: Array.isArray(tradeResults) ? tradeResults.length : 0,
    completeTrades: completeTrades.length,
    degradedTrades: degradedTrades.length,
    metrics: {
      grossExpectancyR: average(grossR),
      netExpectancyR: metrics.expectancyR,
      profitFactor: metrics.profitFactor,
      winRate: metrics.winRate,
      avgWinR: metrics.avgWinR,
      avgLossR: metrics.avgLossR,
      maxDrawdown: metrics.maxDrawdown,
      mfeR: average(completeTrades.map((trade) => trade.mfeR)),
      maeR: average(completeTrades.map((trade) => trade.maeR)),
      feeDrag: metrics.feeDrag,
      slippageDrag: metrics.slippageDrag,
      spreadDrag: metrics.spreadDrag,
      fundingDrag: metrics.fundingDrag,
      totalNetReturn: metrics.totalNetReturn,
      averageNetReturn: metrics.averageNetReturn
    },
    positiveResearchFolds: folds.filter((fold) => Number(fold.metrics.netExpectancyR) > 0).length,
    negativeResearchFolds: folds.filter((fold) => Number(fold.metrics.netExpectancyR) < 0).length,
    folds,
    byAsset: summarizeGroups(completeTrades, (trade) => trade.asset),
    bySide: summarizeGroups(completeTrades, (trade) => trade.side),
    byFold: summarizeGroups(completeTrades, (trade) => trade.researchFold),
    byRegime: summarizeGroups(completeTrades, (trade) => trade.marketRegime),
    concentration: {
      maxAssetTradeShare: maxTradeShare(completeTrades, (trade) => trade.asset),
      maxFoldTradeShare: maxTradeShare(completeTrades, (trade) => trade.researchFold),
      maxSideTradeShare: maxTradeShare(completeTrades, (trade) => trade.side),
      sideCount: new Set(completeTrades.map((trade) => trade.side)).size
    },
    dataQuality: {
      degradedTrades: degradedTrades.length,
      fundingIncompleteTrades: tradeResults.filter((trade) => trade.dataQuality === "INCOMPLETE_FUNDING"
        || trade.dataQualityComponents?.funding === "INCOMPLETE_FUNDING").length,
      incompleteIntrabarTrades: tradeResults.filter((trade) => trade.dataQuality === "INCOMPLETE_INTRABAR_DATA"
        || trade.dataQualityComponents?.intrabar === "INCOMPLETE_INTRABAR_DATA").length
    }
  };
  return {
    ...summary,
    researchGate: evaluateM37ResearchGate(summary)
  };
}

export function evaluateM37ResearchGate(researchResult = {}) {
  const metrics = researchResult.metrics || {};
  const completeTrades = Number(researchResult.completeTrades) || 0;
  const concentration = researchResult.concentration || {};
  const hasBothSides = Number(concentration.sideCount) > 1;
  const gates = {
    minCompleteTrades: completeTrades >= M37_RESEARCH_GATE.minCompleteTrades,
    netExpectancyR: finiteMetric(metrics.netExpectancyR)
      && Number(metrics.netExpectancyR) > M37_RESEARCH_GATE.netExpectancyRGreaterThan,
    profitFactor: finiteMetric(metrics.profitFactor)
      && Number(metrics.profitFactor) >= M37_RESEARCH_GATE.profitFactorAtLeast,
    positiveResearchFolds: Number(researchResult.positiveResearchFolds) >= M37_RESEARCH_GATE.positiveResearchFoldsAtLeast,
    maxAssetTradeShare: finiteMetric(concentration.maxAssetTradeShare)
      && Number(concentration.maxAssetTradeShare) <= M37_RESEARCH_GATE.maxAssetTradeShare,
    maxFoldTradeShare: finiteMetric(concentration.maxFoldTradeShare)
      && Number(concentration.maxFoldTradeShare) <= M37_RESEARCH_GATE.maxFoldTradeShare,
    maxSideTradeShare: !hasBothSides
      || (finiteMetric(concentration.maxSideTradeShare)
        && Number(concentration.maxSideTradeShare) <= M37_RESEARCH_GATE.maxSideTradeShare),
    grossExpectancyR: finiteMetric(metrics.grossExpectancyR)
      && Number(metrics.grossExpectancyR) > M37_RESEARCH_GATE.grossExpectancyRGreaterThan
  };
  const passed = Object.values(gates).every(Boolean);
  return {
    gates,
    allGatesPassed: passed,
    status: passed ? "FORWARD_TEST_CANDIDATE" : "REJECTED_CANDIDATE",
    promisingEdge: false,
    researchOnly: true
  };
}

export function fixedForwardWindowSplit({
  start = M37_FORWARD_SPEC.start,
  endExclusive = M37_FORWARD_SPEC.endExclusive,
  finalHoldoutPct = 0.20
} = {}) {
  const startTime = toTimestamp(start);
  const endTime = toTimestamp(endExclusive);
  const holdoutMs = Math.floor((endTime - startTime) * finalHoldoutPct);
  const finalHoldoutStart = endTime - holdoutMs;
  return {
    walkForwardStart: new Date(startTime).toISOString(),
    walkForwardEndExclusive: new Date(finalHoldoutStart).toISOString(),
    finalHoldoutStart: new Date(finalHoldoutStart).toISOString(),
    finalHoldoutEndExclusive: new Date(endTime).toISOString(),
    finalHoldoutPct
  };
}

export function formalForwardVerdict({
  asOf = Date.now(),
  completeTrades = 0,
  aggregateExpectancyR = null,
  aggregateProfitFactor = null,
  positiveFolds = 0,
  totalFolds = 0,
  concentrationControlsPassed = false
} = {}) {
  if (toTimestamp(asOf) < toTimestamp(M37_FORWARD_SPEC.endExclusive)) {
    return "PENDING_FORWARD_WINDOW";
  }
  if (Number(completeTrades) < M37_FORMAL_FORWARD_GATE.minCompleteOosTrades) {
    return "INSUFFICIENT_DATA";
  }
  if (Number(aggregateExpectancyR) <= 0
    || Number(aggregateProfitFactor) < M37_FORMAL_FORWARD_GATE.aggregateProfitFactorAtLeast
    || Number(positiveFolds) <= Number(totalFolds) / 2
    || concentrationControlsPassed !== true) {
    return "FORMAL_FORWARD_GATE_FAILED";
  }
  return "FORMAL_FORWARD_CANDIDATE";
}

export function buildM37ForwardSpec() {
  const definitions = familyDefinitions();
  return {
    datasetId: M37_FORWARD_SPEC.datasetId,
    start: M37_FORWARD_SPEC.start,
    endExclusive: M37_FORWARD_SPEC.endExclusive,
    candidateIds: definitions.map((definition) => definition.id),
    candidateDefinitionsHash: candidateDefinitionsHash(definitions),
    researchGate: clone(M37_RESEARCH_GATE),
    formalForwardGate: clone(M37_FORMAL_FORWARD_GATE),
    split: fixedForwardWindowSplit(),
    createdBeforeFormalForwardEvaluation: true,
    candidateDefinitionsFrozen: true
  };
}

function buildRelativeMomentumSignals({ context, definition }) {
  const signals = [];
  for (const time of context.timeline) {
    const availableAt = time + intervalMilliseconds("1h");
    const btcReturn24h = benchmarkReturn24hAsOf(context.benchmark, availableAt);
    if (!Number.isFinite(btcReturn24h)) continue;
    const activeAssets = context.assetsAt(time);
    const rows = [];
    for (const dataset of context.datasets) {
      if (!activeAssets.has(dataset.asset)) continue;
      const current = candleAt(dataset, time);
      const sixHoursAgo = candleAt(dataset, time - 6 * 3600 * 1000);
      const twentyFourHoursAgo = candleAt(dataset, time - 24 * 3600 * 1000);
      if (!current || !sixHoursAgo || !twentyFourHoursAgo) continue;
      const return6h = priceReturn(current.close, sixHoursAgo.close);
      const return24h = priceReturn(current.close, twentyFourHoursAgo.close);
      if (!Number.isFinite(return6h) || !Number.isFinite(return24h)) continue;
      rows.push({
        dataset,
        current,
        return6h,
        return24h,
        relative24h: return24h - btcReturn24h
      });
    }
    const values = rows.map((row) => row.relative24h)
      .filter(Number.isFinite)
      .sort((left, right) => left - right);
    for (const row of rows) {
      const percentile = percentileFromSorted(row.relative24h, values);
      const side = percentile >= definition.fixedRules.longRelativePercentileAtLeast
        && row.return6h > definition.fixedRules.longReturn6hGreaterThan
        ? "LONG"
        : percentile <= definition.fixedRules.shortRelativePercentileAtMost
          && row.return6h < definition.fixedRules.shortReturn6hLessThan
          ? "SHORT"
          : null;
      if (!side) continue;
      signals.push(makeM37Signal({
        familyId: definition.id,
        asset: row.dataset.asset,
        side,
        candle: row.current,
        details: {
          return6h: row.return6h,
          return24h: row.return24h,
          btcReturn24h,
          relative24h: row.relative24h,
          crossSectionalPercentile: percentile,
          historicalUniverseSize: activeAssets.size,
          marketRegime: btcReturn24h > 0.02 ? "btc_up" : btcReturn24h < -0.02 ? "btc_down" : "btc_flat"
        }
      }));
    }
  }
  return signals.sort(signalOrder);
}

function buildDislocationSignals({ context, definition }) {
  const signals = [];
  for (const dataset of context.datasets) {
    for (let index = 14; index < dataset.candles.length - 1; index++) {
      const current = dataset.candles[index];
      const sixHoursAgo = candleAt(dataset, Number(current.openTime) - 6 * 3600 * 1000);
      if (!sixHoursAgo || !isContiguous(dataset.candles, index, 14)) continue;
      const latestAtr = atr(dataset.candles, 14, index);
      const displacement6h = Number.isFinite(latestAtr) && latestAtr > 0
        ? (Number(current.close) - Number(sixHoursAgo.close)) / latestAtr
        : null;
      const candleShape = candleShapeFeatures(current);
      if (!Number.isFinite(displacement6h) || !candleShape) continue;
      const side = displacement6h <= definition.fixedRules.displacementAtrLongAtMost
        && candleShape.lowerWickRatio >= definition.fixedRules.wickRatioAtLeast
        && candleShape.closeLocationValue >= definition.fixedRules.longCloseLocationAtLeast
        ? "LONG"
        : displacement6h >= definition.fixedRules.displacementAtrShortAtLeast
          && candleShape.upperWickRatio >= definition.fixedRules.wickRatioAtLeast
          && candleShape.closeLocationValue <= definition.fixedRules.shortCloseLocationAtMost
          ? "SHORT"
          : null;
      if (!side) continue;
      signals.push(makeM37Signal({
        familyId: definition.id,
        asset: dataset.asset,
        side,
        candle: current,
        details: {
          atr14: latestAtr,
          displacement6h,
          ...candleShape,
          marketRegime: "price_dislocation"
        }
      }));
    }
  }
  return signals.sort(signalOrder);
}

function buildFundingCrowdingSignals({ context, definition }) {
  const signals = [];
  for (const time of context.timeline) {
    const availableAt = time + intervalMilliseconds("1h");
    const activeAssets = context.assetsAt(time);
    const rows = [];
    for (const dataset of context.datasets) {
      if (!activeAssets.has(dataset.asset)) continue;
      const current = candleAt(dataset, time);
      const eightHoursAgo = candleAt(dataset, time - 8 * 3600 * 1000);
      const funding = latestFundingBefore(dataset.fundingEvents, availableAt);
      if (!current || !eightHoursAgo || !funding || funding.time >= availableAt) continue;
      const return8h = priceReturn(current.close, eightHoursAgo.close);
      if (!Number.isFinite(return8h)) continue;
      rows.push({ dataset, current, funding, return8h });
    }
    const fundingValues = rows.map((row) => row.funding.rate)
      .filter(Number.isFinite)
      .sort((left, right) => left - right);
    for (const row of rows) {
      const percentile = percentileFromSorted(row.funding.rate, fundingValues);
      const side = percentile <= definition.fixedRules.longFundingPercentileAtMost
        && row.funding.rate < definition.fixedRules.longFundingRateLessThan
        && row.return8h < definition.fixedRules.longReturn8hLessThan
        ? "LONG"
        : percentile >= definition.fixedRules.shortFundingPercentileAtLeast
          && row.funding.rate > definition.fixedRules.shortFundingRateGreaterThan
          && row.return8h > definition.fixedRules.shortReturn8hGreaterThan
          ? "SHORT"
          : null;
      if (!side) continue;
      signals.push(makeM37Signal({
        familyId: definition.id,
        asset: row.dataset.asset,
        side,
        candle: row.current,
        details: {
          fundingRate: row.funding.rate,
          fundingEventTime: row.funding.time,
          fundingPercentile: percentile,
          return8h: row.return8h,
          historicalUniverseSize: activeAssets.size,
          marketRegime: row.funding.rate > 0 ? "positive_funding_crowding" : "negative_funding_crowding"
        }
      }));
    }
  }
  return signals.sort(signalOrder);
}

function makeM37Signal({ familyId, asset, side, candle, details }) {
  const openTime = Number(candle.openTime);
  const closeTime = openTime + intervalMilliseconds("1h");
  return {
    strategyId: familyId,
    familyId,
    asset,
    side,
    signalCandleOpenTime: openTime,
    signalCandleCloseTime: closeTime,
    signalAvailableAt: closeTime,
    entryEligibleAt: closeTime,
    referencePrice: Number(candle.close),
    close: Number(candle.close),
    recommendationScore: null,
    signalSelectionMode: "M3_7_FIXED_FAMILY_RULE",
    details
  };
}

function benchmarkReturn24hAsOf(candles, asOf) {
  const available = toTimestamp(asOf);
  let latestIndex = -1;
  for (let index = 0; index < candles.length; index++) {
    const closeTime = Number(candles[index].openTime) + 4 * 3600 * 1000;
    if (closeTime <= available) latestIndex = index;
    else break;
  }
  const previous = latestIndex >= 6 ? candles[latestIndex - 6] : null;
  const latest = latestIndex >= 0 ? candles[latestIndex] : null;
  return latest && previous ? priceReturn(latest.close, previous.close) : null;
}

function latestFundingBefore(events, availableAt) {
  let selected = null;
  for (const event of Array.isArray(events) ? events : []) {
    if (event.time < availableAt) selected = event;
    else break;
  }
  return selected;
}

function candleAt(dataset, time) {
  const index = dataset?.candleByTime?.get(Number(time));
  return index == null ? null : dataset.candles[index];
}

function candleShapeFeatures(candle) {
  const open = Number(candle?.open);
  const close = Number(candle?.close);
  const high = Number(candle?.high);
  const low = Number(candle?.low);
  const range = high - low;
  if (![open, close, high, low].every(Number.isFinite) || range <= 0) return null;
  return {
    lowerWickRatio: Math.max(0, Math.min(open, close) - low) / range,
    upperWickRatio: Math.max(0, high - Math.max(open, close)) / range,
    closeLocationValue: ((close - low) - (high - close)) / range
  };
}

function isContiguous(candles, index, period) {
  const interval = 3600 * 1000;
  for (let cursor = index; cursor > index - period; cursor--) {
    if (cursor <= 0 || Number(candles[cursor].openTime) - Number(candles[cursor - 1].openTime) !== interval) return false;
  }
  return true;
}

function summarizeGroups(trades, keyFn) {
  const groups = new Map();
  for (const trade of trades) {
    const key = String(keyFn(trade) || "UNKNOWN");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(trade);
  }
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right))
    .map(([key, rows]) => {
      const metrics = aggregateMetrics(rows);
      return {
        key,
        trades: rows.length,
        netExpectancyR: metrics.expectancyR,
        profitFactor: metrics.profitFactor,
        winRate: metrics.winRate,
        totalNetReturn: metrics.totalNetReturn,
        maxDrawdown: metrics.maxDrawdown
      };
    });
}

function fixedResearchFolds(trades, window) {
  const start = toTimestamp(window.start);
  const end = toTimestamp(window.endExclusive ?? window.end);
  const duration = Math.max(1, end - start);
  return Array.from({ length: 5 }, (_, index) => {
    const foldStart = start + Math.floor(duration * index / 5);
    const foldEnd = index === 4 ? end : start + Math.floor(duration * (index + 1) / 5);
    const rows = trades.filter((trade) => {
      const time = Number(trade.signalAvailableAt);
      return time >= foldStart && time < foldEnd;
    });
    const metrics = aggregateMetrics(rows);
    for (const trade of rows) trade.researchFold = `research-fold-${index + 1}`;
    return {
      foldId: `research-fold-${index + 1}`,
      start: new Date(foldStart).toISOString(),
      endExclusive: new Date(foldEnd).toISOString(),
      trades: rows.length,
      metrics: {
        netExpectancyR: metrics.expectancyR,
        profitFactor: metrics.profitFactor,
        winRate: metrics.winRate,
        totalNetReturn: metrics.totalNetReturn,
        maxDrawdown: metrics.maxDrawdown
      }
    };
  });
}

function maxTradeShare(trades, keyFn) {
  if (!trades.length) return 0;
  const counts = new Map();
  for (const trade of trades) {
    const key = String(keyFn(trade) || "UNKNOWN");
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return Math.max(...counts.values()) / trades.length;
}

function findEntryIndex(candles, startIndex, eligibleAt) {
  for (let index = startIndex; index < candles.length; index++) {
    if (Number(candles[index].openTime) >= Number(eligibleAt)) return index;
  }
  return null;
}

function recordM37MissedEntry({
  missedEntries,
  entryStats,
  status,
  reason,
  dataset,
  signal,
  tradeSpec = null
}) {
  if (status === NO_ENTRY) entryStats.noEntry++;
  if (status === MISSED_ENTRY) entryStats.missedEntry++;
  missedEntries.push({
    status,
    reason,
    strategyId: signal?.familyId || signal?.strategyId || null,
    asset: dataset?.asset || signal?.asset || null,
    signalCandleOpenTime: signal?.signalCandleOpenTime ?? null,
    signalAvailableAt: tradeSpec?.signalAvailableAt ?? signal?.signalAvailableAt ?? null,
    entryEligibleAt: tradeSpec?.entryEligibleAt ?? signal?.entryEligibleAt ?? null,
    referencePrice: tradeSpec?.referencePrice ?? signal?.referencePrice ?? null,
    stopLoss: tradeSpec?.stopLoss ?? null,
    takeProfit: tradeSpec?.takeProfit ?? null,
    maxHoldingTime: tradeSpec?.maxHoldingTime ?? null
  });
}

function signalOrder(left, right) {
  return Number(left.signalCandleOpenTime) - Number(right.signalCandleOpenTime)
    || String(left.asset).localeCompare(String(right.asset))
    || String(left.side).localeCompare(String(right.side));
}

function normalizeUniverseRows(value) {
  const rows = Array.isArray(value)
    ? value
    : Object.entries(value || {}).map(([time, assets]) => ({ time, assets }));
  return rows.map((row) => ({
    time: toTimestamp(row?.time ?? row?.start ?? row?.effectiveAt),
    assets: [...new Set((Array.isArray(row?.assets) ? row.assets : [])
      .map((asset) => String(asset).trim().toUpperCase())
      .filter(Boolean))]
  }))
    .filter((row) => Number.isFinite(row.time))
    .sort((left, right) => left.time - right.time);
}

function assetsAtNormalizedRows(rows, timestamp) {
  let left = 0;
  let right = rows.length - 1;
  let selected = null;
  while (left <= right) {
    const middle = Math.floor((left + right) / 2);
    if (rows[middle].time <= Number(timestamp)) {
      selected = rows[middle];
      left = middle + 1;
    } else {
      right = middle - 1;
    }
  }
  return new Set(selected?.assets || []);
}

function normalizeFundingEventsForM37(events) {
  return (Array.isArray(events) ? events : [])
    .map((event) => ({
      time: toTimestamp(event?.time ?? event?.fundingTime),
      rate: Number(event?.rate ?? event?.fundingRate)
    }))
    .filter((event) => Number.isFinite(event.time) && Number.isFinite(event.rate))
    .sort((left, right) => left.time - right.time);
}

function lowerBound(values, target) {
  let left = 0;
  let right = values.length;
  while (left < right) {
    const middle = Math.floor((left + right) / 2);
    if (values[middle] < target) left = middle + 1;
    else right = middle;
  }
  return left;
}

function upperBound(values, target) {
  let left = 0;
  let right = values.length;
  while (left < right) {
    const middle = Math.floor((left + right) / 2);
    if (values[middle] <= target) left = middle + 1;
    else right = middle;
  }
  return left;
}

function priceReturn(current, previous) {
  const now = Number(current);
  const before = Number(previous);
  return Number.isFinite(now) && Number.isFinite(before) && before !== 0 ? now / before - 1 : null;
}

function ratio(numerator, denominator) {
  const left = Number(numerator);
  const right = Number(denominator);
  return Number.isFinite(left) && Number.isFinite(right) && right !== 0 ? left / right : null;
}

function average(values) {
  const finite = values.map(Number).filter(Number.isFinite);
  return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : null;
}

function toTimestamp(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value instanceof Date) return value.getTime();
  if (value == null || value === "") return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function finiteMetric(value) {
  return value !== null
    && value !== undefined
    && value !== ""
    && Number.isFinite(Number(value));
}
