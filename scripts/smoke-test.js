import { buildEmailFrom } from "../lib/email.js";
import { CONFIG } from "../lib/config.js";
import { readFileSync } from "node:fs";
import { parseCronGroups } from "../api/cron.js";
import { buildEmailNotifications } from "../api/status.js";
import { renderSignalEmail, renderTestEmail } from "../lib/report.js";
import { reviewAlertWithCandles, reviewArbitrageAlert } from "../lib/alert-review.js";
import { enhanceDynamicSignal, evaluateDynamicFamilyGate, evaluateDynamicFamilyGates, evaluateDynamicSpotOpportunity, filterSignalsByCurrentPrice, isDynamicPaperSignal, isDynamicSpotCandidate, isDynamicSpotCoolingDown, isDynamicWeakSpotCandidate, isFuturesPriceSignal, routeSignalsByDynamicFamilyGate, selectScanTargets, shouldReviewAlert, shouldReviewRecentAlerts, signalRecord, summarizeLiveAlertPerformance } from "../lib/scanner.js";
import { DYNAMIC_MODEL_VERSION, dynamicModelConfigSnapshot, withModelMetadata } from "../lib/model-metadata.js";
import { hasProcessedScanCandle, recordProcessedScanCandle } from "../lib/storage.js";
import { backtestStrategy, compareStrategyInversion, CRYPTO_STRATEGIES, FUTURES_STRATEGIES, getCurrentSignal, invertStrategyDirection, scoreFuturesSentiment, SHORT_TERM_STRATEGIES, STRATEGIES } from "../lib/strategies.js";
import { isAuthorizedRequest, isDashboardAuthorizedRequest } from "../lib/api-auth.js";
import { attachTradeSpec, createTradeSpec, getTradeSpecForAlert, getTradeSpecForSignal, intervalMilliseconds, isTradeSpec } from "../lib/trading/trade-spec.js";
import { buildV31Portfolio, latestV31RebalanceTime, renderV31PaperEmail, reviewV31PaperRun, V31_MODEL } from "../lib/v3-paper.js";
import {
  applyV33VolatilityTarget,
  buildV33EmailSnapshot,
  deriveV33BreakerState,
  forecastV33PortfolioVolatility,
  isV33PaperEmailReady,
  renderV33PaperEmail,
  reviewV33PaperRun,
  V33_MODEL
} from "../lib/v3-3-paper.js";
import {
  renderV34PaperEmail,
  V34_MODEL
} from "../lib/v3-4-paper.js";
import {
  evaluateFundingCarryPaperGate,
  renderFundingCarryPaperEmail,
  reviewFundingCarryPaperRun,
  runFundingCarryPaperScan,
  FUNDING_CARRY_MODEL
} from "../lib/funding-carry-paper.js";
import {
  calculateFundingZScore,
  evaluateFundingCarryV2PaperGate,
  fundingDirection,
  fundingReversionPasses,
  renderFundingCarryV2PaperEmail,
  reviewFundingCarryV2PaperRun,
  volatilitySnapshot,
  FUNDING_CARRY_V2_MODEL
} from "../lib/funding-carry-v2-paper.js";

if (!STRATEGIES.length) {
  throw new Error("No strategies registered");
}

const dashboardHtml = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const cronApi = readFileSync(new URL("../api/cron.js", import.meta.url), "utf8");
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const inverseReportScript = readFileSync(new URL("./inverse-signal-report.js", import.meta.url), "utf8");
const fundingCarryBacktestSource = readFileSync(new URL("./backtest-funding-carry-perp.js", import.meta.url), "utf8");
const fundingCarryV2BacktestSource = readFileSync(new URL("./backtest-funding-carry-perp-v2.js", import.meta.url), "utf8");
const fundingCarryV2UniverseSource = readFileSync(new URL("./select-funding-carry-v2-universe.js", import.meta.url), "utf8");
const emailSource = readFileSync(new URL("../lib/email.js", import.meta.url), "utf8");
const storageSource = readFileSync(new URL("../lib/storage.js", import.meta.url), "utf8");
const scannerSource = readFileSync(new URL("../lib/scanner.js", import.meta.url), "utf8");
const statusSource = readFileSync(new URL("../api/status.js", import.meta.url), "utf8");
const schemaSource = readFileSync(new URL("../sql/schema.sql", import.meta.url), "utf8");
const tableRenameMigration = readFileSync(new URL("../supabase/migrations/20260801110000_prefix_cr_table_names.sql", import.meta.url), "utf8");
if (dashboardHtml.includes("localStorage") || dashboardHtml.includes("secret=${") || !dashboardHtml.includes("Authorization: `Bearer ${secret}`")) {
  throw new Error("Dashboard should keep the secret out of persistent storage and request URLs");
}

const previousCronSecret = process.env.CRON_SECRET;
const previousDashboardSecret = process.env.DASHBOARD_SECRET;
delete process.env.CRON_SECRET;
delete process.env.DASHBOARD_SECRET;
if (isAuthorizedRequest({ headers: {}, query: {} })) {
  throw new Error("Protected APIs should fail closed when CRON_SECRET is missing");
}
if (isDashboardAuthorizedRequest({ headers: {}, query: {} })) {
  throw new Error("Dashboard API should fail closed when both secrets are missing");
}
process.env.CRON_SECRET = "cron-secret";
process.env.DASHBOARD_SECRET = "dashboard-secret";
if (!isAuthorizedRequest({ headers: { authorization: "Bearer cron-secret" }, query: {} })) {
  throw new Error("Protected APIs should accept a matching Bearer secret");
}
if (isAuthorizedRequest({ headers: { authorization: "Bearer dashboard-secret" }, query: {} })) {
  throw new Error("Dashboard password must not authorize cron or email actions");
}
if (!isDashboardAuthorizedRequest({ headers: { authorization: "Bearer dashboard-secret" }, query: {} })) {
  throw new Error("Dashboard API should accept DASHBOARD_SECRET");
}
if (!isDashboardAuthorizedRequest({ headers: { authorization: "Bearer cron-secret" }, query: {} })) {
  throw new Error("Dashboard API should preserve internal CRON_SECRET access");
}
if (previousCronSecret == null) delete process.env.CRON_SECRET;
else process.env.CRON_SECRET = previousCronSecret;
if (previousDashboardSecret == null) delete process.env.DASHBOARD_SECRET;
else process.env.DASHBOARD_SECRET = previousDashboardSecret;
if (packageJson.scripts?.["inverse-report"] !== "node scripts/inverse-signal-report.js") {
  throw new Error("package.json should expose npm run inverse-report");
}
if (!inverseReportScript.includes("compareStrategyInversion") || !inverseReportScript.includes("inverse_signal_report.json")) {
  throw new Error("Inverse report script should compare strategy inversions and write the expected report");
}
if (cronApi.includes('"inverse-watch-4h"') || cronApi.includes('"inverse-watch-daily"')) {
  throw new Error("Cron API should not allow unproven inverse-watch groups");
}
if (dashboardHtml.includes('return "样本不足";')) {
  throw new Error("Dashboard review text should not use a generic insufficient-sample fallback");
}
if (!dashboardHtml.includes('return "待复盘";') || !dashboardHtml.includes("同类已发样本不足")) {
  throw new Error("Dashboard review text should distinguish pending reviews from live-performance sample gaps");
}

if (!dashboardHtml.includes("historyPerformanceText")) {
  throw new Error("Dashboard should show historical live performance in a separate column");
}
if (!dashboardHtml.includes('"模型版本"') || !dashboardHtml.includes("data.emailNotifications")) {
  throw new Error("Dashboard should render a unified email history with model versions");
}
if (dashboardHtml.includes("reviewText(alert.payload?.review, alert.payload?.livePerformance)")) {
  throw new Error("Dashboard review column should not fall back to historical live performance");
}
if (
  !storageSource.includes('sentAlerts: "cr_sent_alerts"')
  || !storageSource.includes('runLogs: "cr_run_logs"')
  || !storageSource.includes('processedScanCandles: "cr_processed_scan_candles"')
  || !storageSource.includes('paperModelRuns: "cr_paper_model_runs"')
  || /\/rest\/v1\/(sent_alerts|run_logs|processed_scan_candles|paper_model_runs)/.test(storageSource)
) {
  throw new Error("Storage should use the cr_ prefixed Supabase table names");
}
if (
  !schemaSource.includes("create table if not exists cr_sent_alerts")
  || !schemaSource.includes("create table if not exists cr_run_logs")
  || !schemaSource.includes("create table if not exists cr_processed_scan_candles")
  || !schemaSource.includes("create table if not exists cr_paper_model_runs")
  || /\b(sent_alerts|run_logs|processed_scan_candles|paper_model_runs)\b/.test(schemaSource)
) {
  throw new Error("Initial schema should define only cr_ prefixed application tables");
}
if (
  !scannerSource.includes("claimSignalsForEmail")
  || !storageSource.includes("claimSentSignal")
  || !storageSource.includes("resolution=ignore-duplicates,return=representation")
  || !schemaSource.includes("delivery_status text not null default 'sent'")
) {
  throw new Error("Email delivery should claim signal keys atomically before sending");
}
if (
  !statusSource.includes("fetchRecentPaperEmailRuns(alertLimit)")
  || !storageSource.includes('email_status: "eq.sent"')
  || !storageSource.includes('email_sent_at: "not.is.null"')
) {
  throw new Error("Email history should query sent paper runs independently of the latest-run limit");
}
for (const tableRename of [
  "sent_alerts', 'cr_sent_alerts",
  "run_logs', 'cr_run_logs",
  "processed_scan_candles', 'cr_processed_scan_candles",
  "paper_model_runs', 'cr_paper_model_runs"
]) {
  if (!tableRenameMigration.includes(tableRename)) {
    throw new Error(`Table rename migration is missing mapping: ${tableRename}`);
  }
}

const schedulerSql = readFileSync(new URL("../sql/supabase-hourly-cron.example.sql", import.meta.url), "utf8");
const fundingCarryV2Migration = readFileSync(new URL("../supabase/migrations/20260802120000_schedule_funding_carry_v2_paper.sql", import.meta.url), "utf8");
if (!fundingCarryV2Migration.includes("cross_market_signal_funding_carry_v2_paper_hourly")
  || !fundingCarryV2Migration.includes("funding-carry-v2-paper")
  || fundingCarryV2Migration.match(/grant\s+[^;]*(anon|authenticated)/i)) {
  throw new Error("Funding Carry V2 migration should schedule a dedicated Vault-authorized PAPER job without public grants");
}
if (!schedulerSql.includes("'cross_market_signal_review_4h'") || !schedulerSql.includes("'0 */4 * * *'") || !schedulerSql.includes("'group',") || !schedulerSql.includes("'review'")) {
  throw new Error("Scheduler should run a dedicated review job every 4 hours");
}
if (schedulerSql.includes("'cross_market_signal_inverse_watch_4h'") || schedulerSql.includes("'inverse-watch-4h'")) {
  throw new Error("Scheduler should not run unproven inverse-watch scans by default");
}
if (schedulerSql.includes("'cross_market_signal_inverse_watch_daily'") || schedulerSql.includes("'inverse-watch-daily'")) {
  throw new Error("Scheduler should keep inverse-watch manual until live performance is proven");
}
if (!schedulerSql.includes("dynamic-weak-spot")) {
  throw new Error("Scheduler should include the dynamic weak spot scan group");
}
if (!schedulerSql.includes("'cross_market_signal_v3_paper_hourly'") || !schedulerSql.includes("'15 * * * *'") || !schedulerSql.includes("'v3-paper'")) {
  throw new Error("Scheduler should check the V3.1 PAPER rebalance once per hour");
}
if (!schedulerSql.includes("'cross_market_signal_v3_4_paper_hourly'") || !schedulerSql.includes("'35 * * * *'") || !schedulerSql.includes("'v3-4-paper'")) {
  throw new Error("Scheduler should run the unified V3.4 PAPER model once per hour");
}
if (!cronApi.includes("funding-carry-paper") || !packageJson.scripts?.["backtest:funding-carry-perp"] || !packageJson.scripts?.["evaluate:funding-carry-paper"]) {
  throw new Error("Funding Carry PAPER should have a dedicated cron group and historical backtest command");
}
if (!cronApi.includes("funding-carry-v2-paper")
  || packageJson.scripts?.["backtest:funding-carry-perp-v2"] !== "node scripts/backtest-funding-carry-perp-v2.js"
  || packageJson.scripts?.["evaluate:funding-carry-v2-paper"] !== "node scripts/evaluate-funding-carry-v2-paper.js"
  || !fundingCarryV2BacktestSource.includes("[90, 180, 270]")
  || !fundingCarryV2BacktestSource.includes("[1, 1.5, 2]")
  || !fundingCarryV2BacktestSource.includes("[0.0002, 0.0003, 0.0004]")
  || !fundingCarryV2BacktestSource.includes("[24, 48, 72]")
  || !fundingCarryV2BacktestSource.includes("FUNDING_CARRY_V2_Z_WINDOW_VALUES")
  || !fundingCarryV2BacktestSource.includes("FUNDING_CARRY_V2_FUNDING_REVERSION")
  || !fundingCarryV2BacktestSource.includes("theoreticalConfigs")
  || !fundingCarryV2UniverseSource.includes("minimumFundingCoverage")) {
  throw new Error("Funding Carry V2 should expose the fixed z-score search, train-only universe selection and dedicated PAPER commands");
}
if (!fundingCarryBacktestSource.includes('[20, 50, 100]')
  || !fundingCarryBacktestSource.includes('[3, 6, 12]')
  || !fundingCarryBacktestSource.includes('[6, 12, 24]')
  || !fundingCarryBacktestSource.includes('"1.5x"')
  || !fundingCarryBacktestSource.includes('"2x"')
  || !fundingCarryBacktestSource.includes("historicalGatePassed")) {
  throw new Error("Funding Carry backtest should report both cost stresses and an explicit historical Gate");
}
if (schedulerSql.includes("cron.schedule(\n    'cross_market_signal_v3_3_paper_hourly'")) {
  throw new Error("Scheduler should hand legacy V3.3 monitoring over to V3.4");
}
for (const removedScheduledGroup of [
  "futures-scalp-a",
  "futures-scalp-b",
  "crypto-core-a-1h",
  "crypto-alt-a-1h",
  "futures-core-1h",
  "futures-arbitrage",
  "crypto-core-a-mid",
  "futures-core-mid",
  "crypto-core-a-daily",
  "futures-daily"
]) {
  if (schedulerSql.includes(removedScheduledGroup)) {
    throw new Error(`Scheduler should not include fixed low-signal scan group: ${removedScheduledGroup}`);
  }
}

