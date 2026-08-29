import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  FUNDING_CARRY_V2_MODEL,
  isStaleFundingCarryV2Run,
  monitorOpenFundingCarryV2Runs,
  reviewFundingCarryV2PaperRun
} from "../lib/funding-carry-v2-paper.js";
import {
  buildForwardStrategyPerformance,
  buildV42ForwardPromotionGate
} from "../lib/performance-summary.js";

const HOUR_MS = 60 * 60 * 1000;
const entryTime = Date.UTC(2026, 7, 1);

const fundingRun = (rebalanceTime = entryTime, overrides = {}) => ({
  model_id: FUNDING_CARRY_V2_MODEL.id,
  model_version: FUNDING_CARRY_V2_MODEL.version,
  rebalance_time: new Date(rebalanceTime).toISOString(),
  targets: [{
    symbol: "BTCUSDT",
    side: "SHORT",
    direction: -1,
    targetWeight: -0.1,
    referencePrice: 100,
    stopLoss: 105,
    fundingRate: 0.001,
    exitSignedZ: -999,
    zWindow: 2,
    maxHoldingHours: 48,
    trendRules: []
  }],
  review: { status: "pending", reason: "waiting" },
  ...overrides
});

const candles = (hours, options = {}) => Array.from({ length: hours + 1 }, (_, index) => ({
  openTime: entryTime + index * HOUR_MS,
  open: options.openAt48 && index === 48 ? options.openAt48 : 100,
  high: options.highAt48 && index === 48 ? options.highAt48 : 101,
  low: 99,
  close: 100
}));
const fundingRows = [
  { fundingTime: entryTime - 16 * HOUR_MS, fundingRate: 0.0001 },
  { fundingTime: entryTime - 8 * HOUR_MS, fundingRate: 0.0002 },
  { fundingTime: entryTime + 8 * HOUR_MS, fundingRate: 0.001 },
  { fundingTime: entryTime + 16 * HOUR_MS, fundingRate: 0.001 }
];

const withinWindow = reviewFundingCarryV2PaperRun({
  run: fundingRun(),
  hourlyCandlesBySymbol: new Map([["BTCUSDT", candles(47)]]),
  fundingBySymbol: new Map([["BTCUSDT", fundingRows]]),
  now: entryTime + 48 * HOUR_MS
});
assert.equal(withinWindow.status, "pending", "a Funding Carry run inside 48 hours must remain pending");

const maxHolding = reviewFundingCarryV2PaperRun({
  run: fundingRun(),
  hourlyCandlesBySymbol: new Map([["BTCUSDT", candles(48, { openAt48: 102, highAt48: 110 })]]),
  fundingBySymbol: new Map([["BTCUSDT", fundingRows]]),
  now: entryTime + 49 * HOUR_MS
});
assert.equal(maxHolding.status, "reviewed");
assert.equal(maxHolding.positions[0].exitReason, "max_holding", "the 48-hour open must exit before inspecting that candle's later high/low");
assert.equal(maxHolding.positions[0].exitPrice, 102);
assert.ok(Math.abs(maxHolding.positions[0].tradingCost - 0.0012) < 1e-12, "round-trip trading cost must be charged once");

const longFundingRun = fundingRun(entryTime, {
  targets: [{
    ...fundingRun().targets[0],
    symbol: "ETHUSDT",
    side: "LONG",
    direction: 1,
    targetWeight: 0.1,
    fundingRate: -0.001,
    stopLoss: 95
  }]
});
const longFunding = reviewFundingCarryV2PaperRun({
  run: longFundingRun,
  hourlyCandlesBySymbol: new Map([["ETHUSDT", candles(48)]]),
  fundingBySymbol: new Map([["ETHUSDT", fundingRows.map((row) => ({ ...row, fundingRate: -row.fundingRate }))]]),
  now: entryTime + 49 * HOUR_MS
});
assert.ok(maxHolding.positions[0].fundingReturn > 0, "short positive funding must receive funding");
assert.ok(longFunding.positions[0].fundingReturn > 0, "long negative funding must receive funding");

