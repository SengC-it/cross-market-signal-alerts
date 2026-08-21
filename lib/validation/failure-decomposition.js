import { aggregateMetrics } from "../backtest/metrics.js";
import { isPrimaryOosTrade } from "./validation-metrics.js";

export const FAILURE_DECOMPOSITION_VERSION = "V4-M3.5";
export const MIN_SCORE_CALIBRATION_TRADES = 10;

export const DIAGNOSTIC_RULES = Object.freeze({
  percentageScale: "0-100",
  scoreBuckets: ["85", "86", "87", "88", "89+"],
  scoreBucketRule: "floor(score); values below 85 are labelled <85",
  momentum24hBuckets: ["<=-11%", "(-11%,-8%]", "(-8%,0%]", "(0%,8%]", "(8%,10%]", ">10%"],
  relativeBuckets: ["<=-10%", "(-10%,-5%]", "(-5%,0%]", "(0%,5%]", "(5%,10%]", ">10%"],
  volumeMultipleBuckets: ["<=1", "(1,2]", "(2,3]", "(3,4]", ">4"],
  holdingHourBuckets: ["<2h", "2-4h", "4-8h", ">8h"],
  btcTrend: "up if 24h momentum > 2%, down if < -2%, otherwise flat",
  btcVolatility: "low if 24h high-low range <= 2%, medium if <= 5%, otherwise high",
  altBreadth: "positive if positive-return share > 55%, negative if < 45%, otherwise neutral",
  calibrationMinimumTrades: MIN_SCORE_CALIBRATION_TRADES,
  holdoutIncludedInAttribution: false
});

export const PRE_REGISTERED_HYPOTHESES = Object.freeze([
  "H1: Weak breakdowns after an extreme 24h decline may enter during mean reversion rather than continuation.",
  "H2: A weak-strategy volume spike may represent capitulation more often than continuation pressure.",
  "H3: The strong gate may be too selective to support a reliable one-year conclusion, even if its observed edge is not clearly negative."
]);

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
const FIXED_MOMENTUM_BINS = Object.freeze([
  { label: "<=-11%", test: (value) => value <= -0.11 },
  { label: "(-11%,-8%]", test: (value) => value <= -0.08 },
  { label: "(-8%,0%]", test: (value) => value <= 0 },
  { label: "(0%,8%]", test: (value) => value <= 0.08 },
  { label: "(8%,10%]", test: (value) => value <= 0.10 },
  { label: ">10%", test: () => true }
]);
const FIXED_RELATIVE_BINS = Object.freeze([
  { label: "<=-10%", test: (value) => value <= -0.10 },
  { label: "(-10%,-5%]", test: (value) => value <= -0.05 },
  { label: "(-5%,0%]", test: (value) => value <= 0 },
  { label: "(0%,5%]", test: (value) => value <= 0.05 },
  { label: "(5%,10%]", test: (value) => value <= 0.10 },
  { label: ">10%", test: () => true }
]);
const FIXED_VOLUME_BINS = Object.freeze([
  { label: "<=1", test: (value) => value <= 1 },
  { label: "(1,2]", test: (value) => value <= 2 },
  { label: "(2,3]", test: (value) => value <= 3 },
  { label: "(3,4]", test: (value) => value <= 4 },
  { label: ">4", test: () => true }
]);

export function buildFailureDecompositionReport({
  frozenBaseSha,
  manifestSha256,
  window,
  strategyAnalyses = [],
  source = {}
} = {}) {
  const byId = Object.fromEntries(strategyAnalyses.map((analysis) => [analysis.strategyId, analysis]));
  const strong = byId.dynamic_relative_strength_breakout || emptyStrategyAnalysis("dynamic_relative_strength_breakout");
  const weak = byId.dynamic_relative_weakness_breakdown || emptyStrategyAnalysis("dynamic_relative_weakness_breakdown");
  return {
    version: FAILURE_DECOMPOSITION_VERSION,
    frozenBaseSha,
    manifestSha256,
    frozenWindow: window,
    strategyParametersChanged: false,
    parameterSearchPerformed: false,
    holdoutUsedForOptimization: false,
    M2BExecutionChanged: false,
    source: {
      ...source,
      tradeResults: "existing frozen M3 validation TradeResult rows only",
      holdoutIncludedInAttribution: false
    },
    diagnosticRules: DIAGNOSTIC_RULES,
    strong,
    weak,
    attrition: {
      strong: strong.attrition,
      weak: weak.attrition
    },
    costDecomposition: {
      strong: strong.costDecomposition,
      weak: weak.costDecomposition
    },
    exitDecomposition: {
      strong: strong.exitDecomposition,
      weak: weak.exitDecomposition
    },
    mfeMae: {
      strong: strong.mfeMae,
      weak: weak.mfeMae
    },
    scoreCalibration: {
      strong: strong.scoreCalibration,
      weak: weak.scoreCalibration
    },
    assetBreakdown: {
      strong: strong.breakdowns.byAsset,
      weak: weak.breakdowns.byAsset
    },
    foldBreakdown: {
      strong: strong.breakdowns.byFold,
      weak: weak.breakdowns.byFold
    },
    regimeBreakdown: {
      strong: strong.regimeBreakdown,
      weak: weak.regimeBreakdown
    },
    preRegisteredHypotheses: [...PRE_REGISTERED_HYPOTHESES],
    recommendedStatus: {
      strong: strong.recommendedStatus,
      weak: weak.recommendedStatus
    }
  };
}