const parsedGroups = parseCronGroups({
  group: "dynamic-spot",
  groups: " futures-scalp-a, futures-scalp-b ,, "
});
if (parsedGroups.join("|") !== "futures-scalp-a|futures-scalp-b") {
  throw new Error("Cron groups parser should prefer comma-separated groups");
}

const v31RebalanceTime = Date.UTC(2026, 6, 23);
if (latestV31RebalanceTime(v31RebalanceTime + 37 * 60 * 60 * 1000) !== v31RebalanceTime) {
  throw new Error("V3.1 should align to one deterministic 168-hour rebalance boundary");
}
if (
  V31_MODEL.state !== "PAPER"
  || V31_MODEL.deploymentGatePassed
  || V31_MODEL.capitalWeight !== 0
  || V31_MODEL.emailEnabled !== false
  || V31_MODEL.benchmarkOnly !== true
) {
  throw new Error("V3.1 must remain a silent zero-capital PAPER benchmark");
}
if (
  V33_MODEL.state !== "PAPER"
  || V33_MODEL.deploymentGatePassed
  || V33_MODEL.capitalWeight !== 0
  || V33_MODEL.catastropheStop !== 0.08
  || V33_MODEL.breakerDrawdown !== 0.1
) {
  throw new Error("V3.3 must remain zero-capital SHADOW PAPER with frozen risk limits");
}
if (
  V34_MODEL.version !== "V3.4 UNIFIED PAPER"
  || V34_MODEL.state !== "PAPER"
  || V34_MODEL.deploymentGatePassed
  || V34_MODEL.capitalWeight !== 0
  || V34_MODEL.signalModelId !== V31_MODEL.id
  || V34_MODEL.catastropheStop !== V33_MODEL.catastropheStop
  || V34_MODEL.breakerDrawdown !== V33_MODEL.breakerDrawdown
  || V34_MODEL.activationRebalanceTime !== Date.UTC(2026, 7, 6)
) {
  throw new Error("V3.4 should unify the frozen V3.1 signal and V3.3 risk layers without enabling live capital");
}
if (
  FUNDING_CARRY_MODEL.state !== "PAPER"
  || FUNDING_CARRY_MODEL.deploymentGatePassed
  || FUNDING_CARRY_MODEL.researchGatePassed
  || FUNDING_CARRY_MODEL.capitalWeight !== 0
  || FUNDING_CARRY_MODEL.accountRiskPerTrade !== 0.0025
  || FUNDING_CARRY_MODEL.maxLeverage !== 3
  || FUNDING_CARRY_MODEL.maxOpenPositions !== 3
  || FUNDING_CARRY_MODEL.maxAggregateRisk !== 0.005
  || FUNDING_CARRY_MODEL.maxHoldingHours !== 48
) {
  throw new Error("Funding Carry must remain disabled zero-capital PAPER until the historical research gate passes");
}
const blockedFundingCarry = await runFundingCarryPaperScan({
  dryRun: true,
  now: Date.UTC(2026, 7, 2, 12)
});
if (blockedFundingCarry.status !== "blocked_by_research_gate" || blockedFundingCarry.capitalWeight !== 0 || blockedFundingCarry.targets.length !== 0) {
  throw new Error("Funding Carry PAPER should refuse to generate targets before the historical gate passes");
}
const carryRebalanceTime = Date.UTC(2026, 6, 23);
const carryHourly = Array.from({ length: 49 }, (_, index) => {
  const open = 100 - index * 0.05;
  return { openTime: carryRebalanceTime + index * 60 * 60 * 1000, open, high: open + 0.1, low: open - 0.1, close: open };
});
const carryReview = reviewFundingCarryPaperRun({
  run: {
    model_id: FUNDING_CARRY_MODEL.id,
    model_version: FUNDING_CARRY_MODEL.version,
    rebalance_time: new Date(carryRebalanceTime).toISOString(),
    targets: [{
      symbol: "BTCUSDT",
      side: "SHORT",
      direction: -1,
      targetWeight: -1,
      referencePrice: 100,
      stopLoss: 105,
      fundingRate: 0.001,
      trendRules: FUNDING_CARRY_MODEL.trendRules
    }]
  },
  hourlyCandlesBySymbol: new Map([["BTCUSDT", carryHourly]]),
  fourHourlyBySymbol: new Map([["BTCUSDT", []]]),
  fundingBySymbol: new Map([["BTCUSDT", [
    { fundingTime: carryRebalanceTime + 8 * 60 * 60 * 1000, fundingRate: 0.001 },
    { fundingTime: carryRebalanceTime + 16 * 60 * 60 * 1000, fundingRate: 0.001 }
  ]]]),
  now: carryRebalanceTime + 49 * 60 * 60 * 1000,
  reviewedAt: carryRebalanceTime + 49 * 60 * 60 * 1000
});
if (carryReview.status !== "reviewed" || carryReview.positions.length !== 1 || carryReview.positions[0].exitReason !== "max_holding" || carryReview.returnPct <= 0 || carryReview.positions[0].fundingReturn <= 0) {
  throw new Error("Funding Carry PAPER review should include price PnL, funding PnL, costs and the 48-hour exit");
}
const negativeFundingReview = reviewFundingCarryPaperRun({
  run: {
    model_id: FUNDING_CARRY_MODEL.id,
    model_version: FUNDING_CARRY_MODEL.version,
    rebalance_time: new Date(carryRebalanceTime).toISOString(),
    targets: [{
      symbol: "ETHUSDT",
      side: "LONG",
      direction: 1,
      targetWeight: 0.1,
      referencePrice: 100,
      stopLoss: 95,
      fundingRate: -0.001,
      trendRules: FUNDING_CARRY_MODEL.trendRules
    }]
  },
  hourlyCandlesBySymbol: new Map([[
    "ETHUSDT",
    Array.from({ length: 49 }, (_, index) => {
      const open = 100 + index * 0.05;
      return { openTime: carryRebalanceTime + index * 60 * 60 * 1000, open, high: open + 0.1, low: open - 0.1, close: open };
    })
  ]]),
  fourHourlyBySymbol: new Map([["ETHUSDT", []]]),
  fundingBySymbol: new Map([["ETHUSDT", [
    { fundingTime: carryRebalanceTime + 8 * 60 * 60 * 1000, fundingRate: -0.001 },
    { fundingTime: carryRebalanceTime + 16 * 60 * 60 * 1000, fundingRate: -0.001 }
  ]]]),
  now: carryRebalanceTime + 49 * 60 * 60 * 1000,
  reviewedAt: carryRebalanceTime + 49 * 60 * 60 * 1000
});
if (negativeFundingReview.positions[0].side !== "LONG" || negativeFundingReview.positions[0].fundingReturn <= 0) {
  throw new Error("Negative funding should map to LONG and produce positive funding income when held");
}
const gapStopReview = reviewFundingCarryPaperRun({
  run: {
    model_id: FUNDING_CARRY_MODEL.id,
    model_version: FUNDING_CARRY_MODEL.version,
    rebalance_time: new Date(carryRebalanceTime).toISOString(),
    targets: [{ symbol: "SOLUSDT", side: "LONG", direction: 1, targetWeight: 0.1, referencePrice: 100, stopLoss: 95, fundingRate: 0.001 }]
  },
  hourlyCandlesBySymbol: new Map([["SOLUSDT", [
    { openTime: carryRebalanceTime, open: 100, high: 101, low: 99, close: 100 },
    { openTime: carryRebalanceTime + 60 * 60 * 1000, open: 90, high: 91, low: 89, close: 90 }
  ]]]),
  fourHourlyBySymbol: new Map([["SOLUSDT", []]]),
  fundingBySymbol: new Map([["SOLUSDT", []]]),
  now: carryRebalanceTime + 2 * 60 * 60 * 1000,
  reviewedAt: carryRebalanceTime + 2 * 60 * 60 * 1000
});
if (gapStopReview.positions[0].exitReason !== "atr_stop" || gapStopReview.positions[0].exitPrice !== 90) {
  throw new Error("ATR stop should fill at the next candle open after a stop gap");
}
const fundingExitReview = reviewFundingCarryPaperRun({
  run: {
    model_id: FUNDING_CARRY_MODEL.id,
    model_version: FUNDING_CARRY_MODEL.version,
    rebalance_time: new Date(carryRebalanceTime).toISOString(),
    targets: [{ symbol: "BTCUSDT", side: "SHORT", direction: -1, targetWeight: -0.1, referencePrice: 100, stopLoss: 105, fundingRate: 0.001 }]
  },
  hourlyCandlesBySymbol: new Map([["BTCUSDT", Array.from({ length: 10 }, (_, index) => ({
    openTime: carryRebalanceTime + index * 60 * 60 * 1000,
    open: 100,
    high: 101,
    low: 99,
    close: 100
  }))]]),
  fourHourlyBySymbol: new Map([["BTCUSDT", []]]),
  fundingBySymbol: new Map([["BTCUSDT", [{ fundingTime: carryRebalanceTime + 8 * 60 * 60 * 1000, fundingRate: 0.0001 }]]]),
  now: carryRebalanceTime + 9 * 60 * 60 * 1000,
  reviewedAt: carryRebalanceTime + 9 * 60 * 60 * 1000
});
if (fundingExitReview.positions[0].exitReason !== "funding_threshold") {
  throw new Error("Funding Carry should exit when funding falls below the frozen threshold");
}
const carryEmail = renderFundingCarryPaperEmail({
  model_version: FUNDING_CARRY_MODEL.version,
  rebalance_time: new Date(carryRebalanceTime).toISOString(),
  targets: [{ symbol: "BTCUSDT", side: "SHORT", referencePrice: 100, stopLoss: 105, fundingRate: 0.001, targetWeight: -0.1, trendRules: ["sma50_slope3"], nextFundingTime: carryRebalanceTime + 8 * 60 * 60 * 1000, expectedExitTime: new Date(carryRebalanceTime + 48 * 60 * 60 * 1000).toISOString() }]
});
if (!carryEmail.subject.includes("[PAPER]") || !carryEmail.text.includes("不执行交易") || !carryEmail.text.includes("48 小时")) {
  throw new Error("Funding Carry PAPER email should clearly state that it is not an execution instruction");
}
const fundingNotifications = buildEmailNotifications([], [{
  model_id: FUNDING_CARRY_MODEL.id,
  model_version: FUNDING_CARRY_MODEL.version,
  rebalance_time: new Date(carryRebalanceTime).toISOString(),
  email_status: "sent",
  email_sent_at: new Date(carryRebalanceTime + 1000).toISOString(),
  targets: [{ symbol: "BTCUSDT", side: "SHORT", targetWeight: -0.1, referencePrice: 100, stopLoss: 105, fundingRate: 0.001, trendRules: ["sma50_slope3"], maxHoldingHours: 48 }],
  risk_state: { maxLeverage: 3 },
  review: carryReview
}]);
if (fundingNotifications.length !== 1 || fundingNotifications[0].payload.executionPlan.kind !== "funding_carry_paper_position" || fundingNotifications[0].payload.alertTierLabel !== "PAPER no execution" || fundingNotifications[0].payload.executionPlan.stopLoss !== 105) {
  throw new Error("Status email history should expose Funding Carry PAPER metadata and risk controls");
}
const emptyFundingGate = evaluateFundingCarryPaperGate([]);
if (emptyFundingGate.passed || emptyFundingGate.checks.sample || emptyFundingGate.checks.duration) {
  throw new Error("Funding Carry PAPER gate should fail without eight weeks of closed observations");
}
const dirtyFundingGate = evaluateFundingCarryPaperGate([{
  rebalance_time: new Date(carryRebalanceTime).toISOString(),
  targets: [{ symbol: "BTCUSDT", side: "LONG", fundingRate: 0.001, nextFundingTime: carryRebalanceTime + 8 * 60 * 60 * 1000 }],
  email_status: "failed",
  diagnostics: { dataErrors: [] },
  review: { status: "reviewed", positions: [{ symbol: "BTCUSDT", status: "pending", returnPct: 0, netContribution: 0 }] }
}]);
if (dirtyFundingGate.checks.executionClean || dirtyFundingGate.metrics.wrongDirectionCount !== 1 || dirtyFundingGate.metrics.emailAnomalyCount !== 1) {
  throw new Error("Funding Carry PAPER Gate should block wrong direction, unresolved exits and email anomalies");
}