const oldRun = fundingRun(entryTime);
const middleRun = fundingRun(entryTime + HOUR_MS);
const newestRun = fundingRun(entryTime + 2 * HOUR_MS);
const reviewedRun = fundingRun(entryTime - HOUR_MS, { review: { status: "reviewed", returnPct: 0.01 } });
const calls = [];
const persisted = [];
const recovery = await monitorOpenFundingCarryV2Runs({
  now: entryTime + 72 * HOUR_MS,
  limit: 10,
  fetchRuns: async () => [newestRun, reviewedRun, middleRun, oldRun],
  reviewRun: async ({ run }) => {
    calls.push(run.rebalance_time);
    if (run === middleRun) throw new Error("temporary market data error");
    return run === newestRun
      ? { status: "pending", reason: "not ready", diagnostics: { status: "retry_pending" } }
      : { status: "reviewed", returnPct: 0.01 };
  },
  persistReview: async (update) => {
    persisted.push(update);
    return update;
  }
});
assert.deepEqual(calls, [oldRun.rebalance_time, middleRun.rebalance_time, newestRun.rebalance_time], "historical pending runs must be rediscovered oldest first; reviewed runs are skipped");
assert.equal(recovery.checked, 3, "multiple pending runs must be reviewed in one bounded batch");
assert.equal(recovery.reviewed, 1);
assert.equal(recovery.pending, 2, "one data error must not block later runs");
assert.equal(persisted.length, 1, "the monitor persists an explicit retry diagnostic for the failed run");
assert.equal(persisted[0].review.diagnostics.status, "stale_review");
assert.match(persisted[0].review.reason, /temporary market data error/);

assert.equal(isStaleFundingCarryV2Run(oldRun, entryTime + 55 * HOUR_MS), true, "stale Funding Carry pending must be detected after holding plus grace");
assert.equal(isStaleFundingCarryV2Run({
  ...oldRun,
  model_id: "v3_4_unified_residual_volatility_risk",
  targets: [{ maxHoldingHours: 168 }]
}, entryTime + 55 * HOUR_MS), false, "V3.4 168-hour pending must not be classified by the Funding V2 stale detector");

let mutableRun = fundingRun();
let reviewCalls = 0;
const idempotentDependencies = {
  now: entryTime + 72 * HOUR_MS,
  fetchRuns: async () => mutableRun.review.status === "pending" ? [mutableRun] : [],
  reviewRun: async ({ run, persistReview }) => {
    reviewCalls += 1;
    const review = { status: "reviewed", returnPct: 0.02 };
    await persistReview({ modelId: run.model_id, rebalanceTime: run.rebalance_time, review });
    return review;
  },
  persistReview: async ({ review }) => {
    mutableRun = { ...mutableRun, review };
    return mutableRun;
  }
};
await monitorOpenFundingCarryV2Runs(idempotentDependencies);
await monitorOpenFundingCarryV2Runs(idempotentDependencies);
assert.equal(reviewCalls, 1, "a completed backfill must not calculate or persist a duplicate return");

const previousUrl = process.env.SUPABASE_URL;
const previousKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role";
const { fetchPendingPaperModelRunsForModel, updatePendingPaperModelReview } = await import("../lib/storage.js?review-integrity-test");
let lookupUrl = null;
await fetchPendingPaperModelRunsForModel({
  modelId: FUNDING_CARRY_V2_MODEL.id,
  limit: 12,
  fetchImpl: async (url) => {
    lookupUrl = new URL(url);
    return { ok: true, status: 200, json: async () => [oldRun], text: async () => "" };
  }
});
assert.equal(lookupUrl.searchParams.get("review->>status"), "eq.pending");
assert.equal(lookupUrl.searchParams.get("targets"), "neq.[]");
assert.equal(lookupUrl.searchParams.get("order"), "rebalance_time.asc");
let updateUrl = null;
const claimed = await updatePendingPaperModelReview({
  modelId: FUNDING_CARRY_V2_MODEL.id,
  rebalanceTime: oldRun.rebalance_time,
  review: { status: "reviewed", returnPct: 0.01 },
  fetchImpl: async (url) => {
    updateUrl = new URL(url);
    return { ok: true, status: 200, json: async () => [], text: async () => "" };
  }
});
assert.equal(updateUrl.searchParams.get("review->>status"), "eq.pending", "review persistence must be compare-and-set idempotent");
assert.equal(claimed, null, "a concurrent already-reviewed row must not be overwritten");
if (previousUrl == null) delete process.env.SUPABASE_URL;
else process.env.SUPABASE_URL = previousUrl;
if (previousKey == null) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
else process.env.SUPABASE_SERVICE_ROLE_KEY = previousKey;

