import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import {
  M37_OLD_WINDOW,
  candidateDefinitionsHash,
  familyDefinitions
} from "../lib/validation/m3-7-strategy-family-reset.js";
import {
  DIAGNOSTIC_SCOPE,
  atrRiskDiagnostics,
  buildPostmortemReport,
  contributionBridge,
  feeInR,
  extremeLossAttribution,
  summarizeCrossSectionalDiagnostics,
  stopAttribution
} from "../lib/validation/m3-7-postmortem.js";

const EXPECTED_HASH = "d368c1f83680d7b30418ff279af9e706e6486a4ba45415896aedbeb40908e3ff";
const formalPath = "artifacts/m3/m3-7-strategy-family-reset.json";
assert.equal(candidateDefinitionsHash(familyDefinitions()), EXPECTED_HASH);

const normalTrade = {
  familyId: "atr_dislocation_mean_reversion_v1",
  asset: "TESTUSDT",
  side: "LONG",
  signalAvailableAt: Date.parse("2025-09-01T00:00:00.000Z"),
  entryFillPrice: 100,
  entryMarketPrice: 99.5,
  stopLoss: 95,
  takeProfit: 107.5,
  rawExitMarketPrice: 105,
  exitMarketPrice: 105,
  exitFillPrice: 104.5,
  exitReason: "take_profit",
  exitResolution: "take_profit",
  initialRiskPct: 0.05,
  grossReturnPct: 0.05,
  entryFeePct: 0.001,
  exitFeePct: 0.00105,
  totalFeePct: 0.00205,
  spreadCostPct: 0.001,
  slippageCostPct: 0.002,
  fundingPct: 0.001,
  netReturnPct: 0.04595,
  realizedR: 0.919,
  holdingHours: 2,
  dataQuality: "COMPLETE",
  ambiguousIntrabar: false,
  lowerTimeframeReplayed: false,
  signalDetails: {
    crossSectionalPercentile: 0.96,
    return6h: 0.03,
    return24h: 0.04,
    btcReturn24h: 0.01,
    relative24h: 0.03
  }
};

const gapStopTrade = {
  ...normalTrade,
  side: "LONG",
  exitReason: "stop_loss",
  exitResolution: "gap_stop_worse_fill",
  rawExitMarketPrice: 90,
  exitMarketPrice: 90,
  exitFillPrice: 89.5,
  grossReturnPct: -0.10,
  totalFeePct: 0.002,
  entryFeePct: 0.001,
  exitFeePct: 0.001,
  spreadCostPct: 0,
  slippageCostPct: 0,
  fundingPct: 0,
  netReturnPct: -0.102,
  realizedR: -2.04,
  holdingHours: 1
};

const bridge = contributionBridge([normalTrade]);
assert.equal(bridge.r.closed, true, "gross-to-net R bridge must close");
assert.equal(bridge.percent.closed, true, "gross-to-net percent bridge must close");
assert.equal(feeInR(normalTrade).entryFeeR, 0.02);
assert.ok(Math.abs(feeInR(normalTrade).exitFeeR - 0.021) < 1e-12);

const stop = stopAttribution([gapStopTrade]);
assert.ok(Math.abs(stop.theoreticalStopR.median + 1) < 1e-12);
assert.equal(stop.gapStopCount, 1);
assert.ok(Math.abs(stop.postFeeNetR.median + 2.04) < 1e-12);
assert.deepEqual(extremeLossAttribution([gapStopTrade]).byCause.stop_gap, 1);

const atr = atrRiskDiagnostics([normalTrade, gapStopTrade]);
assert.equal(atr.accountingChecks.feeDenominatorCorrect, true);
assert.equal(atr.grossToNetWaterfall.r.closed, true);
assert.equal(atr.extremeLosses.count, 1);

const crossDiagnostics = summarizeCrossSectionalDiagnostics([normalTrade]);
assert.equal(crossDiagnostics.diagnosticScope.classification, "POST_HOC_DIAGNOSTIC_ONLY");
assert.equal(crossDiagnostics.signalPercentileBuckets.diagnosticScope.classification, "POST_HOC_DIAGNOSTIC_ONLY");

const formalReport = existsSync(formalPath)
  ? JSON.parse(readFileSync(formalPath, "utf8"))
  : {
    candidateDefinitionsHash: EXPECTED_HASH,
    oldWindowRole: "RESEARCH_ONLY_AFTER_MULTIPLE_INSPECTIONS",
    oldWindowFullyResearch: true,
    forwardTestCandidates: [],
    researchResults: {}
  };
const beforeFormal = JSON.stringify(formalReport);
const postmortemReport = buildPostmortemReport({
  baseReport: formalReport,
  familyDiagnostics: {
    atr_dislocation_mean_reversion_v1: {
      familyId: "atr_dislocation_mean_reversion_v1",
      replay: { completeTrades: 2, metrics: { grossExpectancyR: 0.02, netExpectancyR: -0.2 } },
      atr: { accountingChecks: { anyImplementationIssueFound: false } },
      researchFolds: []
    }
  },
  frozenBaseSha: "15c3cdfe901bdaa633b23f4ba1c67b6f5a492598",
  candidateDefinitionsHash: EXPECTED_HASH
});
assert.equal(JSON.stringify(formalReport), beforeFormal, "postmortem must not mutate formal artifact in memory");
assert.deepEqual(postmortemReport.forwardTestCandidates, []);
assert.equal(postmortemReport.formalForwardVerdict, "PENDING_FORWARD_WINDOW");
assert.equal(postmortemReport.families?.atr_dislocation_mean_reversion_v1?.failureClassification, undefined);
assert.equal(postmortemReport.flags.formalResearchArtifactChanged, false);
assert.equal(postmortemReport.flags.diagnosticsUsedAsOosEvidence, false);
assert.equal(postmortemReport.candidateDefinitionsHash, EXPECTED_HASH);

const clamped = atrRiskDiagnostics([
  { ...normalTrade, netReturnPct: -1.2, realizedR: -24, exitTime: 1 },
  { ...normalTrade, netReturnPct: 0.1, realizedR: 2, exitTime: 2 }
]);
assert.equal(clamped.clampDiagnostic.formalMaxDrawdownWouldBeClampedAtMinusOne, true);
assert.equal(clamped.clampDiagnostic.arithmeticReturnNotClamped, true);
assert.ok(Math.abs(clamped.clampDiagnostic.cumulativeArithmeticNetReturn + 1.1) < 1e-12);

assert.equal(M37_OLD_WINDOW.endExclusive, "2026-08-01T00:00:00.000Z");
assert.equal(DIAGNOSTIC_SCOPE.notForParameterSelection, true);
assert.equal(DIAGNOSTIC_SCOPE.notOosEvidence, true);
console.log("m3-7 postmortem regression tests passed");