if (
  FUNDING_CARRY_V2_MODEL.state !== "PAPER"
  || FUNDING_CARRY_V2_MODEL.deploymentGatePassed
  || !FUNDING_CARRY_V2_MODEL.researchGatePassed
  || FUNDING_CARRY_V2_MODEL.capitalWeight !== 0
  || FUNDING_CARRY_V2_MODEL.accountRiskPerTrade !== 0.0025
  || FUNDING_CARRY_V2_MODEL.maxLeverage !== 3
  || FUNDING_CARRY_V2_MODEL.maxOpenPositions !== 3
  || FUNDING_CARRY_V2_MODEL.maxAggregateRisk !== 0.005
  || FUNDING_CARRY_V2_MODEL.universe.length !== 100
  || FUNDING_CARRY_V2_MODEL.fundingReversion !== true
  || FUNDING_CARRY_V2_MODEL.zWindow !== 90
  || FUNDING_CARRY_V2_MODEL.entrySignedZ !== 1
  || FUNDING_CARRY_V2_MODEL.confirmationEvents !== 2
  || FUNDING_CARRY_V2_MODEL.trendRules.join(",") !== "ema100_slope12"
  || !Array.isArray(FUNDING_CARRY_V2_MODEL.allowedMaxHoldingHours)
  || FUNDING_CARRY_V2_MODEL.allowedMaxHoldingHours.join(",") !== "24,48,72"
) {
  throw new Error("Funding Carry V2 must remain zero-capital PAPER with the frozen universe and risk limits");
}
if (fundingDirection(0.001) !== -1 || fundingDirection(-0.001) !== 1 || fundingDirection(0) !== 0) {
  throw new Error("Funding Carry V2 direction mapping should short positive funding and long negative funding");
}
if (!fundingReversionPasses(-0.001, -0.0005, 1) || !fundingReversionPasses(0.001, 0.0005, -1) || fundingReversionPasses(0.001, 0.001, -1)) {
  throw new Error("Funding Carry V2 mean-reversion filter should require funding to move toward zero in the trade direction");
}
const zRows = [
  { fundingTime: 1, fundingRate: 0.0001 },
  { fundingTime: 2, fundingRate: 0.0002 },
  { fundingTime: 3, fundingRate: 0.0003 },
  { fundingTime: 4, fundingRate: 0.001 }
];
const zAtThird = calculateFundingZScore(zRows, 2, 2);
const zAtFourth = calculateFundingZScore(zRows, 2, 3);
if (!zAtThird || zAtThird.fundingTime !== 3 || zAtFourth?.fundingTime !== 4 || zAtFourth.signedZ <= zAtThird.signedZ) {
  throw new Error("Funding Carry V2 z-score should use only prior funding observations and exclude future rows");
}
if (volatilitySnapshot([]).valid !== false) {
  throw new Error("Funding Carry V2 must block entries when the volatility history is missing");
}
const v2EntryTime = Date.UTC(2026, 6, 23);
const v2PriorFunding = Array.from({ length: 180 }, (_, index) => ({
  fundingTime: v2EntryTime - (180 - index) * 8 * 60 * 60 * 1000,
  fundingRate: index % 2 ? 0.00005 : 0.00015
}));
const v2FundingHistory = [...v2PriorFunding, ...Array.from({ length: 6 }, (_, index) => ({
  fundingTime: v2EntryTime + (index + 1) * 8 * 60 * 60 * 1000,
  fundingRate: 0.001
}))];
const v2Hourly = Array.from({ length: 49 }, (_, index) => ({
  openTime: v2EntryTime + index * 60 * 60 * 1000,
  open: 100,
  high: 101,
  low: 99,
  close: 100
}));
const v2MaxHoldReview = reviewFundingCarryV2PaperRun({
  run: {
    model_id: FUNDING_CARRY_V2_MODEL.id,
    model_version: FUNDING_CARRY_V2_MODEL.version,
    rebalance_time: new Date(v2EntryTime).toISOString(),
    targets: [{
      symbol: "BTCUSDT",
      side: "SHORT",
      direction: -1,
      targetWeight: -0.1,
      accountRisk: 0.0025,
      referencePrice: 100,
      stopLoss: 105,
      fundingRate: 0.001,
      minAbsFunding: 0.0003,
      exitSignedZ: 0.5,
      zWindow: 180,
      maxHoldingHours: 48,
      trendRules: ["sma50_slope6"]
    }]
  },
  hourlyCandlesBySymbol: new Map([["BTCUSDT", v2Hourly]]),
  fourHourlyBySymbol: new Map([["BTCUSDT", []]]),
  fundingBySymbol: new Map([["BTCUSDT", v2FundingHistory]]),
  now: v2EntryTime + 49 * 60 * 60 * 1000,
  reviewedAt: v2EntryTime + 49 * 60 * 60 * 1000
});
if (v2MaxHoldReview.status !== "reviewed" || v2MaxHoldReview.positions[0].exitReason !== "max_holding" || v2MaxHoldReview.positions[0].fundingReturn <= 0) {
  throw new Error("Funding Carry V2 review should include directional price PnL, funding PnL, costs and 48-hour exit");
}
const v2FundingExitRows = [...v2PriorFunding, { fundingTime: v2EntryTime + 8 * 60 * 60 * 1000, fundingRate: 0.0001 }];
const v2FundingExitReview = reviewFundingCarryV2PaperRun({
  run: {
    model_id: FUNDING_CARRY_V2_MODEL.id,
    model_version: FUNDING_CARRY_V2_MODEL.version,
    rebalance_time: new Date(v2EntryTime).toISOString(),
    targets: [{ symbol: "ETHUSDT", side: "SHORT", direction: -1, targetWeight: -0.1, referencePrice: 100, stopLoss: 105, fundingRate: 0.001, minAbsFunding: 0.0003, exitSignedZ: 0.5, zWindow: 180, maxHoldingHours: 48, trendRules: ["sma50_slope6"] }]
  },
  hourlyCandlesBySymbol: new Map([["ETHUSDT", v2Hourly.slice(0, 10)]]),
  fourHourlyBySymbol: new Map([["ETHUSDT", []]]),
  fundingBySymbol: new Map([["ETHUSDT", v2FundingExitRows]]),
  now: v2EntryTime + 10 * 60 * 60 * 1000,
  reviewedAt: v2EntryTime + 10 * 60 * 60 * 1000
});
if (v2FundingExitReview.positions[0].exitReason !== "funding_threshold") {
  throw new Error("Funding Carry V2 should exit when the signed funding z-score falls below the exit threshold");
}
const v2GapReview = reviewFundingCarryV2PaperRun({
  run: {
    model_id: FUNDING_CARRY_V2_MODEL.id,
    model_version: FUNDING_CARRY_V2_MODEL.version,
    rebalance_time: new Date(v2EntryTime).toISOString(),
    targets: [{ symbol: "SOLUSDT", side: "LONG", direction: 1, targetWeight: 0.1, referencePrice: 100, stopLoss: 95, fundingRate: -0.001, minAbsFunding: 0.0003, exitSignedZ: 0.5, zWindow: 180, maxHoldingHours: 24, trendRules: ["sma50_slope6"] }]
  },
  hourlyCandlesBySymbol: new Map([["SOLUSDT", [
    { openTime: v2EntryTime, open: 100, high: 101, low: 99, close: 100 },
    { openTime: v2EntryTime + 60 * 60 * 1000, open: 90, high: 91, low: 89, close: 90 }
  ]]]),
  fourHourlyBySymbol: new Map([["SOLUSDT", []]]),
  fundingBySymbol: new Map([["SOLUSDT", []]]),
  now: v2EntryTime + 2 * 60 * 60 * 1000,
  reviewedAt: v2EntryTime + 2 * 60 * 60 * 1000
});
if (v2GapReview.positions[0].exitReason !== "atr_stop" || v2GapReview.positions[0].exitPrice !== 90) {
  throw new Error("Funding Carry V2 stop gaps should fill at the next candle open");
}
const v2Email = renderFundingCarryV2PaperEmail({
  model_version: FUNDING_CARRY_V2_MODEL.version,
  rebalance_time: new Date(v2EntryTime).toISOString(),
  targets: [{ symbol: "BTCUSDT", side: "SHORT", referencePrice: 100, stopLoss: 105, fundingRate: 0.001, signedZ: 2, zScore: 2, zWindow: 180, trendRules: ["sma50_slope6"], volatility: { atrPct: 0.01 }, nextFundingTime: v2EntryTime + 8 * 60 * 60 * 1000, expectedExitTime: new Date(v2EntryTime + 48 * 60 * 60 * 1000).toISOString() }]
});
if (!v2Email.subject.includes("PAPER / 不执行交易") || !v2Email.text.includes("PAPER / 不执行交易") || !v2Email.text.includes("signedZ")) {
  throw new Error("Funding Carry V2 PAPER email should explicitly prohibit execution and show z-score evidence");
}
const v2Notifications = buildEmailNotifications([], [{
  model_id: FUNDING_CARRY_V2_MODEL.id,
  model_version: FUNDING_CARRY_V2_MODEL.version,
  rebalance_time: new Date(v2EntryTime).toISOString(),
  email_status: "sent",
  email_sent_at: new Date(v2EntryTime + 1000).toISOString(),
  targets: [{ symbol: "BTCUSDT", side: "SHORT", targetWeight: -0.1, referencePrice: 100, stopLoss: 105, fundingRate: 0.001, signedZ: 2, zWindow: 180, maxHoldingHours: 48 }],
  risk_state: { maxLeverage: 3 },
  review: v2MaxHoldReview
}]);
if (v2Notifications.length !== 1 || v2Notifications[0].payload.alertTierLabel !== "PAPER / 不执行交易" || v2Notifications[0].payload.executionPlan.signedZ !== 2 || v2Notifications[0].payload.executionPlan.maxHoldingHours !== 48) {
  throw new Error("Status history should expose Funding Carry V2 PAPER z-score and risk metadata");
}
const dirtyV2Gate = evaluateFundingCarryV2PaperGate([
  { rebalance_time: new Date(v2EntryTime).toISOString(), email_status: "sent", diagnostics: { dataErrors: [] }, targets: [{ symbol: "BTCUSDT", side: "LONG", fundingRate: 0.001, fundingWindowKey: "BTCUSDT:1" }], review: { status: "reviewed", positions: [{ symbol: "BTCUSDT", status: "pending", returnPct: 0, netContribution: 0 }] } },
  { rebalance_time: new Date(v2EntryTime + 8 * 24 * 60 * 60 * 1000).toISOString(), email_status: "failed", diagnostics: { dataErrors: [] }, targets: [{ symbol: "BTCUSDT", side: "SHORT", fundingRate: 0.001, fundingWindowKey: "BTCUSDT:1" }], review: { status: "reviewed", positions: [{ symbol: "BTCUSDT", status: "pending", returnPct: 0, netContribution: 0 }] } }
]);
if (dirtyV2Gate.checks.executionClean || dirtyV2Gate.metrics.duplicateEntryCount !== 1 || dirtyV2Gate.metrics.wrongDirectionCount !== 1) {
  throw new Error("Funding Carry V2 PAPER Gate should block duplicate windows, wrong direction and unresolved exits");
}
if (FUNDING_CARRY_V2_MODEL.researchGatePassed !== true || FUNDING_CARRY_V2_MODEL.deploymentGatePassed !== false || FUNDING_CARRY_V2_MODEL.capitalWeight !== 0) {
  throw new Error("Funding Carry V2 PAPER should remain zero-capital until the separate PAPER Gate passes");
}

