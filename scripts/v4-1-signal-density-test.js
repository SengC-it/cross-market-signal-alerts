import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  M37_REJECTED_STRATEGY_IDS,
  SIGNAL_ONLY_RELEASE,
  SIGNAL_TIERS,
  applyProductionSignalPolicy,
  classifyProductionSignal,
  routeSignalsByProductionPolicy,
  markSignalAsWebOverflow
} from "../lib/production-signal-policy.js";
import {
  buildSignalQueueStats,
  filterSignalsByCurrentPrice,
  splitEmailCapacity
} from "../lib/scanner.js";
import {
  evaluateDynamicProductionOpportunity,
} from "../lib/strategies/dynamic-production.js";
import { rankDynamicPoolTickerDetails } from "../lib/signal-density-pool.js";
import { SIGNAL_DENSITY_CONFIG } from "../lib/signal-density-config.js";
import { buildSignalDensityKpi } from "../lib/signal-density.js";
import { classifyRank11To25, summarizeRankQuality } from "../lib/validation/signal-density-quality.js";

const scannerSource = readFileSync(new URL("../lib/scanner.js", import.meta.url), "utf8");
const dashboardSource = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

assert.equal(SIGNAL_ONLY_RELEASE.autoTrading, false);
assert.equal(SIGNAL_ONLY_RELEASE.orderPlacement, false);
assert.equal(SIGNAL_ONLY_RELEASE.positionManagement, false);
assert.equal(SIGNAL_ONLY_RELEASE.duplicateSignalProtection, true);
assert.equal(SIGNAL_ONLY_RELEASE.processedCandleProtection, true);
assert.equal(SIGNAL_ONLY_RELEASE.currentPriceGuard, true);
assert.equal(SIGNAL_DENSITY_CONFIG.dynamicStrongPoolMaxAssets, 25);
assert.equal(SIGNAL_DENSITY_CONFIG.maxSignalsPerEmail, 4);

const fixture = (signalKey, strategyId, alertTier = "watch", score = 70) => ({
  signalKey,
  strategyId,
  alertTier,
  recommendationScore: score,
  asset: `${signalKey}USDT`,
  triggerTime: Date.now(),
  close: 100
});

const weakRoute = routeSignalsByProductionPolicy({
  candidates: [fixture("weak", "dynamic_relative_weakness_breakdown", "trade", 99)],
  strengthObservationEmailEnabled: true,
  observationEmailEnabled: true,
  limit: 4
});
assert.equal(weakRoute.emailEligibleSignals.length, 0);
assert.equal(weakRoute.shadowOnlySignals.length, 1);

const rejectedRoute = routeSignalsByProductionPolicy({
  candidates: M37_REJECTED_STRATEGY_IDS.map((strategyId, index) => fixture(`m37-${index}`, strategyId, "trade", 99)),
  strengthObservationEmailEnabled: true,
  observationEmailEnabled: true,
  limit: 4
});
assert.equal(rejectedRoute.emailEligibleSignals.length, 0);
assert.equal(rejectedRoute.researchOnlySignals.length, 3);

const genericObservation = routeSignalsByProductionPolicy({
  candidates: [fixture("generic-observation", "some_observation_strategy", "watch", 95)],
  strengthObservationEmailEnabled: true,
  observationEmailEnabled: true,
  limit: 4
});
assert.equal(genericObservation.emailEligibleSignals.length, 0);
assert.equal(genericObservation.webSignals.length, 1);

const strongObservation = routeSignalsByProductionPolicy({
  candidates: [fixture("strong-observation", "dynamic_relative_strength_breakout", "watch", 95)],
  strengthObservationEmailEnabled: true,
  limit: 4
});
assert.equal(strongObservation.emailEligibleSignals.length, 1);
assert.equal(strongObservation.emailEligibleSignals[0].signalTier, SIGNAL_TIERS.OBSERVATION);

const capacityInput = Array.from({ length: 6 }, (_, index) => applyProductionSignalPolicy(
  fixture(`capacity-${index}`, "existing_strategy", "trade", 100 - index)
));
const capacity = splitEmailCapacity({ signals: capacityInput, limit: 4 });
assert.equal(capacity.emailSignals.length, 4);
assert.equal(capacity.overflowSignals.length, 2);
assert.equal(new Set([...capacity.emailSignals, ...capacity.overflowSignals].map((signal) => signal.signalKey)).size, 6);
assert.equal(markSignalAsWebOverflow(capacity.overflowSignals[0]).delivery.mode, "WEB");
assert.equal(markSignalAsWebOverflow(capacity.overflowSignals[0]).delivery.webRecorded, true);
assert.deepEqual(buildSignalQueueStats({
  eligibleHighQualitySignals: 6,
  eligibleStrongObservations: 0,
  emailedSignals: capacity.emailSignals,
  overflowSignals: capacity.overflowSignals
}), {
  eligibleHighQualitySignals: 6,
  emailedHighQualitySignals: 4,
  highQualityOverflowSignals: 2,
  eligibleStrongObservations: 0,
  emailedStrongObservations: 0,
  observationOverflowSignals: 0
});

