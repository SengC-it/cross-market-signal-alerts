import { isPrimaryOosTrade } from "./validation-metrics.js";

export const POST_HOC_DIAGNOSTIC_ONLY = "POST_HOC_DIAGNOSTIC_ONLY";
export const NOT_FOR_PARAMETER_SELECTION = "NOT_FOR_PARAMETER_SELECTION";
export const NOT_OOS_EVIDENCE = "NOT_OOS_EVIDENCE";

export const DIAGNOSTIC_SCOPE = Object.freeze({
  classification: POST_HOC_DIAGNOSTIC_ONLY,
  notForParameterSelection: true,
  notOosEvidence: true,
  markers: Object.freeze([
    POST_HOC_DIAGNOSTIC_ONLY,
    NOT_FOR_PARAMETER_SELECTION,
    NOT_OOS_EVIDENCE
  ])
});

const HOUR_MS = 3600 * 1000;
const EPSILON = 1e-9;

export function postmortemFinite(value) {
  return value !== null
    && value !== undefined
    && value !== ""
    && Number.isFinite(Number(value));
}

export function percentile(values, probability) {
  const sorted = (Array.isArray(values) ? values : [])
    .map(Number)
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  if (!sorted.length) return null;
  const p = Math.max(0, Math.min(1, Number(probability)));
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

export function distribution(values) {
  const finiteValues = (Array.isArray(values) ? values : [])
    .map(Number)
    .filter(Number.isFinite);
  if (!finiteValues.length) {
    return { count: 0, min: null, p1: null, p5: null, p10: null, median: null, p90: null, p95: null, p99: null, max: null };
  }
  return {
    count: finiteValues.length,
    min: finiteValues.reduce((best, value) => Math.min(best, value), Infinity),
    p1: percentile(finiteValues, 0.01),
    p5: percentile(finiteValues, 0.05),
    p10: percentile(finiteValues, 0.10),
    median: percentile(finiteValues, 0.50),
    p90: percentile(finiteValues, 0.90),
    p95: percentile(finiteValues, 0.95),
    p99: percentile(finiteValues, 0.99),
    max: finiteValues.reduce((best, value) => Math.max(best, value), -Infinity)
  };
}

export function directionalReturn(entryPrice, exitPrice, side) {
  const entry = Number(entryPrice);
  const exit = Number(exitPrice);
  if (!Number.isFinite(entry) || !Number.isFinite(exit) || entry === 0) return null;
  const raw = exit / entry - 1;
  return side === "SHORT" ? -raw : raw;
}

export function tradeRiskRows(trades = []) {
  return (Array.isArray(trades) ? trades : []).map((trade) => {
    const risk = Number(trade.initialRiskPct);
    const ratio = (value) => Number.isFinite(risk) && risk > 0 && postmortemFinite(value)
      ? Number(value) / risk
      : null;
    const grossR = ratio(trade.grossReturnPct);
    const entryFeeR = ratio(trade.entryFeePct);
    const exitFeeR = ratio(trade.exitFeePct);
    const slippageR = ratio(trade.slippageCostPct);
    const spreadR = ratio(trade.spreadCostPct);
    const fundingR = ratio(trade.fundingPct);
    const netR = ratio(trade.netReturnPct);
    return {
      trade,
      initialRiskPct: risk,
      initialRiskPriceDistance: Number.isFinite(Number(trade.entryFillPrice))
        && Number.isFinite(Number(trade.stopLoss))
        ? Math.abs(Number(trade.entryFillPrice) - Number(trade.stopLoss))
        : null,
      grossR,
      entryFeeR,
      exitFeeR,
      slippageR,
      spreadR,
      fundingR,
      netR
    };
  });
}

export function diagnosticMetrics(trades = []) {
  const rows = tradeRiskRows(trades);
  const gross = rows.map((row) => row.grossR).filter(Number.isFinite);
  const net = rows.map((row) => row.netR).filter(Number.isFinite);
  const winners = rows.filter((row) => Number(row.trade.netReturnPct) > 0);
  const losers = rows.filter((row) => Number(row.trade.netReturnPct) <= 0);
  const positive = rows
    .map((row) => Number(row.trade.netReturnPct))
    .filter((value) => Number.isFinite(value) && value > 0)
    .reduce((sum, value) => sum + value, 0);
  const negative = rows
    .map((row) => Number(row.trade.netReturnPct))
    .filter((value) => Number.isFinite(value) && value < 0)
    .reduce((sum, value) => sum + value, 0);
  return {
    trades: rows.length,
    winRate: rows.length ? winners.length / rows.length : null,
    grossExpectancyR: average(gross),
    netExpectancyR: average(net),
    avgWinR: average(winners.map((row) => row.netR)),
    avgLossR: average(losers.map((row) => row.netR)),
    profitFactor: negative < 0 ? positive / Math.abs(negative) : rows.length ? Infinity : null,
    avgNetR: average(net),
    averageNetReturn: average(rows.map((row) => Number(row.trade.netReturnPct))),
    totalNetReturnArithmetic: sum(rows.map((row) => Number(row.trade.netReturnPct))),
    cumulativeNetPnLR: sum(net)
  };
}

export function groupDiagnosticTrades(trades, keyFn) {
  const groups = new Map();
  for (const trade of Array.isArray(trades) ? trades : []) {
    const key = String(keyFn(trade) ?? "UNKNOWN");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(trade);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, rows]) => ({ key, ...diagnosticMetrics(rows) }));
}