export function decomposeFrozenValidation({
  strategyId,
  validationResult,
  replaySignals = [],
  pipelineDiagnostics = null,
  datasets = [],
  benchmarkCandles = []
} = {}) {
  const validation = validationResult || {};
  const allTrades = Array.isArray(validation.tradeResults) ? validation.tradeResults : [];
  const completeTrades = allTrades.filter(isPrimaryOosTrade);
  const degradedTrades = allTrades.filter((trade) => !isPrimaryOosTrade(trade));
  const signals = Array.isArray(replaySignals) ? replaySignals : [];
  const signalMap = new Map(signals.map((signal) => [signalKey(signal), signal]));
  const regimeContext = buildRegimeContext({ signals, datasets, benchmarkCandles });
  const enrichedTrades = completeTrades.map((trade) => enrichTrade({
    trade,
    strategyId,
    signal: signalMap.get(signalKey(trade)),
    regime: regimeContext.get(signalKey(trade))
  }));
  const attrition = buildAttritionFunnel({
    validation,
    signals,
    pipelineDiagnostics
  });
  const costDecomposition = buildCostDecomposition(enrichedTrades);
  const exitDecomposition = buildExitDecomposition(enrichedTrades);
  const breakdowns = buildBreakdowns(enrichedTrades);
  const lossDrivers = buildLossDrivers({ breakdowns, exitDecomposition });
  const scoreCalibration = buildScoreCalibration({ enrichedTrades, signals });
  const mfeMae = buildMfeMaeSummary(enrichedTrades);
  const recommendedStatus = recommendStrategyStatus({
    strategyId,
    completeTrades: enrichedTrades.length,
    costDecomposition,
    validation
  });

  return {
    strategyId,
    replaySignals: signals.length,
    primaryEligible: signals.filter((signal) => signal.primaryEligible === true).length,
    completeTrades: enrichedTrades.length,
    degradedTrades: degradedTrades.length,
    noEntry: countMissedEntries(validation.missedEntries, "NO_ENTRY", validation.aggregate?.noEntries),
    missedEntry: countMissedEntries(validation.missedEntries, "MISSED_ENTRY", validation.aggregate?.missedEntries),
    purged: numberOr(validation.aggregate?.purgedBoundarySignals, 0),
    holdout: buildHoldoutSummary(validation.holdoutMetrics),
    attrition,
    costDecomposition,
    exitDecomposition,
    mfeMae,
    scoreCalibration,
    breakdowns,
    regimeBreakdown: breakdowns.byRegime,
    lossDrivers,
    recommendedStatus,
    tradeDetails: enrichedTrades.map(formatTradeDetail),
    quality: {
      unmatchedTradeSignals: enrichedTrades.filter((trade) => !trade.signal).length,
      degradedReasons: sortedCounts(degradedTrades.map((trade) => degradedReason(trade)))
    }
  };
}

