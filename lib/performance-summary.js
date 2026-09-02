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

export const V42_FORWARD_MODEL = Object.freeze({
  modelId: "DYNAMIC_SPOT_V2_2026-08-01",
  strategyId: "dynamic_relative_strength_breakout",
  signalVariant: "STRONG_EXTENSION_10_15",
  modelLabel: "V4.2 Dynamic Strength",
  strategyVersion: "STRONG_EXTENSION_10_15",
  basis: "Production Forward 已完成复盘"
});

export function calculateCompoundedReturn(returns = []) {
  const finiteReturns = (returns || [])
    .map((value) => finiteNumber(value))
    .filter((value) => value != null);
  if (!finiteReturns.length) return null;
  let equity = 1;
  for (const value of finiteReturns) {
    equity *= 1 + value;
    if (!Number.isFinite(equity)) return null;
  }
  const compounded = equity - 1;
  return Number.isFinite(compounded) ? compounded : null;
}

export function formatCompoundedReturn(value) {
  const number = finiteNumber(value);
  if (number == null) return "暂无";
  const percent = number * 100;
  return `${percent > 0 ? "+" : ""}${percent.toFixed(2)}%`;
}

export function buildSignalPerformanceSnapshot({
  signals = [],
  modelId = null,
  modelLabel = "策略模型",
  strategyVersion = null,
  basis = "Production Forward 已完成复盘",
  filter = null
} = {}) {
  const unique = new Map();
  for (const signal of signals || []) {
    const signalKey = normalizedText(signal?.signal_key || signal?.signalKey);
    if (!signalKey) continue;
    if (filter && !filter(signal)) continue;
    const current = unique.get(signalKey);
    if (!current || reviewRank(signal) > reviewRank(current)) unique.set(signalKey, signal);
  }

  const reviewed = [...unique.values()]
    .filter((signal) => signalReview(signal)?.status === "reviewed");
  const returns = reviewed
    .map((signal) => finiteNumber(signalReview(signal)?.returnPct))
    .filter((value) => value != null);
  return buildCompletedSnapshot({
    modelId,
    modelLabel,
    strategyVersion,
    basis,
    reviewedCount: reviewed.length,
    returns
  });
}

export function buildPaperPerformanceSnapshot({
  runs = [],
  modelId,
  modelLabel = "策略模型",
  basis = "Production PAPER 已完成周期"
} = {}) {
  const unique = new Map();
  for (const run of runs || []) {
    if (run?.model_id !== modelId || run?.email_status !== "sent" || !run?.email_sent_at) continue;
    const rebalanceTime = normalizedText(run.rebalance_time);
    if (!rebalanceTime) continue;
    const key = `${run.model_id}:${rebalanceTime}`;
    const current = unique.get(key);
    if (!current || runReviewRank(run) > runReviewRank(current)) unique.set(key, run);
  }

  const reviewed = [...unique.values()]
    .filter((run) => run?.review?.status === "reviewed");
  const returns = reviewed
    .map((run) => finiteNumber(run?.review?.returnPct))
    .filter((value) => value != null);
  return buildCompletedSnapshot({
    modelId,
    modelLabel,
    basis,
    reviewedCount: reviewed.length,
    returns
  });
}

export function buildV42ForwardSnapshot(signals = []) {
  return buildSignalPerformanceSnapshot({
    signals,
    modelId: V42_FORWARD_MODEL.modelId,
    modelLabel: V42_FORWARD_MODEL.modelLabel,
    strategyVersion: V42_FORWARD_MODEL.strategyVersion,
    basis: V42_FORWARD_MODEL.basis,
    filter: isV42ForwardSignal
  });
}

export function buildSignalEmailPerformanceContext({
  signals = [],
  historySignals = []
} = {}) {
  const current = signals || [];
  const isV42Email = current.length > 0 && current.every(isV42ForwardSignal);
  if (isV42Email) {
    return buildV42ForwardSnapshot(historySignals);
  }

  const top = current[0] || {};
  const modelVersion = normalizedText(top.model_version || top.modelVersion || top?.payload?.modelVersion);
  const strategyId = normalizedText(top.strategy_id || top.strategyId || top?.payload?.strategyId);
  const signalVariant = normalizedText(top?.payload?.signalVariant || top.signalVariant);
  const matchingHistory = (historySignals || []).filter((signal) =>
    (!modelVersion || signal?.model_version === modelVersion || signal?.payload?.modelVersion === modelVersion)
    && (!strategyId || signal?.strategy_id === strategyId || signal?.payload?.strategyId === strategyId)
    && (!signalVariant || signal?.payload?.signalVariant === signalVariant || signal?.signalVariant === signalVariant)
    && !isShadowOrResearchSignal(signal)
  );
  return buildSignalPerformanceSnapshot({
    signals: matchingHistory,
    modelId: modelVersion || strategyId || "legacy_signal",
    modelLabel: modelLabelForSignal(top),
    strategyVersion: signalVariant,
    basis: "Production Forward 已完成复盘"
  });
}

