import { buildEmailFrom } from "../lib/email.js";
import { readFileSync } from "node:fs";
import { parseCronGroups } from "../api/cron.js";
import { renderSignalEmail, renderTestEmail } from "../lib/report.js";
import { reviewAlertWithCandles, reviewArbitrageAlert } from "../lib/alert-review.js";
import { filterSignalsByCurrentPrice, isDynamicSpotCoolingDown, shouldReviewRecentAlerts } from "../lib/scanner.js";
import { hasProcessedScanCandle, recordProcessedScanCandle } from "../lib/storage.js";
import { STRATEGIES } from "../lib/strategies.js";

if (!STRATEGIES.length) {
  throw new Error("No strategies registered");
}

const dashboardHtml = readFileSync(new URL("../index.html", import.meta.url), "utf8");
if (dashboardHtml.includes('return "样本不足";')) {
  throw new Error("Dashboard review text should not use a generic insufficient-sample fallback");
}
if (!dashboardHtml.includes('return "待复盘";') || !dashboardHtml.includes("同类已发样本不足")) {
  throw new Error("Dashboard review text should distinguish pending reviews from live-performance sample gaps");
}

const schedulerSql = readFileSync(new URL("../sql/supabase-hourly-cron.example.sql", import.meta.url), "utf8");
if (!schedulerSql.includes("'cross_market_signal_review_4h'") || !schedulerSql.includes("'0 */4 * * *'") || !schedulerSql.includes("'group',") || !schedulerSql.includes("'review'")) {
  throw new Error("Scheduler should run a dedicated review job every 4 hours");
}

const parsedGroups = parseCronGroups({
  group: "dynamic-spot",
  groups: " futures-scalp-a, futures-scalp-b ,, "
});
if (parsedGroups.join("|") !== "futures-scalp-a|futures-scalp-b") {
  throw new Error("Cron groups parser should prefer comma-separated groups");
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

if (shouldReviewRecentAlerts("dynamic-spot") || shouldReviewRecentAlerts("futures-scalp-a") || shouldReviewRecentAlerts("crypto-core-a-1h")) {
  throw new Error("High-frequency scan groups should skip historical alert reviews");
}
if (!shouldReviewRecentAlerts("crypto-core-a-daily") || !shouldReviewRecentAlerts("futures-daily") || !shouldReviewRecentAlerts("all")) {
  throw new Error("Daily and full scan groups should keep historical alert reviews");
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
if (missingPriceKept.length !== 1 || missingPriceWarnings.length !== 1) {
  throw new Error("Current price guard should keep signals when live price is unavailable and warn");
}

if (await hasProcessedScanCandle({ scanGroup: "dynamic-spot", asset: "BTCUSDT", interval: "1h", candleOpenTime: 1780000000000 })) {
  throw new Error("Processed candle lookup should not block scans when Supabase is not configured");
}
await recordProcessedScanCandle({ scanGroup: "dynamic-spot", asset: "BTCUSDT", interval: "1h", candleOpenTime: 1780000000000 });

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
  close: 100,
  validUntil: Date.UTC(2026, 5, 21, 10, 0),
  details: {
    volumeMultiple: 2.5,
    relativeStrength: 0.08
  }
}]);

if (!spotEmail.subject.includes("BTCUSDT") || !spotEmail.subject.includes("82/100")) {
  throw new Error("Single-signal subject should include asset and score");
}
for (const required of ["BTCUSDT", "方向：做多观察", "推荐指数：82/100", "参考价：100", "止损：97", "止盈：105.4", "有效期：", "原因："]) {
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
    validUntil: Date.UTC(2026, 5, 21, 10, 0)
  },
  {
    asset: "SOLUSDT",
    direction: "做多观察",
    strategyId: "dynamic_relative_strength_breakout",
    recommendationScore: 76,
    close: 150,
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

console.log("Smoke test passed");