function buildAttritionFunnel({ validation, signals, pipelineDiagnostics }) {
  const aggregate = validation.aggregate || {};
  const missedEntries = Array.isArray(validation.missedEntries) ? validation.missedEntries : [];
  const rawOosSignals = numberOr(aggregate.rawSignals, signals.length);
  const holdoutMetrics = validation.holdoutMetrics || {};
  const holdoutRawSignals = numberOr(holdoutMetrics.rawSignals, Math.max(0, signals.length - rawOosSignals));
  const holdoutTrades = Array.isArray(validation.holdoutTradeResults) ? validation.holdoutTradeResults : [];
  const purged = numberOr(aggregate.purgedBoundarySignals, 0);
  const eligibleOosSignals = numberOr(aggregate.eligibleOosSignals, Math.max(0, rawOosSignals - purged));
  const plannedEntries = numberOr(aggregate.eligibleOosPlannedEntries, 0);
  const acceptedEntries = Array.isArray(validation.tradeResults) ? validation.tradeResults.length : 0;
  const completeTrades = validation.tradeResults?.filter(isPrimaryOosTrade).length || 0;
  const degradedTrades = Math.max(0, acceptedEntries - completeTrades);
  const noEntry = countMissedEntries(missedEntries, "NO_ENTRY", aggregate.noEntries);
  const missedEntry = countMissedEntries(missedEntries, "MISSED_ENTRY", aggregate.missedEntries);
  const primaryEligible = signals.filter((signal) => signal.primaryEligible === true).length;
  const pipeline = pipelineDiagnostics || {};
  const poolCandidates = numberOr(pipeline.poolCandidates, null);
  const poolSelected = numberOr(pipeline.poolSelected, null);
  const strategyEvaluated = numberOr(pipeline.strategyEvaluated, null);
  const scoreGatePassed = numberOr(pipeline.scoreGatePassed, signals.length);
  const entryFailureReasons = sortedCounts(missedEntries.map((entry) => entry?.reason || "other"));
  const qualityReasons = sortedCounts(
    signals
      .filter((signal) => signal.primaryEligible !== true)
      .flatMap((signal) => signal.quality?.exclusionReasons || ["incomplete_quality"])
  );
  const stages = [
    stage("pool_candidates", poolCandidates, numberOr(pipeline.visibleTickerObservations, null), "visible_ticker_observations", pipeline.poolCandidateRejections),
    stage("pool_rank_selected", poolSelected, poolCandidates, "pool_candidates", pipeline.poolRankRejections),
    stage("strategy_evaluated", strategyEvaluated, poolSelected, "pool_rank_selected", pipeline.cooldownReasons),
    stage("score_gate_passed", scoreGatePassed, strategyEvaluated, "strategy_evaluated", pipeline.strategyGateRejections),
    stage("replay_signals", signals.length, scoreGatePassed, "score_gate_passed", {}),
    stage("primary_eligible", primaryEligible, signals.length, "replay_signals", qualityReasons),
    stage("development_oos_selected", rawOosSignals, signals.length, "replay_signals", {
      holdout_not_attributed: holdoutRawSignals
    }),
    stage("raw_oos_signals", rawOosSignals, null, null, {}),
    stage("purged_boundary", purged, rawOosSignals, "raw_oos_signals", { purged_boundary: purged }),
    stage("eligible_oos_signals", eligibleOosSignals, rawOosSignals, "raw_oos_signals", {}),
    stage("trade_plan_created", plannedEntries, eligibleOosSignals, "eligible_oos_signals", entryFailureReasons),
    stage("entry_accepted", acceptedEntries, plannedEntries, "trade_plan_created", entryFailureReasons),
    stage("complete_trades", completeTrades, acceptedEntries, "entry_accepted", { degraded: degradedTrades }),
    stage("degraded_trades", degradedTrades, acceptedEntries, "entry_accepted", qualityReasonCounts(validation.tradeResults)),
    stage("NO_ENTRY", noEntry, eligibleOosSignals, "eligible_oos_signals", countReasonSubset(missedEntries, "NO_ENTRY")),
    stage("MISSED_ENTRY", missedEntry, eligibleOosSignals, "eligible_oos_signals", countReasonSubset(missedEntries, "MISSED_ENTRY"))
  ];
  return {
    stages,
    counts: {
      poolCandidates,
      strategyEvaluated,
      scoreGatePassed,
      replaySignals: signals.length,
      primaryEligible,
      tradePlanCreated: plannedEntries,
      entryAccepted: acceptedEntries,
      completeTrades,
      degradedTrades,
      noEntry,
      missedEntry,
      purged,
      holdoutRawSignals,
      holdoutTrades: holdoutTrades.length,
      holdoutCompleteTrades: holdoutTrades.filter(isPrimaryOosTrade).length,
      holdoutDegradedTrades: holdoutTrades.filter((trade) => !isPrimaryOosTrade(trade)).length
    },
    exclusionReasons: {
      poolCandidates: sortedCounts(pipeline.poolCandidateRejections),
      poolRank: sortedCounts(pipeline.poolRankRejections),
      strategyGate: sortedCounts(pipeline.strategyGateRejections),
      signalQuality: qualityReasons,
      entry: entryFailureReasons
    },
    holdoutExcludedFromAttribution: {
      rawSignals: holdoutRawSignals,
      tradeResults: holdoutTrades.length,
      completeTrades: holdoutTrades.filter(isPrimaryOosTrade).length,
      degradedTrades: holdoutTrades.filter((trade) => !isPrimaryOosTrade(trade)).length,
      usedForOptimization: false,
      includedInMetrics: false
    }
  };
}

function stage(name, count, denominator, denominatorStage, reasons = {}) {
  const normalizedCount = count == null ? null : numberOr(count, 0);
  const normalizedDenominator = denominator == null ? null : numberOr(denominator, 0);
  return {
    stage: name,
    count: normalizedCount,
    denominator: normalizedDenominator,
    denominatorStage,
    percentage: normalizedCount != null && normalizedDenominator > 0
      ? (normalizedCount / normalizedDenominator) * 100
      : null,
    exclusionReasons: sortedCounts(reasons)
  };
}