const v31Series = new Map();
const v31Symbols = ["BTCUSDT", ...V31_MODEL.universe.slice(1, 9)];
for (const [symbolIndex, symbol] of v31Symbols.entries()) {
  const candles = [];
  const beta = symbol === "BTCUSDT" ? 1 : 0.65 + symbolIndex * 0.08;
  const residualDrift = symbol === "BTCUSDT" ? 0 : (symbolIndex - 4.5) * 0.00008;
  let price = 100 + symbolIndex * 10;
  const firstOpenTime = v31RebalanceTime
    - (V31_MODEL.lookbackHours + V31_MODEL.skipHours + 4) * 60 * 60 * 1000;
  for (let openTime = firstOpenTime, index = 0; openTime <= v31RebalanceTime; openTime += 4 * 60 * 60 * 1000, index++) {
    const marketReturn = 0.0005 + 0.002 * Math.sin(index / 7);
    const residual = symbol === "BTCUSDT" ? 0 : residualDrift + 0.001 * Math.sin(index / 5 + symbolIndex);
    const open = price;
    price *= Math.exp(beta * marketReturn + residual);
    candles.push({
      openTime,
      open,
      high: Math.max(open, price) * 1.001,
      low: Math.min(open, price) * 0.999,
      close: price,
      volume: 1000,
      quoteVolume: 10_000_000
    });
  }
  v31Series.set(symbol, candles);
}
const v31Portfolio = buildV31Portfolio({
  seriesBySymbol: v31Series,
  rebalanceTime: v31RebalanceTime
});
if (v31Portfolio.targets.length !== 6 || v31Portfolio.targets.filter((target) => target.side === "LONG").length !== 3 || v31Portfolio.targets.filter((target) => target.side === "SHORT").length !== 3) {
  throw new Error("V3.1 should produce exactly three long and three short PAPER targets");
}
if (Math.abs(v31Portfolio.grossExposure - 1) > 1e-9 || Math.abs(v31Portfolio.predictedBeta) > 1e-8) {
  throw new Error("V3.1 target weights should have 1x gross exposure and near-zero predicted BTC beta");
}
const v31Email = renderV31PaperEmail({
  model_id: V31_MODEL.id,
  rebalance_time: new Date(v31RebalanceTime).toISOString(),
  state: "PAPER",
  deployment_gate_passed: false,
  capital_weight: 0,
  predicted_beta: v31Portfolio.predictedBeta,
  gross_exposure: v31Portfolio.grossExposure,
  eligible_symbols: v31Portfolio.eligibleSymbols,
  targets: v31Portfolio.targets
});
for (const required of ["【PAPER】V3.1 新信号", "做多目标：", "做空目标：", "实盘部署门槛：未通过", "实盘资金权重：0.00%", "系统不会连接交易账户"]) {
  if (!v31Email.subject.includes(required) && !v31Email.text.includes(required)) {
    throw new Error(`V3.1 PAPER email missing: ${required}`);
  }
}
const v31ReviewExit = v31RebalanceTime + V31_MODEL.rebalanceHours * 60 * 60 * 1000;
const reviewExitCandles = new Map();
const reviewFunding = new Map();
const v31MarkTime = v31RebalanceTime + 4 * 60 * 60 * 1000;
for (const [index, target] of v31Portfolio.targets.entries()) {
  const move = target.side === "LONG" ? 1.02 + index * 0.001 : 0.98 - index * 0.001;
  reviewExitCandles.set(target.symbol, [
    {
      openTime: v31RebalanceTime,
      close: target.referencePrice * move
    },
    {
      openTime: v31ReviewExit,
      open: target.referencePrice * move
    }
  ]);
  reviewFunding.set(target.symbol, [{
    fundingTime: v31RebalanceTime + 8 * 60 * 60 * 1000,
    fundingRate: 0.0001
  }]);
}
const v31Mark = reviewV31PaperRun({
  run: {
    rebalance_time: new Date(v31RebalanceTime).toISOString(),
    targets: v31Portfolio.targets
  },
  exitCandlesBySymbol: reviewExitCandles,
  fundingBySymbol: reviewFunding,
  exitTime: v31MarkTime,
  reviewedAt: v31MarkTime
});
if (
  v31Mark.status !== "pending"
  || v31Mark.outcome !== "持仓中盈利"
  || v31Mark.returnPct <= 0
  || new Date(v31Mark.markTime).getTime() !== v31MarkTime
  || v31Mark.positions.length !== 6
  || v31Mark.positions.some((position) =>
    !Number.isFinite(position.returnPct)
    || !Number.isFinite(position.markPrice)
  )
) {
  throw new Error("V3.1 pending review should expose current per-position and portfolio mark-to-market returns");
}
const v31Review = reviewV31PaperRun({
  run: {
    rebalance_time: new Date(v31RebalanceTime).toISOString(),
    targets: v31Portfolio.targets
  },
  exitCandlesBySymbol: reviewExitCandles,
  fundingBySymbol: reviewFunding,
  exitTime: v31ReviewExit,
  reviewedAt: v31ReviewExit
});
if (v31Review.status !== "reviewed" || v31Review.outcome !== "盈利" || v31Review.returnPct <= 0 || v31Review.tradingCost !== 0.0012 || v31Review.positions.length !== 6 || v31Review.positions.some((position) => !Number.isFinite(position.returnPct))) {
  throw new Error("V3.1 review should record positive net portfolio return after funding and round-trip costs");
}
const emailNotifications = buildEmailNotifications([{
  signal_key: "legacy-1",
  sent_at: new Date(v31RebalanceTime).toISOString(),
  payload: { executionPlan: { modelVersion: "trade_plan_v2" } }
}], [{
  model_id: V31_MODEL.id,
  rebalance_time: new Date(v31RebalanceTime).toISOString(),
  email_status: "sent",
  email_sent_at: new Date(v31RebalanceTime + 1000).toISOString(),
  targets: v31Portfolio.targets,
  review: v31Mark
}]);
const paperEmailNotifications = emailNotifications.filter((item) => item.model_version === "V3.1 PAPER");
if (
  emailNotifications.length !== 7
  || paperEmailNotifications.length !== 6
  || new Set(paperEmailNotifications.map((item) => item.asset)).size !== 6
  || paperEmailNotifications.some((item) => item.asset.startsWith("组合"))
  || paperEmailNotifications.some((item) => item.payload.executionPlan.kind !== "v3_paper_position")
  || paperEmailNotifications.some((item) => item.payload.review.status !== "pending")
  || paperEmailNotifications.some((item) =>
    !Number.isFinite(item.payload.review.returnPct)
    || !Number.isFinite(item.payload.review.portfolioReturnPct)
    || !Number.isFinite(item.payload.review.markPrice)
  )
  || emailNotifications.at(-1).model_version !== "交易计划 V2"
) {
  throw new Error("Unified email history should render one marked-to-market V3.1 row per trading pair");
}
const reviewedPaperNotifications = buildEmailNotifications([], [{
  model_id: V31_MODEL.id,
  rebalance_time: new Date(v31RebalanceTime).toISOString(),
  email_status: "sent",
  email_sent_at: new Date(v31ReviewExit).toISOString(),
  targets: v31Portfolio.targets,
  review: v31Review
}]);
if (reviewedPaperNotifications.some((item) => item.payload.review.status !== "reviewed" || !Number.isFinite(item.payload.review.returnPct))) {
  throw new Error("Each V3.1 trading-pair row should expose its own cost-adjusted review");
}

const v33Targets = [
  {
    symbol: "BTCUSDT",
    side: "LONG",
    targetWeight: 0.5,
    beta: 1,
    score: 1,
    quoteVolume24h: 100_000_000,
    referencePrice: 100
  },
  {
    symbol: "ETHUSDT",
    side: "SHORT",
    targetWeight: -0.5,
    beta: 1,
    score: -1,
    quoteVolume24h: 100_000_000,
    referencePrice: 100
  }
];
const v33VolatilitySeries = new Map();
for (const [index, target] of v33Targets.entries()) {
  const direction = index === 0 ? 1 : -1;
  v33VolatilitySeries.set(target.symbol, Array.from(
    { length: 3 },
    (_, day) => ({
      openTime: v31RebalanceTime - 60 * 60 * 1000 - (2 - day) * 24 * 60 * 60 * 1000,
      close: 100 * (1 + direction * day * 0.01)
    })
  ));
}
const v33Forecast = forecastV33PortfolioVolatility({
  targets: v33Targets,
  hourlySeriesBySymbol: v33VolatilitySeries,
  rebalanceTime: v31RebalanceTime,
  lookbackDays: 2
});
const v33Scaled = applyV33VolatilityTarget({
  portfolio: {
    targets: v33Targets,
    grossExposure: 1,
    predictedBeta: 0,
    eligibleSymbols: 2,
    excluded: []
  },
  forecastAnnualVolatility: v33Forecast
});
if (
  !(v33Forecast > 0)
  || v33Scaled.grossExposure < V33_MODEL.minimumGrossExposure
  || v33Scaled.grossExposure > V33_MODEL.maximumGrossExposure
  || Math.abs(v33Scaled.targets.reduce((sum, target) => sum + target.targetWeight, 0)) > 1e-12
) {
  throw new Error("V3.3 should scale the beta-neutral portfolio inside the frozen volatility bounds");
}

const v33ExitTime = v31RebalanceTime + 60 * 60 * 1000;
const v33PendingReview = reviewV33PaperRun({
  run: {
    rebalance_time: new Date(v31RebalanceTime).toISOString(),
    gross_exposure: 1,
    targets: v33Targets
  },
  hourlyCandlesBySymbol: new Map([
    ["BTCUSDT", [{ openTime: v31RebalanceTime, open: 100, close: 102 }]],
    ["ETHUSDT", [{ openTime: v31RebalanceTime, open: 100, close: 98 }]]
  ]),
  fundingBySymbol: new Map([
    ["BTCUSDT", []],
    ["ETHUSDT", []]
  ]),
  now: v33ExitTime + 30 * 60 * 1000,
  reviewedAt: v33ExitTime + 30 * 60 * 1000
});
if (
  v33PendingReview.status !== "pending"
  || v33PendingReview.outcome !== "持仓中盈利"
  || v33PendingReview.returnPct <= 0
  || v33PendingReview.positions.length !== 2
  || v33PendingReview.positions.some((position) =>
    !Number.isFinite(position.returnPct)
    || !Number.isFinite(position.markPrice)
  )
) {
  throw new Error("V3.3 pending review should expose current per-position and portfolio mark-to-market returns");
}
const v33Review = reviewV33PaperRun({
  run: {
    rebalance_time: new Date(v31RebalanceTime).toISOString(),
    gross_exposure: 1,
    targets: v33Targets
  },
  hourlyCandlesBySymbol: new Map([
    ["BTCUSDT", [
      { openTime: v31RebalanceTime, open: 100, close: 90 },
      { openTime: v33ExitTime, open: 91, close: 91 }
    ]],
    ["ETHUSDT", [
      { openTime: v31RebalanceTime, open: 100, close: 110 },
      { openTime: v33ExitTime, open: 109, close: 109 }
    ]]
  ]),
  fundingBySymbol: new Map([
    ["BTCUSDT", []],
    ["ETHUSDT", []]
  ]),
  now: v33ExitTime + 30 * 60 * 1000,
  reviewedAt: v33ExitTime + 30 * 60 * 1000
});
if (
  v33Review.status !== "reviewed"
  || v33Review.exitReason !== "catastrophe_stop"
  || new Date(v33Review.exitTime).getTime() !== v33ExitTime
  || v33Review.returnPct >= -0.08
  || v33Review.positions.length !== 2
) {
  throw new Error("V3.3 catastrophe stop should exit the full portfolio at the next hourly open");
}
if (!dashboardHtml.includes("组合浮动盈利") || !dashboardHtml.includes("未最终：")) {
  throw new Error("Dashboard should distinguish live mark-to-market returns from final reviews");
}

