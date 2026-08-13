import { buildEmailFrom } from "../lib/email.js";
import { CONFIG } from "../lib/config.js";
import { readFileSync } from "node:fs";
import { parseCronGroups } from "../api/cron.js";
import { renderSignalEmail, renderTestEmail } from "../lib/report.js";
import { reviewAlertWithCandles, reviewArbitrageAlert } from "../lib/alert-review.js";
import { evaluateDynamicSpotOpportunity, filterSignalsByCurrentPrice, isDynamicSpotCandidate, isDynamicSpotCoolingDown, isDynamicWeakSpotCandidate, isFuturesPriceSignal, selectScanTargets, shouldReviewAlert, shouldReviewRecentAlerts } from "../lib/scanner.js";
import { hasProcessedScanCandle, recordProcessedScanCandle, sentAlertsForReviewParams } from "../lib/storage.js";
import { compareStrategyInversion, CRYPTO_STRATEGIES, FUTURES_STRATEGIES, invertStrategyDirection, SHORT_TERM_STRATEGIES, STRATEGIES } from "../lib/strategies.js";

if (!STRATEGIES.length) {
  throw new Error("No strategies registered");
}

const reviewParams = sentAlertsForReviewParams(30);
if (
  reviewParams.get("delivery_status") !== null
  || reviewParams.get("or") !== "(delivery_status.eq.sent,delivery_mode.eq.PAPER)"
  || reviewParams.get("limit") !== "30"
) {
  throw new Error("Alert review lookup must include PAPER shadow records as well as sent emails");
}

