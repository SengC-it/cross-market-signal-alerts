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
const MAX_RECORDS = readOptionalPositiveInteger("--max-records");

if (process.argv[1] && process.argv[1].endsWith("backfill-alert-reviews.js")) {
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
  configured = isSupabaseConfigured,
  fetchPage = fetchSentAlertsForReviewPage,
  processAlert = processOrdinaryReviewAlert
} = {}) {
  if (apply && process.env.CONFIRM_REVIEW_BACKFILL !== "YES") {
    throw new Error("Refusing to apply review backfill without CONFIRM_REVIEW_BACKFILL=YES");
  }
  if (!configured()) {
    throw new Error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY before running the alert review backfill");
  }

  const beforeRows = await fetchAllSentAlerts(pageSize, fetchPage);
  const before = summarizeRows(beforeRows, now);
  const normalizedMaxRecords = normalizeMaxRecords(maxRecords);
  const dueRows = beforeRows.filter((alert) => {
    const state = classifyReviewState(alert?.payload?.review, now);
    return state.due && alert?.payload?.review?.status !== "reviewed";
  });
  const selectedRows = normalizedMaxRecords == null
    ? dueRows
    : dueRows.slice(0, normalizedMaxRecords);
  const recovery = {
    checked: 0,
    newlyReviewed: 0,
    stillPending: 0,
    failed: 0,
    skipped: beforeRows.length - selectedRows.length,
    reasons: {}
  };

  for (const alert of selectedRows) {
    const previousStatus = alert?.payload?.review?.status;
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
    maxRecords: normalizedMaxRecords,
    truncated: selectedRows.length < dueRows.length,
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

function readOptionalPositiveInteger(flag) {
  return readPositiveInteger(flag, null);
}

function normalizeMaxRecords(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}