function buildCostDecomposition(trades) {
  const rows = (Array.isArray(trades) ? trades : []).filter((trade) => (
    Number.isFinite(Number(trade.grossReturnPct))
    && Number.isFinite(Number(trade.netReturnPct))
  ));
  const grossReturnPctTotal = sum(rows, "grossReturnPct");
  const netReturnPctTotal = sum(rows, "netReturnPct");
  const feeDragPct = sum(rows, "totalFeePct");
  const spreadDragPct = sum(rows, "spreadCostPct");
  const slippageDragPct = sum(rows, "slippageCostPct");
  const fundingPctTotal = sum(rows, "fundingPct");
  const fundingDragPct = -fundingPctTotal;
  const grossR = rows.map((trade) => safeRatio(trade.grossReturnPct, trade.initialRiskPct)).filter(Number.isFinite);
  const netR = rows.map((trade) => Number(trade.realizedR)).filter(Number.isFinite);
  const grossExpectancyR = average(grossR);
  const netExpectancyR = average(netR);
  const reconciliationErrorPct = grossReturnPctTotal
    - feeDragPct
    - spreadDragPct
    - slippageDragPct
    + fundingPctTotal
    - netReturnPctTotal;
  const grossDirectionalPnl = {
    sumReturnPct: grossReturnPctTotal,
    averageReturnPct: average(rows.map((trade) => Number(trade.grossReturnPct))),
    sumR: sum(grossR),
    averageR: grossExpectancyR
  };
  const netPnl = {
    sumReturnPct: netReturnPctTotal,
    averageReturnPct: average(rows.map((trade) => Number(trade.netReturnPct))),
    sumR: sum(netR),
    averageR: netExpectancyR,
    compoundedReturnPct: aggregateMetrics(rows).totalNetReturn,
    profitFactor: aggregateMetrics(rows).profitFactor
  };
  return {
    trades: rows.length,
    grossDirectionalPnl,
    grossExpectancyR,
    feeDragPct,
    feeDrag: feeDragPct,
    spreadDragPct,
    spreadDrag: spreadDragPct,
    slippageDragPct,
    slippageDrag: slippageDragPct,
    fundingPctTotal,
    fundingDragPct,
    fundingDrag: fundingDragPct,
    netPnl,
    netExpectancyR,
    costImpactR: Number.isFinite(grossExpectancyR) && Number.isFinite(netExpectancyR)
      ? grossExpectancyR - netExpectancyR
      : null,
    reconciliationErrorPct,
    reconciles: Math.abs(reconciliationErrorPct) < 1e-10,
    rawEdgeClassification: classifyRawEdge(grossExpectancyR, netExpectancyR)
  };
}

function classifyRawEdge(grossExpectancyR, netExpectancyR) {
  if (!Number.isFinite(grossExpectancyR) || !Number.isFinite(netExpectancyR)) return "INSUFFICIENT_DATA";
  if (grossExpectancyR <= 0) return "RAW_SIGNAL_NEGATIVE";
  if (netExpectancyR <= 0) return "COST_ERODED_EDGE";
  return "RAW_SIGNAL_POSITIVE_AFTER_COST";
}

function buildExitDecomposition(trades) {
  const keys = ["take_profit", "stop_loss", "time_stop", "end_of_data", "other"];
  return keys.map((key) => {
    const group = trades.filter((trade) => normalizeExitReason(trade.exitReason) === key);
    return { exitReason: key, ...groupSummary(group), averageHoldingHours: average(group.map((trade) => Number(trade.holdingHours))) };
  });
}

function buildMfeMaeSummary(trades) {
  const total = trades.length;
  const threshold = (field, limit, direction) => {
    const count = trades.filter((trade) => {
      const value = Number(trade[field]);
      return Number.isFinite(value) && (direction === "atLeast" ? value >= limit : value <= limit);
    }).length;
    return { count, percentage: total ? (count / total) * 100 : null };
  };
  return {
    trades: total,
    averageMfeR: average(trades.map((trade) => Number(trade.mfeR))),
    averageMaeR: average(trades.map((trade) => Number(trade.maeR))),
    mfeAtLeast: {
      "0.5R": threshold("mfeR", 0.5, "atLeast"),
      "1R": threshold("mfeR", 1, "atLeast"),
      "1.5R": threshold("mfeR", 1.5, "atLeast")
    },
    maeAtMost: {
      "-0.5R": threshold("maeR", -0.5, "atMost"),
      "-1R": threshold("maeR", -1, "atMost")
    }
  };
}

