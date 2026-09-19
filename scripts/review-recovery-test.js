import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  fetchWithRetry
} from "../lib/storage.js";
import {
  classifyReviewState,
  processOrdinaryReviewAlert,
  processPaperReviewRun,
  runReviewRecovery
} from "../lib/review-recovery.js";
import { run as runAlertBackfill } from "./backfill-alert-reviews.js";
import { run as runFundingCarryV2Backfill } from "./backfill-funding-carry-v2-reviews.js";
import { FUNDING_CARRY_V2_MODEL } from "../lib/funding-carry-v2-paper.js";

const NOW = Date.parse("2026-09-19T00:00:00.000Z");

const reviewedAlert = {
  signal_key: "reviewed",
  sent_at: "2026-09-01T00:00:00.000Z",
  asset: "BTCUSDT",
  payload: { review: { status: "reviewed", outcome: "止盈" } }
};
const dueAlert = {
  signal_key: "due",
  sent_at: "2026-08-01T00:00:00.000Z",
  asset: "BTCUSDT",
  payload: { review: { status: "pending", reviewAfter: NOW - 1 } }
};
const waitingAlert = {
  signal_key: "waiting",
  sent_at: "2026-08-02T00:00:00.000Z",
  asset: "BTCUSDT",
  payload: { review: { status: "pending", reviewAfter: NOW + 3600000 } }
};

assert.equal(classifyReviewState(reviewedAlert.payload.review, NOW).due, false, "reviewed rows are idempotently skipped");
assert.equal(classifyReviewState(dueAlert.payload.review, NOW).due, true, "due pending rows are eligible");
assert.equal(classifyReviewState(waitingAlert.payload.review, NOW).due, false, "future reviewAfter rows are deferred");

let reviewCalls = 0;
let persistCalls = 0;
const directReview = await processOrdinaryReviewAlert(dueAlert, {
  now: NOW,
  loadCandles: async () => [],
  review: () => {
    reviewCalls++;
    return { status: "reviewed", outcome: "止盈", returnPct: 0.01 };
  },
  persist: async () => {
    persistCalls++;
  }
});
assert.equal(directReview.status, "reviewed", "due pending signals are reviewed");
assert.equal(reviewCalls, 1);
assert.equal(persistCalls, 1);

let skippedCalls = 0;
const alreadyReviewed = await processOrdinaryReviewAlert(reviewedAlert, {
  now: NOW,
  loadCandles: async () => {
    skippedCalls++;
    return [];
  },
  review: () => {
    skippedCalls++;
    return { status: "reviewed" };
  },
  persist: async () => {
    skippedCalls++;
  }
});
assert.equal(alreadyReviewed.status, "skipped", "already reviewed signals are never recalculated");
assert.equal(skippedCalls, 0);
const waitingResult = await processOrdinaryReviewAlert(waitingAlert, { now: NOW });
assert.equal(waitingResult.status, "skipped");
assert.equal(waitingResult.skippedUntilRetry, true);

const isolated = await runReviewRecovery({
  dryRun: true,
  now: NOW,
  batchSize: 2,
  timeBudgetMs: 3000,
  isConfigured: () => true,
  fetchAlerts: ({ excludeSignalKeys = [] } = {}) => [
    { signal_key: "bad", sent_at: "2026-08-01T00:00:00.000Z", payload: { review: { status: "pending" } } },
    { signal_key: "good", sent_at: "2026-08-02T00:00:00.000Z", payload: { review: { status: "pending" } } }
  ].filter((alert) => !excludeSignalKeys.includes(alert.signal_key)),
  fetchPaperRuns: () => [],
  processAlert: async (alert) => alert.signal_key === "bad"
    ? { key: alert.signal_key, status: "failed", failed: true }
    : { key: alert.signal_key, status: "reviewed", failed: false }
});
assert.equal(isolated.reviewRecovery.ordinarySignals.failed, 1, "one bad row is recorded as failed");
assert.equal(isolated.reviewRecovery.ordinarySignals.reviewed, 1, "later healthy rows continue after a failure");
assert.equal(isolated.reviewRecovery.health, "degraded");
assert.deepEqual(isolated.reviewRecovery.hasMore, { ordinary: false, paper: false });

