import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import {
  M36_CANDIDATE_DEFINITIONS,
  M36_MAX_CANDIDATES,
  M36_OLD_WINDOW_ROLE,
  M36_RESEARCH_STATUS,
  buildM36CandidateSignals,
  computeM36Features,
  candidateDefinitions
} from "../lib/validation/m3-6-strategy-redesign.js";
import {
  buildM36ForwardTestDecision,
  compareM36Candidate,
  isStrictFinite
} from "../lib/validation/m3-6-gates.js";

const ROOT = process.cwd();
const FROZEN_BASE_SHA = "975f0d11231947c306b02e0241ca5179eed5a650";
const M36_BASE_SHA = "68272f3ec4bd74c0bf6d6bf051bd09d4eb35900a";
const REPORT_PATH = "artifacts/m3/m3-6-strategy-redesign.json";

assert.equal(M36_CANDIDATE_DEFINITIONS.length, 3);
assert.equal(candidateDefinitions().length, M36_MAX_CANDIDATES);
assert.ok(candidateDefinitions().length <= M36_MAX_CANDIDATES);
assert.equal(new Set(candidateDefinitions().map((definition) => definition.id)).size, 3);
assert.equal(candidateDefinitions().some((definition) => /grid|optimiz|search/i.test(JSON.stringify(definition))), false);
assert.equal(candidateDefinitions().some((definition) => /recommendationScore|scoreGate/i.test(JSON.stringify(definition))), false);
assert.equal(isStrictFinite(null), false);
assert.equal(isStrictFinite(undefined), false);
assert.equal(isStrictFinite(""), false);
assert.equal(isStrictFinite(0), true);

const gateBaseline = {
  completeTrades: 20,
  netExpectancyR: -0.1,
  profitFactor: 1.5,
  maxDrawdown: -0.5
};
const zeroTradeComparison = compareM36Candidate({
  baseline: gateBaseline,
  candidate: {
    strategyId: "synthetic_zero_trade",
    completeTrades: 0,
    metrics: {
      netExpectancyR: null,
      profitFactor: null,
      maxDrawdown: null,
      maxAssetTradeShare: null,
      maxFoldTradeShare: null
    }
  }
});
assert.equal(zeroTradeComparison.gates.metricsAvailable, false);
assert.equal(zeroTradeComparison.gates.researchExpectancyAboveBaseline, false);
assert.equal(zeroTradeComparison.gates.researchProfitFactorAboveBaseline, false);
assert.equal(zeroTradeComparison.gates.drawdownMateriallyImproved, false);
assert.equal(zeroTradeComparison.gates.reasonableSampleSize, false);
assert.equal(zeroTradeComparison.researchStatus, "REJECTED_CANDIDATE");

const syntheticPassingComparison = compareM36Candidate({
  baseline: gateBaseline,
  candidate: {
    strategyId: "synthetic_passing_candidate",
    completeTrades: 10,
    metrics: {
      netExpectancyR: 0,
      profitFactor: 2,
      maxDrawdown: -0.4,
      maxAssetTradeShare: 0.4,
      maxFoldTradeShare: 0.4
    }
  }
});
assert.equal(syntheticPassingComparison.researchStatus, "FORWARD_TEST_CANDIDATE");
assert.equal(syntheticPassingComparison.promisingEdge, false);
const withoutNewOos = buildM36ForwardTestDecision([syntheticPassingComparison], false);
assert.equal(withoutNewOos.forwardTestCandidates.length, 1);
assert.equal(withoutNewOos.forwardTestCandidates[0].status, "FORWARD_TEST_CANDIDATE");
assert.equal(withoutNewOos.forwardTestCandidates[0].requiresNewUntouchedOos, true);
assert.equal(withoutNewOos.forwardTestCandidates[0].promisingEdge, false);
assert.equal(withoutNewOos.validationVerdict, "NOT_READY_FOR_NEW_OOS");
const withNewOos = buildM36ForwardTestDecision([syntheticPassingComparison], true);
assert.equal(withNewOos.forwardTestCandidates[0].status, "FORWARD_TEST_CANDIDATE");
assert.equal(withNewOos.forwardTestCandidates[0].requiresNewUntouchedOos, false);
assert.equal(withNewOos.forwardTestCandidates[0].promisingEdge, false);
assert.equal(withNewOos.validationVerdict, "RESEARCH_COMPLETE_FORWARD_TEST_REQUIRED");

const candles = buildCausalCandles();
const beforeFutureMutation = computeM36Features({
  candles,
  signalIndex: 27,
  benchmarkMomentum24h: 0
});
assert.equal(beforeFutureMutation.complete, true);
assert.equal(beforeFutureMutation.causalInputMaxOpenTime, candles[27].openTime);
assert.equal(beforeFutureMutation.causalInputMaxOpenTime <= candles[27].openTime, true);