const sameGate = (rank) => evaluateDynamicProductionOpportunity({
  strategyId: "dynamic_relative_strength_breakout",
  momentum24h: 0.08,
  relativeStrength: 0.12,
  volumeMultiple: 1.75,
  breakout: true,
  hasOrderBook: true,
  dynamicPoolRank: rank
});
assert.deepEqual(sameGate(1), sameGate(11));
const ranked = rankDynamicPoolTickerDetails({
  tickers: Array.from({ length: 25 }, (_, index) => ({
    symbol: `RANK${String(index + 1).padStart(2, "0")}USDT`,
    priceChangePercent: 9,
    quoteVolume: 60_000_000 + index
  })),
  direction: "strong",
  futuresSymbols: new Set(Array.from({ length: 25 }, (_, index) => `RANK${String(index + 1).padStart(2, "0")}USDT`)),
  maxAssets: 25
});
assert.equal(ranked.length, 25);
assert.equal(ranked[0].dynamicPoolRankBand, "1-10");
assert.equal(ranked[10].dynamicPoolRankBand, "11-25");
assert.equal(ranked[24].dynamicPoolRankBand, "11-25");

const guardWarnings = [];
const guarded = filterSignalsByCurrentPrice({
  signals: [fixture("guard-pass", "existing_strategy", "trade"), fixture("guard-drop", "existing_strategy", "trade")],
  currentPrices: new Map([["guard-passUSDT", 100.2], ["guard-dropUSDT", 100.4]]),
  maxDriftPct: 0.003,
  warnings: guardWarnings
});
assert.deepEqual(guarded.map((signal) => signal.signalKey), ["guard-pass"]);
assert.equal(guardWarnings.length, 1);

const now = Date.parse("2026-08-23T00:00:00.000Z");
const signalDensity = buildSignalDensityKpi({
  now,
  sentAlerts: [
    { signal_key: "tw", sent_at: "2026-08-22T00:00:00Z", strategy_id: "existing", payload: { signalTier: "TRADE_WATCH" } },
    { signal_key: "obs", sent_at: "2026-08-10T00:00:00Z", strategy_id: "dynamic_relative_strength_breakout", payload: { signalTier: "OBSERVATION", dynamicPoolRank: 12 } },
    { signal_key: "shadow", sent_at: "2026-08-10T00:00:00Z", strategy_id: "dynamic_relative_weakness_breakdown", payload: { signalTier: "SHADOW_ONLY" } }
  ],
  runLogs: [{
    created_at: "2026-08-22T00:00:00Z",
    warnings: [{ label: "research-only production block", warning: "frozen research candidate" }]
  }]
});
assert.equal(signalDensity.signalsLast7d, 1);
assert.equal(signalDensity.signalsLast30d, 3);
assert.equal(signalDensity.tradeWatchLast30d, 1);
assert.equal(signalDensity.strongObservationLast30d, 1);
assert.equal(signalDensity.shadowLast30d, 1);
assert.equal(signalDensity.researchBlockedLast30d, 1);
assert.equal(signalDensity.strongRank11To25Last30d, 1);

const syntheticPositive = summarizeRankQuality(Array.from({ length: 30 }, (_, index) => ({
  return1h: 0.01,
  return4h: 0.02,
  return8h: 0.03,
  mae8h: -0.01,
  mfe8h: 0.04,
  fold: index % 5
})), { tradingCost: 0.0012 });
assert.equal(classifyRank11To25(syntheticPositive).classification, "STRONG_OBSERVATION_EMAIL");

assert.ok(scannerSource.includes("hasSentSignal"));
assert.ok(scannerSource.includes("processedScanCandleState"));
assert.ok(scannerSource.includes("markSignalAsWebOverflow"));
assert.ok(scannerSource.includes("persistNonEmailSignals"));
assert.ok(dashboardSource.includes("signalDensityKpi"));
assert.ok(dashboardSource.includes("strongRank11To25Last30d"));
assert.ok(packageJson.scripts["quality:v4-1"]);

console.log("v4.1 signal density regression tests passed");