const healthy = await runReviewRecovery({
  dryRun: true,
  now: NOW,
  timeBudgetMs: 3000,
  isConfigured: () => true,
  fetchAlerts: ({ excludeSignalKeys = [] } = {}) => [
    { signal_key: "healthy", sent_at: "2026-08-03T00:00:00.000Z", payload: { review: { status: "pending" } } }
  ].filter((alert) => !excludeSignalKeys.includes(alert.signal_key)),
  fetchPaperRuns: () => [],
  processAlert: async (alert) => ({ key: alert.signal_key, status: "reviewed", failed: false })
});
assert.equal(healthy.reviewRecovery.health, "healthy");

const backlog = await runReviewRecovery({
  dryRun: true,
  now: NOW,
  timeBudgetMs: 1000,
  isConfigured: () => true,
  fetchAlerts: ({ excludeSignalKeys = [] } = {}) => [
    { signal_key: "backlog", sent_at: "2026-08-04T00:00:00.000Z", payload: { review: { status: "pending" } } }
  ].filter((alert) => !excludeSignalKeys.includes(alert.signal_key)),
  fetchPaperRuns: () => [],
  processAlert: async (alert) => {
    await new Promise((resolve) => setTimeout(resolve, 1100));
    return { key: alert.signal_key, status: "reviewed", failed: false };
  }
});
assert.equal(backlog.reviewRecovery.health, "backlog");
assert.equal(backlog.reviewRecovery.hasMore.ordinary, true);

const degraded = await runReviewRecovery({
  dryRun: true,
  timeBudgetMs: 1000,
  isConfigured: () => true,
  fetchAlerts: () => Promise.reject(new Error("Supabase review queue unavailable")),
  fetchPaperRuns: () => []
});
assert.equal(degraded.reviewRecovery.health, "degraded", "queue errors surface degraded recovery health");

const v2Rows = ["bad-1", "bad-2", "good-3"].map((key, index) => ({
  model_id: "funding-carry-v2",
  rebalance_time: new Date(NOW - (index + 1) * 3600000).toISOString(),
  review: { status: "pending" }
}));
const v2Keys = new Map(v2Rows.map((row, index) => [
  `${row.model_id}:${row.rebalance_time}`,
  index < 2 ? "bad" : "good"
]));
const v2Recovery = await runReviewRecovery({
  dryRun: true,
  now: NOW,
  batchSize: 1,
  concurrency: 1,
  timeBudgetMs: 3000,
  isConfigured: () => true,
  fetchAlerts: () => [],
  fetchPaperRuns: ({ excludeRunKeys = [] } = {}) => v2Rows.filter((row) => {
    const key = `${row.model_id}:${row.rebalance_time}`;
    return !excludeRunKeys.includes(key);
  }),
  processPaper: async (run) => {
    const key = `${run.model_id}:${run.rebalance_time}`;
    return v2Keys.get(key) === "bad"
      ? { key, status: "failed", failed: true }
      : { key, status: "reviewed", failed: false };
  }
});
assert.equal(v2Recovery.reviewRecovery.paperRuns.failed, 2, "Funding Carry V2 failures receive independent retry slots");
assert.equal(v2Recovery.reviewRecovery.paperRuns.reviewed, 1, "Funding Carry V2 later rows are not head-of-line blocked");
assert.equal(v2Recovery.reviewRecovery.health, "degraded");