function buildBreakdowns(trades) {
  return {
    byAsset: summarizeDimension(trades, (trade) => trade.asset || "UNKNOWN"),
    byFold: summarizeDimension(trades, (trade) => trade.foldId || "UNKNOWN"),
    byMonth: summarizeDimension(trades, (trade) => trade.month || "UNKNOWN"),
    byScore: summarizeDimension(trades, (trade) => trade.scoreBucket),
    byPoolRank: summarizeDimension(trades, (trade) => trade.poolRankBucket),
    byMomentum24h: summarizeDimension(trades, (trade) => trade.momentumBucket),
    byRelativeMetric: summarizeDimension(trades, (trade) => trade.relativeBucket),
    byVolumeMultiple: summarizeDimension(trades, (trade) => trade.volumeBucket),
    byBtcBenchmarkRegime: summarizeDimension(trades, (trade) => trade.btcTrend),
    byVolatilityRegime: summarizeDimension(trades, (trade) => trade.btcVolatility),
    byFundingSign: summarizeDimension(trades, (trade) => trade.fundingSign),
    byExitReason: summarizeDimension(trades, (trade) => normalizeExitReason(trade.exitReason)),
    byHoldingHours: summarizeDimension(trades, (trade) => trade.holdingBucket),
    byRegime: summarizeDimension(trades, (trade) => trade.regimeKey)
  };
}

function buildLossDrivers({ breakdowns, exitDecomposition }) {
  const dimensions = [
    ["exitReason", exitDecomposition],
    ["asset", breakdowns.byAsset],
    ["fold", breakdowns.byFold],
    ["month", breakdowns.byMonth],
    ["score", breakdowns.byScore],
    ["poolRank", breakdowns.byPoolRank],
    ["relativeMetric", breakdowns.byRelativeMetric],
    ["volumeMultiple", breakdowns.byVolumeMultiple],
    ["btcBenchmarkRegime", breakdowns.byBtcBenchmarkRegime],
    ["volatilityRegime", breakdowns.byVolatilityRegime],
    ["fundingSign", breakdowns.byFundingSign],
    ["holdingHours", breakdowns.byHoldingHours],
    ["regime", breakdowns.byRegime]
  ];
  const slices = dimensions.flatMap(([dimension, groups]) => (Array.isArray(groups) ? groups : [])
    .filter((group) => Number(group.totalNetReturn) < 0)
    .map((group) => ({
      dimension,
      key: group.key,
      trades: group.trades,
      totalNetReturn: group.totalNetReturn,
      expectancyR: group.expectancyR,
      PF: group.PF
    })));
  return {
    interpretation: "Overlapping diagnostic slices ranked by totalNetReturn; they are not independent causal effects.",
    top3: slices.sort((left, right) => (
      Number(left.totalNetReturn) - Number(right.totalNetReturn)
      || left.dimension.localeCompare(right.dimension)
      || left.key.localeCompare(right.key)
    )).slice(0, 3)
  };
}

function summarizeDimension(trades, keyFn) {
  const groups = new Map();
  for (const trade of trades) {
    const key = String(keyFn(trade) || "UNKNOWN");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(trade);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, group]) => ({ key, ...groupSummary(group) }));
}

function groupSummary(trades) {
  const metrics = aggregateMetrics(trades);
  return {
    trades: trades.length,
    winRate: metrics.winRate,
    expectancyR: metrics.expectancyR,
    PF: metrics.profitFactor,
    avgNetReturn: metrics.averageNetReturn,
    totalNetReturn: metrics.totalNetReturn,
    MFE_R: average(trades.map((trade) => Number(trade.mfeR))),
    MAE_R: average(trades.map((trade) => Number(trade.maeR)))
  };
}

function buildScoreCalibration({ enrichedTrades, signals }) {
  const completeByBucket = new Map();
  for (const trade of enrichedTrades) {
    const key = trade.scoreBucket || "unknown";
    if (!completeByBucket.has(key)) completeByBucket.set(key, []);
    completeByBucket.get(key).push(trade);
  }
  const signalCounts = countBy(signals.map((signal) => scoreBucket(signal.recommendationScore)));
  const labels = ["85", "86", "87", "88", "89+"];
  const extraLabels = [...new Set([...signalCounts.keys(), ...completeByBucket.keys()])]
    .filter((label) => !labels.includes(label))
    .sort();
  const buckets = [...labels, ...extraLabels].map((key) => ({
    bucket: key,
    signals: Number(signalCounts.get(key)) || 0,
    completeTrades: (completeByBucket.get(key) || []).length,
    ...groupSummary(completeByBucket.get(key) || [])
  }));
  const rows = enrichedTrades
    .filter((trade) => Number.isFinite(Number(trade.score)) && Number.isFinite(Number(trade.netReturnPct)))
    .map((trade) => ({ score: Number(trade.score), netReturn: Number(trade.netReturnPct) }));
  const distinctBuckets = new Set(rows.map((row) => scoreBucket(row.score))).size;
  const status = rows.length < MIN_SCORE_CALIBRATION_TRADES || distinctBuckets < 2
    ? "INSUFFICIENT_FOR_CALIBRATION"
    : "AVAILABLE";
  return {
    buckets,
    spearmanCorrelation: spearmanCorrelation(rows.map((row) => row.score), rows.map((row) => row.netReturn)),
    sampleSize: rows.length,
    distinctBuckets,
    status
  };
}

