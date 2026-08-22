import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import {
  M37_BASE_SHA,
  M37_FAMILY_DEFINITIONS,
  M37_FORWARD_SPEC,
  M37_OLD_WINDOW_ROLE,
  M37_FORMAL_FORWARD_GATE,
  M37_RESEARCH_GATE,
  buildM37FamilySignals,
  buildM37ForwardSpec,
  buildM37MarketContext,
  buildM37TradePlan,
  candidateDefinitionsHash,
  crossSectionalPercentile,
  evaluateM37ResearchGate,
  familyDefinitions,
  fixedForwardWindowSplit,
  formalForwardVerdict,
  historicalUniverseAssetsAt,
  summarizeM37ProviderGapPolicy,
  summarizeM37Research
} from "../lib/validation/m3-7-strategy-family-reset.js";
import { buildM37ResearchSpanPlan } from "../lib/validation/m3-7-data.js";
import {
  M37_PROVIDER_GAP_POLICY_VERSION,
  M37_PROVIDER_GAP_REGISTRY,
  PURGED_PROVIDER_DATA_GAP,
  normalizeProviderGapRegistry,
  providerGapDependency,
  providerGapRegistryMissingBars
} from "../lib/validation/m3-7-provider-gaps.js";

const ROOT = process.cwd();
const REPORT_PATH = "artifacts/m3/m3-7-strategy-family-reset.json";
const FORWARD_SPEC_PATH = "artifacts/m3/m3-7-forward-spec.json";

assert.equal(M37_OLD_WINDOW_ROLE, "RESEARCH_ONLY_AFTER_MULTIPLE_INSPECTIONS");
assert.deepEqual(M37_FORWARD_SPEC, {
  datasetId: "M37_FORWARD_2026_08_2026_12",
  start: "2026-08-01T00:00:00.000Z",
  endExclusive: "2026-12-01T00:00:00.000Z"
});
assert.equal(M37_FAMILY_DEFINITIONS.length, 3);
assert.equal(familyDefinitions().length, 3);
assert.equal(new Set(familyDefinitions().map((definition) => definition.id)).size, 3);
assert.equal(candidateDefinitionsHash(), candidateDefinitionsHash(familyDefinitions()));
assert.equal(/grid|search|optimiz/i.test(JSON.stringify(familyDefinitions())), false);
assert.equal(familyDefinitions().every((definition) => definition.recommendationScoreGate === false), true);
assert.equal(familyDefinitions().some((definition) => definition.id.endsWith("_v2")), false);

const forwardSpec = buildM37ForwardSpec();
assert.deepEqual(forwardSpec.candidateIds, familyDefinitions().map((definition) => definition.id));
assert.equal(forwardSpec.candidateDefinitionsHash, candidateDefinitionsHash());
assert.equal(forwardSpec.createdBeforeFormalForwardEvaluation, true);
assert.equal(forwardSpec.candidateDefinitionsFrozen, true);
assert.deepEqual(forwardSpec.split, fixedForwardWindowSplit());
assert.equal(forwardSpec.split.walkForwardStart, "2026-08-01T00:00:00.000Z");
assert.equal(forwardSpec.split.walkForwardEndExclusive, "2026-11-06T15:00:00.000Z");
assert.equal(forwardSpec.split.finalHoldoutStart, "2026-11-06T15:00:00.000Z");
assert.equal(forwardSpec.split.finalHoldoutEndExclusive, "2026-12-01T00:00:00.000Z");
assert.equal(forwardSpec.split.splitAlignedToInterval, true);
assert.equal(candidateDefinitionsHash(), "d368c1f83680d7b30418ff279af9e706e6486a4ba45415896aedbeb40908e3ff");