const originalFetch = globalThis.fetch;
let retryCalls = 0;
globalThis.fetch = async () => {
  retryCalls++;
  return retryCalls === 1
    ? new Response("Gateway Timeout", { status: 504 })
    : new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
};
const recovered = await fetchWithRetry("https://supabase.test/review", {
  headers: { Authorization: "Bearer test" }
}, { maxAttempts: 4, delaysMs: [0, 0, 0], sleep: async () => {} });
assert.equal(recovered.status, 200, "a transient Supabase 504 recovers on a later attempt");
assert.equal(retryCalls, 2);

retryCalls = 0;
globalThis.fetch = async () => {
  retryCalls++;
  return new Response("Gateway Timeout", { status: 504 });
};
let persistentWriteCalls = 0;
const failedWrite = await processOrdinaryReviewAlert(dueAlert, {
  now: NOW,
  review: () => ({ status: "reviewed", outcome: "止盈" }),
  loadCandles: async () => [],
  persist: async () => {
    persistentWriteCalls++;
    const response = await fetchWithRetry("https://supabase.test/review", {}, {
      maxAttempts: 3,
      delaysMs: [0, 0],
      sleep: async () => {}
    });
    if (!response.ok) throw new Error(`Supabase review patch failed: ${response.status}`);
  }
});
assert.equal(failedWrite.status, "failed", "persistent 504 fails safely without a reviewed write");
assert.equal(failedWrite.failed, true);
assert.equal(persistentWriteCalls, 1);
assert.equal(retryCalls, 3);

let dryRunWrites = 0;
const dryRun = await processOrdinaryReviewAlert(dueAlert, {
  now: NOW,
  dryRun: true,
  loadCandles: async () => [],
  review: () => ({ status: "reviewed", outcome: "止盈" }),
  persist: async () => {
    dryRunWrites++;
  }
});
assert.equal(dryRun.status, "reviewed");
assert.equal(dryRunWrites, 0, "dry-run does not write review state");

let applyWrites = 0;
await processPaperReviewRun({
  model_id: "test-paper",
  rebalance_time: new Date(NOW - 3600000).toISOString(),
  targets: []
}, {
  now: NOW,
  review: () => ({ status: "reviewed", outcome: "flat" }),
  persist: async () => {
    applyWrites++;
  }
});
assert.equal(applyWrites, 1, "apply mode writes the review record");

let failedPaperReview = null;
const retryablePaper = await processPaperReviewRun({
  model_id: "funding-carry-v2",
  rebalance_time: new Date(NOW - 3600000).toISOString(),
  targets: [{ symbol: "BTCUSDT" }]
}, {
  now: NOW,
  review: () => {
    throw new Error("historical candles unavailable");
  },
  persist: async ({ review }) => {
    failedPaperReview = review;
  }
});
assert.equal(retryablePaper.status, "pending", "review data errors never become reviewed");
assert.equal(failedPaperReview.status, "pending");
assert.equal(failedPaperReview.diagnostics.status, "data_error");
assert.equal(failedPaperReview.diagnostics.attemptCount, 1);
assert.equal(new Date(failedPaperReview.diagnostics.nextRetryAt).getTime(), NOW + 5 * 60 * 1000);

const historicalRows = Array.from({ length: 400 }, (_, index) => ({
  signal_key: `recent-${index}`,
  sent_at: new Date(NOW - index * 3600000).toISOString(),
  payload: { review: { status: "reviewed" } }
}));
historicalRows.push({
  signal_key: "old-pending",
  sent_at: "2024-01-01T00:00:00.000Z",
  payload: { review: { status: "pending" } }
});
historicalRows.push({
  signal_key: "old-pending-2",
  sent_at: "2024-01-02T00:00:00.000Z",
  payload: { review: { status: "pending" } }
});
const originalLog = console.log;
console.log = () => {};
let backfillFetches = 0;
const backfillResult = await runAlertBackfill({
  apply: false,
  now: NOW,
  pageSize: 100,
  maxRecords: 1,
  configured: () => true,
  fetchPage: ({ limit, offset }) => {
    backfillFetches++;
    return historicalRows.slice(offset, offset + limit);
  },
  processAlert: async (alert) => ({
    key: alert.signal_key,
    status: "pending",
    failed: false,
    review: alert.payload.review
  })
});
console.log = originalLog;
assert.ok(backfillFetches >= 5, "backfill paginates through the full history");
assert.equal(backfillResult.before.total, 402, "pending signals older than the latest 400 remain discoverable");
assert.equal(backfillResult.recovery.checked, 1);
assert.equal(backfillResult.recovery.stillPending, 1);
assert.equal(backfillResult.maxRecords, 1);
assert.equal(backfillResult.truncated, true, "max-records caps the selected due rows");