const v33Breaker = deriveV33BreakerState([{
  rebalance_time: new Date(v31RebalanceTime).toISOString(),
  review: {
    status: "reviewed",
    breakerReturnPct: -0.11
  }
}]);
if (v33Breaker.cooldownRemaining !== 4 || v33Breaker.currentDrawdown > -0.1) {
  throw new Error("V3.3 drawdown breaker should start a four-week cash cooldown");
}
const v33EmailRun = {
  model_id: V33_MODEL.id,
  model_version: V33_MODEL.version,
  rebalance_time: new Date(v31RebalanceTime).toISOString(),
  state: "PAPER",
  deployment_gate_passed: false,
  capital_weight: 0,
  predicted_beta: 0,
  gross_exposure: 1,
  eligible_symbols: 2,
  targets: v33Targets,
  risk_state: {
    forecastAnnualVolatility: 0.12,
    targetAnnualVolatility: 0.15,
    catastropheStop: 0.08,
    breakerDrawdown: 0.1,
    breakerCooldownWeeks: 4
  },
  review: v33PendingReview,
  email_status: "sent",
  email_sent_at: new Date(v31RebalanceTime + 2000).toISOString()
};
const v33EmailSnapshot = buildV33EmailSnapshot(v33EmailRun);
if (
  !isV33PaperEmailReady(v33EmailRun)
  || isV33PaperEmailReady({ ...v33EmailRun, review: { status: "pending" } })
  || v33EmailSnapshot.reportingNotionalUsdt !== 10_000
  || v33EmailSnapshot.currentReturnPct !== v33PendingReview.returnPct
  || Math.abs(v33EmailSnapshot.currentPnlUsdt - 194) > 1e-9
  || v33EmailSnapshot.catastropheStopAmountUsdt !== -800
  || Math.abs(v33EmailSnapshot.remainingToStopUsdt - 994) > 1e-9
  || new Date(v33EmailSnapshot.expiresAt).getTime()
    !== v31RebalanceTime + V31_MODEL.rebalanceHours * 60 * 60 * 1000
) {
  throw new Error("V3.3 email snapshot should expose normalized stop, expiry, and current portfolio PnL");
}
const v33Email = renderV33PaperEmail(v33EmailRun);
for (const required of [
  "模拟交易提醒",
  "看涨（价格上涨时受益）",
  "看跌（价格下跌时受益）",
  "标准化模拟本金：10,000.00 USDT",
  "组合灾难止损：-8.00% / -800.00 USDT",
  "最新组合浮动盈亏：+1.94% / +194.00 USDT",
  "距离组合止损：9.94% / 994.00 USDT",
  "最晚到期时间：",
  "北京时间",
  "模拟亏损达到 8.00%",
  "最多观察 7 天",
  "暂停建立新仓位 4 周",
  "不是投资建议"
]) {
  if (!v33Email.subject.includes(required) && !v33Email.text.includes(required)) {
    throw new Error(`V3.3 email missing: ${required}`);
  }
}
for (const jargon of [
  "预测年化波动率",
  "组合总敞口",
  "残差分数",
  "beta",
  "部署门槛"
]) {
  if (v33Email.subject.includes(jargon) || v33Email.text.includes(jargon)) {
    throw new Error(`V3.3 plain-language email still contains jargon: ${jargon}`);
  }
}
const v33Notifications = buildEmailNotifications([], [v33EmailRun]);
if (
  v33Notifications.length !== 2
  || v33Notifications.some((item) => item.model_version !== V33_MODEL.version)
  || v33Notifications.some((item) => item.payload.executionPlan.catastropheStopPct !== 0.08)
  || new Set(v33Notifications.map((item) => item.asset)).size !== 2
) {
  throw new Error("Email history should expose one versioned V3.3 row per trading pair");
}
const v34EmailRun = {
  ...v33EmailRun,
  model_id: V34_MODEL.id,
  model_version: V34_MODEL.version,
  targets: v33Scaled.targets
};
const v34Email = renderV34PaperEmail(v34EmailRun);
for (const required of [
  "V3.4 统一策略",
  "V3.1 残差动量",
  "V3.1 基础权重",
  "V3.4 调整后权重",
  "组合灾难止损：-8.00% / -800.00 USDT",
  "绩效安全闸"
]) {
  if (!v34Email.subject.includes(required) && !v34Email.text.includes(required)) {
    throw new Error(`V3.4 unified email missing: ${required}`);
  }
}
const v34Notifications = buildEmailNotifications([], [v34EmailRun]);
if (
  v34Notifications.length !== 2
  || v34Notifications.some((item) => item.model_version !== V34_MODEL.version)
  || v34Notifications.some((item) =>
    !item.payload.strategyName.includes("残差动量")
    || !item.payload.strategyName.includes("波动率目标")
    || item.payload.executionPlan.baseTargetWeight == null
  )
) {
  throw new Error("Email history should expose V3.4 as one unified signal and risk model");
}
if (!emailSource.includes('"Idempotency-Key": idempotencyKey') || !emailSource.includes("X-Signal-Idempotency-Key")) {
  throw new Error("Email providers should receive the deterministic V3.1 idempotency key");
}

const dynamicCooldown = isDynamicSpotCoolingDown({
  sentAlerts: [{
    asset: "SAGAUSDT",
    strategy_id: "dynamic_relative_strength_breakout",
    interval: "1h",
    trigger_time: new Date(Date.UTC(2026, 5, 21, 12, 0)).toISOString()
  }],
  asset: "SAGAUSDT",
  triggerTime: Date.UTC(2026, 5, 21, 13, 0)
});
if (!dynamicCooldown.active || dynamicCooldown.hoursSince !== 1) {
  throw new Error("Dynamic spot cooldown should block repeated same-asset alerts");
}

if (shouldReviewRecentAlerts("dynamic-spot") || shouldReviewRecentAlerts("futures-scalp-a") || shouldReviewRecentAlerts("crypto-core-a-1h") || shouldReviewRecentAlerts("inverse-watch-4h") || shouldReviewRecentAlerts("inverse-watch-daily")) {
  throw new Error("High-frequency scan groups should skip historical alert reviews");
}
if (!shouldReviewRecentAlerts("crypto-core-a-daily") || !shouldReviewRecentAlerts("futures-daily") || !shouldReviewRecentAlerts("all")) {
  throw new Error("Daily and full scan groups should keep historical alert reviews");
}
if (!shouldReviewAlert({ payload: { review: { status: "reviewed", outcome: "盈利" } } })) {
  throw new Error("Previously manual close reviews should be rechecked under strict email TP/SL rules");
}
if (shouldReviewAlert({ payload: { review: { status: "reviewed", outcome: "止盈" } } })) {
  throw new Error("Already finalized TP/SL reviews should not be rechecked");
}

const reviewTargets = selectScanTargets("review");
if (
  reviewTargets.cryptoAssets.length ||
  reviewTargets.futuresAssets.length ||
  reviewTargets.arbitrageAssets.length ||
  reviewTargets.cryptoIntervals.length ||
  reviewTargets.futuresIntervals.length
) {
  throw new Error("Review-only cron group should not scan market data");
}

const weakTargets = selectScanTargets("dynamic-weak-spot");
if (
  weakTargets.cryptoAssets.length ||
  weakTargets.futuresAssets.length ||
  weakTargets.arbitrageAssets.length ||
  weakTargets.cryptoIntervals.length ||
  weakTargets.futuresIntervals.length
) {
  throw new Error("Dynamic weak spot group should not fall back to broad market scans");
}

const inverse4hTargets = selectScanTargets("inverse-watch-4h");
if (!inverse4hTargets.inverseWatch || inverse4hTargets.futuresIntervals.join("|") !== "4h" || !inverse4hTargets.futuresAssets.includes("NEARUSDT")) {
  throw new Error("Inverse watch 4h should scan only the controlled inverse-watch futures profile");
}

const inverseDailyTargets = selectScanTargets("inverse-watch-daily");
if (!inverseDailyTargets.inverseWatch || inverseDailyTargets.futuresIntervals.join("|") !== "1d" || !inverseDailyTargets.futuresAssets.includes("INJUSDT")) {
  throw new Error("Inverse watch daily should scan only the controlled inverse-watch daily profile");
}

if (CRYPTO_STRATEGIES.some((strategy) => strategy.id === "short_term_momentum_24h") || FUTURES_STRATEGIES.some((strategy) => strategy.id === "short_term_momentum_24h")) {
  throw new Error("Loss-making short-term momentum should not be part of production scan strategy sets");
}

if (CONFIG.futuresStopAtrMultiplier !== 2.08) {
  throw new Error("Optimized execution plan should widen ATR stop distance to 1.3x the prior 1.6 multiplier");
}
if (CONFIG.futuresMinStopPct !== 0.0078) {
  throw new Error("Optimized execution plan should widen the minimum futures stop to 0.78%");
}
if (CONFIG.futuresFallbackStopPct !== 0.0234) {
  throw new Error("Optimized execution plan should widen fallback futures stop to 2.34%");
}
if (CONFIG.futuresRewardRiskRatio !== 1.5) {
  throw new Error("Optimized execution plan should use 1.5R take-profit");
}

const weakExisting = new Set();
if (isDynamicWeakSpotCandidate({ symbol: "WIFUSDT", priceChangePercent: -6.5, quoteVolume: 60000000 }, weakExisting)) {
  throw new Error("Dynamic weak spot candidate should reject mild downside moves with weak edge");
}
if (!isDynamicWeakSpotCandidate({ symbol: "WIFUSDT", priceChangePercent: -10, quoteVolume: 60000000 }, weakExisting)) {
  throw new Error("Dynamic weak spot candidate should accept profitable-bucket falling USDT symbols");
}
if (isDynamicWeakSpotCandidate({ symbol: "WIFUSDT", priceChangePercent: -12, quoteVolume: 60000000 }, weakExisting)) {
  throw new Error("Dynamic weak spot candidate should reject downside moves beyond the profitable 8%-11% bucket");
}
if (isDynamicWeakSpotCandidate({ symbol: "WIFUSDT", priceChangePercent: -14, quoteVolume: 60000000 }, weakExisting)) {
  throw new Error("Dynamic weak spot candidate should reject downside moves outside the profitable 8%-13% bucket");
}
if (isDynamicWeakSpotCandidate({ symbol: "THINUSDT", priceChangePercent: -6.5, quoteVolume: 100000 }, weakExisting)) {
  throw new Error("Dynamic weak spot candidate should reject illiquid symbols");
}
if (isDynamicWeakSpotCandidate({ symbol: "SLOWUSDT", priceChangePercent: -1.2, quoteVolume: 60000000 }, weakExisting)) {
  throw new Error("Dynamic weak spot candidate should reject symbols without enough downside momentum");
}
if (isDynamicSpotCandidate({ symbol: "NFPUSDT", priceChangePercent: 8.5, quoteVolume: 60000000 }, weakExisting, new Set(["WIFUSDT"]))) {
  throw new Error("Dynamic strong candidate should reject spot symbols without a USDT perpetual contract");
}
if (!isDynamicSpotCandidate({ symbol: "WIFUSDT", priceChangePercent: 8.5, quoteVolume: 60000000 }, weakExisting, new Set(["WIFUSDT"]))) {
  throw new Error("Dynamic strong candidate should accept liquid rising symbols with a USDT perpetual contract");
}
if (isDynamicSpotCandidate({ symbol: "WIFUSDT", priceChangePercent: 11, quoteVolume: 60000000 }, weakExisting, new Set(["WIFUSDT"]))) {
  throw new Error("Dynamic strong candidate should reject long setups above the profitable 8%-10% bucket");
}
if (isDynamicSpotCandidate({ symbol: "HOTUSDT", priceChangePercent: 22, quoteVolume: 60000000 }, weakExisting, new Set(["HOTUSDT"]))) {
  throw new Error("Dynamic strong candidate should reject overheated 24h movers before scanning");
}
if (isDynamicWeakSpotCandidate({ symbol: "NFPUSDT", priceChangePercent: -6.5, quoteVolume: 60000000 }, weakExisting, new Set(["WIFUSDT"]))) {
  throw new Error("Dynamic weak spot candidate should reject spot symbols without a USDT perpetual contract");
}
if (!isDynamicWeakSpotCandidate({ symbol: "WIFUSDT", priceChangePercent: -10, quoteVolume: 60000000 }, weakExisting, new Set(["WIFUSDT"]))) {
  throw new Error("Dynamic weak spot candidate should accept profitable-bucket falling symbols with a USDT perpetual contract");
}
if (isDynamicWeakSpotCandidate({ symbol: "WIFUSDT", priceChangePercent: -12, quoteVolume: 60000000 }, weakExisting, new Set(["WIFUSDT"]))) {
  throw new Error("Dynamic weak spot candidate should reject downside moves beyond the profitable 8%-11% bucket with a USDT perpetual contract");
}
if (isDynamicWeakSpotCandidate({ symbol: "CRASHUSDT", priceChangePercent: -18, quoteVolume: 60000000 }, weakExisting, new Set(["CRASHUSDT"]))) {
  throw new Error("Dynamic weak spot candidate should reject crash-chasing downside moves");
}
if (!isFuturesPriceSignal({ market: "USDT 永续合约（动态强势池）", strategyId: "dynamic_relative_strength_breakout" })) {
  throw new Error("Current price guard should treat dynamic contract pool signals as futures signals");
}

const moderateDynamicSpot = evaluateDynamicSpotOpportunity({
  momentum24h: 0.085,
  relativeStrength: 0.12,
  volumeMultiple: 1.8,
  breakout: true,
  hasOrderBook: true
});
if (!moderateDynamicSpot.passed || moderateDynamicSpot.score < 85 || moderateDynamicSpot.score >= 90) {
  throw new Error("Dynamic spot quality gate should pass the trade-grade 8%-10% momentum and 1.5x-2x volume bucket");
}

const weakRelativeDynamicSpot = evaluateDynamicSpotOpportunity({
  momentum24h: 0.09,
  relativeStrength: 0.09,
  volumeMultiple: 1.8,
  breakout: true,
  hasOrderBook: true
});
if (weakRelativeDynamicSpot.passed || weakRelativeDynamicSpot.reason !== "insufficient_relative_strength") {
  throw new Error("Dynamic spot quality gate should reject longs without at least 12% relative strength versus BTC");
}