function buildHoldoutSummary(metrics = {}) {
  return {
    completeTrades: numberOr(metrics.completeTrades, 0),
    winRate: metrics.winRate ?? null,
    expectancyR: metrics.expectancyR ?? null,
    profitFactor: metrics.profitFactor ?? null,
    totalNetReturn: metrics.totalNetReturn ?? null,
    usedForOptimization: false,
    includedInAttribution: false
  };
}

function recommendStrategyStatus({ strategyId, completeTrades, costDecomposition, validation }) {
  const aggregate = validation.aggregate || {};
  const negativeFolds = numberOr(aggregate.negativeFolds, 0);
  const totalFolds = Array.isArray(validation.folds) ? validation.folds.length : 0;
  const grossExpectancyR = Number(costDecomposition.grossExpectancyR);
  if (strategyId === "dynamic_relative_weakness_breakdown"
    && Number.isFinite(grossExpectancyR)
    && grossExpectancyR <= 0
    && totalFolds > 0
    && negativeFolds > totalFolds / 2) {
    return {
      status: "REDESIGN_CANDIDATE",
      reason: "Gross expectancy is non-positive and a majority of frozen development folds are negative; this is a diagnostic status, not a parameter recommendation."
    };
  }
  if (strategyId === "dynamic_relative_strength_breakout"
    && completeTrades < 60
    && Number.isFinite(grossExpectancyR)
    && grossExpectancyR >= 0
    && !(totalFolds > 0 && negativeFolds > totalFolds / 2)) {
    return {
      status: "KEEP_FOR_MORE_DATA",
      reason: "The frozen sample is too small for a strong conclusion and does not show a clearly negative raw edge."
    };
  }
  return {
    status: "NO_CONCLUSION",
    reason: "The frozen diagnostic rules do not support a stronger status."
  };
}

function buildRegimeContext({ signals, datasets, benchmarkCandles }) {
  const signalTimes = new Set(signals
    .map((signal) => Number(signal.signalCandleOpenTime))
    .filter(Number.isFinite));
  const requiredTimes = new Set();
  for (const time of signalTimes) {
    requiredTimes.add(time);
    requiredTimes.add(time - DAY_MS);
  }
  const closesByTime = new Map();
  for (const dataset of Array.isArray(datasets) ? datasets : []) {
    for (const candle of Array.isArray(dataset?.candles) ? dataset.candles : []) {
      const openTime = Number(candle?.openTime);
      if (!requiredTimes.has(openTime)) continue;
      if (!closesByTime.has(openTime)) closesByTime.set(openTime, []);
      const close = Number(candle?.close);
      if (Number.isFinite(close)) closesByTime.get(openTime).push(close);
    }
  }
  const result = new Map();
  for (const signal of signals) {
    const openTime = Number(signal.signalCandleOpenTime);
    const current = closesByTime.get(openTime) || [];
    const previous = closesByTime.get(openTime - DAY_MS) || [];
    const returns = current
      .map((close, index) => Number.isFinite(previous[index]) && previous[index] !== 0
        ? close / previous[index] - 1
        : null)
      .filter(Number.isFinite);
    const positiveShare = returns.length
      ? returns.filter((value) => value > 0).length / returns.length
      : null;
    const benchmark = benchmarkRegime({
      benchmarkCandles,
      asOf: Number(signal.signalAvailableAt),
      fallbackMomentum: Number(signal.details?.benchmarkMomentum24h)
    });
    const altBreadth = positiveShare == null
      ? "unknown"
      : positiveShare > 0.55 ? "positive" : positiveShare < 0.45 ? "negative" : "neutral";
    const regimeKey = `${benchmark.trend}|${benchmark.volatility}|${altBreadth}`;
    result.set(signalKey(signal), {
      btcTrend: benchmark.trend,
      btcVolatility: benchmark.volatility,
      altMarketBreadth: altBreadth,
      regimeKey
    });
  }
  return result;
}

