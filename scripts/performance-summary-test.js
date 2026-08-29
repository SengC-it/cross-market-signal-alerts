import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildEmailNotifications } from "../api/status.js";
import { buildPerformanceSummary } from "../lib/performance-summary.js";

const reviewed = (returnPct, outcome = "已复盘") => ({ status: "reviewed", returnPct, outcome });
const legacyAlert = (signalKey, asset, review, payload = {}) => ({
  signal_key: signalKey,
  asset,
  sent_at: "2026-01-01T00:00:00.000Z",
  trigger_time: "2026-01-01T00:00:00.000Z",
  payload: { ...payload, review }
});
const paperTarget = (symbol, returnPct) => ({
  symbol,
  side: returnPct >= 0 ? "LONG" : "SHORT",
  targetWeight: returnPct >= 0 ? 0.2 : -0.2,
  referencePrice: 100,
  returnPct,
  outcome: returnPct > 0 ? "盈利" : returnPct < 0 ? "亏损" : "持平"
});
const paperRun = ({ modelId, rebalanceTime, portfolioReturn, targets, status = "reviewed", emailStatus = "sent", emailSentAt = "2026-02-01T00:00:00.000Z" }) => ({
  model_id: modelId,
  model_version: "V3.4 PAPER",
  rebalance_time: rebalanceTime,
  email_status: emailStatus,
  email_sent_at: emailSentAt,
  targets,
  review: status === "reviewed"
    ? {
        status,
        returnPct: portfolioReturn,
        positions: targets.map((target) => ({
          symbol: target.symbol,
          outcome: target.outcome,
          returnPct: target.returnPct,
          directionalPriceReturn: target.returnPct,
          fundingReturn: 0,
          tradingCost: 0
        }))
      }
    : { status: "pending", reason: "持仓周期未结束" }
});

const legacySignals = [
  legacyAlert("legacy-profit", "BTCUSDT", reviewed(0.1)),
  legacyAlert("legacy-profit", "BTCUSDT", { status: "pending" }),
  legacyAlert("legacy-loss", "BTCUSDT", reviewed(-0.05)),
  legacyAlert("legacy-loss-2", "BTCUSDT", reviewed(-0.01)),
  legacyAlert("legacy-pending", "ETHUSDT", { status: "pending" }),
  legacyAlert("legacy-flat", "XRPUSDT", reviewed(0)),
  legacyAlert("legacy-profit-2", "SOLUSDT", reviewed(0.02)),
  legacyAlert("research-only", "BADUSDT", reviewed(1), { signalTier: "RESEARCH_ONLY" }),
  legacyAlert("suppressed-paper", "HIDDENUSDT", reviewed(1), {
    delivery: { mode: "PAPER", emailSuppressed: true }
  })
];
const losingPaperRun = paperRun({
  modelId: "paper-model",
  rebalanceTime: "2026-02-01T00:00:00.000Z",
  portfolioReturn: -0.04,
  targets: [paperTarget("BTCUSDT", 0.03), paperTarget("DOGEUSDT", -0.02)]
});
const profitablePaperRun = paperRun({
  modelId: "paper-model",
  rebalanceTime: "2026-02-08T00:00:00.000Z",
  portfolioReturn: 0.01,
  targets: [paperTarget("ADAUSDT", 0.015)]
});
const pendingPaperRun = paperRun({
  modelId: "paper-model",
  rebalanceTime: "2026-02-15T00:00:00.000Z",
  portfolioReturn: null,
  targets: [paperTarget("LINKUSDT", 0)],
  status: "pending"
});
const unsentPaperRun = paperRun({
  modelId: "paper-model",
  rebalanceTime: "2026-02-22T00:00:00.000Z",
  portfolioReturn: 1,
  targets: [paperTarget("UNSENTUSDT", 1)],
  emailStatus: "pending",
  emailSentAt: null
});
const paperRuns = [
  losingPaperRun,
  { ...losingPaperRun },
  profitablePaperRun,
  pendingPaperRun,
  unsentPaperRun
];

const notifications = buildEmailNotifications(legacySignals, paperRuns);
const summary = buildPerformanceSummary({
  emailNotifications: notifications,
  paperModelRuns: paperRuns,
  calculatedAt: "2026-08-28T00:00:00.000Z"
});

assert.equal(summary.totalSignals, 10, "legacy and paper targets should count as unique signals");
assert.equal(summary.reviewedSignals, 8);
assert.equal(summary.pendingSignals, 2);
assert.equal(summary.reviewRate, 8 / 10);
assert.equal(summary.profitSignals, 4);
assert.equal(summary.lossSignals, 3);
assert.equal(summary.flatSignals, 1);
assert.equal(summary.winRate, 4 / 7);
assert.equal(summary.totalAssets, 7);
assert.equal(summary.profitableAssets, 3, "profitable assets should be unique");
assert.equal(summary.losingAssets, 2, "losing assets should be unique");
assert.ok(Math.abs(summary.grossProfitReturn - 0.165) < 1e-12);
assert.ok(Math.abs(summary.grossLossReturn - (-0.08)) < 1e-12);
assert.ok(Math.abs(summary.netSignalReturn - 0.085) < 1e-12);
assert.ok(Math.abs(summary.averageSignalReturn - (0.085 / 8)) < 1e-12);
assert.ok(Math.abs(summary.profitFactor - (0.165 / 0.08)) < 1e-12);
assert.equal(summary.reviewedPaperRuns, 2, "one paper run with multiple targets should count once");
assert.equal(summary.profitablePaperRuns, 1);
assert.equal(summary.losingPaperRuns, 1);
assert.ok(Math.abs(summary.paperPortfolioReturn - (-0.03)) < 1e-12, "paper portfolio returns must not repeat per target");
assert.equal(summary.calculatedAt, "2026-08-28T00:00:00.000Z");
assert.match(summary.returnBasis, /等权信号/);