const futureMutated = structuredClone(candles);
futureMutated[28] = {
  ...futureMutated[28],
  open: 1,
  high: 1000,
  low: 0.01,
  close: 500,
  volume: 999999
};
const afterFutureMutation = computeM36Features({
  candles: futureMutated,
  signalIndex: 27,
  benchmarkMomentum24h: 0
});
assert.deepEqual(afterFutureMutation, beforeFutureMutation, "future candles must not affect candidate features");

const baseSignal = {
  asset: "TESTUSDT",
  strategyId: "dynamic_relative_weakness_breakdown",
  signalCandleOpenTime: candles[27].openTime,
  signalAvailableAt: candles[27].openTime + 3600 * 1000,
  entryEligibleAt: candles[27].openTime + 3600 * 1000,
  primaryEligible: true,
  opportunityPassed: true,
  details: { benchmarkMomentum24h: 0 }
};
const dataset = [{ asset: "TESTUSDT", candles }];
const lowScoreSignals = buildM36CandidateSignals({
  baseSignals: [{ ...baseSignal, recommendationScore: 1 }],
  datasets: dataset,
  candidateId: "weak_breakdown_confirmed_continuation_v1"
});
const highScoreSignals = buildM36CandidateSignals({
  baseSignals: [{ ...baseSignal, recommendationScore: 99 }],
  datasets: dataset,
  candidateId: "weak_breakdown_confirmed_continuation_v1"
});
assert.equal(lowScoreSignals.length, 1);
assert.deepEqual(
  lowScoreSignals.map((signal) => signal.signalCandleOpenTime),
  highScoreSignals.map((signal) => signal.signalCandleOpenTime),
  "recommendation score must not be a candidate edge gate"
);
assert.equal(lowScoreSignals[0].m36.causalInputMaxOpenTime, baseSignal.signalCandleOpenTime);
assert.equal(lowScoreSignals[0].signalSelectionMode, "M3_6_CANDIDATE_RULES");

for (const path of ["lib/config.js", "lib/strategies/dynamic-production.js"]) {
  assert.equal(gitDiffStatus(path), 0, `frozen strategy file changed: ${path}`);
}
assert.equal(
  gitDiffStatus("lib/validation/m3-6-strategy-redesign.js", M36_BASE_SHA),
  0,
  "M3.6 candidate definitions changed"
);
for (const path of [
  "lib/backtest/execution-model.js",
  "lib/backtest/trade-simulator.js",
  "lib/backtest/backtest-engine.js",
  "lib/trading/replay-engine.js",
  "lib/trading/trade-economics.js",
  "lib/trading/trade-plan.js"
]) {
  assert.equal(gitDiffStatus(path), 0, `frozen M2-B file changed: ${path}`);
}
for (const path of [
  "artifacts/m3/manifest.json",
  "artifacts/m3/m3-real-validation-report.json",
  "artifacts/m3/m3-5-failure-decomposition.json"
]) {
  assert.equal(gitDiffStatus(path), 0, `frozen M3/M3.5 artifact changed: ${path}`);
}

const frozenReport = JSON.parse(readFileSync("artifacts/m3/m3-real-validation-report.json", "utf8"));
const frozenWeak = frozenReport.strategies.dynamic_relative_weakness_breakdown;
assert.equal(frozenWeak.aggregateOOS.completeTrades, 61);
assert.equal(frozenWeak.aggregateOOS.profitFactor, 0.5699430218673189);
assert.equal(frozenWeak.aggregateOOS.expectancyR, -0.2023577937552056);
assert.equal(frozenWeak.holdout.completeTrades, 13);
assert.equal(frozenWeak.holdout.expectancyR, -0.13831305506178365);
assert.equal(frozenReport.strategies.dynamic_relative_strength_breakout.replayDiagnostics.replaySignalsTotal, 8);

