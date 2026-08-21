import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { buildFailureDecompositionReport, decomposeFrozenValidation } from "../lib/validation/failure-decomposition.js";
import { CONFIG } from "../lib/config.js";
import { M3_REAL_DATA_WINDOW, M3_REAL_MANIFEST_SHA256 } from "../lib/validation/real-data.js";

const ROOT = process.cwd();
const FROZEN_BASE_SHA = "f8a6f5c4f1b8b129dd866cd29638db8b57d228f0";

const manifestBytes = await readFile("artifacts/m3/manifest.json");
assert.equal(createHash("sha256").update(manifestBytes).digest("hex"), M3_REAL_MANIFEST_SHA256);
const manifest = JSON.parse(manifestBytes);
assert.equal(manifest.windowStart, M3_REAL_DATA_WINDOW.start);
assert.equal(manifest.windowEnd, M3_REAL_DATA_WINDOW.end);

for (const path of ["lib/config.js", "lib/strategies/dynamic-production.js"]) {
  assert.equal(gitDiffStatus(path), 0, `frozen strategy config changed: ${path}`);
}
for (const path of [
  "lib/backtest/execution-model.js",
  "lib/backtest/trade-simulator.js",
  "lib/backtest/backtest-engine.js",
  "lib/trading/replay-engine.js",
  "lib/trading/trade-economics.js",
  "lib/trading/trade-plan.js"
]) {
  assert.equal(gitDiffStatus(path), 0, `frozen M2-B execution changed: ${path}`);
}

const originalConfigSnapshot = JSON.stringify({
  relativeStrengthMinMomentum24h: CONFIG.relativeStrengthMinMomentum24h,
  relativeStrengthMaxMomentum24h: CONFIG.relativeStrengthMaxMomentum24h,
  relativeWeaknessMinMomentum24h: CONFIG.relativeWeaknessMinMomentum24h,
  relativeWeaknessMaxMomentum24h: CONFIG.relativeWeaknessMaxMomentum24h,
  dynamicTradeMinRecommendationScore: CONFIG.dynamicTradeMinRecommendationScore,
  futuresTradingCost: CONFIG.futuresTradingCost
});

const signal1 = {
  asset: "TESTUSDT",
  strategyId: "dynamic_relative_weakness_breakdown",
  signalCandleOpenTime: 1000,
  signalAvailableAt: 4600,
  primaryEligible: true,
  recommendationScore: 85.5,
  details: {
    poolRank: 1,
    momentum24h: -0.09,
    relativeWeakness: -0.06,
    volumeMultiple: 3.1,
    benchmarkMomentum24h: -0.01
  }
};
const signal2 = {
  ...signal1,
  signalCandleOpenTime: 2000,
  signalAvailableAt: 5600,
  recommendationScore: 89.2,
  details: { ...signal1.details, poolRank: 2, momentum24h: -0.1 }
};
const signal3 = {
  ...signal1,
  signalCandleOpenTime: 3000,
  signalAvailableAt: 6600,
  recommendationScore: 87.1,
  details: { ...signal1.details, poolRank: 3, momentum24h: -0.08 }
};
const trade1 = {
  strategyId: signal1.strategyId,
  asset: signal1.asset,
  side: "SHORT",
  dataQuality: "COMPLETE",
  ambiguousIntrabar: false,
  signalCandleOpenTime: signal1.signalCandleOpenTime,
  signalAvailableAt: signal1.signalAvailableAt,
  entryFillPrice: 100,
  exitFillPrice: 90,
  exitReason: "stop_loss",
  grossReturnPct: 0.1,
  netReturnPct: 0.08,
  initialRiskPct: 0.05,
  realizedR: 1.6,
  totalFeePct: 0.01,
  spreadCostPct: 0.005,
  slippageCostPct: 0.003,
  fundingPct: -0.002,
  mfeR: 0.5,
  maeR: -0.5,
  holdingHours: 2
};
const trade2 = {
  ...trade1,
  signalCandleOpenTime: signal2.signalCandleOpenTime,
  signalAvailableAt: signal2.signalAvailableAt,
  exitReason: "take_profit",
  grossReturnPct: 0.15,
  netReturnPct: 0.13,
  realizedR: 2.6,
  mfeR: 1.5,
  maeR: -1.2,
  holdingHours: 7
};
const degradedTrade = {
  ...trade1,
  signalCandleOpenTime: 3000,
  dataQuality: "INCOMPLETE_INTRABAR_DATA",
  ambiguousIntrabar: true
};