export function foldIdForTime(time, window) {
  const start = Date.parse(window?.start);
  const end = Date.parse(window?.endExclusive ?? window?.end);
  const timestamp = Number(time);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !Number.isFinite(timestamp)) return "UNKNOWN";
  const index = Math.max(0, Math.min(4, Math.floor((timestamp - start) / (end - start) * 5)));
  return `research-fold-${index + 1}`;
}

export function exitReasonCategory(reason) {
  if (reason === "take_profit") return "TP";
  if (reason === "stop_loss") return "SL";
  if (reason === "time_stop") return "TIME_STOP";
  return "OTHER";
}

export function summarizeExitReasons(trades) {
  return {
    diagnosticScope: DIAGNOSTIC_SCOPE,
    groups: groupDiagnosticTrades(trades, (trade) => exitReasonCategory(trade.exitReason))
  };
}

export function summarizeFolds(trades, window) {
  const rows = (Array.isArray(trades) ? trades : []).map((trade) => ({
    ...trade,
    researchFold: trade.researchFold || foldIdForTime(trade.signalAvailableAt, window)
  }));
  const groups = groupDiagnosticTrades(rows, (trade) => trade.researchFold);
  return groups.map((group) => {
    const groupRows = rows.filter((trade) => trade.researchFold === group.key);
    return {
      ...group,
      grossExpectancyR: group.grossExpectancyR,
      netExpectancyR: group.netExpectancyR,
      winRate: group.winRate,
      avgWinR: group.avgWinR,
      avgLossR: group.avgLossR,
      exitReasonCounts: countExitReasons(groupRows),
      medianHoldingHours: percentile(groupRows.map((trade) => trade.holdingHours), 0.5)
    };
  });
}