const oldResearchEnd = Date.parse(M37_FORWARD_SPEC.start);
const researchHour = 3600 * 1000;
const boundarySignal = {
  familyId: "cross_sectional_relative_momentum_v1",
  asset: "BOUNDARYUSDT",
  side: "LONG",
  signalCandleOpenTime: oldResearchEnd - 2 * researchHour,
  signalCandleCloseTime: oldResearchEnd - researchHour,
  signalAvailableAt: oldResearchEnd,
  entryEligibleAt: oldResearchEnd,
  referencePrice: 100
};
const crossingSignal = {
  ...boundarySignal,
  signalCandleOpenTime: oldResearchEnd - 2 * researchHour,
  signalCandleCloseTime: oldResearchEnd - researchHour,
  signalAvailableAt: oldResearchEnd - researchHour,
  entryEligibleAt: oldResearchEnd - researchHour,
  maxHoldingTime: oldResearchEnd + 3 * researchHour
};
const eligibleSignal = {
  ...boundarySignal,
  asset: "ELIGIBLEUSDT",
  signalCandleOpenTime: oldResearchEnd - 10 * researchHour,
  signalCandleCloseTime: oldResearchEnd - 9 * researchHour,
  signalAvailableAt: oldResearchEnd - 9 * researchHour,
  entryEligibleAt: oldResearchEnd - 9 * researchHour,
  maxHoldingHours: 8,
  maxHoldingTime: null
};
const boundarySpanPlan = buildM37ResearchSpanPlan({
  cross_sectional_relative_momentum_v1: [boundarySignal, crossingSignal, eligibleSignal]
});
assert.equal(boundarySpanPlan.researchBoundaryPurgedByFamily.cross_sectional_relative_momentum_v1.length, 2);
assert.equal(boundarySpanPlan.researchBoundaryPurgedByFamily.cross_sectional_relative_momentum_v1.every((row) => row.reason), true);
assert.deepEqual(boundarySpanPlan.spansByFamily.cross_sectional_relative_momentum_v1.get("ELIGIBLEUSDT"), [{
  start: oldResearchEnd - 9 * researchHour,
  end: oldResearchEnd - researchHour
}]);
assert.equal(boundarySpanPlan.spansByFamily.cross_sectional_relative_momentum_v1.has("BOUNDARYUSDT"), false);

assert.equal(crossSectionalPercentile(1, [1, 2, 3]), 0);
assert.equal(crossSectionalPercentile(3, [1, 2, 3]), 1);
assert.equal(crossSectionalPercentile(2, [1, 2, 3]), 0.5);
const historicalUniverse = [
  { time: "2026-08-01T00:00:00.000Z", assets: ["DELISTEDUSDT", "CURRENTUSDT"] },
  { time: "2026-09-01T00:00:00.000Z", assets: ["CURRENTUSDT"] }
];
assert.equal(historicalUniverseAssetsAt(historicalUniverse, "2026-08-15T00:00:00.000Z").has("DELISTEDUSDT"), true);
assert.equal(historicalUniverseAssetsAt(historicalUniverse, "2026-09-15T00:00:00.000Z").has("DELISTEDUSDT"), false);

const lifecycleHour = 3600 * 1000;
const lifecycleContext = buildM37MarketContext({
  datasets: [
    { asset: "OLDUSDT", candles: buildFlatCandles(40, 0) },
    { asset: "NEWUSDT", candles: buildFlatCandles(20, 20) }
  ],
  historicalUniverse: [
    { time: 0, assets: ["OLDUSDT"] },
    { time: 20 * lifecycleHour, assets: ["OLDUSDT", "NEWUSDT"] },
    { time: 35 * lifecycleHour, assets: ["OLDUSDT"] }
  ],
  window: { start: 0, endExclusive: 40 * lifecycleHour }
});
assert.equal(lifecycleContext.assetsAt(19 * lifecycleHour).has("NEWUSDT"), false);
assert.equal(lifecycleContext.assetsAt(20 * lifecycleHour).has("NEWUSDT"), true);
assert.equal(lifecycleContext.assetsAt(35 * lifecycleHour).has("NEWUSDT"), false);
assert.equal(lifecycleContext.crossSectionalUniverseAt(20 * lifecycleHour).crossSectionalUniverseComplete, true);

const missingActiveContext = buildM37MarketContext({
  datasets: [{ asset: "OLDUSDT", candles: buildFlatCandles(40, 0) }],
  historicalUniverse: [{ time: 0, assets: ["OLDUSDT", "MISSINGUSDT"] }],
  window: { start: 0, endExclusive: 40 * lifecycleHour }
});
const missingDiagnostic = missingActiveContext.crossSectionalUniverseAt(25 * lifecycleHour);
assert.equal(missingDiagnostic.crossSectionalUniverseComplete, false);
assert.deepEqual(missingDiagnostic.missingActiveAssets, ["MISSINGUSDT"]);

