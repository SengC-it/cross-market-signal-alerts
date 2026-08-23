import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CONFIG } from "../lib/config.js";
import { renderSignalEmail } from "../lib/report.js";
import {
  SIGNAL_ONLY_RELEASE,
  SIGNAL_TIERS,
  isSignalOnlyExecutionPath,
  routeSignalsByProductionPolicy
} from "../lib/production-signal-policy.js";
import {
  resolveStrongExtensionQualityPolicy
} from "../lib/signal-density-quality-policy.js";
import {
  evaluateStrongExtensionOpportunity,
  STRONG_CORE_PROFILE,
  STRONG_EXTENSION_PROFILE,
  STRONG_EXTENSION_VARIANT,
  isStrongExtensionPoolCandidate
} from "../lib/strategies/strong-extension.js";

const artifact = JSON.parse(readFileSync("artifacts/v4/v4-2-strong-extension-quality.json", "utf8"));

assert.deepEqual(STRONG_CORE_PROFILE, {
  variant: "STRONG_CORE_8_10",
  momentumMin: 0.08,
  momentumMax: 0.10,
  relativeStrengthMin: 0.12,
  volumeMin: 1.5,
  volumeMax: 2,
  quoteVolumeMin: 50_000_000,
  breakoutRequired: true,
  cooldownHours: 24
});
assert.deepEqual(STRONG_EXTENSION_PROFILE, {
  variant: "STRONG_EXTENSION_10_15",
  momentumMin: 0.10,
  momentumMax: 0.15,
  momentumLowerExclusive: true,
  relativeStrengthMin: 0.12,
  volumeMin: 1.5,
  volumeMax: 2,
  quoteVolumeMin: 50_000_000,
  breakoutRequired: true,
  cooldownHours: 24
});
assert.equal(CONFIG.relativeStrengthMinMomentum24h, 0.08);
assert.equal(CONFIG.relativeStrengthMaxMomentum24h, 0.10);
assert.equal(CONFIG.relativeStrengthMinRelativeStrength24h, 0.12);
assert.equal(CONFIG.relativeStrengthMinVolumeMultiple, 1.5);
assert.equal(CONFIG.relativeStrengthMaxVolumeMultiple, 2);
assert.equal(CONFIG.dynamicTradeMinRecommendationScore, 85);
assert.equal(CONFIG.dynamicSpotPoolMinQuoteVolume, 50_000_000);
assert.equal(CONFIG.assetSignalCooldownHours, 24);

const extensionTicker = { symbol: "EXTUSDT", priceChangePercent: 10.01, quoteVolume: 50_000_000 };
assert.equal(isStrongExtensionPoolCandidate(extensionTicker, new Set(), new Set(["EXTUSDT"])), true);
assert.equal(isStrongExtensionPoolCandidate({ ...extensionTicker, priceChangePercent: 10 }, new Set(), new Set(["EXTUSDT"])), false);
assert.equal(isStrongExtensionPoolCandidate({ ...extensionTicker, priceChangePercent: 15.01 }, new Set(), new Set(["EXTUSDT"])), false);
assert.equal(isStrongExtensionPoolCandidate({ ...extensionTicker, quoteVolume: 49_999_999 }, new Set(), new Set(["EXTUSDT"])), false);

const extensionFeatureBase = {
  momentum24h: 0.11,
  relativeStrength: 0.12,
  volumeMultiple: 1.5,
  breakout: true,
  momentumMin: 0.10,
  momentumMax: 0.15
};
assert.equal(evaluateStrongExtensionOpportunity({ features: extensionFeatureBase }).passed, true);
assert.equal(evaluateStrongExtensionOpportunity({ features: { ...extensionFeatureBase, momentum24h: 0.10 } }).passed, false);
assert.equal(evaluateStrongExtensionOpportunity({ features: { ...extensionFeatureBase, momentum24h: 0.15 } }).passed, true);
assert.equal(evaluateStrongExtensionOpportunity({ features: { ...extensionFeatureBase, momentum24h: 0.151 } }).passed, false);
assert.equal(evaluateStrongExtensionOpportunity({ features: { ...extensionFeatureBase, relativeStrength: 0.119 } }).passed, false);
assert.equal(evaluateStrongExtensionOpportunity({ features: { ...extensionFeatureBase, volumeMultiple: 1.49 } }).passed, false);
assert.equal(evaluateStrongExtensionOpportunity({ features: { ...extensionFeatureBase, volumeMultiple: 2.01 } }).passed, false);
assert.equal(evaluateStrongExtensionOpportunity({ features: { ...extensionFeatureBase, breakout: false } }).passed, false);

const extensionSignal = {
  signalKey: "extension-test",
  asset: "EXTUSDT",
  close: 100,
  signalAvailableAt: Date.parse("2026-08-01T00:00:00.000Z"),
  validUntil: Date.parse("2026-08-01T04:00:00.000Z"),
  strategyId: "dynamic_relative_strength_breakout",
  signalVariant: STRONG_EXTENSION_VARIANT,
  alertTier: "watch",
  dynamicPoolRank: 12,
  recommendationScore: 90,
  direction: "做多观察",
  triggerReason: "固定 extension regression fixture"
};
const shadowPolicy = { classification: "SHADOW_OBSERVATION_ONLY", failClosed: false };
const passPolicy = { classification: "STRONG_OBSERVATION", failClosed: false };

