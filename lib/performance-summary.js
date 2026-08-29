export function buildPerformanceSummary({
  emailNotifications = [],
  paperModelRuns = [],
  calculatedAt = new Date().toISOString()
} = {}) {
  const signals = dedupeSignals(emailNotifications);
  const reviewedReturns = [];
  const assets = new Set();
  const profitableAssetSet = new Set();
  const losingAssetSet = new Set();
  let reviewedSignals = 0;
  let profitSignals = 0;
  let lossSignals = 0;
  let flatSignals = 0;

  for (const signal of signals) {
    const asset = normalizedText(signal.asset);
    if (asset) assets.add(asset);
    const review = signal?.payload?.review;
    if (review?.status !== "reviewed") continue;
    reviewedSignals += 1;
    const returnPct = finiteNumber(review.returnPct);
    if (returnPct == null) continue;
    reviewedReturns.push(returnPct);
    if (returnPct > 0) {
      profitSignals += 1;
      if (asset) profitableAssetSet.add(asset);
    } else if (returnPct < 0) {
      lossSignals += 1;
      if (asset) losingAssetSet.add(asset);
    } else {
      flatSignals += 1;
    }
  }

  const totalSignals = signals.length;
  const grossProfitReturn = reviewedReturns.length
    ? reviewedReturns.filter((value) => value > 0).reduce(sum, 0)
    : null;
  const grossLossReturn = reviewedReturns.length
    ? reviewedReturns.filter((value) => value < 0).reduce(sum, 0)
    : null;
  const netSignalReturn = reviewedReturns.length ? reviewedReturns.reduce(sum, 0) : null;
  const paperSummary = summarizePaperRuns(paperModelRuns);
  const strategyPerformance = buildForwardStrategyPerformance({
    emailNotifications: signals,
    paperModelRuns
  });

  return {
    totalSignals,
    reviewedSignals,
    pendingSignals: totalSignals - reviewedSignals,
    reviewRate: ratio(reviewedSignals, totalSignals),
    profitSignals,
    lossSignals,
    flatSignals,
    winRate: ratio(profitSignals, profitSignals + lossSignals),
    totalAssets: assets.size,
    profitableAssets: profitableAssetSet.size,
    losingAssets: losingAssetSet.size,
    grossProfitReturn,
    grossLossReturn,
    netSignalReturn,
    averageSignalReturn: reviewedReturns.length ? netSignalReturn / reviewedReturns.length : null,
    profitFactor: grossLossReturn != null && grossLossReturn < 0
      ? grossProfitReturn / Math.abs(grossLossReturn)
      : null,
    ...paperSummary,
    strategyPerformance,
    forwardPromotionGate: buildV42ForwardPromotionGate(strategyPerformance.v42Forward),
    calculatedAt,
    returnBasis: "等权信号收益简单累计；PAPER 组合收益按唯一 model_id + rebalance_time 周期累计"
  };
}

export function buildForwardStrategyPerformance({
  emailNotifications = [],
  paperModelRuns = []
} = {}) {
  const signals = dedupeSignals(emailNotifications);
  const legacySignals = signals.filter((signal) =>
    !String(signal.signal_key || "").startsWith("paper:")
    && signal.model_version !== "DYNAMIC_SPOT_V2_2026-08-01"
  );
  const v42Signals = signals.filter((signal) =>
    signal.model_version === "DYNAMIC_SPOT_V2_2026-08-01"
    && signal.strategy_id === "dynamic_relative_strength_breakout"
    && signal?.payload?.signalVariant === "STRONG_EXTENSION_10_15"
  );

  return {
    legacyProduction: summarizeSignalStrategy(legacySignals, {
      id: "legacy_production",
      label: "LEGACY PRODUCTION",
      scope: "旧 scanner 实际历史邮件"
    }),
    v42Forward: summarizeSignalStrategy(v42Signals, {
      id: "v4_2_forward",
      label: "V4.2 FORWARD",
      scope: "dynamic_relative_strength_breakout / STRONG_EXTENSION_10_15"
    }),
    v34ForwardPaper: summarizePaperStrategy(paperModelRuns, {
      id: "v3_4_forward_paper",
      label: "V3.4 FORWARD PAPER",
      modelId: "v3_4_unified_residual_volatility_risk"
    }),
    fundingCarryV2ForwardPaper: summarizePaperStrategy(paperModelRuns, {
      id: "funding_carry_v2_forward_paper",
      label: "FUNDING CARRY V2 FORWARD PAPER",
      modelId: "funding_carry_perp_reversion_ema100_v2"
    })
  };
}

export function buildV42ForwardPromotionGate(performance = {}) {
  const minimumReviewedSignals = 30;
  const maxDrawdownLimit = 0.2;
  const reviewed = Number(performance.reviewed || 0);
  const checks = reviewed >= minimumReviewedSignals
    ? {
        averageNetReturn: finiteNumber(performance.averageNetReturn) > 0,
        profitFactor: finiteNumber(performance.profitFactor) != null && Number(performance.profitFactor) >= 1.15,
        maxDrawdown: finiteNumber(performance.maxDrawdown) != null && Math.abs(Number(performance.maxDrawdown)) <= maxDrawdownLimit,
        dataCompleteness: finiteNumber(performance.dataCompleteness) != null && Number(performance.dataCompleteness) >= 0.95
      }
    : {
        averageNetReturn: null,
        profitFactor: null,
        maxDrawdown: null,
        dataCompleteness: null
      };
  const sufficientSample = reviewed >= minimumReviewedSignals;
  return {
    status: !sufficientSample
      ? "INSUFFICIENT_FORWARD_SAMPLE"
      : Object.values(checks).every(Boolean) ? "FORWARD_GATE_PASS" : "FORWARD_GATE_FAIL",
    readOnly: true,
    automaticPromotion: false,
    minimumReviewedSignals,
    reviewedSignals: reviewed,
    maxDrawdownLimit,
    checks
  };
}