assert.equal(M37_PROVIDER_GAP_POLICY_VERSION, "M3_7_PROVIDER_GAP_POLICY_V1");
assert.equal(normalizeProviderGapRegistry(M37_PROVIDER_GAP_REGISTRY).length, 2);
assert.equal(providerGapRegistryMissingBars(M37_PROVIDER_GAP_REGISTRY), 28);
const providerGapStart = 10 * lifecycleHour;
const providerGapEnd = 11 * lifecycleHour;
const fixtureProviderGaps = [{
  asset: "GAPUSDT",
  start: providerGapStart,
  endExclusive: providerGapEnd,
  missingBars: 1,
  primarySource: "FIXTURE_PRIMARY",
  fallbackSource: "FIXTURE_FALLBACK",
  status: "PROVIDER_DATA_MISSING"
}];
const directProviderDependency = providerGapDependency(fixtureProviderGaps, {
  asset: "GAPUSDT",
  start: providerGapStart,
  endExclusive: providerGapEnd
});
assert.equal(directProviderDependency.affected, true);
assert.equal(directProviderDependency.gaps[0].status, "PROVIDER_DATA_MISSING");

const providerGapContext = buildM37MarketContext({
  datasets: [
    { asset: "GAPUSDT", candles: buildFlatCandles(40, 0) },
    { asset: "OTHERUSDT", candles: buildFlatCandles(40, 0) }
  ],
  historicalUniverse: [{ time: 0, assets: ["GAPUSDT", "OTHERUSDT"] }],
  historicalUniverseComplete: true,
  providerGapRegistry: fixtureProviderGaps,
  benchmarkCandles: buildBenchmarkCandles(),
  window: { start: 0, endExclusive: 40 * lifecycleHour }
});
const currentProviderGapDiagnostic = providerGapContext.crossSectionalUniverseAt(providerGapStart);
assert.equal(currentProviderGapDiagnostic.crossSectionalUniverseComplete, false);
assert.equal(currentProviderGapDiagnostic.providerGapContaminated, true);
assert.deepEqual(currentProviderGapDiagnostic.providerGapMissingAssets, ["GAPUSDT"]);
const lookbackProviderGapDiagnostic = providerGapContext.crossSectionalUniverseAt(20 * lifecycleHour);
assert.equal(lookbackProviderGapDiagnostic.providerGapContaminated, true);
const beforeProviderGapDiagnostic = providerGapContext.crossSectionalUniverseAt(9 * lifecycleHour);
assert.equal(beforeProviderGapDiagnostic.providerGapContaminated, false);
const recoveredProviderGapDiagnostic = providerGapContext.crossSectionalUniverseAt(36 * lifecycleHour);
assert.equal(recoveredProviderGapDiagnostic.providerGapContaminated, false);
buildM37FamilySignals({
  familyId: "cross_sectional_relative_momentum_v1",
  context: providerGapContext
});
const crossProviderPurges = providerGapContext.providerGapPurgeRecords
  .filter((record) => record.familyId === "cross_sectional_relative_momentum_v1");
assert.equal(crossProviderPurges.some((record) => record.scope === "timestamp"
  && record.affectedAssets.includes("GAPUSDT")
  && record.affectedAssets.includes("OTHERUSDT")
  && record.status === PURGED_PROVIDER_DATA_GAP), true);
assert.equal(providerGapContext.providerGapEvaluation.byFamily.cross_sectional_relative_momentum_v1.providerGapPurgedSignals > 0, true);