const empty = buildPerformanceSummary();
assert.equal(empty.totalSignals, 0);
assert.equal(empty.reviewedSignals, 0);
assert.equal(empty.pendingSignals, 0);
assert.equal(empty.netSignalReturn, null);
assert.equal(empty.paperPortfolioReturn, null);
assert.equal(empty.strategyPerformance.legacyProduction.signals, 0);
assert.equal(empty.strategyPerformance.v42Forward.signals, 0);
assert.equal(empty.forwardPromotionGate.status, "INSUFFICIENT_FORWARD_SAMPLE");
assert.equal(empty.returnBasis, "等权信号收益简单累计；PAPER 组合收益按唯一 model_id + rebalance_time 周期累计");

const noLoss = buildPerformanceSummary({
  emailNotifications: [legacyAlert("only-profit", "BTCUSDT", reviewed(0.1))]
});
assert.equal(noLoss.profitFactor, null, "zero gross loss must not produce Infinity");
assertFiniteNumbers(summary);
assertFiniteNumbers(empty);
assertFiniteNumbers(noLoss);

const previousUrl = process.env.SUPABASE_URL;
const previousKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role";
const { fetchAllPaperEmailRuns, fetchAllSentAlerts } = await import("../lib/storage.js?performance-summary-test");

const sentRows = Array.from({ length: 1205 }, (_, index) => ({ signal_key: `signal-${index}` }));
const sentRequests = [];
const fetchedSentRows = await fetchAllSentAlerts({
  pageSize: 500,
  fetchImpl: paginatedFetch(sentRows, sentRequests)
});
assert.equal(fetchedSentRows.length, 1205, "more than 1000 historical alerts must be fully paginated");
assert.equal(sentRequests.length, 3);
assert.deepEqual(sentRequests.map((request) => request.offset), [0, 500, 1000]);
assert.ok(sentRequests.every((request) => request.deliveryStatus === "eq.sent"));
assert.ok(sentRequests.every((request) => request.order === "sent_at.asc,signal_key.asc"));

const paperRows = Array.from({ length: 450 }, (_, index) => ({ model_id: `paper-${index}` }));
const paperRequests = [];
const fetchedPaperRows = await fetchAllPaperEmailRuns({
  pageSize: 200,
  fetchImpl: paginatedFetch(paperRows, paperRequests)
});
assert.equal(fetchedPaperRows.length, 450, "more than 200 paper runs must be fully paginated");
assert.equal(paperRequests.length, 3);
assert.ok(paperRequests.every((request) => request.emailStatus === "eq.sent"));
assert.ok(paperRequests.every((request) => request.emailSentAt === "not.is.null"));

if (previousUrl == null) delete process.env.SUPABASE_URL;
else process.env.SUPABASE_URL = previousUrl;
if (previousKey == null) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
else process.env.SUPABASE_SERVICE_ROLE_KEY = previousKey;

const dashboardSource = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const statusSource = readFileSync(new URL("../api/status.js", import.meta.url), "utf8");
assert.ok(dashboardSource.includes("renderAlertsV2(emailNotifications)"), "existing Signal Feed rendering must remain wired");
assert.ok(dashboardSource.includes('class="signal-feed"'), "existing Signal Feed markup must remain intact");
assert.ok(dashboardSource.includes("查看详情"), "Signal Feed details must remain available");
assert.ok(dashboardSource.includes("renderPerformanceSummary(data.performanceSummary)"));
assert.ok(dashboardSource.includes("等权信号收益用于衡量信号整体质量，不代表真实账户资金曲线。"));
assert.ok(dashboardSource.includes("PAPER 组合周期累计"));
assert.ok(statusSource.includes("fetchAllSentAlerts()"));
assert.ok(statusSource.includes("fetchAllPaperEmailRuns()"));
assert.ok(statusSource.includes("buildEmailNotifications(historicalSentAlerts, historicalPaperEmailRuns)"));

console.log("performance summary tests passed");

function paginatedFetch(rows, requests) {
  return async (url) => {
    const parsed = new URL(url);
    const limit = Number(parsed.searchParams.get("limit"));
    const offset = Number(parsed.searchParams.get("offset"));
    requests.push({
      limit,
      offset,
      deliveryStatus: parsed.searchParams.get("delivery_status"),
      emailStatus: parsed.searchParams.get("email_status"),
      emailSentAt: parsed.searchParams.get("email_sent_at"),
      order: parsed.searchParams.get("order")
    });
    return {
      ok: true,
      status: 200,
      json: async () => rows.slice(offset, offset + limit),
      text: async () => ""
    };
  };
}

function assertFiniteNumbers(value) {
  for (const item of Object.values(value)) {
    if (typeof item === "number") assert.ok(Number.isFinite(item), "summary must not contain NaN or Infinity");
  }
  assert.doesNotMatch(JSON.stringify(value), /NaN|Infinity|undefined|\[object Object\]/);
}