function dedupeSignals(notifications) {
  const unique = new Map();
  for (const notification of notifications) {
    const key = normalizedText(notification?.signal_key);
    if (!key) continue;
    const current = unique.get(key);
    if (!current || reviewRank(notification) > reviewRank(current)) unique.set(key, notification);
  }
  return [...unique.values()];
}

function summarizePaperRuns(runs) {
  const unique = new Map();
  for (const run of runs) {
    if (run?.email_status !== "sent" || !run?.email_sent_at) continue;
    const modelId = normalizedText(run.model_id);
    const rebalanceTime = normalizedText(run.rebalance_time);
    if (!modelId || !rebalanceTime) continue;
    const key = `${modelId}:${rebalanceTime}`;
    const current = unique.get(key);
    if (!current || runReviewRank(run) > runReviewRank(current)) unique.set(key, run);
  }

  let reviewedPaperRuns = 0;
  let profitablePaperRuns = 0;
  let losingPaperRuns = 0;
  const returns = [];
  for (const run of unique.values()) {
    if (run?.review?.status !== "reviewed") continue;
    reviewedPaperRuns += 1;
    const returnPct = finiteNumber(run.review.returnPct);
    if (returnPct == null) continue;
    returns.push(returnPct);
    if (returnPct > 0) profitablePaperRuns += 1;
    if (returnPct < 0) losingPaperRuns += 1;
  }

  return {
    reviewedPaperRuns,
    profitablePaperRuns,
    losingPaperRuns,
    paperPortfolioReturn: returns.length ? returns.reduce(sum, 0) : null
  };
}

function summarizeSignalStrategy(signals, metadata) {
  const records = signals.map((signal) => ({
    status: signal?.payload?.review?.status,
    returnPct: signal?.payload?.review?.returnPct,
    time: signal?.sent_at || signal?.trigger_time
  }));
  return {
    ...metadata,
    unit: "signals",
    signals: signals.length,
    periods: null,
    ...summarizeStrategyRecords(records)
  };
}

function summarizePaperStrategy(runs, metadata) {
  const unique = new Map();
  for (const run of runs) {
    if (run?.model_id !== metadata.modelId || run?.email_status !== "sent" || !run?.email_sent_at) continue;
    const key = `${run.model_id}:${run.rebalance_time}`;
    const current = unique.get(key);
    if (!current || runReviewRank(run) > runReviewRank(current)) unique.set(key, run);
  }
  const periods = [...unique.values()];
  const records = periods.map((run) => ({
    status: run?.review?.status,
    returnPct: run?.review?.returnPct,
    time: run?.rebalance_time
  }));
  return {
    id: metadata.id,
    label: metadata.label,
    scope: metadata.modelId,
    unit: "periods",
    signals: periods.reduce((count, run) => count + (Array.isArray(run.targets) ? run.targets.length : 0), 0),
    periods: periods.length,
    ...summarizeStrategyRecords(records)
  };
}

function summarizeStrategyRecords(records) {
  const reviewed = records.filter((record) => record.status === "reviewed");
  const finiteReviewed = reviewed
    .map((record) => ({ ...record, returnPct: finiteNumber(record.returnPct) }))
    .filter((record) => record.returnPct != null)
    .sort((left, right) => new Date(left.time).getTime() - new Date(right.time).getTime());
  const returns = finiteReviewed.map((record) => record.returnPct);
  const grossProfit = returns.filter((value) => value > 0).reduce(sum, 0);
  const grossLoss = returns.filter((value) => value < 0).reduce(sum, 0);
  const times = records.map((record) => new Date(record.time).getTime()).filter(Number.isFinite).sort((a, b) => a - b);
  return {
    reviewed: reviewed.length,
    pending: records.length - reviewed.length,
    wins: returns.filter((value) => value > 0).length,
    losses: returns.filter((value) => value < 0).length,
    flat: returns.filter((value) => value === 0).length,
    winRate: ratio(
      returns.filter((value) => value > 0).length,
      returns.filter((value) => value !== 0).length
    ),
    averageNetReturn: returns.length ? returns.reduce(sum, 0) / returns.length : null,
    netReturn: returns.length ? returns.reduce(sum, 0) : null,
    profitFactor: grossLoss < 0 ? grossProfit / Math.abs(grossLoss) : null,
    maxDrawdown: returns.length ? calculateMaxDrawdown(returns) : null,
    dataCompleteness: reviewed.length ? finiteReviewed.length / reviewed.length : null,
    firstSignalAt: times.length ? new Date(times[0]).toISOString() : null,
    latestSignalAt: times.length ? new Date(times.at(-1)).toISOString() : null
  };
}

function calculateMaxDrawdown(returns) {
  let equity = 1;
  let peak = 1;
  let maxDrawdown = 0;
  for (const value of returns) {
    equity *= 1 + value;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.min(maxDrawdown, equity / peak - 1);
  }
  return maxDrawdown;
}

function reviewRank(notification) {
  return notification?.payload?.review?.status === "reviewed" ? 1 : 0;
}

function runReviewRank(run) {
  return run?.review?.status === "reviewed" ? 1 : 0;
}

function normalizedText(value) {
  if (value == null || value === "") return null;
  return String(value);
}

function finiteNumber(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : null;
}

function sum(total, value) {
  return total + value;
}