const lifecycleWarmupProviderContext = buildM37MarketContext({
  datasets: [{ asset: "NEWUSDT", candles: buildFlatCandles(20, 20) }],
  historicalUniverse: [{ time: 20 * lifecycleHour, assets: ["NEWUSDT"] }],
  historicalUniverseMetadata: [{ asset: "NEWUSDT", firstSeen: 20 * lifecycleHour }],
  historicalUniverseComplete: true,
  providerGapRegistry: [{
    asset: "NEWUSDT",
    start: 0,
    endExclusive: lifecycleHour,
    missingBars: 1,
    primarySource: "FIXTURE_PRIMARY",
    fallbackSource: "FIXTURE_FALLBACK",
    status: "PROVIDER_DATA_MISSING"
  }],
  window: { start: 0, endExclusive: 40 * lifecycleHour }
});
const lifecycleWarmupDiagnostic = lifecycleWarmupProviderContext.crossSectionalUniverseAt(20 * lifecycleHour);
assert.equal(lifecycleWarmupDiagnostic.crossSectionalUniverseComplete, true);
assert.equal(lifecycleWarmupDiagnostic.providerGapContaminated, false);

const dislocationCandles = buildDislocationCandles();
const dislocationContext = buildM37MarketContext({
  datasets: [{ asset: "DELISTEDUSDT", candles: dislocationCandles }],
  historicalUniverse: [{ time: 0, assets: ["DELISTEDUSDT"] }],
  window: { start: 0, endExclusive: 31 * 3600 * 1000 }
});
const dislocationSignals = buildM37FamilySignals({
  familyId: "atr_dislocation_mean_reversion_v1",
  context: dislocationContext
});
assert.equal(dislocationSignals.length > 0, true);
assert.equal(dislocationSignals[0].signalAvailableAt, dislocationSignals[0].signalCandleCloseTime);
assert.equal(dislocationSignals[0].entryEligibleAt, dislocationSignals[0].signalCandleCloseTime);
assert.equal(dislocationSignals[0].recommendationScore, null);
const dislocationPlan = buildM37TradePlan({
  familyId: "atr_dislocation_mean_reversion_v1",
  signal: dislocationSignals[0],
  candles: dislocationCandles,
  signalIndex: 30
});
assert.equal(dislocationPlan.tradeSpec.entryEligibleAt, dislocationSignals[0].signalCandleCloseTime);
assert.equal(dislocationPlan.tradeSpec.maxHoldingHours, 4);
assert.equal(dislocationPlan.tradeSpec.rewardRiskRatio, 1.5);

const atrProviderGapContext = buildM37MarketContext({
  datasets: [{ asset: "DELISTEDUSDT", candles: dislocationCandles }],
  historicalUniverse: [{ time: 0, assets: ["DELISTEDUSDT"] }],
  historicalUniverseComplete: true,
  providerGapRegistry: [{
    asset: "DELISTEDUSDT",
    start: 24 * lifecycleHour,
    endExclusive: 25 * lifecycleHour,
    missingBars: 1,
    primarySource: "FIXTURE_PRIMARY",
    fallbackSource: "FIXTURE_FALLBACK",
    status: "PROVIDER_DATA_MISSING"
  }],
  window: { start: 0, endExclusive: 31 * lifecycleHour }
});
const atrProviderGapSignals = buildM37FamilySignals({
  familyId: "atr_dislocation_mean_reversion_v1",
  context: atrProviderGapContext
});
assert.equal(atrProviderGapSignals.length, 0);
assert.equal(atrProviderGapContext.providerGapEvaluation.byFamily.atr_dislocation_mean_reversion_v1.providerGapPurgedSignals > 0, true);
const atrUnrelatedProviderGapContext = buildM37MarketContext({
  datasets: [{ asset: "DELISTEDUSDT", candles: dislocationCandles }],
  historicalUniverse: [{ time: 0, assets: ["DELISTEDUSDT"] }],
  historicalUniverseComplete: true,
  providerGapRegistry: [{
    asset: "OTHERUSDT",
    start: 24 * lifecycleHour,
    endExclusive: 25 * lifecycleHour,
    missingBars: 1,
    primarySource: "FIXTURE_PRIMARY",
    fallbackSource: "FIXTURE_FALLBACK",
    status: "PROVIDER_DATA_MISSING"
  }],
  window: { start: 0, endExclusive: 31 * lifecycleHour }
});
assert.equal(buildM37FamilySignals({
  familyId: "atr_dislocation_mean_reversion_v1",
  context: atrUnrelatedProviderGapContext
}).length > 0, true);