const reviewed = (returnPct) => ({ status: "reviewed", returnPct });
const signal = ({ key, modelVersion = "legacy", strategyId = "legacy", variant = null, review = { status: "pending" }, at = entryTime }) => ({
  signal_key: key,
  model_version: modelVersion,
  strategy_id: strategyId,
  sent_at: new Date(at).toISOString(),
  payload: { signalVariant: variant, review }
});
const paper = ({ modelId, at, review, targets = 2 }) => ({
  model_id: modelId,
  rebalance_time: new Date(at).toISOString(),
  email_status: "sent",
  email_sent_at: new Date(at + 1000).toISOString(),
  targets: Array.from({ length: targets }, (_, index) => ({ symbol: `ASSET${index}` })),
  review
});
const performance = buildForwardStrategyPerformance({
  emailNotifications: [
    signal({ key: "legacy-win", review: reviewed(0.02) }),
    signal({ key: "legacy-loss", review: reviewed(-0.01), at: entryTime + HOUR_MS }),
    signal({ key: "v42", modelVersion: "DYNAMIC_SPOT_V2_2026-08-01", strategyId: "dynamic_relative_strength_breakout", variant: "STRONG_EXTENSION_10_15" }),
    signal({ key: "v42-other", modelVersion: "DYNAMIC_SPOT_V2_2026-08-01", strategyId: "dynamic_relative_strength_breakout", variant: "STRONG_CORE_8_10" }),
    signal({ key: "v42-weak", modelVersion: "DYNAMIC_SPOT_V2_2026-08-01", strategyId: "dynamic_relative_weakness_breakdown" })
  ],
  paperModelRuns: [
    paper({ modelId: "v3_4_unified_residual_volatility_risk", at: entryTime, review: reviewed(0.03) }),
    paper({ modelId: FUNDING_CARRY_V2_MODEL.id, at: entryTime, review: reviewed(-0.02) }),
    paper({ modelId: FUNDING_CARRY_V2_MODEL.id, at: entryTime, review: reviewed(0.99) })
  ]
});
assert.equal(performance.legacyProduction.signals, 2);
assert.equal(performance.v42Forward.signals, 1, "V4.2 Forward must include only the requested production strategy and variant");
assert.equal(performance.v34ForwardPaper.periods, 1);
assert.equal(performance.fundingCarryV2ForwardPaper.periods, 1, "one PAPER run with multiple targets or duplicate rows counts once");
assert.equal(performance.fundingCarryV2ForwardPaper.signals, 2);
assert.equal(performance.fundingCarryV2ForwardPaper.netReturn, -0.02);
assert.equal(buildV42ForwardPromotionGate(performance.v42Forward).status, "INSUFFICIENT_FORWARD_SAMPLE");
assert.equal(buildV42ForwardPromotionGate({ reviewed: 30, averageNetReturn: 0.01, profitFactor: 1.2, maxDrawdown: -0.1, dataCompleteness: 0.96 }).status, "FORWARD_GATE_PASS");
assertFiniteNumbers(performance);

const dashboardSource = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const policySource = readFileSync(new URL("../lib/production-signal-policy.js", import.meta.url), "utf8");
const performanceSource = readFileSync(new URL("../lib/performance-summary.js", import.meta.url), "utf8");
assert.match(dashboardSource, /历史验证 ≠ Forward 实际表现/);
assert.match(dashboardSource, /INSUFFICIENT_FORWARD_SAMPLE|forwardPromotionGate/);
assert.match(policySource, /autoTrading: false/);
assert.match(policySource, /orderPlacement: false/);
assert.doesNotMatch(performanceSource, /v4-2-strong-extension-quality\.json/, "historical V4.2 artifact must never enter Forward statistics");

console.log("review integrity and forward performance tests passed");

function assertFiniteNumbers(value) {
  const serialized = JSON.stringify(value);
  assert.doesNotMatch(serialized, /NaN|Infinity|undefined|\[object Object\]/);
  for (const item of Object.values(value || {})) {
    if (typeof item === "number") assert.ok(Number.isFinite(item));
    if (item && typeof item === "object") assertFiniteNumbers(item);
  }
}