const idealDynamicSpot = evaluateDynamicSpotOpportunity({
  momentum24h: 0.09,
  relativeStrength: 0.3,
  volumeMultiple: 1.75,
  breakout: true,
  hasOrderBook: true
});
if (!idealDynamicSpot.passed || idealDynamicSpot.score >= 90) {
  throw new Error("Dynamic spot quality gate should cap strong-pool scores below trade-grade levels");
}

const overheatedMomentumSpot = evaluateDynamicSpotOpportunity({
  momentum24h: 0.11,
  relativeStrength: 0.25,
  volumeMultiple: 1.8,
  breakout: true,
  hasOrderBook: true
});
if (overheatedMomentumSpot.passed || !overheatedMomentumSpot.reason?.includes("overheated_momentum")) {
  throw new Error("Dynamic spot quality gate should reject overheated 24h momentum");
}

const overheatedVolumeSpot = evaluateDynamicSpotOpportunity({
  momentum24h: 0.09,
  relativeStrength: 0.12,
  volumeMultiple: 9,
  breakout: true,
  hasOrderBook: true
});
if (overheatedVolumeSpot.passed || !overheatedVolumeSpot.reason?.includes("overheated_volume")) {
  throw new Error("Dynamic spot quality gate should reject extreme volume spikes");
}

const weakEdgeVolumeSpot = evaluateDynamicSpotOpportunity({
  momentum24h: 0.09,
  relativeStrength: 0.12,
  volumeMultiple: 2.5,
  breakout: true,
  hasOrderBook: true
});
if (weakEdgeVolumeSpot.passed || !weakEdgeVolumeSpot.reason?.includes("weak_edge_volume")) {
  throw new Error("Dynamic spot quality gate should reject 2x-4x volume after cost-negative performance");
}

const shortTermMomentum = SHORT_TERM_STRATEGIES.find((strategy) => strategy.id === "short_term_momentum_24h");
const overheatedMomentumCandles = Array.from({ length: 60 }, (_, index) => ({
  openTime: Date.UTC(2026, 5, 21, index),
  open: index < 35 ? 100 : 120,
  high: index < 35 ? 101 : 121,
  low: index < 35 ? 99 : 119,
  close: index < 35 ? 100 : 120,
  volume: index === 59 ? 2500 : 1000
}));
if (shortTermMomentum.evaluate(overheatedMomentumCandles, 59, { interval: "1h" }).passed) {
  throw new Error("Short-term momentum strategy should reject overheated 24h moves");
}

const driftWarnings = [];
const driftFiltered = filterSignalsByCurrentPrice({
  signals: [
    { asset: "TURBOUSDT", close: 0.00095, recommendationScore: 82 },
    { asset: "BTCUSDT", close: 100, recommendationScore: 75 }
  ],
  currentPrices: new Map([
    ["TURBOUSDT", 0.00091],
    ["BTCUSDT", 99.5]
  ]),
  maxDriftPct: 0.02,
  warnings: driftWarnings
});
if (driftFiltered.length !== 1 || driftFiltered[0].asset !== "BTCUSDT" || driftWarnings.length !== 1) {
  throw new Error("Current price guard should drop signals that moved too far from reference price");
}

const missingPriceWarnings = [];
const missingPriceKept = filterSignalsByCurrentPrice({
  signals: [{ asset: "ETHUSDT", close: 2000, recommendationScore: 76 }],
  currentPrices: new Map(),
  maxDriftPct: 0.02,
  warnings: missingPriceWarnings
});
if (missingPriceKept.length !== 0 || missingPriceWarnings.length !== 1) {
  throw new Error("Current price guard should fail closed when live price is unavailable");
}

const crowdedChecks = [];
const crowdedLongScore = scoreFuturesSentiment({
  checks: crowdedChecks,
  sentiment: { topPositions: { ratio: 3 } },
  wantsLong: true,
  wantsShort: false
});
if (crowdedLongScore !== -2 || !crowdedChecks.some((check) => check[1] === "风险")) {
  throw new Error("Extreme same-direction top-trader crowding should be penalized before directional support");
}

const reviewedDynamicAlerts = Array.from({ length: 30 }, (_, index) => ({
  strategy_id: index % 2 ? "dynamic_relative_strength_breakout" : "dynamic_relative_weakness_breakdown",
  payload: { review: { status: "reviewed", returnPct: index % 3 ? -0.03 : 0.045 } }
}));
const haltedDynamicFamily = evaluateDynamicFamilyGate({ sentAlerts: reviewedDynamicAlerts });
if (haltedDynamicFamily.passed || haltedDynamicFamily.state !== "HALTED" || haltedDynamicFamily.performance.trades !== 30) {
  throw new Error("Dynamic family gate should halt a cost-negative reviewed strategy family");
}
const unprovenDynamicFamily = evaluateDynamicFamilyGate({ sentAlerts: reviewedDynamicAlerts.slice(0, 10) });
if (unprovenDynamicFamily.passed || unprovenDynamicFamily.state !== "PAPER") {
  throw new Error("Dynamic family gate should keep insufficient live samples in paper mode");
}
const provenDynamicFamily = evaluateDynamicFamilyGate({
  sentAlerts: Array.from({ length: 30 }, () => ({
    strategy_id: "dynamic_relative_strength_breakout",
    payload: { review: { status: "reviewed", returnPct: 0.01 } }
  }))
});
if (!provenDynamicFamily.passed || provenDynamicFamily.state !== "LIVE") {
  throw new Error("Dynamic family gate should allow a statistically positive cost-adjusted family");
}
const versionedStrengthAlerts = Array.from({ length: 30 }, (_, index) => ({
  strategy_id: "dynamic_relative_strength_breakout",
  model_version: DYNAMIC_MODEL_VERSION,
  sent_at: new Date(1780000000000 + index * 3600000).toISOString(),
  payload: { review: { status: "reviewed", returnPct: 0.01 } }
}));
const versionedDynamicGates = evaluateDynamicFamilyGates({ sentAlerts: versionedStrengthAlerts });
if (
  !versionedDynamicGates.dynamic_strength.passed
  || versionedDynamicGates.dynamic_weakness.passed
  || versionedDynamicGates.dynamic_weakness.state !== "PAPER"
) {
  throw new Error("Dynamic family gates should isolate model version and direction samples");
}
const metadataSignal = withModelMetadata({
  strategyId: "dynamic_relative_strength_breakout",
  direction: "LONG"
}, {
  modelVersion: DYNAMIC_MODEL_VERSION,
  modelFamily: "dynamic_strength",
  configSnapshot: dynamicModelConfigSnapshot()
});
if (
  metadataSignal.modelMetadata.modelVersion !== DYNAMIC_MODEL_VERSION
  || metadataSignal.modelMetadata.modelFamily !== "dynamic_strength"
  || metadataSignal.modelMetadata.configHash.length !== 16
  || metadataSignal.modelMetadata.fingerprint.length !== 16
) {
  throw new Error("Signal metadata should expose deterministic version, family, and configuration fingerprints");
}
const dynamicGateCandidate = {
  signalKey: "BTCUSDT:DYNAMIC_SPOT:1h:dynamic_relative_strength_breakout:1",
  strategyId: "dynamic_relative_strength_breakout",
  recommendationScore: 90,
  gateNotes: []
};
const unrelatedGateCandidate = {
  signalKey: "ETHUSDT:USDT_PERP:1h:futures_trend:1",
  strategyId: "futures_trend",
  recommendationScore: 80
};
const haltedRouting = routeSignalsByDynamicFamilyGate({
  candidates: [unrelatedGateCandidate, dynamicGateCandidate],
  dynamicFamilyGate: haltedDynamicFamily,
  limit: 5
});
if (
  haltedRouting.emailCandidates.length !== 1
  || haltedRouting.emailCandidates[0].signalKey !== unrelatedGateCandidate.signalKey
  || haltedRouting.paperCandidates.length !== 1
  || !isDynamicPaperSignal(haltedRouting.paperCandidates[0])
  || haltedRouting.paperCandidates[0].delivery.gateState !== "HALTED"
  || haltedRouting.paperCandidates[0].delivery.emailSuppressed !== true
) {
  throw new Error("HALTED dynamic signals should be routed to PAPER persistence without entering email candidates");
}
const unprovenRouting = routeSignalsByDynamicFamilyGate({
  candidates: [dynamicGateCandidate],
  dynamicFamilyGate: unprovenDynamicFamily,
  limit: 5
});
if (
  unprovenRouting.emailCandidates.length !== 0
  || unprovenRouting.paperCandidates.length !== 1
  || unprovenRouting.paperCandidates[0].delivery.gateState !== "PAPER"
) {
  throw new Error("Unproven dynamic signals should keep collecting PAPER evidence without sending email");
}
const liveRouting = routeSignalsByDynamicFamilyGate({
  candidates: [unrelatedGateCandidate, dynamicGateCandidate],
  dynamicFamilyGate: provenDynamicFamily,
  limit: 5
});
if (
  liveRouting.emailCandidates.length !== 2
  || liveRouting.paperCandidates.length !== 0
  || liveRouting.emailCandidates.some(isDynamicPaperSignal)
) {
  throw new Error("LIVE dynamic signals should remain eligible for email delivery");
}
const allPaperCandidatesRouting = routeSignalsByDynamicFamilyGate({
  candidates: Array.from({ length: 3 }, (_, index) => ({
    ...dynamicGateCandidate,
    signalKey: `BTCUSDT:DYNAMIC_SPOT:1h:dynamic_relative_strength_breakout:${index}`
  })),
  dynamicFamilyGates: {
    dynamic_strength: haltedDynamicFamily,
    dynamic_weakness: provenDynamicFamily
  },
  limit: 1
});
if (allPaperCandidatesRouting.paperCandidates.length !== 3) {
  throw new Error("PAPER evidence collection should not be capped by the email recipient limit");
}
const shadowEmailNotifications = buildEmailNotifications([{
  signal_key: haltedRouting.paperCandidates[0].signalKey,
  asset: "BTCUSDT",
  strategy_id: haltedRouting.paperCandidates[0].strategyId,
  interval: "1h",
  trigger_time: new Date(1780000000000).toISOString(),
  sent_at: new Date(1780000000000).toISOString(),
  payload: haltedRouting.paperCandidates[0]
}], []);
if (shadowEmailNotifications.length !== 0) {
  throw new Error("PAPER shadow samples must not appear in sent email history");
}

if (await hasProcessedScanCandle({ scanGroup: "dynamic-spot", asset: "BTCUSDT", interval: "1h", candleOpenTime: 1780000000000 })) {
  throw new Error("Processed candle lookup should not block scans when Supabase is not configured");
}
await recordProcessedScanCandle({ scanGroup: "dynamic-spot", asset: "BTCUSDT", interval: "1h", candleOpenTime: 1780000000000 });

const tradeSpecOpenTime = Date.UTC(2026, 5, 21, 8, 0);
const tradeSpecInterval = intervalMilliseconds("1h");
const longTradeSpec = createTradeSpec({
  side: "LONG",
  interval: "1h",
  signalCandleOpenTime: tradeSpecOpenTime,
  referencePrice: 100,
  stopLoss: 97,
  takeProfit: 105,
  rewardRiskRatio: 5 / 3,
  maxHoldingHours: 8
});
const shortTradeSpec = createTradeSpec({
  side: "SHORT",
  interval: "1h",
  signalCandleOpenTime: tradeSpecOpenTime,
  referencePrice: 100,
  stopLoss: 103,
  takeProfit: 95,
  rewardRiskRatio: 5 / 3,
  maxHoldingHours: 8
});
if (
  longTradeSpec.side !== "LONG"
  || longTradeSpec.signalCandleCloseTime !== tradeSpecOpenTime + tradeSpecInterval
  || longTradeSpec.signalAvailableAt !== longTradeSpec.signalCandleCloseTime
  || longTradeSpec.entryEligibleAt !== longTradeSpec.signalCandleCloseTime
  || longTradeSpec.entry.referencePrice !== 100
  || longTradeSpec.stopLoss !== 97
  || longTradeSpec.takeProfit !== 105
  || longTradeSpec.maxHoldingTime !== longTradeSpec.entryEligibleAt + 8 * 3600 * 1000
) {
  throw new Error("LONG TradeSpec should define close-time availability and next-bar entry eligibility");
}
if (shortTradeSpec.side !== "SHORT" || shortTradeSpec.stopLoss !== 103 || shortTradeSpec.takeProfit !== 95) {
  throw new Error("SHORT TradeSpec should preserve side-specific stop loss and take profit");
}
const attachedTimedSignal = attachTradeSpec({ triggerTime: tradeSpecOpenTime }, longTradeSpec);
if (attachedTimedSignal.triggerTime !== longTradeSpec.signalAvailableAt || attachedTimedSignal.triggerTime === longTradeSpec.signalCandleOpenTime) {
  throw new Error("Trade signal triggerTime should use post-close availability, not candle.openTime");
}

