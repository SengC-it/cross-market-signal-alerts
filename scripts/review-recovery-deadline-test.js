import assert from "node:assert/strict";
import { runReviewRecovery } from "../lib/review-recovery.js";

const originalNow = Date.now;
let clock = Date.parse("2026-10-25T00:00:00Z");
Date.now = () => clock;

try {
  for (const queue of ["ordinary", "paper"]) {
    const completed = new Set();
    const rows = Array.from({ length: 4 }, (_, index) => ({
      signal_key: `alert-${index}`,
      model_id: `paper-${index}`,
      rebalance_time: "2026-10-24T00:00:00Z",
      targets: [{ symbol: "BTCUSDT" }]
    }));
    const pending = () => rows.filter((row) => !completed.has(row.signal_key));
    const process = async (row) => {
      clock += 600;
      completed.add(row.signal_key);
      return { key: row.signal_key, status: "reviewed" };
    };
    const options = {
      dryRun: true,
      concurrency: 1,
      timeBudgetMs: 1000,
      isConfigured: () => true,
      fetchAlerts: queue === "ordinary" ? pending : () => [],
      fetchPaperRuns: queue === "paper" ? pending : () => [],
      processAlert: process,
      processPaper: process
    };
    const first = await runReviewRecovery(options);
    assert.equal(completed.size, 2, `${queue}: no new work starts after the deadline`);
    assert.equal(first.reviewRecovery.hasMore[queue], true);
    assert.equal(first.reviewRecovery.health, "backlog");
    await runReviewRecovery(options);
    assert.equal(completed.size, 4, `${queue}: remaining rows can resume next invocation`);
    const drained = await runReviewRecovery(options);
    assert.equal(drained.reviewRecovery.health, "healthy");
  }

  let processed = 0;
  const expiredDuringFetch = await runReviewRecovery({
    dryRun: true,
    timeBudgetMs: 1000,
    isConfigured: () => true,
    fetchAlerts: async () => {
      clock += 1000;
      return [{ signal_key: "late" }];
    },
    fetchPaperRuns: () => [],
    processAlert: async () => { processed++; return { status: "reviewed" }; }
  });
  assert.equal(processed, 0, "a queue fetch that exhausts the budget starts no reviews");
  assert.equal(expiredDuringFetch.reviewRecovery.hasMore.ordinary, true);

  let started = 0;
  let release;
  const inFlight = new Promise((resolve) => { release = resolve; });
  const concurrent = runReviewRecovery({
    dryRun: true,
    concurrency: 3,
    timeBudgetMs: 1000,
    isConfigured: () => true,
    fetchAlerts: () => Array.from({ length: 8 }, (_, index) => ({ signal_key: `concurrent-${index}` })),
    fetchPaperRuns: () => [],
    processAlert: async (row) => {
      started++;
      if (started === 3) { clock += 1000; release(); }
      await inFlight;
      return { key: row.signal_key, status: "reviewed" };
    }
  });
  const finished = await concurrent;
  assert.equal(started, 3, "already running workers finish without starting queued work");
  assert.equal(finished.reviewRecovery.ordinarySignals.reviewed, 3);
  assert.equal(finished.reviewRecovery.hasMore.ordinary, true);
  console.log("review-recovery-deadline-test: all assertions passed");
} finally {
  Date.now = originalNow;
}
