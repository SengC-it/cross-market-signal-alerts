import {
  fetchAllPaperEmailRuns,
  fetchPaperModelRunsPage,
  isSupabaseConfigured,
  paperModelRunKey
} from "../lib/storage.js";
import {
  classifyReviewState,
  processPaperReviewRun
} from "../lib/review-recovery.js";
import {
  FUNDING_CARRY_V2_MODEL,
  tryReviewFundingCarryV2PaperRun
} from "../lib/funding-carry-v2-paper.js";
import { buildForwardStrategyPerformance } from "../lib/performance-summary.js";

const APPLY = process.argv.includes("--apply");
const PAGE_SIZE = readPositiveInteger("--page-size", 100);
const MAX_RECORDS = readOptionalPositiveInteger("--max-records");

if (process.argv[1] && process.argv[1].endsWith("backfill-funding-carry-v2-reviews.js")) {
  run().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

export async function run({
  apply = APPLY,
  pageSize = PAGE_SIZE,
  maxRecords = MAX_RECORDS,
  now = Date.now(),
  isConfigured = isSupabaseConfigured,
  fetchPage = fetchPaperModelRunsPage,
  fetchEmailRuns = fetchAllPaperEmailRuns,
  processReview = processFundingCarryV2Review
} = {}) {
  if (apply && process.env.CONFIRM_REVIEW_BACKFILL !== "YES") {
    throw new Error("Refusing to apply review backfill without CONFIRM_REVIEW_BACKFILL=YES");
  }
  if (!isConfigured()) {
    throw new Error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY before running the Funding Carry V2 review backfill");
  }

  const normalizedPageSize = Math.min(500, Math.max(1, Math.trunc(Number(pageSize) || 100)));
  const normalizedMaxRecords = normalizeMaxRecords(maxRecords);
  const beforeRows = await fetchAllRuns(normalizedPageSize, fetchPage);
  const beforeEmailRuns = await fetchEmailRuns();
  const before = fundingSummary(beforeEmailRuns);
  const reviewQueueBefore = summarizeRows(beforeRows, now);
  const rawPending = reviewQueueBefore.pending;
  const noTargetRuns = beforeRows.filter((runRow) =>
    isPendingReviewRun(runRow) && !isActionablePaperRun(runRow)
  ).length;
  const actionablePending = beforeRows.filter((runRow) =>
    isPendingReviewRun(runRow) && isActionablePaperRun(runRow)
  ).length;
  const dueRows = beforeRows.filter((runRow) => {
    const state = classifyReviewState(runRow?.review, now);
    return runRow?.model_id === FUNDING_CARRY_V2_MODEL.id
      && isActionablePaperRun(runRow)
      && state.due
      && runRow?.review?.status !== "reviewed";
  });
  const actionableDue = dueRows.length;
  const selectedDueRows = normalizedMaxRecords == null
    ? dueRows
    : dueRows.slice(0, normalizedMaxRecords);

  const results = await mapLimit(selectedDueRows, 2, async (runRow) => {
    try {
      const result = await processReview(runRow, { now, dryRun: !apply });
      return {
        key: paperModelRunKey(runRow),
        rebalanceTime: runRow.rebalance_time,
        status: result.status,
        failed: Boolean(result.failed),
        reason: result.review?.reason || null,
        review: result.review || null
      };
    } catch (error) {
      return {
        key: paperModelRunKey(runRow),
        rebalanceTime: runRow.rebalance_time,
        status: "error",
        failed: true,
        reason: error instanceof Error ? error.message : String(error),
        review: null
      };
    }
  });

  const recovery = {
    checked: selectedDueRows.length,
    reviewed: results.filter((result) => result.status === "reviewed").length,
    newlyReviewed: results.filter((result) => result.status === "reviewed").length,
    pending: results.filter((result) => result.status === "pending").length,
    stillPending: results.filter((result) => result.status === "pending").length,
    failed: results.filter((result) => result.failed || result.status === "error").length,
    skipped: beforeRows.length - selectedDueRows.length,
    reasons: {},
    results
  };
  for (const result of results) {
    const reason = result.reason || (result.status === "error" ? "error" : "未分类");
    recovery.reasons[reason] = (recovery.reasons[reason] || 0) + 1;
  }

  const simulatedRows = mergeReviews(beforeRows, results);
  const afterRows = apply ? await fetchAllRuns(normalizedPageSize, fetchPage) : simulatedRows;
  const afterEmailRuns = apply
    ? await fetchEmailRuns()
    : mergeReviews(beforeEmailRuns, results);
  const unresolved = afterRows
    .filter((runRow) => runRow.model_id === FUNDING_CARRY_V2_MODEL.id)
    .filter((runRow) => runRow.email_status === "sent" && runRow.email_sent_at)
    .filter((runRow) => runRow.review?.status !== "reviewed")
    .map((runRow) => ({
      rebalanceTime: runRow.rebalance_time,
      targets: Array.isArray(runRow.targets) ? runRow.targets.map((target) => target.symbol) : [],
      reason: runRow.review?.diagnostics?.lastError
        || runRow.review?.diagnostics?.retryReason
        || runRow.review?.reason
        || "unknown"
    }));

  const output = {
    mode: apply ? "apply" : "dry-run",
    maxRecords: normalizedMaxRecords,
    truncated: selectedDueRows.length < dueRows.length,
    modelId: FUNDING_CARRY_V2_MODEL.id,
    calculatedAt: new Date(now).toISOString(),
    rawPending,
    noTargetRuns,
    actionablePending,
    actionableDue,
    before,
    after: fundingSummary(afterEmailRuns),
    reviewQueueBefore,
    reviewQueueAfter: summarizeRows(afterRows, now),
    recovery,
    unresolved,
    note: apply
      ? "仅更新 Funding Carry V2 的 cr_paper_model_runs.review；不会修改模型参数或发送邮件。"
      : "dry-run 未写入数据库；使用 --apply 才会更新复盘字段。"
  };
  console.log(JSON.stringify(output, null, 2));
  return output;
}

async function processFundingCarryV2Review(runRow, { now, dryRun }) {
  return processPaperReviewRun(runRow, {
    now,
    dryRun,
    review: async (run, reviewNow) => tryReviewFundingCarryV2PaperRun({
      run,
      now: reviewNow,
      // processPaperReviewRun owns the final write and retry diagnostics.
      persistReview: async () => run
    })
  });
}

async function fetchAllRuns(pageSize, fetchPage) {
  const rows = [];
  for (let offset = 0; ; offset += pageSize) {
    const page = await fetchPage({
      modelId: FUNDING_CARRY_V2_MODEL.id,
      limit: pageSize,
      offset
    });
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}

function mergeReviews(rows, results) {
  const reviewByKey = new Map(results
    .filter((result) => result.key && result.review)
    .map((result) => [result.key, result.review]));
  return rows.map((runRow) => {
    const review = reviewByKey.get(paperModelRunKey(runRow));
    return review ? { ...runRow, review } : runRow;
  });
}

export function summarizeRows(rows, now = Date.now()) {
  const summary = {
    total: rows.length,
    reviewed: 0,
    pending: 0,
    noReview: 0,
    due: 0,
    waitingForWindow: 0,
    dataError: 0,
    oldestPendingAt: null,
    reasons: {}
  };
  for (const runRow of rows) {
    const review = runRow?.review;
    const state = classifyReviewState(review, now);
    if (review?.status === "reviewed") {
      summary.reviewed++;
      continue;
    }
    summary.pending++;
    if (!review) summary.noReview++;
    if (state.due) summary.due++;
    if (state.state === "awaiting_window" || state.state === "retrying") summary.waitingForWindow++;
    if (review?.diagnostics?.status === "data_error") summary.dataError++;
    const timestamp = new Date(runRow?.rebalance_time || 0).getTime();
    if (Number.isFinite(timestamp) && (!summary.oldestPendingAt || timestamp < new Date(summary.oldestPendingAt).getTime())) {
      summary.oldestPendingAt = new Date(timestamp).toISOString();
    }
    const reason = review?.reason || "无 review";
    summary.reasons[reason] = (summary.reasons[reason] || 0) + 1;
  }
  return summary;
}

function isPendingReviewRun(runRow) {
  return runRow?.review?.status !== "reviewed";
}

function isActionablePaperRun(runRow) {
  return Array.isArray(runRow?.targets) && runRow.targets.length > 0;
}

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

function readPositiveInteger(flag, fallback) {
  const index = process.argv.indexOf(flag);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function readOptionalPositiveInteger(flag) {
  return readPositiveInteger(flag, null);
}

function normalizeMaxRecords(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

async function mapLimit(items, limit, fn) {
  const queue = [...items];
  const results = [];
  const workerCount = Math.max(1, Math.min(Number(limit) || 1, queue.length || 1));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (queue.length) {
      const item = queue.shift();
      results.push(await fn(item));
    }
  }));
  return results;
}