const futureMutation = structuredClone(dislocationCandles);
futureMutation[31] = { ...futureMutation[31], close: 1000, high: 1200, low: 1, volume: 999999 };
const mutatedContext = buildM37MarketContext({
  datasets: [{ asset: "DELISTEDUSDT", candles: futureMutation }],
  historicalUniverse: [{ time: 0, assets: ["DELISTEDUSDT"] }],
  window: { start: 0, endExclusive: 31 * 3600 * 1000 }
});
const mutatedSignals = buildM37FamilySignals({
  familyId: "atr_dislocation_mean_reversion_v1",
  context: mutatedContext
});
assert.deepEqual(
  mutatedSignals.filter((signal) => signal.signalCandleOpenTime <= 30 * 3600 * 1000),
  dislocationSignals.filter((signal) => signal.signalCandleOpenTime <= 30 * 3600 * 1000),
  "future candle must not alter a historical signal"
);

const fundingCandlesA = buildFundingCandles(90);
const fundingCandlesB = buildFundingCandles(110);
const fundingEventsA = [{ time: 30 * 3600 * 1000, rate: -0.01 }];
const fundingEventsB = [{ time: 30 * 3600 * 1000, rate: 0.01 }];
const fundingContext = buildM37MarketContext({
  datasets: [
    { asset: "AUSDT", candles: fundingCandlesA, fundingEvents: fundingEventsA },
    { asset: "BUSDT", candles: fundingCandlesB, fundingEvents: fundingEventsB }
  ],
  historicalUniverse: [{ time: 0, assets: ["AUSDT", "BUSDT"] }],
  window: { start: 0, endExclusive: 31 * 3600 * 1000 }
});
const fundingSignals = buildM37FamilySignals({
  familyId: "funding_extreme_crowding_reversal_v1",
  context: fundingContext
});
assert.equal(fundingSignals.length >= 2, true);
assert.equal(fundingSignals.every((signal) => signal.details.fundingEventTime < signal.signalAvailableAt), true);
assert.equal(new Set(fundingSignals.map((signal) => `${signal.asset}:${signal.details.fundingEventTime}`)).size, fundingSignals.length);
assert.equal(fundingContext.fundingEvaluation.duplicateFundingEventSignals, 0);
const fundingProviderGapContext = buildM37MarketContext({
  datasets: [
    { asset: "AUSDT", candles: fundingCandlesA, fundingEvents: fundingEventsA },
    { asset: "BUSDT", candles: fundingCandlesB, fundingEvents: fundingEventsB }
  ],
  historicalUniverse: [{ time: 0, assets: ["AUSDT", "BUSDT"] }],
  historicalUniverseComplete: true,
  providerGapRegistry: [{
    asset: "AUSDT",
    start: 25 * lifecycleHour,
    endExclusive: 26 * lifecycleHour,
    missingBars: 1,
    primarySource: "FIXTURE_PRIMARY",
    fallbackSource: "FIXTURE_FALLBACK",
    status: "PROVIDER_DATA_MISSING"
  }],
  window: { start: 0, endExclusive: 31 * 3600 * 1000 }
});
const fundingProviderGapSignals = buildM37FamilySignals({
  familyId: "funding_extreme_crowding_reversal_v1",
  context: fundingProviderGapContext
});
assert.equal(fundingProviderGapSignals.some((signal) => signal.asset === "AUSDT"), false);
const unaffectedFundingSignal = fundingProviderGapSignals.find((signal) => signal.asset === "BUSDT");
assert.ok(unaffectedFundingSignal);
assert.equal(unaffectedFundingSignal.details.fundingPercentile, 1);
assert.equal(fundingProviderGapContext.providerGapEvaluation.byFamily.funding_extreme_crowding_reversal_v1.providerGapPurgedSignals, 1);
assert.equal(fundingProviderGapContext.fundingEvaluation.duplicateFundingEventSignals, 0);
const providerPolicySummary = summarizeM37ProviderGapPolicy({
  context: fundingProviderGapContext,
  inputCoverage: {
    requiredHistoricalFundingAvailable: true,
    signalRelevantFundingCoverage: { complete: true },
    signalRelevantLowerTfCoverage: { complete: true }
  }
});
assert.equal(providerPolicySummary.rawProviderDataComplete, false);
assert.equal(providerPolicySummary.providerConfirmedMissing1hBars, 1);
assert.equal(providerPolicySummary.providerGapPolicyFrozen, true);
assert.equal(providerPolicySummary.providerGapPurgedOpportunities, 1);
assert.equal(providerPolicySummary.unhandledProviderGapDependencies, 0);
assert.equal(providerPolicySummary.researchEffectiveDataQualityComplete, true);
const providerPurgeSummary = summarizeM37Research({
  familyId: "funding_extreme_crowding_reversal_v1",
  signals: [],
  tradeResults: [{
    asset: "AUSDT",
    side: "LONG",
    dataQuality: PURGED_PROVIDER_DATA_GAP,
    ambiguousIntrabar: false
  }],
  dataQuality: {
    researchDataQualityComplete: false,
    researchEffectiveDataQualityComplete: true
  }
});
assert.equal(providerPurgeSummary.completeTrades, 0);
assert.equal(providerPurgeSummary.metrics.profitFactor, null);
const futureFundingContext = buildM37MarketContext({
  datasets: [
    { asset: "AUSDT", candles: fundingCandlesA, fundingEvents: [...fundingEventsA, { time: 31 * 3600 * 1000, rate: 0.9 }] },
    { asset: "BUSDT", candles: fundingCandlesB, fundingEvents: [...fundingEventsB, { time: 31 * 3600 * 1000, rate: -0.9 }] }
  ],
  historicalUniverse: [{ time: 0, assets: ["AUSDT", "BUSDT"] }],
  window: { start: 0, endExclusive: 31 * 3600 * 1000 }
});
const futureFundingSignals = buildM37FamilySignals({
  familyId: "funding_extreme_crowding_reversal_v1",
  context: futureFundingContext
});
assert.deepEqual(futureFundingSignals, fundingSignals, "future settlement must not affect the current funding signal");

