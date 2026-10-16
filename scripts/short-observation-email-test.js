import assert from "node:assert/strict";
import {
  SIGNAL_ONLY_RELEASE,
  SIGNAL_TIERS,
  M37_REJECTED_STRATEGY_IDS,
  isDynamicWeaknessObservation,
  routeSignalsByProductionPolicy
} from "../lib/production-signal-policy.js";
import { renderSignalEmail } from "../lib/report.js";
import { buildSignalQueueStats, filterSignalsByCurrentPrice, signalRecord, splitEmailCapacity } from "../lib/scanner.js";
import { createTradeSpec } from "../lib/trading/trade-spec.js";

const triggerTime = Date.parse("2026-10-16T00:00:00Z");
const short = (signalKey, score = 70) => ({
  signalKey,
  asset: "WUSDT",
  strategyId: "dynamic_relative_weakness_breakdown",
  strategyName: "动态弱势币放量跌破",
  direction: "做空观察",
  alertTier: "watch",
  recommendationScore: score,
  modelVersion: "DYNAMIC_SPOT_V2_2026-08-01",
  market: "USDT 永续合约",
  interval: "1h",
  triggerTime,
  close: 100,
  tradeSpec: createTradeSpec({
    side: "SHORT",
    interval: "1h",
    signalCandleOpenTime: triggerTime,
    referencePrice: 100,
    stopLoss: 103,
    takeProfit: 95.5,
    maxHoldingHours: 8
  })
});

assert.equal(SIGNAL_ONLY_RELEASE.dynamicWeaknessObservationEmailEnabled, true);
for (const strengthObservationEmailEnabled of [false, true]) {
  const routed = routeSignalsByProductionPolicy({
    candidates: [
      short("new-short"),
      { ...short("generic"), strategyId: "generic_observation" },
      ...M37_REJECTED_STRATEGY_IDS.map((strategyId) => ({ ...short(strategyId), strategyId, alertTier: "trade" }))
    ],
    strengthObservationEmailEnabled
  });
  assert.deepEqual(routed.emailCandidates.map((signal) => signal.signalKey), ["new-short"]);
  assert.equal(routed.highQualitySignals.length, 0);
  assert.equal(routed.webSignals.length, 1);
  assert.equal(routed.researchOnlySignals.length, 3);
  assert.equal(routed.shadowOnlySignals.length, 0);
  assert.equal(routed.eligibleShortObservations, 1);
  const signal = routed.emailCandidates[0];
  assert.equal(signal.signalTier, SIGNAL_TIERS.OBSERVATION);
  assert.equal(signal.signalTierLabel, "SHORT 观察级");
  assert.equal(signal.delivery.mode, "EMAIL");
  assert.equal(signal.delivery.emailSuppressed, false);
  assert.equal(signal.delivery.autoTrading, false);
  assert.equal(signal.delivery.orderPlacement, false);
  assert.equal(signal.delivery.positionManagement, false);
  assert.equal(isDynamicWeaknessObservation(signal), true);
  const persisted = signalRecord(signal);
  assert.equal(persisted.delivery_mode, "EMAIL");
  assert.equal(persisted.payload.signalTierLabel, "SHORT 观察级");
  const email = renderSignalEmail([signal]);
  assert.match(email.subject, /^\[SHORT 观察级 \| SIGNAL-ONLY\]/);
  assert.match(email.subject, /WUSDT/);
  assert.match(email.text, /信号级别：SHORT 观察级/);
  assert.match(email.text, /尚未验证稳定净盈利/);
  assert.match(email.text, /由用户自行人工决定/);
  assert.doesNotMatch(email.text, /高质量人工关注/);
}

const routed = routeSignalsByProductionPolicy({
  candidates: Array.from({ length: 6 }, (_, index) => short("short-" + index, 90 - index)),
  limit: 4
});
assert.equal(routed.emailEligibleSignals.length, 6);
assert.equal(routed.emailCandidates.length, 4);
const capacity = splitEmailCapacity({ signals: routed.emailEligibleSignals, limit: 4 });
assert.equal(capacity.overflowSignals.length, 2);
const stats = buildSignalQueueStats({
  eligibleShortObservations: 6,
  emailedSignals: capacity.emailSignals,
  overflowSignals: capacity.overflowSignals
});
assert.equal(stats.emailedHighQualitySignals, 0);
assert.equal(stats.emailedStrongObservations, 0);
assert.equal(stats.eligibleShortObservations, 6);
assert.equal(stats.emailedShortObservations, 4);
assert.equal(stats.shortObservationOverflowSignals, 2);
assert.equal(filterSignalsByCurrentPrice({
  signals: routed.emailCandidates,
  currentPrices: new Map([["WUSDT", 100.1]]),
  maxDriftPct: 0.003
}).length, 4);
assert.equal(filterSignalsByCurrentPrice({
  signals: routed.emailCandidates,
  currentPrices: new Map([["WUSDT", 100.5]]),
  maxDriftPct: 0.003
}).length, 0);

const ordinary = routeSignalsByProductionPolicy({
  candidates: [{ ...short("ordinary"), strategyId: "existing_strategy", alertTier: "trade" }]
}).emailCandidates[0];
assert.doesNotMatch(renderSignalEmail([ordinary]).subject, /SHORT 观察级/);
const mixed = renderSignalEmail([ordinary, ...capacity.emailSignals]);
assert.match(mixed.subject, /SHORT 观察级/);
assert.match(mixed.text, /信号级别：SHORT 观察级/);
assert.match(mixed.text, /信号级别：TRADE_WATCH/);
console.log("SHORT observation email routing, labeling, persistence, capacity and price guard tests passed");
