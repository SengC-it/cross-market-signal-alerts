import {
  FUNDING_CARRY_V2_MODEL,
  monitorOpenFundingCarryV2Runs,
  tryReviewFundingCarryV2PaperRun
} from "../lib/funding-carry-v2-paper.js";
import {
  fetchAllPaperEmailRuns,
  fetchPendingPaperModelRunsForModel
} from "../lib/storage.js";
import { buildForwardStrategyPerformance } from "../lib/performance-summary.js";

const apply = process.argv.includes("--apply");
const now = Date.now();
const beforeRuns = await fetchAllPaperEmailRuns();
const before = fundingSummary(beforeRuns);
let recovery;
let afterRuns;

if (apply) {
  recovery = await monitorOpenFundingCarryV2Runs({ now, limit: 20 });
  afterRuns = await fetchAllPaperEmailRuns();
} else {
  const pendingRuns = await fetchPendingPaperModelRunsForModel({
    modelId: FUNDING_CARRY_V2_MODEL.id,
    limit: 20
  });
  const simulatedReviews = new Map();
  const results = [];
  for (const run of pendingRuns) {
    try {
      const review = await tryReviewFundingCarryV2PaperRun({
        run,
        now,
        persistReview: async ({ review: nextReview }) => {
          simulatedReviews.set(run.rebalance_time, nextReview);
          return { ...run, review: nextReview };
        }
      });
      results.push({ rebalanceTime: run.rebalance_time, status: review.status, reason: review.reason || null });
    } catch (error) {
      results.push({
        rebalanceTime: run.rebalance_time,
        status: "error",
        reason: error instanceof Error ? error.message : String(error)
      });
    }
  }
  recovery = {
    checked: results.length,
    reviewed: results.filter((result) => result.status === "reviewed").length,
    pending: results.filter((result) => result.status === "pending").length,
    failed: results.filter((result) => result.status === "error").length,
    results
  };
  afterRuns = beforeRuns.map((run) => run.model_id === FUNDING_CARRY_V2_MODEL.id && simulatedReviews.has(run.rebalance_time)
    ? { ...run, review: simulatedReviews.get(run.rebalance_time) }
    : run);
}

const after = fundingSummary(afterRuns);
const unresolved = afterRuns
  .filter((run) => run.model_id === FUNDING_CARRY_V2_MODEL.id)
  .filter((run) => run.email_status === "sent" && run.email_sent_at)
  .filter((run) => run.review?.status !== "reviewed")
  .map((run) => ({
    rebalanceTime: run.rebalance_time,
    targets: Array.isArray(run.targets) ? run.targets.map((target) => target.symbol) : [],
    reason: run.review?.diagnostics?.retryReason || run.review?.reason || "unknown"
  }));

console.log(JSON.stringify({
  mode: apply ? "apply" : "dry_run",
  modelId: FUNDING_CARRY_V2_MODEL.id,
  calculatedAt: new Date(now).toISOString(),
  before,
  recovery,
  after,
  unresolved
}, null, 2));

function fundingSummary(runs) {
  const performance = buildForwardStrategyPerformance({ paperModelRuns: runs })
    .fundingCarryV2ForwardPaper;
  return {
    pending: performance.pending,
    reviewed: performance.reviewed,
    profit: performance.wins,
    loss: performance.losses,
    flat: performance.flat,
    averageNetReturn: performance.averageNetReturn,
    profitFactor: performance.profitFactor,
    netReturn: performance.netReturn,
    maxDrawdown: performance.maxDrawdown
  };
}
