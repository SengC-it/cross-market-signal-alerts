import {
  fetchSentAlertsForReviewPage,
  isSupabaseConfigured
} from "../lib/storage.js";
import {
  classifyReviewState,
  processOrdinaryReviewAlert
} from "../lib/review-recovery.js";

const APPLY = process.argv.includes("--apply");
const PAGE_SIZE = readPositiveInteger("--page-size", 100);

if (process.argv[1] && process.argv[1].endsWith("backfill-alert-reviews.js")) {
  run().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

export async function run({
  apply = APPLY,
  pageSize = PAGE_SIZE,
  now = Date.now(),
  configured = isSupabaseConfigured,
  fetchPage = fetchSentAlertsForReviewPage,
  processAlert = processOrdinaryReviewAlert
} = {}) {
  if (!configured()) {
    throw new Error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY before running the alert review backfill");
  }

  const beforeRows = await fetchAllSentAlerts(pageSize, fetchPage);
  const before = summarizeRows(beforeRows, now);
  const recovery = {
    checked: 0,
    newlyReviewed: 0,
    stillPending: 0,
    failed: 0,
    skipped: 0,
    reasons: {}
  };

  for (const alert of beforeRows) {
    const previousStatus = alert?.payload?.review?.status;
    const state = classifyReviewState(alert?.payload?.review, now);
    if (!state.due || previousStatus === "reviewed") {
      recovery.skipped++;
      continue;
    }
    recovery.checked++;
    const result = await processAlert(alert, { now, dryRun: !apply });
    if (result.failed) recovery.failed++;
    if (result.status === "reviewed" && previousStatus !== "reviewed") recovery.newlyReviewed++;
    if (result.status === "pending") recovery.stillPending++;
    if (result.status === "skipped") recovery.skipped++;
    const reason = result.review?.reason || "未分类";
    recovery.reasons[reason] = (recovery.reasons[reason] || 0) + 1;
  }

  const after = apply ? summarizeRows(await fetchAllSentAlerts(pageSize, fetchPage), now) : null;
  const output = {
    mode: apply ? "apply" : "dry-run",
    before,
    recovery,
    after,
    note: apply
      ? "仅更新 cr_sent_alerts.payload.review；不会新增信号或发送邮件。"
      : "dry-run 未写入数据库；使用 --apply 才会更新复盘字段。"
  };
  console.log(JSON.stringify(output, null, 2));
  return output;
}

async function fetchAllSentAlerts(pageSize, fetchPage = fetchSentAlertsForReviewPage) {
  const rows = [];
  let offset = 0;
  while (true) {
    const page = await fetchPage({ limit: pageSize, offset });
    rows.push(...page);
    if (page.length < pageSize) return rows;
    offset += page.length;
  }
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
  for (const alert of rows) {
    const review = alert?.payload?.review;
    const state = classifyReviewState(review, now);
    if (review?.status === "reviewed") summary.reviewed++;
    else {
      summary.pending++;
      if (!review) summary.noReview++;
      if (state.due) summary.due++;
      if (state.state === "awaiting_window" || state.state === "retrying") summary.waitingForWindow++;
      if (review?.diagnostics?.status === "data_error") summary.dataError++;
      const timestamp = new Date(alert?.sent_at || 0).getTime();
      if (Number.isFinite(timestamp) && (!summary.oldestPendingAt || timestamp < new Date(summary.oldestPendingAt).getTime())) {
        summary.oldestPendingAt = new Date(timestamp).toISOString();
      }
      const reason = review?.reason || "无 review";
      summary.reasons[reason] = (summary.reasons[reason] || 0) + 1;
    }
  }
  return summary;
}

function readPositiveInteger(flag, fallback) {
  const index = process.argv.indexOf(flag);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}