const currentSignalCandles = Array.from({ length: 223 }, (_, index) => ({
  openTime: tradeSpecOpenTime + index * tradeSpecInterval,
  close: 100,
  high: 101,
  low: 99
}));
const currentSignal = getCurrentSignal(
  currentSignalCandles,
  {
    holdHours: 8,
    evaluate(_candles, index) {
      return { passed: index === 221, details: {} };
    }
  },
  "1h"
);
if (
  !currentSignal
  || currentSignal.signalAvailableAt !== currentSignal.candle.openTime + tradeSpecInterval
  || currentSignal.entryEligibleAt !== currentSignal.signalAvailableAt
  || currentSignal.signalAvailableAt === currentSignal.candle.openTime
) {
  throw new Error("Signals should become available only after the signal candle closes");
}

const nextBarEntryCandles = Array.from({ length: 223 }, (_, index) => ({
  openTime: tradeSpecOpenTime + index * tradeSpecInterval,
  open: 100,
  close: 100,
  high: 101,
  low: 99
}));
nextBarEntryCandles[220] = {
  ...nextBarEntryCandles[220],
  close: 50
};
nextBarEntryCandles[221] = {
  ...nextBarEntryCandles[221],
  open: 100,
  close: 110
};
const nextBarBacktest = backtestStrategy(
  nextBarEntryCandles,
  {
    id: "m1_next_bar_entry_test",
    direction: "LONG",
    holdHours: 1,
    evaluate(_candles, index) {
      return { passed: index === 220 };
    }
  },
  "1h",
  0
);
if (!nextBarBacktest || Math.abs(nextBarBacktest.totalReturn - 0.1) > 1e-9) {
  throw new Error("Backtest must enter at the next candle open, not at the signal candle close");
}

const invalidChronologyCases = [
  { ...longTradeSpec, signalCandleOpenTime: longTradeSpec.signalCandleCloseTime + 1 },
  { ...longTradeSpec, signalCandleCloseTime: longTradeSpec.signalCandleOpenTime - 1 },
  { ...longTradeSpec, signalAvailableAt: longTradeSpec.signalCandleCloseTime - 1 },
  { ...longTradeSpec, entryEligibleAt: longTradeSpec.signalAvailableAt - 1 }
];
if (invalidChronologyCases.some((spec) => isTradeSpec(spec))) {
  throw new Error("TradeSpec should reject invalid signal-time chronology");
}
const invalidCreatedTradeSpec = createTradeSpec({
  side: "LONG",
  interval: "1h",
  signalCandleOpenTime: tradeSpecOpenTime + tradeSpecInterval,
  signalCandleCloseTime: tradeSpecOpenTime,
  signalAvailableAt: tradeSpecOpenTime,
  entryEligibleAt: tradeSpecOpenTime,
  referencePrice: 100,
  stopLoss: 97,
  takeProfit: 105,
  maxHoldingHours: 8
});
if (invalidCreatedTradeSpec !== null || getTradeSpecForSignal({ tradeSpec: invalidChronologyCases[0] }) !== null) {
  throw new Error("Invalid TradeSpec chronology must fail closed without legacy fallback");
}

const sharedTradeSpec = createTradeSpec({
  side: "LONG",
  interval: "1h",
  signalCandleOpenTime: tradeSpecOpenTime,
  referencePrice: 100,
  stopLoss: 97,
  takeProfit: 105,
  rewardRiskRatio: 5 / 3,
  maxHoldingHours: 8,
  modelVersion: "m1-test"
});
const sharedSignal = {
  asset: "SHAREDUSDT",
  direction: "做多观察",
  strategyId: "m1_shared_trade_spec",
  recommendationScore: 90,
  validUntil: tradeSpecOpenTime + 8 * 3600 * 1000,
  close: 999,
  tradeSpec: sharedTradeSpec,
  executionPlan: {
    entryReference: 999,
    stopLoss: 900,
    takeProfit: 1100
  }
};
if (getTradeSpecForSignal(sharedSignal) !== sharedTradeSpec || getTradeSpecForAlert({ payload: { tradeSpec: sharedTradeSpec } }) !== sharedTradeSpec) {
  throw new Error("Email and Alert Review should resolve the same TradeSpec object");
}
const sharedEmail = renderSignalEmail([sharedSignal]);
if (!sharedEmail.text.includes("参考价：100") || !sharedEmail.text.includes("止损：97") || !sharedEmail.text.includes("止盈：105") || sharedEmail.text.includes("参考价：999")) {
  throw new Error("Email should read entry, stop loss, and take profit directly from TradeSpec");
}
const sharedReview = reviewAlertWithCandles({
  trigger_time: new Date(tradeSpecOpenTime).toISOString(),
  sent_at: new Date(tradeSpecOpenTime + 30 * 60 * 1000).toISOString(),
  interval: "1h",
  payload: {
    ...sharedSignal,
    executionPlan: { entryReference: 999, stopLoss: 900, takeProfit: 1100 }
  }
}, [
  { openTime: tradeSpecOpenTime + tradeSpecInterval, high: 106, low: 99, close: 105.5 }
], tradeSpecOpenTime + 2 * tradeSpecInterval + 1);
if (sharedReview.status !== "reviewed" || sharedReview.outcome !== "止盈" || sharedReview.exitPrice !== 105 || sharedReview.referencePrice !== 100) {
  throw new Error("Alert Review should use the same TradeSpec TP/SL and reference price as Email");
}
const shortFirstBarReview = reviewAlertWithCandles({
  trigger_time: new Date(tradeSpecOpenTime).toISOString(),
  interval: "1h",
  payload: { tradeSpec: shortTradeSpec }
}, [
  { openTime: tradeSpecOpenTime + tradeSpecInterval, open: 102, high: 104, low: 99, close: 101 }
], tradeSpecOpenTime + 2 * tradeSpecInterval + 1);
if (shortFirstBarReview.status !== "reviewed" || shortFirstBarReview.outcome !== "止损" || shortFirstBarReview.exitPrice !== 103) {
  throw new Error("The first post-signal candle should be able to trigger a SHORT stop loss");
}

const dynamicSignalCandles = Array.from({ length: 260 }, (_, index) => ({
  openTime: Date.UTC(2026, 5, 1) + index * tradeSpecInterval,
  open: 100,
  high: 101,
  low: 99,
  close: 100,
  volume: 100
}));
function dynamicSignalFixture(strategyId, direction) {
  const signalCandleOpenTime = Date.UTC(2026, 5, 21, 10, 0);
  const signalCandleCloseTime = signalCandleOpenTime + tradeSpecInterval;
  return {
    signalKey: `DYNAMIC_TEST:${strategyId}`,
    asset: "DYNAMICUSDT",
    market: "USDT 永续合约（动态测试）",
    interval: "1h",
    strategyId,
    strategyName: strategyId,
    direction: direction === "LONG" ? "做多观察" : "做空观察",
    signalCandleOpenTime,
    signalCandleCloseTime,
    signalAvailableAt: signalCandleCloseTime,
    entryEligibleAt: signalCandleCloseTime,
    triggerTime: signalCandleCloseTime,
    validUntil: signalCandleOpenTime + 4 * 3600 * 1000,
    close: 100,
    details: {}
  };
}
function buildDynamicTestSignal(strategyId, direction) {
  return enhanceDynamicSignal(
    dynamicSignalFixture(strategyId, direction),
    {
      candles: dynamicSignalCandles,
      strategy: { id: strategyId, direction, holdHours: 8 },
      interval: "1h",
      funding: null,
      openInterest: null,
      sentiment: null
    }
  );
}
const dynamicStrongSignal = buildDynamicTestSignal("dynamic_relative_strength_breakout", "LONG");
const dynamicWeakSignal = buildDynamicTestSignal("dynamic_relative_weakness_breakdown", "SHORT");
const dynamicStrongRecord = signalRecord(dynamicStrongSignal);
const dynamicWeakRecord = signalRecord(dynamicWeakSignal);
for (const [name, signal, record] of [
  ["strong", dynamicStrongSignal, dynamicStrongRecord],
  ["weak", dynamicWeakSignal, dynamicWeakRecord]
]) {
  if (!isTradeSpec(signal.tradeSpec) || !isTradeSpec(record.payload.tradeSpec)) {
    throw new Error(`Dynamic ${name} signal payload should persist a valid TradeSpec`);
  }
  if (getTradeSpecForAlert({ payload: record.payload }) !== record.payload.tradeSpec || record.payload.tradeSpec.source === "legacy_adapter") {
    throw new Error(`Dynamic ${name} signal should use its persisted TradeSpec without the legacy adapter`);
  }
  if (signal.validUntil !== signal.signalCandleCloseTime + 4 * 3600 * 1000) {
    throw new Error(`Dynamic ${name} validUntil should start from signal candle close`);
  }
}

const livePerformanceSpec = createTradeSpec({
  side: "LONG",
  interval: "1h",
  signalCandleOpenTime: Date.UTC(2026, 5, 21, 10, 0),
  signalCandleCloseTime: Date.UTC(2026, 5, 21, 11, 0),
  signalAvailableAt: Date.UTC(2026, 5, 21, 11, 0),
  entryEligibleAt: Date.UTC(2026, 5, 21, 11, 0),
  referencePrice: 100,
  stopLoss: 97,
  takeProfit: 105,
  maxHoldingHours: 1
});
const livePerformance = summarizeLiveAlertPerformance({
  sentAlerts: [{
    asset: "LIVEUSDT",
    strategy_id: "m1_live_performance_test",
    interval: "1h",
    trigger_time: new Date(Date.UTC(2026, 5, 21, 11, 0)).toISOString(),
    payload: { tradeSpec: livePerformanceSpec }
  }],
  candles: [
    { openTime: Date.UTC(2026, 5, 21, 10, 0), close: 100 },
    { openTime: Date.UTC(2026, 5, 21, 11, 0), close: 110 },
    { openTime: Date.UTC(2026, 5, 21, 12, 0), close: 102 }
  ],
  asset: "LIVEUSDT",
  strategy: { id: "m1_live_performance_test", direction: "LONG", holdHours: 1 },
  interval: "1h",
  tradingCost: 0
});
if (livePerformance.trades !== 1 || Math.abs(livePerformance.totalReturn - 0.02) > 1e-9) {
  throw new Error("Live performance should start its hold period at entryEligibleAt, not signalCandleOpenTime");
}

const email = renderTestEmail();
if (!email.includes("云端信号系统测试邮件")) {
  throw new Error("Test email renderer failed");
}
if (!email.includes("BTCUSDT") || !email.includes("止损：") || !email.includes("止盈：")) {
  throw new Error("Test email does not show compact signal sample");
}

const spotEmail = renderSignalEmail([{
  asset: "BTCUSDT",
  direction: "做多观察",
  strategyName: "放量突破",
  strategyId: "dynamic_relative_strength_breakout",
  recommendationScore: 82,
  rawScore: 94,
  close: 100,
  signalCandleOpenTime: Date.UTC(2026, 5, 21, 8, 0),
  validUntil: Date.UTC(2026, 5, 21, 10, 0),
  details: {
    volumeMultiple: 2.5,
    relativeStrength: 0.08
  }
}]);

if (!spotEmail.subject.includes("BTCUSDT") || !spotEmail.subject.includes("94/100")) {
  throw new Error("Single-signal subject should include asset and display score");
}
for (const required of ["BTCUSDT", "方向：做多观察", "推荐指数：94/100", "参考价：100", "止损：97", "止盈：104.5", "有效期：", "原因："]) {
  if (!spotEmail.text.includes(required)) {
    throw new Error(`Compact spot email missing: ${required}`);
  }
}
for (const removed of ["历史样本", "推荐指数拆解", "为什么提醒你", "你可以怎么处理"]) {
  if (spotEmail.text.includes(removed)) {
    throw new Error(`Compact spot email still contains verbose section: ${removed}`);
  }
}

const futuresEmail = renderSignalEmail([{
  asset: "ETHUSDT",
  direction: "做空观察",
  strategyId: "futures_scalp_short",
  recommendationScore: 76,
  close: 2000,
  signalCandleOpenTime: Date.UTC(2026, 5, 21, 8, 0),
  validUntil: Date.UTC(2026, 5, 21, 11, 0),
  executionPlan: {
    entryReference: 2000,
    stopLoss: 2040,
    takeProfit: 1928,
    simpleThesis: "ETHUSDT 出现偏空合约观察信号。"
  }
}]);
for (const required of ["ETHUSDT", "方向：做空观察", "参考价：2000", "止损：2040", "止盈：1928"]) {
  if (!futuresEmail.text.includes(required)) {
    throw new Error(`Compact futures email missing: ${required}`);
  }
}