const incompleteQuality = evaluateM37ResearchGate({
  completeTrades: 100,
  positiveResearchFolds: 5,
  concentration: {
    maxAssetTradeShare: 0.2,
    maxFoldTradeShare: 0.2,
    maxSideTradeShare: 0.8,
    sideCount: 2
  },
  metrics: { netExpectancyR: 0.2, profitFactor: 1.5, grossExpectancyR: 0.3 },
  researchDataQualityComplete: false
});
assert.equal(incompleteQuality.status, "DATA_INCOMPLETE");
assert.equal(incompleteQuality.allGatesPassed, false);

const passingResearch = evaluateM37ResearchGate({
  completeTrades: 30,
  positiveResearchFolds: 3,
  concentration: {
    maxAssetTradeShare: 0.2,
    maxFoldTradeShare: 0.4,
    maxSideTradeShare: 0.8,
    sideCount: 2
  },
  metrics: { netExpectancyR: 0.1, profitFactor: 1.2, grossExpectancyR: 0.2 }
});
assert.equal(passingResearch.status, "FORWARD_TEST_CANDIDATE");
assert.equal(passingResearch.promisingEdge, false);
assert.equal(formalForwardVerdict({
  asOf: "2026-10-01T00:00:00.000Z",
  completeTrades: 100,
  aggregateExpectancyR: 1,
  aggregateProfitFactor: 2,
  positiveFolds: 4,
  totalFolds: 5,
  concentrationControlsPassed: true
}), "PENDING_FORWARD_WINDOW");
assert.equal(formalForwardVerdict({
  asOf: "2026-12-02T00:00:00.000Z",
  completeTrades: 59,
  aggregateExpectancyR: 1,
  aggregateProfitFactor: 2,
  positiveFolds: 5,
  totalFolds: 5,
  concentrationControlsPassed: true
}), "INSUFFICIENT_DATA");

for (const path of [
  "artifacts/m3/manifest.json",
  "artifacts/m3/m3-real-validation-report.json",
  "artifacts/m3/m3-5-failure-decomposition.json",
  "artifacts/m3/m3-6-strategy-redesign.json",
  "lib/config.js",
  "lib/strategies/dynamic-production.js",
  "lib/backtest/execution-model.js",
  "lib/backtest/trade-simulator.js",
  "lib/backtest/backtest-engine.js",
  "lib/trading/replay-engine.js",
  "lib/trading/trade-economics.js",
  "lib/trading/trade-plan.js"
]) {
  assert.equal(gitDiffStatus(path), 0, `frozen M3/M3.5/M3.6/Strong/M2-B file changed: ${path}`);
}