export function performanceEmailLines(snapshot, {
  includeStrategyVersion = true
} = {}) {
  const modelLabel = normalizedText(snapshot?.modelLabel) || "策略模型";
  const strategyVersion = normalizedText(snapshot?.strategyVersion);
  const completedPeriods = Number.isFinite(Number(snapshot?.completedPeriods))
    ? Math.max(0, Math.trunc(Number(snapshot.completedPeriods)))
    : 0;
  const snapshotBasis = normalizedText(snapshot?.basis);
  const emptyBasis = normalizedText(snapshot?.emptyBasis);
  const basis = completedPeriods > 0
    ? snapshotBasis || "Production Forward 已完成复盘"
    : emptyBasis
      || (snapshotBasis && /PAPER/i.test(snapshotBasis)
        ? `${snapshotBasis}（暂无已完成样本）`
        : "Forward 样本不足");
  return [
    `策略模型：${modelLabel}`,
    ...(includeStrategyVersion && strategyVersion ? [`策略版本：${strategyVersion}`] : []),
    `已完成周期：${completedPeriods}`,
    `已完成周期复合收益：${formatCompoundedReturn(snapshot?.compoundedReturn)}`,
    `统计口径：${basis}`
  ];
}

function buildCompletedSnapshot({
  modelId,
  modelLabel,
  strategyVersion = null,
  basis,
  reviewedCount,
  returns
}) {
  const validReviewedCount = returns.length;
  return {
    modelId: normalizedText(modelId),
    modelLabel: normalizedText(modelLabel) || "策略模型",
    strategyVersion: normalizedText(strategyVersion),
    completedPeriods: validReviewedCount,
    reviewedPeriods: Number.isFinite(Number(reviewedCount)) ? Number(reviewedCount) : validReviewedCount,
    compoundedReturn: calculateCompoundedReturn(returns),
    basis: normalizedText(basis) || "Production Forward 已完成复盘",
    sufficientData: validReviewedCount > 0 && validReviewedCount === Number(reviewedCount)
  };
}

function modelLabelForSignal(signal) {
  if (isV42ForwardSignal(signal)) return V42_FORWARD_MODEL.modelLabel;
  const modelVersion = normalizedText(signal?.model_version || signal?.modelVersion || signal?.payload?.modelVersion);
  if (modelVersion) return modelVersion;
  const strategyId = normalizedText(signal?.strategy_id || signal?.strategyId || signal?.payload?.strategyId);
  return strategyId || "旧版信号模型";
}

function signalModelVersion(signal = {}) {
  return signal?.model_version || signal?.modelVersion || signal?.payload?.modelVersion || null;
}

export function isV42ForwardSignal(signal = {}) {
  const modelVersion = signalModelVersion(signal);
  const strategyId = signal?.strategy_id || signal?.strategyId || signal?.payload?.strategyId;
  const signalVariant = signal?.payload?.signalVariant || signal?.signalVariant;
  return modelVersion === V42_FORWARD_MODEL.modelId
    && strategyId === V42_FORWARD_MODEL.strategyId
    && signalVariant === V42_FORWARD_MODEL.signalVariant
    && !isShadowOrResearchSignal(signal)
    && !isPaperSignal(signal);
}

function isShadowOrResearchSignal(signal = {}) {
  return signal?.delivery_mode === "SHADOW_ONLY"
    || signal?.delivery?.mode === "SHADOW_ONLY"
    || signal?.payload?.delivery?.mode === "SHADOW_ONLY"
    || signal?.signalTier === "SHADOW_ONLY"
    || signal?.payload?.signalTier === "SHADOW_ONLY"
    || signal?.payload?.signalTier === "RESEARCH_ONLY"
    || (signal?.payload?.delivery?.emailSuppressed === true
      && signal?.payload?.delivery?.mode === "PAPER");
}

function isPaperSignal(signal = {}) {
  return String(signal?.signal_key || signal?.signalKey || "").startsWith("paper:")
    || signal?.delivery_mode === "PAPER"
    || signal?.payload?.delivery?.mode === "PAPER";
}

function signalReview(signal = {}) {
  return signal?.payload?.review || signal?.review || null;
}

export function buildForwardStrategyPerformance({
  emailNotifications = [],
  paperModelRuns = []
} = {}) {
  const signals = dedupeSignals(emailNotifications);
  const legacySignals = signals.filter((signal) =>
    !isPaperSignal(signal)
    && signalModelVersion(signal) !== V42_FORWARD_MODEL.modelId
    && !isShadowOrResearchSignal(signal)
  );
  const v42Signals = signals.filter(isV42ForwardSignal);

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
    compoundedReturn: calculateCompoundedReturn(returns),
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
  return signalReview(notification)?.status === "reviewed" ? 1 : 0;
}

function runReviewRank(run) {
  return run?.review?.status === "reviewed" ? 1 : 0;
}

function normalizedText(value) {
  if (value == null || value === "" || typeof value === "object") return null;
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
