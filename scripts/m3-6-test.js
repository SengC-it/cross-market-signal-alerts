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

const ROOT = process.cwd();
const FROZEN_BASE_SHA = "975f0d11231947c306b02e0241ca5179eed5a650";
const REPORT_PATH = "artifacts/m3/m3-6-strategy-redesign.json";

assert.equal(M36_CANDIDATE_DEFINITIONS.length, 3);
assert.equal(candidateDefinitions().length, M36_MAX_CANDIDATES);
assert.ok(candidateDefinitions().length <= M36_MAX_CANDIDATES);
assert.equal(new Set(candidateDefinitions().map((definition) => definition.id)).size, 3);
assert.equal(candidateDefinitions().some((definition) => /grid|optimiz|search/i.test(JSON.stringify(definition))), false);
assert.equal(candidateDefinitions().some((definition) => /recommendationScore|scoreGate/i.test(JSON.stringify(definition))), false);

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
    assert.equal(comparison.researchStatus === "FORWARD_TEST_CANDIDATE"
      ? report.newUntouchedOosAvailable
      : true, true);
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

function gitDiffStatus(path) {
  return spawnSync("git", ["diff", "--quiet", FROZEN_BASE_SHA, "--", path], {
    cwd: ROOT,
    stdio: "ignore"
  }).status;
}