const validation = {
  tradeResults: [trade1, trade2, degradedTrade],
  missedEntries: [],
  aggregate: {
    rawSignals: 3,
    rawPlannedEntries: 3,
    eligibleOosSignals: 3,
    eligibleOosPlannedEntries: 3,
    purgedBoundarySignals: 0,
    completeTrades: 2,
    degradedTrades: 1,
    noEntries: 0,
    missedEntries: 0,
    negativeFolds: 1,
    positiveFolds: 2
  },
  folds: [{ expectancyR: 1 }, { expectancyR: 0.5 }, { expectancyR: -0.2 }, { expectancyR: 0 }, { expectancyR: 0.1 }],
  holdoutMetrics: { completeTrades: 0, expectancyR: null, profitFactor: null, totalNetReturn: 0 },
  flags: {
    strategyParametersChanged: false,
    parameterSearchPerformed: false,
    holdoutUsedForOptimization: false
  }
};
const pipelineDiagnostics = {
  visibleTickerObservations: 100,
  poolCandidates: 10,
  poolSelected: 5,
  strategyEvaluated: 4,
  scoreGatePassed: 3,
  poolCandidateRejections: { momentum_too_low: 90 },
  poolRankRejections: { pool_rank_cutoff: 5 },
  cooldownReasons: { cooldown: 1 },
  strategyGateRejections: { score_below_threshold: 1 },
  signalQualityExclusions: {}
};

const before = JSON.stringify({ validation, signal1, signal2, signal3, trade1, trade2, CONFIG: originalConfigSnapshot });
const analysis = decomposeFrozenValidation({
  strategyId: signal1.strategyId,
  validationResult: validation,
  replaySignals: [signal1, signal2, signal3],
  pipelineDiagnostics,
  datasets: [],
  benchmarkCandles: []
});
assert.equal(analysis.completeTrades, 2);
assert.equal(analysis.degradedTrades, 1);
assert.equal(analysis.tradeDetails.length, 2);
assert.equal(analysis.costDecomposition.reconciles, true);
assert.equal(analysis.attrition.conservation.valid, true);
assert.equal(analysis.attrition.conservation.replaySignals, 3);
assert.equal(analysis.attrition.conservation.initialTrainingContextSignals, 0);
assert.equal(analysis.attrition.conservation.developmentOosSignals, 3);
assert.equal(analysis.attrition.conservation.holdoutSignals, 0);
assert.equal(analysis.exitDecomposition.find((group) => group.exitReason === "stop_loss")?.key, "stop_loss");
assertClose(analysis.costDecomposition.grossExpectancyR, 2.5);
assertClose(analysis.costDecomposition.grossDirectionalPnl.sumR, 5);
assertClose(analysis.costDecomposition.netExpectancyR, 2.1);
assertClose(analysis.costDecomposition.netPnl.sumR, 4.2);
assertClose(analysis.costDecomposition.costImpactR, 0.4);
assertClose(analysis.costDecomposition.feeDragPct, 0.02);
assertClose(analysis.costDecomposition.spreadDragPct, 0.01);
assertClose(analysis.costDecomposition.slippageDragPct, 0.006);
assertClose(analysis.costDecomposition.fundingPctTotal, -0.004);
assert.equal(analysis.mfeMae.mfeAtLeast["0.5R"].count, 2);
assert.equal(analysis.mfeMae.mfeAtLeast["1R"].count, 1);
assert.equal(analysis.mfeMae.maeAtMost["-0.5R"].count, 2);
assert.equal(analysis.scoreCalibration.buckets.find((bucket) => bucket.bucket === "85")?.signals, 1);
assert.equal(analysis.scoreCalibration.buckets.find((bucket) => bucket.bucket === "89+")?.signals, 1);
assert.equal(analysis.scoreCalibration.status, "INSUFFICIENT_FOR_CALIBRATION");
assert.equal(analysis.lossDrivers.top3.length <= 3, true);
assert.equal(JSON.stringify({ validation, signal1, signal2, signal3, trade1, trade2, CONFIG: originalConfigSnapshot }), before);
assert.equal(JSON.stringify({
  relativeStrengthMinMomentum24h: CONFIG.relativeStrengthMinMomentum24h,
  relativeStrengthMaxMomentum24h: CONFIG.relativeStrengthMaxMomentum24h,
  relativeWeaknessMinMomentum24h: CONFIG.relativeWeaknessMinMomentum24h,
  relativeWeaknessMaxMomentum24h: CONFIG.relativeWeaknessMaxMomentum24h,
  dynamicTradeMinRecommendationScore: CONFIG.dynamicTradeMinRecommendationScore,
  futuresTradingCost: CONFIG.futuresTradingCost
}), originalConfigSnapshot);