export function countExitReasons(trades) {
  return (Array.isArray(trades) ? trades : []).reduce((counts, trade) => {
    const key = exitReasonCategory(trade.exitReason);
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, { TP: 0, SL: 0, TIME_STOP: 0, OTHER: 0 });
}

export function summarizeNumericBuckets(trades, valueFn, labels = ["weak", "medium", "strong"]) {
  const values = (Array.isArray(trades) ? trades : [])
    .map((trade) => Number(valueFn(trade)))
    .filter(Number.isFinite);
  const low = percentile(values, 1 / 3);
  const high = percentile(values, 2 / 3);
  const rows = [];
  for (const [index, label] of labels.entries()) {
    const selected = (Array.isArray(trades) ? trades : []).filter((trade) => {
      const value = Number(valueFn(trade));
      if (!Number.isFinite(value)) return false;
      return index === 0 ? value <= low : index === labels.length - 1 ? value > high : value > low && value <= high;
    });
    rows.push({ key: label, count: selected.length, ...diagnosticMetrics(selected) });
  }
  return {
    diagnosticScope: DIAGNOSTIC_SCOPE,
    thresholds: { low, high },
    groups: rows
  };
}

export function summarizeCrossSectionalDiagnostics(trades) {
  const rows = Array.isArray(trades) ? trades : [];
  const normalizedPercentile = (trade) => {
    const percentileValue = Number(trade.signalDetails?.crossSectionalPercentile);
    if (!Number.isFinite(percentileValue)) return null;
    return trade.side === "SHORT" ? 1 - percentileValue : percentileValue;
  };
  const percentileBuckets = [
    ["90_92_5", 0.90, 0.925],
    ["92_5_95", 0.925, 0.95],
    ["95_97_5", 0.95, 0.975],
    ["gte_97_5", 0.975, 1.0000001]
  ].map(([key, start, end]) => ({
    key,
    count: rows.filter((trade) => {
      const value = normalizedPercentile(trade);
      return Number.isFinite(value) && value >= start && value < end;
    }).length,
    ...diagnosticMetrics(rows.filter((trade) => {
      const value = normalizedPercentile(trade);
      return Number.isFinite(value) && value >= start && value < end;
    }))
  }));
  const component = (field) => ({
    distribution: distribution(rows.map((trade) => trade.signalDetails?.[field])),
    buckets: summarizeNumericBuckets(rows, (trade) => trade.signalDetails?.[field])
  });
  return {
    diagnosticScope: DIAGNOSTIC_SCOPE,
    longVsShort: {
      LONG: diagnosticMetrics(rows.filter((trade) => trade.side === "LONG")),
      SHORT: diagnosticMetrics(rows.filter((trade) => trade.side === "SHORT"))
    },
    researchFolds: summarizeFolds(rows, { start: "2025-08-01T00:00:00.000Z", endExclusive: "2026-08-01T00:00:00.000Z" }),
    signalPercentileBuckets: {
      diagnosticScope: DIAGNOSTIC_SCOPE,
      normalizedForSide: "LONG percentile; SHORT 1-percentile",
      groups: percentileBuckets
    },
    return6hMagnitudeBuckets: summarizeNumericBuckets(rows, (trade) => Math.abs(Number(trade.signalDetails?.return6h))),
    btcRelativeComponent: {
      absolute24h: component("return24h"),
      btc24h: component("btcReturn24h"),
      relative24h: component("relative24h")
    }
  };
}

export function summarizeFundingDiagnostics(trades) {
  const rows = Array.isArray(trades) ? trades : [];
  const crowdingPercentile = (trade) => {
    const value = Number(trade.signalDetails?.fundingPercentile);
    if (!Number.isFinite(value)) return null;
    return trade.side === "LONG" ? 1 - value : value;
  };
  const extremeBucket = (trade) => {
    const value = crowdingPercentile(trade);
    if (!Number.isFinite(value)) return "unknown";
    if (value >= 0.975) return "extreme_2_5_pct";
    if (value >= 0.95) return "extreme_5_pct";
    if (value >= 0.90) return "extreme_10_pct";
    return "below_extreme_10_pct";
  };
  const extensionBucket = (trade) => {
    const value = trade.side === "LONG"
      ? -Number(trade.signalDetails?.return8h)
      : Number(trade.signalDetails?.return8h);
    return value >= 0.10 ? "strong_extension" : value >= 0.05 ? "medium_extension" : "weak_extension";
  };
  const twoDimensional = groupDiagnosticTrades(rows, (trade) => `${Number(trade.signalDetails?.fundingRate) < 0 ? "negative" : "positive"}:${extensionBucket(trade)}`);
  return {
    diagnosticScope: DIAGNOSTIC_SCOPE,
    longVsShort: {
      LONG: diagnosticMetrics(rows.filter((trade) => trade.side === "LONG")),
      SHORT: diagnosticMetrics(rows.filter((trade) => trade.side === "SHORT"))
    },
    fundingPercentileBuckets: {
      diagnosticScope: DIAGNOSTIC_SCOPE,
      groups: groupDiagnosticTrades(rows, extremeBucket)
    },
    absoluteFundingRate: {
      distribution: distribution(rows.map((trade) => Math.abs(Number(trade.signalDetails?.fundingRate)))),
      groups: summarizeNumericBuckets(rows, (trade) => Math.abs(Number(trade.signalDetails?.fundingRate)), ["weak", "medium", "strong"])
    },
    return8hBuckets: summarizeNumericBuckets(rows, (trade) => {
      const value = trade.side === "LONG" ? -Number(trade.signalDetails?.return8h) : Number(trade.signalDetails?.return8h);
      return value;
    }),
    fundingSignMagnitudeXReturn8h: {
      diagnosticScope: DIAGNOSTIC_SCOPE,
      groups: twoDimensional
    },
    settlementUtcHour: groupDiagnosticTrades(rows, (trade) => {
      const time = Number(trade.signalDetails?.fundingEventTime);
      return Number.isFinite(time) ? String(new Date(time).getUTCHours()).padStart(2, "0") : "unknown";
    }),
    contribution: contributionBridge(rows),
    fold2Attribution: buildFold2Attribution(rows)
  };
}

export function contributionBridge(trades) {
  const rows = tradeRiskRows(trades);
  const sums = (field) => sum(rows.map((row) => row[field]));
  const pct = (field) => sum(rows.map((row) => Number(row.trade[field])));
  const bridge = {
    grossDirectionalPnLR: sums("grossR"),
    entryFeesR: sums("entryFeeR"),
    exitFeesR: sums("exitFeeR"),
    slippageR: sums("slippageR"),
    spreadR: sums("spreadR"),
    fundingCashflowR: sums("fundingR"),
    fundingDragR: -sums("fundingR"),
    netPnLR: sums("netR")
  };
  const computedNetPnLR = bridge.grossDirectionalPnLR
    - bridge.entryFeesR
    - bridge.exitFeesR
    - bridge.slippageR
    - bridge.spreadR
    + bridge.fundingCashflowR;
  const percentBridge = {
    grossReturn: pct("grossReturnPct"),
    fees: pct("totalFeePct"),
    slippage: pct("slippageCostPct"),
    spread: pct("spreadCostPct"),
    fundingCashflow: pct("fundingPct"),
    netReturn: pct("netReturnPct")
  };
  const computedNetReturn = percentBridge.grossReturn
    - percentBridge.fees
    - percentBridge.slippage
    - percentBridge.spread
    + percentBridge.fundingCashflow;
  return {
    diagnosticScope: DIAGNOSTIC_SCOPE,
    r: {
      ...bridge,
      computedNetPnLR,
      closureErrorR: bridge.netPnLR - computedNetPnLR,
      closed: Math.abs(bridge.netPnLR - computedNetPnLR) <= EPSILON
    },
    percent: {
      ...percentBridge,
      computedNetReturn,
      closureError: percentBridge.netReturn - computedNetReturn,
      closed: Math.abs(percentBridge.netReturn - computedNetReturn) <= EPSILON
    }
  };
}

export function feeInR(trade) {
  const risk = Number(trade?.initialRiskPct);
  if (!Number.isFinite(risk) || risk <= 0) return { entryFeeR: null, exitFeeR: null };
  return {
    entryFeeR: Number(trade.entryFeePct) / risk,
    exitFeeR: Number(trade.exitFeePct) / risk
  };
}

export function stopAttribution(trades) {
  const rows = tradeRiskRows(trades).filter((row) => row.trade.exitReason === "stop_loss");
  const details = rows.map((row) => {
    const trade = row.trade;
    const theoreticalStopR = directionalReturn(trade.entryFillPrice, trade.stopLoss, trade.side) / row.initialRiskPct;
    const rawExitR = directionalReturn(trade.entryFillPrice, trade.rawExitMarketPrice, trade.side) / row.initialRiskPct;
    const roundedExitR = directionalReturn(trade.entryFillPrice, trade.exitMarketPrice, trade.side) / row.initialRiskPct;
    const postFeeNetR = row.netR;
    const gapThrough = trade.exitResolution === "gap_stop_worse_fill"
      || (trade.side === "LONG" && Number(trade.rawExitMarketPrice) < Number(trade.stopLoss))
      || (trade.side === "SHORT" && Number(trade.rawExitMarketPrice) > Number(trade.stopLoss));
    return { trade, theoreticalStopR, rawExitR, roundedExitR, postFeeNetR, gapThrough };
  });
  return {
    diagnosticScope: DIAGNOSTIC_SCOPE,
    stopTrades: details.length,
    theoreticalStopR: distribution(details.map((row) => row.theoreticalStopR)),
    rawExitR: distribution(details.map((row) => row.rawExitR)),
    postRoundingExitR: distribution(details.map((row) => row.roundedExitR)),
    postFeeNetR: distribution(details.map((row) => row.postFeeNetR)),
    gapStopCount: details.filter((row) => row.gapThrough).length,
    normalStopCount: details.filter((row) => !row.gapThrough).length,
    extremeStopCount: details.filter((row) => Number(row.postFeeNetR) <= -2).length,
    expectedTheoreticalStopR: -1,
    normalStopApproximatelyMinusOneR: details.filter((row) => !row.gapThrough)
      .every((row) => Math.abs(Number(row.theoreticalStopR) + 1) <= 1e-8)
  };
}

export function classifyExtremeLoss(row) {
  const trade = row.trade;
  const causes = [];
  const rawExit = Number(trade.rawExitMarketPrice);
  const stop = Number(trade.stopLoss);
  const crossed = trade.exitResolution === "gap_stop_worse_fill"
    || (trade.side === "LONG" && rawExit < stop)
    || (trade.side === "SHORT" && rawExit > stop);
  if (crossed) causes.push("stop_gap");
  if (trade.lowerTimeframeReplayed === true) causes.push("next_lower_tf_fill");
  if (Math.abs(Number(trade.exitMarketPrice) - rawExit) > EPSILON
    || Math.abs(Number(trade.entryFillPrice) - Number(trade.entryMarketPrice)) > EPSILON) causes.push("tick_rounding");
  if (Math.abs(Number(row.entryFeeR) || 0) + Math.abs(Number(row.exitFeeR) || 0) >= 1) causes.push("fee_amplification");
  if (Math.abs(Number(row.slippageR) || 0) >= 0.5) causes.push("slippage_amplification");
  if (Math.abs(Number(row.fundingR) || 0) >= 0.5) causes.push("funding");
  if (trade.exitReason === "time_stop") causes.push("time_stop");
  return causes.length ? causes : ["other"];
}

export function extremeLossAttribution(trades) {
  const rows = tradeRiskRows(trades).filter((row) => Number(row.netR) <= -2);
  const counts = {};
  for (const row of rows) {
    for (const cause of classifyExtremeLoss(row)) counts[cause] = (counts[cause] || 0) + 1;
  }
  return {
    diagnosticScope: DIAGNOSTIC_SCOPE,
    count: rows.length,
    proportion: trades.length ? rows.length / trades.length : null,
    byCause: counts,
    causesMayOverlap: true
  };
}

export function atrRiskDiagnostics(trades) {
  const rows = tradeRiskRows(trades);
  const bridge = contributionBridge(trades);
  const stop = stopAttribution(trades);
  const lossRows = rows.filter((row) => Number(row.netR) <= 0);
  const feeDenominatorCorrect = rows.every((row) => {
    const expected = feeInR(row.trade);
    return Math.abs(Number(row.entryFeeR) - Number(expected.entryFeeR)) <= EPSILON
      && Math.abs(Number(row.exitFeeR) - Number(expected.exitFeeR)) <= EPSILON;
  });
  const finiteRisk = rows.every((row) => Number.isFinite(row.initialRiskPct) && row.initialRiskPct > 0);
  const accountingIssueFound = bridge.r.closed !== true || bridge.percent.closed !== true || !feeDenominatorCorrect;
  const rNormalizationIssueFound = !finiteRisk;
  const executionModelIssueFound = stop.stopTrades > 0 && !stop.normalStopApproximatelyMinusOneR;
  const allIssueFlags = accountingIssueFound || rNormalizationIssueFound || executionModelIssueFound;
  return {
    diagnosticScope: DIAGNOSTIC_SCOPE,
    initialRiskPct: distribution(rows.map((row) => row.initialRiskPct)),
    initialRiskPriceDistance: distribution(rows.map((row) => row.initialRiskPriceDistance)),
    entryFeeR: distribution(rows.map((row) => row.entryFeeR)),
    exitFeeR: distribution(rows.map((row) => row.exitFeeR)),
    slippageR: distribution(rows.map((row) => row.slippageR)),
    fundingR: distribution(rows.map((row) => row.fundingR)),
    realizedLossR: distribution(lossRows.map((row) => row.netR)),
    extremeLosses: extremeLossAttribution(trades),
    stopAttribution: stop,
    grossToNetWaterfall: bridge,
    accountingChecks: {
      feeDenominatorCorrect,
      finitePositiveInitialRisk: finiteRisk,
      grossToNetBridgeClosed: bridge.r.closed,
      grossToNetPercentBridgeClosed: bridge.percent.closed,
      accountingIssueFound,
      executionModelIssueFound,
      rNormalizationIssueFound,
      anyImplementationIssueFound: allIssueFlags
    },
    clampDiagnostic: equityClampDiagnostic(trades)
  };
}

export function equityClampDiagnostic(trades) {
  const ordered = [...(Array.isArray(trades) ? trades : [])]
    .sort((left, right) => Number(left.exitTime) - Number(right.exitTime));
  let equity = 1;
  let minimum = 1;
  let ruinTimestamp = null;
  let tradesBeforeRuin = null;
  let arithmeticReturn = 0;
  let arithmeticR = 0;
  for (let index = 0; index < ordered.length; index++) {
    const trade = ordered[index];
    const netReturn = Number(trade.netReturnPct);
    const realizedR = Number(trade.realizedR);
    if (Number.isFinite(netReturn)) {
      arithmeticReturn += netReturn;
      equity *= 1 + netReturn;
      minimum = Math.min(minimum, equity);
    }
    if (Number.isFinite(realizedR)) arithmeticR += realizedR;
    if (ruinTimestamp == null && equity <= 0) {
      ruinTimestamp = Number.isFinite(Number(trade.exitTime)) ? Number(trade.exitTime) : null;
      tradesBeforeRuin = index + 1;
    }
  }
  return {
    diagnosticScope: DIAGNOSTIC_SCOPE,
    cumulativeArithmeticNetReturn: arithmeticReturn,
    cumulativeNetPnLR: arithmeticR,
    ruinTimestamp,
    tradesBeforeRuin,
    minEquityBeforeClamp: minimum,
    formalTotalNetReturnWouldBe: equity - 1,
    formalMaxDrawdownWouldBeClampedAtMinusOne: minimum <= 0,
    arithmeticReturnNotClamped: Number.isFinite(arithmeticReturn)
  };
}

export function commonDiagnostics(trades, window) {
  const rows = Array.isArray(trades) ? trades : [];
  return {
    diagnosticScope: DIAGNOSTIC_SCOPE,
    exitReason: summarizeExitReasons(rows),
    holdingTimeBuckets: {
      diagnosticScope: DIAGNOSTIC_SCOPE,
      groups: groupDiagnosticTrades(rows, (trade) => holdingBucket(trade.holdingHours))
    },
    assetContribution: contributionGroups(rows, (trade) => trade.asset),
    monthContribution: contributionGroups(rows, (trade) => monthKey(trade.signalAvailableAt)),
    sideContribution: contributionGroups(rows, (trade) => trade.side),
    foldContribution: contributionGroups(rows, (trade) => foldIdForTime(trade.signalAvailableAt, window))
  };
}

export function buildFamilyPostmortem({ familyId, trades, signals, formalResult, window }) {
  const completeTrades = (Array.isArray(trades) ? trades : []).filter(isPrimaryOosTrade);
  const metrics = diagnosticMetrics(completeTrades);
  const base = {
    familyId,
    diagnosticScope: DIAGNOSTIC_SCOPE,
    formalResearch: {
      completeTrades: formalResult?.completeTrades ?? null,
      metrics: formalResult?.metrics || null,
      researchStatus: formalResult?.researchGate?.status || "REJECTED_CANDIDATE"
    },
    replay: {
      rawTradeRows: Array.isArray(trades) ? trades.length : 0,
      completeTrades: completeTrades.length,
      degradedTrades: Math.max(0, (Array.isArray(trades) ? trades.length : 0) - completeTrades.length),
      signalCount: Array.isArray(signals) ? signals.length : 0,
      metrics
    },
    longVsShort: {
      LONG: diagnosticMetrics(completeTrades.filter((trade) => trade.side === "LONG")),
      SHORT: diagnosticMetrics(completeTrades.filter((trade) => trade.side === "SHORT"))
    },
    researchFolds: summarizeFolds(completeTrades, window),
    common: commonDiagnostics(completeTrades, window)
  };
  if (familyId === "cross_sectional_relative_momentum_v1") {
    base.crossSectional = summarizeCrossSectionalDiagnostics(completeTrades);
    base.failureClassification = classifyCrossFailure(base);
  } else if (familyId === "funding_extreme_crowding_reversal_v1") {
    base.funding = summarizeFundingDiagnostics(completeTrades);
    base.failureClassification = classifyFundingFailure(base);
  } else if (familyId === "atr_dislocation_mean_reversion_v1") {
    base.atr = atrRiskDiagnostics(completeTrades);
    base.failureClassification = classifyAtrFailure(base);
  } else {
    base.failureClassification = ["OTHER"];
  }
  return base;
}

export function buildPostmortemReport({ baseReport, familyDiagnostics, frozenBaseSha, candidateDefinitionsHash }) {
  const implementationIssue = Object.values(familyDiagnostics || {})
    .some((family) => family.atr?.accountingChecks?.anyImplementationIssueFound === true);
  return {
    version: "V4-M3.7-FAILURE-POSTMORTEM",
    mode: "READ_ONLY_DIAGNOSTIC",
    baseResearchSha: frozenBaseSha,
    sourceResearchArtifact: "artifacts/m3/m3-7-strategy-family-reset.json",
    candidateDefinitionsHash,
    oldWindowRole: baseReport?.oldWindowRole || "RESEARCH_ONLY_AFTER_MULTIPLE_INSPECTIONS",
    oldWindowFullyResearch: baseReport?.oldWindowFullyResearch === true,
    diagnosticPolicy: DIAGNOSTIC_SCOPE,
    families: familyDiagnostics,
    formalScreening: Object.fromEntries(Object.entries(baseReport?.researchResults || {}).map(([familyId, result]) => [
      familyId,
      {
        completeTrades: result.completeTrades,
        metrics: result.metrics,
        status: result.researchGate?.status || "REJECTED_CANDIDATE"
      }
    ])),
    implementationVerdict: implementationIssue
      ? "POSTMORTEM_IMPLEMENTATION_ISSUE_FOUND"
      : "STRATEGY_ECONOMICS_FAILURE",
    forwardTestCandidates: [],
    formalForwardVerdict: "PENDING_FORWARD_WINDOW",
    flags: {
      formalResearchArtifactChanged: false,
      candidateDefinitionsChanged: false,
      parameterSearchPerformed: false,
      manualThresholdIteration: false,
      formalResearchRerun: false,
      holdoutUsedForNewUntouchedValidation: false,
      enteredM4: false,
      mergedMain: false,
      diagnosticsUsedAsOosEvidence: false
    },
    researchArtifactReference: {
      candidateDefinitionsHash,
      formalResearchArtifactChanged: false,
      forwardTestCandidates: [],
      formalForwardVerdict: "PENDING_FORWARD_WINDOW"
    }
  };
}

export function classifyCrossFailure(family) {
  const metrics = family.replay?.metrics || {};
  const classification = [];
  if (Number(metrics.grossExpectancyR) <= 0) classification.push("NO_GROSS_EDGE");
  if (Number(metrics.netExpectancyR) < Number(metrics.grossExpectancyR)) classification.push("COST_OVERWHELMS_WEAK_EDGE");
  if (family.longVsShort?.LONG?.netExpectancyR != null
    && family.longVsShort?.SHORT?.netExpectancyR != null
    && Math.abs(Number(family.longVsShort.LONG.netExpectancyR) - Number(family.longVsShort.SHORT.netExpectancyR)) > 0.02) classification.push("SIDE_ASYMMETRY");
  return classification.length ? classification : ["OTHER"];
}

export function classifyFundingFailure(family) {
  const metrics = family.replay?.metrics || {};
  const foldMetrics = (family.researchFolds || []).map((fold) => Number(fold.netExpectancyR)).filter(Number.isFinite);
  const classification = [];
  if (Number(metrics.grossExpectancyR) <= 0) classification.push("NO_GROSS_EDGE");
  if (Number(metrics.netExpectancyR) < Number(metrics.grossExpectancyR)) classification.push("COST_OVERWHELMS_WEAK_EDGE");
  if (foldMetrics.length && foldMetrics.some((value) => value > 0) && foldMetrics.some((value) => value < 0)) classification.push("REGIME_SPECIFIC_ONLY");
  return classification.length ? classification : ["OTHER"];
}

export function classifyAtrFailure(family) {
  const metrics = family.replay?.metrics || {};
  const checks = family.atr?.accountingChecks || {};
  if (checks.anyImplementationIssueFound === true) return ["EXECUTION_MODEL_PATHOLOGY"];
  const classification = [];
  if (Number(metrics.grossExpectancyR) > 0 && Number(metrics.netExpectancyR) < 0) classification.push("COST_OVERWHELMS_WEAK_EDGE");
  if (family.atr?.stopAttribution?.extremeStopCount > 0) classification.push("EXIT_STRUCTURE_FAILURE");
  return classification.length ? classification : ["OTHER"];
}

function contributionGroups(trades, keyFn) {
  const rows = groupDiagnosticTrades(trades, keyFn);
  const ranked = rows.map((row) => ({ ...row, contributionNetR: row.netExpectancyR * row.trades }))
    .sort((left, right) => right.contributionNetR - left.contributionNetR);
  return {
    diagnosticScope: DIAGNOSTIC_SCOPE,
    all: ranked,
    top20: ranked.slice(0, 20),
    bottom20: [...ranked].sort((left, right) => left.contributionNetR - right.contributionNetR).slice(0, 20)
  };
}

function holdingBucket(value) {
  const hours = Number(value);
  if (!Number.isFinite(hours)) return "unknown";
  if (hours < 1) return "0_1h";
  if (hours < 2) return "1_2h";
  if (hours < 4) return "2_4h";
  if (hours < 8) return "4_8h";
  return "gte_8h";
}

function monthKey(value) {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString().slice(0, 7) : "unknown";
}

function average(values) {
  const finiteValues = (Array.isArray(values) ? values : []).map(Number).filter(Number.isFinite);
  return finiteValues.length ? finiteValues.reduce((sum, value) => sum + value, 0) / finiteValues.length : null;
}

function sum(values) {
  return (Array.isArray(values) ? values : [])
    .map(Number)
    .filter(Number.isFinite)
    .reduce((total, value) => total + value, 0);
}

function buildFold2Attribution(trades) {
  const fold2 = (Array.isArray(trades) ? trades : [])
    .filter((trade) => foldIdForTime(trade.signalAvailableAt, { start: "2025-08-01T00:00:00.000Z", endExclusive: "2026-08-01T00:00:00.000Z" }) === "research-fold-2");
  return {
    diagnosticScope: DIAGNOSTIC_SCOPE,
    trades: fold2.length,
    metrics: diagnosticMetrics(fold2),
    byAsset: contributionGroups(fold2, (trade) => trade.asset),
    bySide: contributionGroups(fold2, (trade) => trade.side),
    byFundingMagnitude: contributionGroups(fold2, (trade) => {
      const value = Math.abs(Number(trade.signalDetails?.fundingRate));
      return value >= 0.01 ? "high" : value >= 0.005 ? "medium" : "low";
    }),
    byUtcHour: contributionGroups(fold2, (trade) => {
      const time = Number(trade.signalDetails?.fundingEventTime);
      return Number.isFinite(time) ? String(new Date(time).getUTCHours()).padStart(2, "0") : "unknown";
    })
  };
}
