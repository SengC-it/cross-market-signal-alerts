import assert from "node:assert/strict";

process.env.SUPABASE_URL = "https://supabase.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";

const originalFetch = globalThis.fetch;
const requests = [];
const missingReviewRows = [
  {
    model_id: "funding-carry-v2",
    rebalance_time: "2026-08-01T00:00:00.000Z",
    targets: [],
    review: null
  },
  {
    model_id: "funding-carry-v2",
    rebalance_time: "2026-08-02T00:00:00.000Z",
    targets: [{ symbol: "BTCUSDT" }],
    review: null
  }
];
const pendingReviewRows = [
  {
    model_id: "funding-carry-v2",
    rebalance_time: "2026-08-03T00:00:00.000Z",
    targets: [],
    review: { status: "pending" }
  },
  {
    model_id: "funding-carry-v2",
    rebalance_time: "2026-08-04T00:00:00.000Z",
    targets: [{ symbol: "ETHUSDT" }],
    review: { status: "pending" }
  }
];

try {
  const { fetchPendingPaperModelRunsForReview } = await import("../lib/storage.js?review-queue-test");
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    requests.push(url);
    assert.equal(url.searchParams.get("targets"), "neq.[]", "paper review queries exclude empty targets");
    const rows = url.searchParams.get("review") === "is.null"
      ? missingReviewRows
      : pendingReviewRows;
    return new Response(JSON.stringify(rows), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  const rows = await fetchPendingPaperModelRunsForReview({ modelId: "funding-carry-v2" });
  assert.equal(requests.length, 2, "both missing-review and pending-review queries run");
  assert.deepEqual(
    rows.map((row) => `${row.model_id}:${row.rebalance_time}`),
    [
      "funding-carry-v2:2026-08-02T00:00:00.000Z",
      "funding-carry-v2:2026-08-04T00:00:00.000Z"
    ],
    "empty-target rows are removed defensively after the query"
  );
} finally {
  globalThis.fetch = originalFetch;
}

console.log("review-queue-test: all assertions passed");