const fundingRows = ["funding-1", "funding-2"].map((_key, index) => ({
  model_id: FUNDING_CARRY_V2_MODEL.id,
  rebalance_time: new Date(NOW - (index + 1) * 3600000).toISOString(),
  targets: [{ symbol: "BTCUSDT" }],
  review: { status: "pending" }
}));
const fundingBackfillResult = await runFundingCarryV2Backfill({
  apply: false,
  now: NOW,
  maxRecords: 1,
  isConfigured: () => true,
  fetchPage: () => fundingRows,
  fetchEmailRuns: () => [],
  processReview: async () => ({
    status: "reviewed",
    failed: false,
    review: { status: "reviewed", outcome: "flat" }
  })
});
assert.equal(fundingBackfillResult.recovery.checked, 1);
assert.equal(fundingBackfillResult.maxRecords, 1);
assert.equal(fundingBackfillResult.truncated, true, "Funding Carry V2 backfill honors max-records");

const previousConfirmation = process.env.CONFIRM_REVIEW_BACKFILL;
delete process.env.CONFIRM_REVIEW_BACKFILL;
try {
  await assert.rejects(
    () => runAlertBackfill({ apply: true, configured: () => true }),
    { message: "Refusing to apply review backfill without CONFIRM_REVIEW_BACKFILL=YES" }
  );
  await assert.rejects(
    () => runFundingCarryV2Backfill({ apply: true, isConfigured: () => true }),
    { message: "Refusing to apply review backfill without CONFIRM_REVIEW_BACKFILL=YES" }
  );
} finally {
  if (previousConfirmation === undefined) delete process.env.CONFIRM_REVIEW_BACKFILL;
  else process.env.CONFIRM_REVIEW_BACKFILL = previousConfirmation;
}

globalThis.fetch = originalFetch;
process.env.CRON_SECRET = "review-test-secret";
const { default: cronHandler } = await import("../api/cron.js");
let cronBody = null;
let cronStatus = null;
const response = {
  setHeader() {},
  status(code) {
    cronStatus = code;
    return this;
  },
  json(value) {
    cronBody = value;
  }
};
await cronHandler({
  headers: { authorization: "Bearer review-test-secret" },
  query: { group: "review", dryRun: "1" }
}, response);
assert.equal(cronStatus, 200);
assert.ok(cronBody.reviewRecovery, "review cron returns recovery metrics");
assert.equal(Object.hasOwn(cronBody, "candidates"), false, "review cron does not create scan candidates");
assert.equal(Object.hasOwn(cronBody, "emailResult"), false, "review cron does not send trading signal email");

const strategyFiles = [
  "lib/config.js",
  "lib/funding-carry-v2-paper.js",
  "lib/model-metadata.js",
  "lib/signal-density-config.js",
  "lib/signal-density-quality-policy.js",
  "lib/signal-density.js",
  "lib/strategies.js",
  "lib/strategies/dynamic-production.js",
  "lib/strategies/strong-extension.js",
  "lib/trading/trade-plan.js",
  "lib/trading/trade-spec.js",
  "lib/v3-3-paper.js",
  "lib/v3-4-paper.js",
  "lib/v3-paper.js"
];
execFileSync("git", ["diff", "--quiet", "origin/main", "--", ...strategyFiles], { cwd: process.cwd(), stdio: "ignore" });
console.log("review-recovery-test: all assertions passed");