if (existsSync(REPORT_PATH)) {
  const report = JSON.parse(readFileSync(REPORT_PATH, "utf8"));
  assert.equal(report.frozenBaseSha, M37_BASE_SHA);
  assert.equal(report.oldWindowRole, M37_OLD_WINDOW_ROLE);
  assert.equal(report.oldWindowFullyResearch, true);
  assert.equal(report.forwardSpec.datasetId, M37_FORWARD_SPEC.datasetId);
  assert.equal(report.forwardSpec.start, M37_FORWARD_SPEC.start);
  assert.equal(report.forwardSpec.endExclusive, M37_FORWARD_SPEC.endExclusive);
  assert.equal(report.forwardSpec.split.walkForwardEndExclusive, "2026-11-06T15:00:00.000Z");
  assert.equal(report.forwardSpec.split.splitAlignedToInterval, true);
  assert.equal(report.familyDefinitions.length, 3);
  assert.equal(report.candidateDefinitionsHash, candidateDefinitionsHash());
  assert.equal(report.dataCoverage.historicalUniverseAssetCount > 0, true);
  assert.equal(report.dataCoverage.researchDatasetAssetCount > 0, true);
  assert.equal(typeof report.dataCoverage.researchDataQualityComplete, "boolean");
  assert.equal(report.formalForwardVerdict, "PENDING_FORWARD_WINDOW");
  assert.equal(report.flags.parameterSearchPerformed, false);
  assert.equal(report.flags.gridSearchPerformed, false);
  assert.equal(report.flags.manualThresholdIteration, false);
  assert.equal(report.flags.interimResultsUsedForOptimization, false);
  assert.equal(report.flags.WeakChanged, false);
  assert.equal(report.flags.StrongChanged, false);
  assert.equal(report.flags.M2BChanged, false);
  assert.notEqual(report.formalForwardVerdict, "PROMISING_EDGE");
  assert.notEqual(report.formalForwardVerdict, "NEGATIVE_EDGE");
  assert.notEqual(report.formalForwardVerdict, "UNSTABLE");
}

console.log(JSON.stringify({
  test: "m3-7",
  passed: true,
  familyCount: familyDefinitions().length,
  candidateDefinitionsHash: candidateDefinitionsHash(),
  reportChecked: existsSync(REPORT_PATH),
  forwardSpecChecked: existsSync(FORWARD_SPEC_PATH)
}, null, 2));

function buildBenchmarkCandles() {
  const fourHours = 4 * 3600 * 1000;
  return Array.from({ length: 10 }, (_, index) => ({
    openTime: index * fourHours,
    open: 100 + index,
    high: 101 + index,
    low: 99 + index,
    close: 100 + index,
    volume: 10
  }));
}

function buildDislocationCandles() {
  const hour = 3600 * 1000;
  const candles = Array.from({ length: 40 }, (_, index) => ({
    openTime: index * hour,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 10
  }));
  candles[30] = {
    openTime: 30 * hour,
    open: 88,
    high: 92,
    low: 85,
    close: 90,
    volume: 20
  };
  return candles;
}

function buildFlatCandles(count, startIndex) {
  const hour = 3600 * 1000;
  return Array.from({ length: count }, (_, index) => ({
    openTime: (startIndex + index) * hour,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 10
  }));
}

function buildFundingCandles(close) {
  const hour = 3600 * 1000;
  return Array.from({ length: 40 }, (_, index) => {
    const value = index === 30 ? close : 100;
    return {
      openTime: index * hour,
      open: value,
      high: value + 1,
      low: value - 1,
      close: value,
      volume: 10
    };
  });
}

function gitDiffStatus(path) {
  return spawnSync("git", ["diff", "--quiet", M37_BASE_SHA, "--", path], {
    cwd: ROOT,
    stdio: "ignore"
  }).status;
}
