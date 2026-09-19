import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.SUPABASE_URL = "https://supabase.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";
process.env.DASHBOARD_SECRET = "dashboard-test-secret";

const reviewLog = {
  id: 1,
  created_at: "2026-09-19T00:00:00.000Z",
  started_at: "2026-09-19T00:00:00.000Z",
  finished_at: "2026-09-19T00:00:01.000Z",
  scan_group: "review",
  candidates_count: 2,
  signals_count: 1,
  emailed: false,
  email_status: "review_recovery",
  email_result: {
    reviewRecovery: {
      ordinarySignals: { checked: 1, reviewed: 1, pending: 0, failed: 0 },
      paperRuns: { checked: 1, reviewed: 1, pending: 0, failed: 0 }
    }
  },
  sent_alert_keys: [],
  errors: [],
  warnings: []
};
const sentAlert = {
  signal_key: "signal-1",
  asset: "BTCUSDT",
  strategy_id: "dynamic_relative_strength_breakout",
  interval: "1h",
  trigger_time: "2026-09-18T23:00:00.000Z",
  sent_at: "2026-09-18T23:00:01.000Z",
  delivery_status: "sent",
  model_version: "dynamic_production_v1",
  payload: { signalTier: "TRADE_WATCH", review: { status: "reviewed", outcome: "止盈" } }
};
const paperRun = {
  model_id: "funding_carry_perp_reversion_ema100_v2",
  model_version: "FUNDING CARRY PERP Z-SCORE V2 REVERSION EMA100 PAPER 2026-08-02",
  model_fingerprint: "test-fingerprint",
  code_commit: "test-commit",
  rebalance_time: "2026-09-16T00:00:00.000Z",
  data_cutoff_time: "2026-09-16T00:00:00.000Z",
  state: "PAPER",
  deployment_gate_passed: false,
  capital_weight: 0,
  predicted_beta: 0,
  gross_exposure: 0.01,
  eligible_symbols: 1,
  targets: [{
    symbol: "BTCUSDT",
    side: "LONG",
    targetWeight: 0.01,
    referencePrice: 100,
    maxHoldingHours: 48,
    outcome: "profit",
    returnPct: 0.01
  }],
  risk_state: {},
  diagnostics: { historicalGateVersion: "test" },
  review: {
    status: "reviewed",
    outcome: "profit",
    returnPct: 0.01,
    positions: [{
      symbol: "BTCUSDT",
      outcome: "profit",
      entryPrice: 100,
      exitPrice: 101,
      directionalPriceReturn: 0.01,
      returnPct: 0.01,
      tradingCost: 0.001
    }]
  },
  email_status: "sent",
  email_claimed_at: "2026-09-16T00:00:02.000Z",
  email_sent_at: "2026-09-16T00:00:03.000Z",
  email_result: { messageId: "test-message" },
  created_at: "2026-09-16T00:00:01.000Z"
};

globalThis.fetch = async (input) => {
  const url = String(input);
  let body = [];
  if (url.includes("cr_run_logs")) body = [reviewLog];
  if (url.includes("cr_sent_alerts")) body = [sentAlert];
  if (url.includes("cr_paper_model_runs")) body = [paperRun];
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
};

const { default: statusHandler } = await import("../api/status.js?review-recovery-compatibility-test");
let statusCode = null;
let statusBody = null;
const response = {
  setHeader() {},
  status(code) {
    statusCode = code;
    return this;
  },
  json(value) {
    statusBody = value;
  }
};

await statusHandler({
  headers: { authorization: "Bearer dashboard-test-secret" },
  query: { limit: "10", alertLimit: "10", paperLimit: "10" }
}, response);

assert.equal(statusCode, 200, "main status API remains available");
assert.equal(statusBody.ok, true);
assert.equal(statusBody.sentAlerts[0].signal_key, "signal-1", "Recent Signal Feed data is still returned");
assert.ok(statusBody.performanceSummary, "historical performance summary is still returned");
assert.equal(statusBody.fundingCarryV2.modelId, paperRun.model_id, "Funding Carry V2 status is still returned");
assert.ok(statusBody.summary.reviewRecovery, "review recovery summary is visible through the status API");
assert.equal(statusBody.emailNotifications.length, 2, "legacy and paper email history remain visible");

const scannerSource = readFileSync(new URL("../lib/scanner.js", import.meta.url), "utf8");
assert.match(scannerSource, /loadSignalEmailPerformanceSnapshot/, "production email performance context remains wired");
assert.match(scannerSource, /const emailPerformanceHistory = sentAlerts/, "scanner still supplies recent history to email context");
assert.doesNotMatch(scannerSource, /async function reviewRecentSentAlerts/, "ordinary scan no longer owns review persistence");

console.log("review-recovery-compatibility-test: all assertions passed");