function benchmarkRegime({ benchmarkCandles, asOf, fallbackMomentum }) {
  const rows = (Array.isArray(benchmarkCandles) ? benchmarkCandles : [])
    .filter((candle) => Number.isFinite(Number(candle?.openTime)))
    .sort((left, right) => Number(left.openTime) - Number(right.openTime));
  const visible = rows.filter((candle) => Number(candle.openTime) + 4 * HOUR_MS <= asOf);
  const latest = visible.at(-1);
  const previous = visible.at(-7);
  const momentum = Number.isFinite(fallbackMomentum)
    ? fallbackMomentum
    : latest && previous && Number(previous.close) !== 0
      ? Number(latest.close) / Number(previous.close) - 1
      : null;
  const trend = !Number.isFinite(momentum)
    ? "unknown"
    : momentum > 0.02 ? "up" : momentum < -0.02 ? "down" : "flat";
  const window = visible.slice(-7);
  const highs = window.map((candle) => Number(candle.high)).filter(Number.isFinite);
  const lows = window.map((candle) => Number(candle.low)).filter(Number.isFinite);
  const closes = window.map((candle) => Number(candle.close)).filter(Number.isFinite);
  const averageClose = average(closes);
  const range = highs.length && lows.length && averageClose > 0
    ? (Math.max(...highs) - Math.min(...lows)) / averageClose
    : null;
  const volatility = !Number.isFinite(range)
    ? "unknown"
    : range <= 0.02 ? "low" : range <= 0.05 ? "medium" : "high";
  return { trend, volatility };
}

function enrichTrade({ trade, strategyId, signal, regime = {} }) {
  const details = signal?.details || {};
  const score = Number(signal?.recommendationScore);
  const momentum = Number(details.momentum24h);
  const relative = strategyId === "dynamic_relative_weakness_breakdown"
    ? Number(details.relativeWeakness)
    : Number(details.relativeStrength);
  return {
    ...trade,
    signal,
    score: Number.isFinite(score) ? score : null,
    scoreBucket: scoreBucket(score),
    poolRankBucket: Number.isFinite(Number(details.poolRank)) ? `rank_${Number(details.poolRank)}` : "unknown",
    momentum24h: Number.isFinite(momentum) ? momentum : null,
    momentumBucket: fixedBin(momentum, FIXED_MOMENTUM_BINS),
    relativeMetric: Number.isFinite(relative) ? relative : null,
    relativeBucket: fixedBin(relative, FIXED_RELATIVE_BINS),
    volumeMultiple: Number.isFinite(Number(details.volumeMultiple)) ? Number(details.volumeMultiple) : null,
    volumeBucket: fixedBin(Number(details.volumeMultiple), FIXED_VOLUME_BINS),
    month: monthKey(trade.signalAvailableAt),
    fundingSign: fundingSign(trade.fundingPct),
    holdingBucket: holdingBucket(trade.holdingHours),
    btcTrend: regime.btcTrend || "unknown",
    btcVolatility: regime.btcVolatility || "unknown",
    altMarketBreadth: regime.altMarketBreadth || "unknown",
    regimeKey: regime.regimeKey || "unknown|unknown|unknown"
  };
}

function formatTradeDetail(trade) {
  return {
    asset: trade.asset,
    foldId: trade.foldId || null,
    signalCandleOpenTime: trade.signalCandleOpenTime,
    signalAvailableAt: trade.signalAvailableAt,
    score: trade.score,
    poolRank: trade.signal?.details?.poolRank ?? null,
    momentum24h: trade.momentum24h,
    relativeMetric: trade.relativeMetric,
    volumeMultiple: trade.volumeMultiple,
    entry: trade.entryFillPrice,
    exit: trade.exitFillPrice,
    exitReason: trade.exitReason,
    netR: trade.realizedR,
    MFE_R: trade.mfeR,
    MAE_R: trade.maeR,
    holdingHours: trade.holdingHours,
    grossReturnPct: trade.grossReturnPct,
    netReturnPct: trade.netReturnPct,
    feeDragPct: trade.totalFeePct,
    spreadDragPct: trade.spreadCostPct,
    slippageDragPct: trade.slippageCostPct,
    fundingPct: trade.fundingPct
  };
}

function signalKey(value = {}) {
  return [value.asset, value.strategyId, Number(value.signalCandleOpenTime)].join(":");
}

function scoreBucket(value) {
  const score = Number(value);
  if (!Number.isFinite(score)) return "unknown";
  const floor = Math.floor(score);
  if (floor < 85) return "<85";
  if (floor >= 89) return "89+";
  return String(floor);
}

function fixedBin(value, bins) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return "unknown";
  return bins.find((bin) => bin.test(parsed))?.label || "unknown";
}

function fundingSign(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed === 0) return "zero";
  return parsed > 0 ? "positive" : "negative";
}

function holdingBucket(value) {
  const hours = Number(value);
  if (!Number.isFinite(hours)) return "unknown";
  if (hours < 2) return "<2h";
  if (hours <= 4) return "2-4h";
  if (hours <= 8) return "4-8h";
  return ">8h";
}