const failedExtension = routeSignalsByProductionPolicy({
  candidates: [extensionSignal],
  strengthObservationEmailEnabled: true,
  strongExtensionQualityPolicy: shadowPolicy
});
assert.equal(failedExtension.emailCandidates.length, 0);
assert.equal(failedExtension.shadowOnlySignals.length, 1);
assert.equal(failedExtension.shadowOnlySignals[0].delivery.mode, "SHADOW_ONLY");

const passedExtension = routeSignalsByProductionPolicy({
  candidates: [extensionSignal],
  strengthObservationEmailEnabled: true,
  strongExtensionQualityPolicy: passPolicy
});
assert.equal(passedExtension.emailCandidates.length, 1);
assert.equal(passedExtension.emailCandidates[0].signalTier, SIGNAL_TIERS.OBSERVATION);
assert.equal(passedExtension.emailCandidates[0].delivery.mode, "EMAIL");
const extensionEmail = renderSignalEmail(passedExtension.emailCandidates);
assert.match(extensionEmail.text, /STRONG EXTENSION/);
assert.match(extensionEmail.text, /NOT_VALIDATED_PROFITABILITY/);
assert.match(extensionEmail.text, /REFERENCE ONLY/);
assert.match(extensionEmail.text, /人工决定/);

const missingPolicy = resolveStrongExtensionQualityPolicy(null);
assert.equal(missingPolicy.classification, "SHADOW_OBSERVATION_ONLY");
assert.equal(missingPolicy.failClosed, true);
const missingExtension = routeSignalsByProductionPolicy({
  candidates: [extensionSignal],
  strengthObservationEmailEnabled: true,
  strongExtensionQualityPolicy: missingPolicy
});
assert.equal(missingExtension.emailCandidates.length, 0);
assert.equal(missingExtension.shadowOnlySignals.length, 1);

const coreSignal = {
  ...extensionSignal,
  signalKey: "core-test",
  signalVariant: STRONG_CORE_PROFILE.variant,
  dynamicPoolRank: 1
};
const coreRouted = routeSignalsByProductionPolicy({
  candidates: [coreSignal],
  strengthObservationEmailEnabled: true,
  rank11To25QualityPolicy: { classification: "SHADOW_OBSERVATION_ONLY", failClosed: false }
});
assert.equal(coreRouted.emailCandidates.length, 1);

const weakRouted = routeSignalsByProductionPolicy({
  candidates: [{ ...extensionSignal, signalKey: "weak-test", strategyId: "dynamic_relative_weakness_breakdown" }],
  strengthObservationEmailEnabled: true
});
assert.equal(weakRouted.emailCandidates.length, 0);
assert.equal(weakRouted.shadowOnlySignals.length, 1);

const m37Routed = routeSignalsByProductionPolicy({
  candidates: [{ ...extensionSignal, signalKey: "m37-test", strategyId: "cross_sectional_relative_momentum_v1" }],
  strengthObservationEmailEnabled: true
});
assert.equal(m37Routed.emailCandidates.length, 0);
assert.equal(m37Routed.researchOnlySignals.length, 1);

assert.equal(SIGNAL_ONLY_RELEASE.autoTrading, false);
assert.equal(SIGNAL_ONLY_RELEASE.orderPlacement, false);
assert.equal(SIGNAL_ONLY_RELEASE.positionManagement, false);
assert.equal(isSignalOnlyExecutionPath(SIGNAL_ONLY_RELEASE), true);
assert.equal(SIGNAL_ONLY_RELEASE.duplicateSignalProtection, true);
assert.equal(SIGNAL_ONLY_RELEASE.processedCandleProtection, true);
assert.equal(SIGNAL_ONLY_RELEASE.currentPriceGuard, true);

assert.equal(artifact.historicalUniverse.assetsLoaded, 805);
assert.equal(artifact.historicalUniverse.datasetDescriptors, 805);
assert.equal(artifact.historicalUniverse.historicalUniverseComplete, true);
assert.equal(artifact.historicalUniverse.survivorshipBiasRisk, false);
assert.deepEqual(artifact.window, {
  start: "2025-08-01T00:00:00.000Z",
  end: "2026-08-01T00:00:00.000Z",
  months: 12,
  folds: 5,
  holdHours: 8,
  roundTripCostProxy: 0.0012,
  signalFrequencyBasis: "all gated signals"
});
assert.equal(artifact.parameterSearchPerformed, false);
assert.equal(artifact.thresholdsChanged, false);
assert.equal(artifact.extensionVerdict.classification, "STRONG_OBSERVATION");
assert.deepEqual(Object.keys(artifact.extensionVerdict.gates).sort(), [
  "completeSignals",
  "maxAssetShareAtMost25Pct",
  "net4hPositive",
  "net8hPositive",
  "pf4hAtLeast110",
  "pf8hAtLeast110",
  "positiveFoldsAtLeast3Of5",
  "signalsPerMonth"
].sort());

const v41QualitySource = readFileSync("scripts/v4-1-signal-density-quality.js", "utf8");
assert.equal(v41QualitySource.includes("slice(0, 250)"), false);
assert.match(v41QualitySource, /loadHistoricalUniverseIndex/);

console.log("v4.2 strong extension tests passed");