if (existsSync(REPORT_PATH)) {
  const report = JSON.parse(readFileSync(REPORT_PATH, "utf8"));
  assert.equal(report.frozenBaseSha, FROZEN_BASE_SHA);
  assert.equal(report.oldWindowRole, M36_OLD_WINDOW_ROLE);
  assert.equal(report.researchStatus, M36_RESEARCH_STATUS);
  assert.equal(report.formerHoldoutRole, "RESEARCH_ONLY_AFTER_BEING_OBSERVED");
  assert.equal(report.oldWindowFullyResearch, true);
  assert.equal(report.holdoutUsedForNewUntouchedValidation, false);
  assert.equal(report.candidateDefinitions.length, 3);
  assert.equal(report.baselineWeak.deploymentStatus, "NEGATIVE_EDGE_BASELINE");
  assert.equal(report.baselineWeak.deploymentMode, "SHADOW_ONLY_RESEARCH_ONLY");
  assert.equal(report.baselineWeak.actionable, false);
  assert.equal(report.baselineWeak.frozenMetrics.holdoutCompleteTrades, 13);
  assert.equal(report.strongReference.changed, false);
  assert.equal(report.flags.oldHoldoutReusedForOptimization, false);
  assert.equal(report.flags.parameterGridSearch, false);
  assert.equal(report.flags.automaticThresholdOptimization, false);
  assert.equal(report.flags.strategyParametersChanged, false);
  assert.equal(report.flags.strongChanged, false);
  assert.equal(report.flags.M2BChanged, false);
  assert.equal(report.flags.enteredM4, false);
  assert.equal(report.flags.mergedMain, false);
  for (const comparison of Object.values(report.candidateComparison)) {
    assert.equal(comparison.promisingEdge, false);
  }
  assert.equal(report.newUntouchedOosAvailable, false);
  assert.deepEqual(report.forwardTestCandidates, []);
  assert.equal(report.baselineWeak.researchResult.signals, 78);
  assert.equal(report.baselineWeak.researchResult.completeTrades, 78);
  assertClose(report.baselineWeak.researchResult.metrics.netExpectancyR, -0.18143580658297762);
  assertClose(report.baselineWeak.researchResult.metrics.profitFactor, 0.6199643819002939);
  const candidateExpectations = {
    weak_breakdown_confirmed_continuation_v1: {
      signals: 0,
      completeTrades: 0,
      netExpectancyR: null,
      profitFactor: null
    },
    weak_breakdown_exhaustion_filtered_v1: {
      signals: 58,
      completeTrades: 58,
      netExpectancyR: -0.260142143354018,
      profitFactor: 0.5451897172328126
    },
    weak_breakdown_confirmed_market_v1: {
      signals: 0,
      completeTrades: 0,
      netExpectancyR: null,
      profitFactor: null
    }
  };
  for (const [candidateId, expected] of Object.entries(candidateExpectations)) {
    const result = report.researchResults[candidateId];
    const comparison = report.candidateComparison[candidateId];
    assert.equal(result.signals, expected.signals);
    assert.equal(result.completeTrades, expected.completeTrades);
    assert.equal(result.metrics.netExpectancyR, expected.netExpectancyR);
    assert.equal(result.metrics.profitFactor, expected.profitFactor);
    assert.equal(comparison.researchStatus, "REJECTED_CANDIDATE");
    assert.equal(comparison.promisingEdge, false);
    if (expected.completeTrades === 0) {
      assert.equal(comparison.gates.researchExpectancyAboveBaseline, false);
      assert.equal(comparison.gates.researchProfitFactorAboveBaseline, false);
      assert.equal(comparison.gates.drawdownMateriallyImproved, false);
      assert.equal(comparison.gates.reasonableSampleSize, false);
    }
  }
  assert.notEqual(report.validationVerdict, "PROMISING_EDGE");
}

console.log(JSON.stringify({
  test: "m3-6",
  passed: true,
  candidateCount: candidateDefinitions().length,
  frozenWeak: {
    completeTrades: frozenWeak.aggregateOOS.completeTrades,
    expectancyR: frozenWeak.aggregateOOS.expectancyR,
    profitFactor: frozenWeak.aggregateOOS.profitFactor,
    holdoutCompleteTrades: frozenWeak.holdout.completeTrades
  },
  researchReportChecked: existsSync(REPORT_PATH)
}, null, 2));

function buildCausalCandles() {
  const hourMs = 3600 * 1000;
  const rows = Array.from({ length: 40 }, (_, index) => {
    const openTime = index * hourMs;
    return {
      openTime,
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 10
    };
  });
  for (const index of [24, 25, 26]) {
    rows[index] = { ...rows[index], open: 103, high: 104, low: 102, close: 103 };
  }
  rows[27] = {
    ...rows[27],
    open: 100,
    high: 101,
    low: 98,
    close: 99,
    volume: 20
  };
  return rows;
}

function gitDiffStatus(path, baseSha = FROZEN_BASE_SHA) {
  return spawnSync("git", ["diff", "--quiet", baseSha, "--", path], {
    cwd: ROOT,
    stdio: "ignore"
  }).status;
}

function assertClose(actual, expected) {
  assert.ok(Math.abs(Number(actual) - Number(expected)) < 1e-12);
}