const weakSpotEmail = renderSignalEmail([{
  asset: "WIFUSDT",
  direction: "做空观察",
  strategyId: "dynamic_relative_weakness_breakdown",
  strategyName: "动态弱势币放量跌破",
  recommendationScore: 88,
  close: 1.2,
  signalCandleOpenTime: Date.UTC(2026, 5, 21, 8, 0),
  validUntil: Date.UTC(2026, 5, 21, 11, 0),
  details: {
    volumeMultiple: 2.2,
    relativeWeakness: -0.07
  }
}]);
for (const required of ["WIFUSDT", "方向：做空观察", "推荐指数：88/100", "止损：1.236", "止盈：1.146"]) {
  if (!weakSpotEmail.text.includes(required)) {
    throw new Error(`Compact weak spot email missing: ${required}`);
  }
}

const arbitrageEmail = renderSignalEmail([{
  kind: "futures_arbitrage",
  asset: "SOLUSDT",
  recommendationScore: 81,
  close: 150,
  details: {
    fundingRate: 0.0004,
    annualizedFunding: 0.438,
    nextFundingTime: Date.UTC(2026, 5, 21, 12, 0)
  }
}]);
for (const required of ["SOLUSDT", "类型：合约套利观察", "资金费率：0.0400% / 8小时", "年化收益：43.8%", "下次结算："]) {
  if (!arbitrageEmail.text.includes(required)) {
    throw new Error(`Compact arbitrage email missing: ${required}`);
  }
}
if (arbitrageEmail.text.includes("止损：") || arbitrageEmail.text.includes("止盈：")) {
  throw new Error("Arbitrage email should not show stop loss or take profit");
}

const summaryEmail = renderSignalEmail([
  {
    asset: "BTCUSDT",
    direction: "做多观察",
    strategyId: "dynamic_relative_strength_breakout",
    recommendationScore: 82,
    close: 100,
    signalCandleOpenTime: Date.UTC(2026, 5, 21, 8, 0),
    validUntil: Date.UTC(2026, 5, 21, 10, 0)
  },
  {
    asset: "SOLUSDT",
    direction: "做多观察",
    strategyId: "dynamic_relative_strength_breakout",
    recommendationScore: 76,
    close: 150,
    signalCandleOpenTime: Date.UTC(2026, 5, 21, 8, 0),
    validUntil: Date.UTC(2026, 5, 21, 10, 0)
  }
]);
if (!summaryEmail.subject.includes("2") || !summaryEmail.subject.includes("BTCUSDT") || !summaryEmail.subject.includes("82/100")) {
  throw new Error("Multi-signal subject should include count, top asset, and top score");
}

const previousEmailFromName = process.env.EMAIL_FROM_NAME;
process.env.EMAIL_FROM_NAME = "Crypto Signal Bot";
const namedFrom = buildEmailFrom("sender@example.com");
process.env.EMAIL_FROM_NAME = previousEmailFromName;
if (namedFrom !== "Crypto Signal Bot <sender@example.com>") {
  throw new Error("EMAIL_FROM_NAME should control sender display name");
}

const reviewNow = Date.UTC(2026, 5, 21, 12, 0);
const reviewedWin = reviewAlertWithCandles({
  trigger_time: new Date(Date.UTC(2026, 5, 21, 8, 0)).toISOString(),
  interval: "1h",
  payload: {
    close: 100,
    validUntil: Date.UTC(2026, 5, 21, 10, 0),
    direction: "做多观察",
    executionPlan: { entryReference: 100, stopLoss: 97, takeProfit: 105 }
  }
}, [
  { openTime: Date.UTC(2026, 5, 21, 9, 0), high: 106, low: 99, close: 105.5 }
], reviewNow);
if (reviewedWin.status !== "reviewed" || reviewedWin.outcome !== "止盈" || reviewedWin.returnPct <= 0) {
  throw new Error("Alert review should detect take profit");
}

const reviewedLoss = reviewAlertWithCandles({
  trigger_time: new Date(Date.UTC(2026, 5, 21, 8, 0)).toISOString(),
  interval: "1h",
  payload: {
    close: 100,
    validUntil: Date.UTC(2026, 5, 21, 10, 0),
    direction: "做多观察",
    executionPlan: { entryReference: 100, stopLoss: 97, takeProfit: 105 }
  }
}, [
  { openTime: Date.UTC(2026, 5, 21, 9, 0), high: 101, low: 96.5, close: 97 }
], reviewNow);
if (reviewedLoss.status !== "reviewed" || reviewedLoss.outcome !== "止损" || reviewedLoss.returnPct >= 0) {
  throw new Error("Alert review should detect stop loss");
}

const pendingReview = reviewAlertWithCandles({
  trigger_time: new Date(Date.UTC(2026, 5, 21, 8, 0)).toISOString(),
  interval: "1h",
  payload: {
    close: 100,
    validUntil: Date.UTC(2026, 5, 21, 10, 0),
    direction: "做多观察"
  }
}, [
  { openTime: Date.UTC(2026, 5, 21, 9, 0), high: 101, low: 99, close: 100.5 }
], Date.UTC(2026, 5, 21, 9, 30));
if (pendingReview.status !== "pending") {
  throw new Error("Alert review should stay pending before validUntil");
}

const tpAfterValidUntilReview = reviewAlertWithCandles({
  trigger_time: new Date(Date.UTC(2026, 5, 21, 8, 0)).toISOString(),
  interval: "1h",
  payload: {
    close: 100,
    validUntil: Date.UTC(2026, 5, 21, 10, 0),
    direction: "鍋氬瑙傚療",
    executionPlan: { entryReference: 100, stopLoss: 97, takeProfit: 105 }
  }
}, [
  { openTime: Date.UTC(2026, 5, 21, 9, 0), high: 101, low: 99, close: 100.5 },
  { openTime: Date.UTC(2026, 5, 21, 11, 0), high: 106, low: 100, close: 105.5 }
], reviewNow);
if (tpAfterValidUntilReview.status !== "reviewed" || tpAfterValidUntilReview.exitTime !== Date.UTC(2026, 5, 21, 11, 0) || tpAfterValidUntilReview.returnPct <= 0) {
  throw new Error("Alert review should keep watching after validUntil until email take-profit or stop-loss is touched");
}

const unresolvedTpSlReview = reviewAlertWithCandles({
  trigger_time: new Date(Date.UTC(2026, 5, 21, 8, 0)).toISOString(),
  interval: "1h",
  payload: {
    close: 100,
    validUntil: Date.UTC(2026, 5, 21, 10, 0),
    direction: "鍋氬瑙傚療",
    executionPlan: { entryReference: 100, stopLoss: 97, takeProfit: 105 }
  }
}, [
  { openTime: Date.UTC(2026, 5, 21, 9, 0), high: 101, low: 99, close: 100.5 },
  { openTime: Date.UTC(2026, 5, 21, 11, 0), high: 104, low: 98, close: 103 }
], reviewNow);
if (unresolvedTpSlReview.status !== "pending" || Number.isFinite(Number(unresolvedTpSlReview.exitPrice))) {
  throw new Error("Alert review should not create a manual close review when neither email take-profit nor stop-loss is touched");
}

const sentTimeReview = reviewAlertWithCandles({
  trigger_time: new Date(Date.UTC(2026, 5, 21, 8, 0)).toISOString(),
  sent_at: new Date(Date.UTC(2026, 5, 21, 9, 30)).toISOString(),
  interval: "1h",
  payload: {
    close: 100,
    validUntil: Date.UTC(2026, 5, 21, 11, 0),
    direction: "鍋氬瑙傚療",
    executionPlan: { entryReference: 100, stopLoss: 97, takeProfit: 105 }
  }
}, [
  { openTime: Date.UTC(2026, 5, 21, 9, 0), high: 101, low: 96.5, close: 97 },
  { openTime: Date.UTC(2026, 5, 21, 10, 0), high: 106, low: 99, close: 105.5 }
], reviewNow);
if (sentTimeReview.status !== "pending" || sentTimeReview.state !== "ambiguous" || sentTimeReview.reason !== "pending_partial_candle" || Number.isFinite(Number(sentTimeReview.exitPrice))) {
  throw new Error("Alert review must fail safe when sent_at falls inside the first post-signal candle");
}

const earlySentReview = reviewAlertWithCandles({
  trigger_time: new Date(Date.UTC(2026, 5, 21, 8, 0)).toISOString(),
  sent_at: new Date(Date.UTC(2026, 5, 21, 8, 30)).toISOString(),
  interval: "1h",
  payload: {
    close: 100,
    direction: "做多观察",
    executionPlan: { entryReference: 100, stopLoss: 97, takeProfit: 105 }
  }
}, [
  { openTime: Date.UTC(2026, 5, 21, 9, 0), open: 100, high: 101, low: 96.5, close: 97 }
], Date.UTC(2026, 5, 21, 10, 1));
if (earlySentReview.status !== "reviewed" || earlySentReview.outcome !== "止损") {
  throw new Error("Alert review should use the first complete candle when sent_at is before entryEligibleAt");
}

const exactBoundaryReview = reviewAlertWithCandles({
  trigger_time: new Date(Date.UTC(2026, 5, 21, 8, 0)).toISOString(),
  sent_at: new Date(Date.UTC(2026, 5, 21, 9, 0)).toISOString(),
  interval: "1h",
  payload: {
    close: 100,
    direction: "做多观察",
    executionPlan: { entryReference: 100, stopLoss: 97, takeProfit: 105 }
  }
}, [
  { openTime: Date.UTC(2026, 5, 21, 9, 0), open: 95, high: 99, low: 94, close: 96 }
], Date.UTC(2026, 5, 21, 10, 1));
if (exactBoundaryReview.outcome !== "止损" || exactBoundaryReview.exitPrice !== 95 || exactBoundaryReview.returnPct > -0.049) {
  throw new Error("Alert review should include an exact-boundary candle and use a gap-aware stop fill");
}

const timeStopReview = reviewAlertWithCandles({
  trigger_time: new Date(Date.UTC(2026, 5, 21, 8, 0)).toISOString(),
  sent_at: new Date(Date.UTC(2026, 5, 21, 9, 0)).toISOString(),
  interval: "1h",
  payload: {
    close: 100,
    direction: "做多观察",
    executionPlan: {
      modelVersion: "trade_plan_v2",
      entryReference: 100,
      stopLoss: 97,
      takeProfit: 105,
      maxHoldingHours: 2,
      modeledRoundTripCostPct: 0.0012
    }
  }
}, [
  { openTime: Date.UTC(2026, 5, 21, 9, 0), open: 100, high: 101, low: 99, close: 100.5 },
  { openTime: Date.UTC(2026, 5, 21, 10, 0), open: 100.5, high: 102, low: 99.5, close: 101 }
], Date.UTC(2026, 5, 21, 11, 1));
if (timeStopReview.outcome !== "时间退出" || Math.abs(timeStopReview.returnPct - 0.0088) > 1e-9 || timeStopReview.netOfCosts !== true) {
  throw new Error("Trade plan v2 review should time-exit and report net-of-cost return");
}

const arbitrageReview = reviewArbitrageAlert({
  payload: {
    kind: "futures_arbitrage",
    close: 150,
    validUntil: Date.UTC(2026, 5, 21, 10, 0),
    details: { estimatedDailyFunding: 0.0012 }
  }
}, reviewNow);
if (arbitrageReview.status !== "reviewed" || arbitrageReview.returnPct !== 0.0012) {
  throw new Error("Arbitrage review should use estimated funding return");
}

const inverseSourceStrategy = {
  id: "test_inverse_bias",
  name: "Test inverse bias",
  direction: "LONG",
  holdHours: 1,
  evaluate(_candles, index) {
    return { passed: index >= 220 && index % 2 === 0, details: { index } };
  }
};
const invertedStrategy = invertStrategyDirection(inverseSourceStrategy);
if (invertedStrategy.id !== "test_inverse_bias__inverse" || invertedStrategy.direction !== "SHORT") {
  throw new Error("Inverted strategy should use an inverse id and opposite direction");
}
if (!invertedStrategy.evaluate([], 220).passed || invertedStrategy.evaluate([], 221).passed) {
  throw new Error("Inverted strategy should keep the original trigger condition");
}

const inverseCandles = Array.from({ length: 260 }, (_, index) => ({
  openTime: Date.UTC(2026, 0, 1, index),
  open: 300 - index,
  high: 300 - index,
  low: 299 - index,
  close: 299 - index,
  volume: 1000
}));
const inverseComparison = compareStrategyInversion({
  candles: inverseCandles,
  strategy: inverseSourceStrategy,
  interval: "1h",
  tradingCost: 0.001,
  minTrades: 8
});
if (!inverseComparison.inverse || inverseComparison.recommendation !== "inverse_candidate") {
  throw new Error("Inverse comparison should flag a stable profitable inverse candidate");
}
if (inverseComparison.original.totalReturn >= 0 || inverseComparison.inverse.totalReturn <= 0) {
  throw new Error("Inverse comparison should preserve original and inverse performance");
}

console.log("Smoke test passed");
