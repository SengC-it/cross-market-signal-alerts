import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  M37_REJECTED_STRATEGY_IDS,
  SIGNAL_ONLY_RELEASE,
  SIGNAL_TIERS,
  applyProductionSignalPolicy,
  classifyProductionSignal,
  isSignalOnlyExecutionPath,
  routeSignalsByProductionPolicy
} from "../lib/production-signal-policy.js";

const dashboard = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const report = readFileSync(new URL("../lib/report.js", import.meta.url), "utf8");
const scanner = readFileSync(new URL("../lib/scanner.js", import.meta.url), "utf8");
const health = readFileSync(new URL("../api/health.js", import.meta.url), "utf8");
const status = readFileSync(new URL("../api/status.js", import.meta.url), "utf8");
const formalResearch = JSON.parse(readFileSync(new URL("../artifacts/m3/m3-7-strategy-family-reset.json", import.meta.url), "utf8"));

assert.equal(SIGNAL_ONLY_RELEASE.autoTrading, false);
assert.equal(SIGNAL_ONLY_RELEASE.orderPlacement, false);
assert.equal(SIGNAL_ONLY_RELEASE.positionManagement, false);
assert.equal(SIGNAL_ONLY_RELEASE.duplicateSignalProtection, true);
assert.equal(SIGNAL_ONLY_RELEASE.processedCandleProtection, true);
assert.equal(SIGNAL_ONLY_RELEASE.currentPriceGuard, true);
assert.equal(isSignalOnlyExecutionPath(SIGNAL_ONLY_RELEASE), true);

const strengthObservation = classifyProductionSignal({
  strategyId: "dynamic_relative_strength_breakout",
  alertTier: "watch"
});
assert.equal(strengthObservation.tier, SIGNAL_TIERS.OBSERVATION);
assert.equal(strengthObservation.emailEligible, false);
assert.match(strengthObservation.historicalSampleStatus, /NOT_VALIDATED/);

const strengthTradeWatch = classifyProductionSignal({
  strategyId: "dynamic_relative_strength_breakout",
  alertTier: "trade"
});
assert.equal(strengthTradeWatch.tier, SIGNAL_TIERS.TRADE_WATCH);
assert.equal(strengthTradeWatch.emailEligible, true);
assert.match(strengthTradeWatch.reason, /不宣称已验证盈利/);

const weakness = classifyProductionSignal({
  strategyId: "dynamic_relative_weakness_breakdown",
  alertTier: "trade"
});
assert.equal(weakness.tier, SIGNAL_TIERS.SHADOW_ONLY);
assert.equal(weakness.emailEligible, false);
assert.equal(weakness.shadowRecorded, true);

for (const strategyId of M37_REJECTED_STRATEGY_IDS) {
  const policy = classifyProductionSignal({ strategyId, alertTier: "trade" });
  assert.equal(policy.tier, SIGNAL_TIERS.RESEARCH_ONLY);
  assert.equal(policy.emailEligible, false);
  assert.equal(policy.webRecorded, false);
}

const fixture = (signalKey, strategyId, alertTier = "watch") => ({
  signalKey,
  strategyId,
  alertTier,
  recommendationScore: alertTier === "trade" ? 90 : 70
});
const routed = routeSignalsByProductionPolicy({
  candidates: [
    fixture("trade-watch", "existing_strategy", "trade"),
    fixture("observation", "dynamic_relative_strength_breakout"),
    fixture("shadow", "dynamic_relative_weakness_breakdown"),
    ...M37_REJECTED_STRATEGY_IDS.map((strategyId) => fixture(`research:${strategyId}`, strategyId))
  ],
  limit: 2
});
assert.equal(routed.highQualitySignals.length, 1);
assert.equal(routed.observationSignals.length, 1);
assert.equal(routed.shadowOnlySignals.length, 1);
assert.equal(routed.researchOnlySignals.length, 3);
assert.equal(routed.emailCandidates.length, 1);
assert.equal(routed.emailCandidates[0].delivery.mode, "EMAIL");

const optionalObservation = routeSignalsByProductionPolicy({
  candidates: [fixture("observation-email", "dynamic_relative_strength_breakout")],
  observationEmailEnabled: true,
  limit: 2
});
assert.equal(optionalObservation.emailCandidates.length, 1);
assert.equal(optionalObservation.emailCandidates[0].signalTier, SIGNAL_TIERS.OBSERVATION);
assert.equal(optionalObservation.emailCandidates[0].delivery.mode, "EMAIL");
assert.equal(optionalObservation.emailCandidates[0].delivery.emailSuppressed, false);

const decorated = applyProductionSignalPolicy(fixture("manual-only", "dynamic_relative_strength_breakout"));
assert.equal(decorated.referenceRiskOnly, true);
assert.equal(decorated.humanDecisionRequired, true);
assert.equal(decorated.delivery.autoTrading, false);
assert.equal(decorated.delivery.orderPlacement, false);
assert.equal(decorated.delivery.positionManagement, false);

for (const requiredCopy of [
  "本系统仅提供市场信号和数据分析",
  "是否交易、仓位、止盈止损和平仓均由用户自行人工决定",
  "REFERENCE ONLY",
  "Signal-only 运行边界",
  "信号级别",
  "价格漂移",
  "失效条件",
  "历史样本状态"
]) {
  assert.ok(dashboard.includes(requiredCopy) || report.includes(requiredCopy), `missing release copy: ${requiredCopy}`);
}
assert.ok(report.includes("[SIGNAL-ONLY]"));
assert.ok(health.includes("SIGNAL_ONLY_RELEASE"));
assert.ok(status.includes('alert?.payload?.signalTier !== "RESEARCH_ONLY"'));

assert.deepEqual(formalResearch.forwardTestCandidates, []);
assert.equal(formalResearch.formalForwardVerdict, "PENDING_FORWARD_WINDOW");
for (const strategyId of M37_REJECTED_STRATEGY_IDS) {
  assert.equal(formalResearch.researchResults[strategyId]?.researchClassification, "RESEARCH_ONLY");
  assert.equal(
    formalResearch.rejectedCandidates.find((candidate) => candidate.candidateId === strategyId)?.status,
    "REJECTED_CANDIDATE"
  );
}

assert.ok(scanner.includes("routeSignalsByProductionPolicy"));
assert.ok(scanner.includes("hasSentSignal"));
assert.ok(scanner.includes("processedScanCandleState"));
assert.ok(scanner.includes("guardSignalsByCurrentPrice"));
const forbiddenTradingApi = /\b(placeOrder|newOrder|createOrder|cancelOrder|setLeverage|accountTrade)\b/i;
for (const source of [dashboard, report, scanner, health, status]) {
  assert.equal(forbiddenTradingApi.test(source), false, "release path must not contain exchange trading API calls");
}

console.log("v4 signal-only release regression tests passed");
