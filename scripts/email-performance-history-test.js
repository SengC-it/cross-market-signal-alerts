import assert from "node:assert/strict";

const previousUrl = process.env.SUPABASE_URL;
const previousKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const previousFetch = globalThis.fetch;
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role";

const {
  fetchAllPaperEmailRunsForModel,
  fetchAllSentAlertsForModel
} = await import("../lib/storage.js?email-performance-history-test");
const {
  buildPaperPerformanceSnapshot,
  calculateCompoundedReturn
} = await import("../lib/performance-summary.js?email-performance-history-test");
const { loadSignalEmailPerformanceSnapshot } = await import("../lib/email-performance-context.js?email-performance-history-test");

const modelId = "funding_carry_perp_reversion_ema100_v2";
const beforeTime = "2026-09-01T00:00:00.000Z";
const completedReturns = Array.from({ length: 13 }, (_, index) => (index % 2 ? -0.002 : 0.001));
const sentRuns = completedReturns.map((returnPct, index) => ({
  model_id: modelId,
  rebalance_time: new Date(Date.UTC(2026, 6, index + 1)).toISOString(),
  email_status: "sent",
  email_sent_at: new Date(Date.UTC(2026, 6, index + 1, 1)).toISOString(),
  targets: [{ symbol: "BTCUSDT" }],
  review: { status: "reviewed", returnPct }
}));
const suppressedRuns = Array.from({ length: 105 }, (_, index) => ({
  model_id: modelId,
  rebalance_time: new Date(Date.UTC(2026, 7, index + 1)).toISOString(),
  email_status: "suppressed",
  email_sent_at: null,
  targets: [],
  review: { status: "reviewed", returnPct: 0.5 }
}));
const databaseRows = [...suppressedRuns, ...sentRuns];
const paperRequests = [];
const fetchedPaperRuns = await fetchAllPaperEmailRunsForModel({
  modelId,
  beforeTime,
  pageSize: 5,
  fetchImpl: paginatedDatabaseFetch(databaseRows, paperRequests, ({ row }) =>
    row.model_id === modelId
      && row.email_status === "sent"
      && row.email_sent_at != null
      && row.rebalance_time < beforeTime
  )
});
assert.equal(fetchedPaperRuns.length, 13, "database filtering must remove suppressed runs before pagination");
assert.ok(paperRequests.length > 1, "the complete PAPER history must be paginated");
assert.ok(paperRequests.every((request) => request.modelId === modelId));
assert.ok(paperRequests.every((request) => request.emailStatus === "eq.sent"));
assert.ok(paperRequests.every((request) => request.emailSentAt === "not.is.null"));
assert.ok(paperRequests.every((request) => request.rebalanceTime === `lt.${beforeTime}`));
const paperSnapshot = buildPaperPerformanceSnapshot({
  runs: fetchedPaperRuns,
  modelId,
  modelLabel: "Funding Carry V2",
  basis: "Production PAPER 已完成周期"
});
assert.equal(paperSnapshot.completedPeriods, 13, "all 13 completed Funding Carry V2 periods must be retained");
assert.ok(Math.abs(paperSnapshot.compoundedReturn - calculateCompoundedReturn(completedReturns)) < 1e-12);
assert.notEqual(paperSnapshot.compoundedReturn, calculateCompoundedReturn(completedReturns.slice(-3)));

const v42Rows = Array.from({ length: 401 }, (_, index) => ({
  signal_key: `v42-history-${index}`,
  model_version: "DYNAMIC_SPOT_V2_2026-08-01",
  strategy_id: "dynamic_relative_strength_breakout",
  sent_at: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
  payload: {
    signalVariant: "STRONG_EXTENSION_10_15",
    delivery: { mode: "EMAIL" },
    review: { status: "reviewed", returnPct: 0.001 }
  }
}));
const v42Requests = [];
const fetchedV42 = await fetchAllSentAlertsForModel({
  modelVersion: "DYNAMIC_SPOT_V2_2026-08-01",
  strategyId: "dynamic_relative_strength_breakout",
  signalVariant: "STRONG_EXTENSION_10_15",
  beforeTime,
  pageSize: 200,
  fetchImpl: paginatedDatabaseFetch(v42Rows, v42Requests, () => true)
});
assert.equal(fetchedV42.length, 401, "V4.2 history must not stop at the 400-row Gate window");
assert.ok(v42Requests.length > 2, "V4.2 complete history must be paginated");
assert.ok(v42Requests.every((request) => request.modelVersion === "DYNAMIC_SPOT_V2_2026-08-01"));
assert.ok(v42Requests.every((request) => request.strategyId === "dynamic_relative_strength_breakout"));
assert.ok(v42Requests.every((request) => request.signalVariant === "STRONG_EXTENSION_10_15"));

let fetchCalls = 0;
globalThis.fetch = async (url) => {
  fetchCalls += 1;
  const parsed = new URL(url);
  const limit = Number(parsed.searchParams.get("limit"));
  const offset = Number(parsed.searchParams.get("offset"));
  return {
    ok: true,
    status: 200,
    json: async () => v42Rows.slice(offset, offset + limit),
    text: async () => ""
  };
};
const v42Signal = {
  signal_key: "v42-current",
  model_version: "DYNAMIC_SPOT_V2_2026-08-01",
  strategy_id: "dynamic_relative_strength_breakout",
  payload: {
    signalVariant: "STRONG_EXTENSION_10_15",
    delivery: { mode: "EMAIL" }
  }
};
const completeSnapshot = await loadSignalEmailPerformanceSnapshot({
  signals: [v42Signal],
  historySignals: [],
  beforeTime
});
assert.equal(completeSnapshot.completedPeriods, 401, "the email-time V4.2 snapshot must use complete history");
assert.equal(fetchCalls, 1, "401 records should require one 500-row page");

if (previousUrl == null) delete process.env.SUPABASE_URL;
else process.env.SUPABASE_URL = previousUrl;
if (previousKey == null) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
else process.env.SUPABASE_SERVICE_ROLE_KEY = previousKey;
globalThis.fetch = previousFetch;

console.log("email performance history tests passed");

function paginatedDatabaseFetch(rows, requests, filter) {
  return async (url) => {
    const parsed = new URL(url);
    const limit = Number(parsed.searchParams.get("limit"));
    const offset = Number(parsed.searchParams.get("offset"));
    const request = {
      limit,
      offset,
      modelId: parsed.searchParams.get("model_id")?.replace(/^eq\./, ""),
      modelVersion: parsed.searchParams.get("model_version")?.replace(/^eq\./, ""),
      strategyId: parsed.searchParams.get("strategy_id")?.replace(/^eq\./, ""),
      signalVariant: parsed.searchParams.get("payload->>signalVariant")?.replace(/^eq\./, ""),
      emailStatus: parsed.searchParams.get("email_status"),
      emailSentAt: parsed.searchParams.get("email_sent_at"),
      rebalanceTime: parsed.searchParams.get("rebalance_time")
    };
    requests.push(request);
    const filtered = rows.filter((row) => filter({ row, request }));
    return {
      ok: true,
      status: 200,
      json: async () => filtered.slice(offset, offset + limit),
      text: async () => ""
    };
  };
}