const dashboardHtml = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const cronApi = readFileSync(new URL("../api/cron.js", import.meta.url), "utf8");
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const inverseReportScript = readFileSync(new URL("./inverse-signal-report.js", import.meta.url), "utf8");
if (packageJson.scripts?.["inverse-report"] !== "node scripts/inverse-signal-report.js") {
  throw new Error("package.json should expose npm run inverse-report");
}
if (!inverseReportScript.includes("compareStrategyInversion") || !inverseReportScript.includes("inverse_signal_report.json")) {
  throw new Error("Inverse report script should compare strategy inversions and write the expected report");
}
if (cronApi.includes('"inverse-watch-4h"') || cronApi.includes('"inverse-watch-daily"')) {
  throw new Error("Cron API should keep unproven inverse-watch groups disabled");
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
if (dashboardHtml.includes("reviewText(alert.payload?.review, alert.payload?.livePerformance)")) {
  throw new Error("Dashboard review column should not fall back to historical live performance");
}

const schedulerSql = readFileSync(new URL("../sql/supabase-hourly-cron.example.sql", import.meta.url), "utf8");
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
const liquidDynamicQuoteVolume = Math.max(
  CONFIG.dynamicSpotPoolMinQuoteVolume,
  CONFIG.dynamicWeakSpotPoolMinQuoteVolume
);
if (isDynamicWeakSpotCandidate({ symbol: "WIFUSDT", priceChangePercent: -6.5, quoteVolume: liquidDynamicQuoteVolume }, weakExisting)) {
  throw new Error("Dynamic weak spot candidate should reject mild downside moves with weak edge");
}
if (!isDynamicWeakSpotCandidate({ symbol: "WIFUSDT", priceChangePercent: -10, quoteVolume: liquidDynamicQuoteVolume }, weakExisting)) {
  throw new Error("Dynamic weak spot candidate should accept profitable-bucket falling USDT symbols");
}
if (isDynamicWeakSpotCandidate({ symbol: "WIFUSDT", priceChangePercent: -12, quoteVolume: liquidDynamicQuoteVolume }, weakExisting)) {
  throw new Error("Dynamic weak spot candidate should reject downside moves beyond the profitable 8%-11% bucket");
}
if (isDynamicWeakSpotCandidate({ symbol: "WIFUSDT", priceChangePercent: -14, quoteVolume: liquidDynamicQuoteVolume }, weakExisting)) {
  throw new Error("Dynamic weak spot candidate should reject downside moves outside the profitable 8%-13% bucket");
}
if (isDynamicWeakSpotCandidate({ symbol: "THINUSDT", priceChangePercent: -6.5, quoteVolume: 100000 }, weakExisting)) {
  throw new Error("Dynamic weak spot candidate should reject illiquid symbols");
}
if (isDynamicWeakSpotCandidate({ symbol: "SLOWUSDT", priceChangePercent: -1.2, quoteVolume: liquidDynamicQuoteVolume }, weakExisting)) {
  throw new Error("Dynamic weak spot candidate should reject symbols without enough downside momentum");
}
if (isDynamicSpotCandidate({ symbol: "NFPUSDT", priceChangePercent: 8.5, quoteVolume: liquidDynamicQuoteVolume }, weakExisting, new Set(["WIFUSDT"]))) {
  throw new Error("Dynamic strong candidate should reject spot symbols without a USDT perpetual contract");
}
if (!isDynamicSpotCandidate({ symbol: "WIFUSDT", priceChangePercent: 8.5, quoteVolume: liquidDynamicQuoteVolume }, weakExisting, new Set(["WIFUSDT"]))) {
  throw new Error("Dynamic strong candidate should accept liquid rising symbols with a USDT perpetual contract");
}
if (isDynamicSpotCandidate({ symbol: "WIFUSDT", priceChangePercent: 11, quoteVolume: liquidDynamicQuoteVolume }, weakExisting, new Set(["WIFUSDT"]))) {
  throw new Error("Dynamic strong candidate should reject long setups above the profitable 8%-10% bucket");
}
if (isDynamicSpotCandidate({ symbol: "HOTUSDT", priceChangePercent: 22, quoteVolume: liquidDynamicQuoteVolume }, weakExisting, new Set(["HOTUSDT"]))) {
  throw new Error("Dynamic strong candidate should reject overheated 24h movers before scanning");
}
if (isDynamicWeakSpotCandidate({ symbol: "NFPUSDT", priceChangePercent: -6.5, quoteVolume: liquidDynamicQuoteVolume }, weakExisting, new Set(["WIFUSDT"]))) {
  throw new Error("Dynamic weak spot candidate should reject spot symbols without a USDT perpetual contract");
}
if (!isDynamicWeakSpotCandidate({ symbol: "WIFUSDT", priceChangePercent: -10, quoteVolume: liquidDynamicQuoteVolume }, weakExisting, new Set(["WIFUSDT"]))) {
  throw new Error("Dynamic weak spot candidate should accept profitable-bucket falling symbols with a USDT perpetual contract");
}
if (isDynamicWeakSpotCandidate({ symbol: "WIFUSDT", priceChangePercent: -12, quoteVolume: liquidDynamicQuoteVolume }, weakExisting, new Set(["WIFUSDT"]))) {
  throw new Error("Dynamic weak spot candidate should reject downside moves beyond the profitable 8%-11% bucket with a USDT perpetual contract");
}
if (isDynamicWeakSpotCandidate({ symbol: "CRASHUSDT", priceChangePercent: -18, quoteVolume: liquidDynamicQuoteVolume }, weakExisting, new Set(["CRASHUSDT"]))) {
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
if (
  missingPriceKept.length !== 0
  || missingPriceWarnings.length !== 1
  || !missingPriceWarnings[0].warning.includes("dropped signal: current price unavailable")
) {
  throw new Error("Current price guard should fail closed when live price is unavailable");
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
  rawScore: 94,
  close: 100,
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
if (sentTimeReview.status !== "reviewed" || sentTimeReview.exitTime !== Date.UTC(2026, 5, 21, 10, 0) || sentTimeReview.returnPct <= 0) {
  throw new Error("Alert review should ignore candles that opened before the email was sent");
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
  low: 300 - index,
  close: 300 - index,
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