function normalizeExitReason(value) {
  return ["take_profit", "stop_loss", "time_stop", "end_of_data"].includes(value) ? value : "other";
}

function monthKey(value) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp)) return "unknown";
  return new Date(timestamp).toISOString().slice(0, 7);
}

function qualityReasonCounts(trades = []) {
  return sortedCounts((Array.isArray(trades) ? trades : [])
    .filter((trade) => !isPrimaryOosTrade(trade))
    .map((trade) => degradedReason(trade)));
}

function degradedReason(trade) {
  if (trade?.ambiguousIntrabar === true) return "ambiguous_intrabar";
  return trade?.dataQuality || trade?.dataQualityComponents?.intrabar || "degraded";
}

function countReasonSubset(entries = [], status) {
  return sortedCounts((Array.isArray(entries) ? entries : [])
    .filter((entry) => entry?.status === status)
    .map((entry) => entry?.reason || "other"));
}

function countMissedEntries(entries, status, fallback) {
  if (Array.isArray(entries)) return entries.filter((entry) => entry?.status === status).length;
  return numberOr(fallback, 0);
}

function countBy(values = []) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  return counts;
}

function sortedCounts(value) {
  let source;
  if (value instanceof Map) source = Object.fromEntries(value);
  else if (Array.isArray(value)) {
    source = {};
    for (const item of value) {
      const key = String(item || "other");
      source[key] = (Number(source[key]) || 0) + 1;
    }
  } else source = value || {};
  return Object.fromEntries(Object.entries(source)
    .map(([key, count]) => [key, Number(count) || 0])
    .sort((left, right) => (right[1] - left[1]) || left[0].localeCompare(right[0])));
}

function sum(rows, fieldOrRows) {
  const values = Array.isArray(fieldOrRows)
    ? fieldOrRows
    : fieldOrRows == null
      ? (Array.isArray(rows) ? rows : []).map(Number)
      : (Array.isArray(rows) ? rows : []).map((row) => Number(row?.[fieldOrRows]));
  return values.filter(Number.isFinite).reduce((total, value) => total + value, 0);
}

function average(values = []) {
  const finite = values.map(Number).filter(Number.isFinite);
  return finite.length ? finite.reduce((total, value) => total + value, 0) / finite.length : null;
}

function safeRatio(numerator, denominator) {
  const left = Number(numerator);
  const right = Number(denominator);
  return Number.isFinite(left) && Number.isFinite(right) && right !== 0 ? left / right : null;
}

function numberOr(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function spearmanCorrelation(left, right) {
  if (left.length !== right.length || left.length < 2) return null;
  const leftRanks = rankValues(left);
  const rightRanks = rankValues(right);
  return pearsonCorrelation(leftRanks, rightRanks);
}

function rankValues(values) {
  const indexed = values.map((value, index) => ({ value, index }))
    .sort((left, right) => left.value - right.value);
  const ranks = Array(values.length);
  let index = 0;
  while (index < indexed.length) {
    let end = index + 1;
    while (end < indexed.length && indexed[end].value === indexed[index].value) end++;
    const rank = (index + 1 + end) / 2;
    for (let cursor = index; cursor < end; cursor++) ranks[indexed[cursor].index] = rank;
    index = end;
  }
  return ranks;
}

function pearsonCorrelation(left, right) {
  const leftMean = average(left);
  const rightMean = average(right);
  const numerator = left.reduce((total, value, index) => total + (value - leftMean) * (right[index] - rightMean), 0);
  const leftVariance = left.reduce((total, value) => total + (value - leftMean) ** 2, 0);
  const rightVariance = right.reduce((total, value) => total + (value - rightMean) ** 2, 0);
  const denominator = Math.sqrt(leftVariance * rightVariance);
  return denominator > 0 ? numerator / denominator : null;
}

function emptyStrategyAnalysis(strategyId) {
  return {
    strategyId,
    replaySignals: 0,
    primaryEligible: 0,
    completeTrades: 0,
    degradedTrades: 0,
    noEntry: 0,
    missedEntry: 0,
    purged: 0,
    attrition: { stages: [], counts: {} },
    costDecomposition: buildCostDecomposition([]),
    exitDecomposition: [],
    mfeMae: buildMfeMaeSummary([]),
    scoreCalibration: { buckets: [], spearmanCorrelation: null, sampleSize: 0, distinctBuckets: 0, status: "INSUFFICIENT_FOR_CALIBRATION" },
    breakdowns: {},
    regimeBreakdown: [],
    lossDrivers: { interpretation: "No frozen TradeResults were available.", top3: [] },
    recommendedStatus: { status: "NO_CONCLUSION", reason: "No frozen TradeResults were available." },
    tradeDetails: [],
    quality: { unmatchedTradeSignals: 0, degradedReasons: {} }
  };
}