const strongRecommendation = decomposeFrozenValidation({
  strategyId: "dynamic_relative_strength_breakout",
  validationResult: {
    ...validation,
    tradeResults: [trade1, trade2],
    aggregate: { ...validation.aggregate, negativeFolds: 1 },
    folds: validation.folds
  },
  replaySignals: [signal1, signal2, signal3],
  pipelineDiagnostics
});
assert.equal(strongRecommendation.recommendedStatus.status, "KEEP_FOR_MORE_DATA");

const weakRecommendation = decomposeFrozenValidation({
  strategyId: "dynamic_relative_weakness_breakdown",
  validationResult: {
    ...validation,
    tradeResults: [{
      ...trade1,
      grossReturnPct: -0.02,
      netReturnPct: -0.04,
      realizedR: -0.8
    }],
    aggregate: { ...validation.aggregate, negativeFolds: 4 },
    folds: [{ expectancyR: 1 }, { expectancyR: -1 }, { expectancyR: -0.2 }, { expectancyR: -0.3 }, { expectancyR: -0.1 }]
  },
  replaySignals: [signal1, signal2, signal3],
  pipelineDiagnostics
});
assert.equal(weakRecommendation.recommendedStatus.status, "REDESIGN_CANDIDATE");
assert.equal(
  weakRecommendation.lossDrivers.top3.some((driver) => driver.dimension === "exitReason" && driver.key === "stop_loss"),
  true
);

const report = buildFailureDecompositionReport({
  frozenBaseSha: FROZEN_BASE_SHA,
  manifestSha256: M3_REAL_MANIFEST_SHA256,
  window: M3_REAL_DATA_WINDOW,
  strategyAnalyses: [strongRecommendation, weakRecommendation]
});
assert.equal(report.strategyParametersChanged, false);
assert.equal(report.parameterSearchPerformed, false);
assert.equal(report.holdoutUsedForOptimization, false);
assert.equal(report.source.holdoutIncludedInAttribution, false);
assert.equal(report.frozenBaseSha, FROZEN_BASE_SHA);
assert.equal(report.attrition.strong.conservation.valid, true);
assert.equal(report.attrition.weak.conservation.valid, true);

console.log(JSON.stringify({ test: "m3-5", passed: true }, null, 2));

function gitDiffStatus(path) {
  return spawnSync("git", ["diff", "--quiet", FROZEN_BASE_SHA, "--", path], {
    cwd: ROOT,
    stdio: "ignore"
  }).status;
}

function assertClose(actual, expected) {
  assert.ok(Math.abs(Number(actual) - Number(expected)) < 1e-12);
}
