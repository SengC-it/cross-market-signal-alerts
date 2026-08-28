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
    calculatedAt,
    returnBasis: "等权信号收益简单累计；PAPER 组合收益按唯一 model_id + rebalance_time 周期累计"
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
