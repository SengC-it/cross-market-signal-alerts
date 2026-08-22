export function isStrictFinite(value) {
  return value !== null
    && value !== undefined
    && value !== ""
    && Number.isFinite(Number(value));
}

export function compareM36Candidate({ baseline = {}, candidate = {} } = {}) {
  const metrics = candidate.metrics || {};
  const candidateCompleteTrades = Number(candidate.completeTrades);
  const baselineCompleteTrades = Number(baseline.completeTrades);
  const metricsAvailable = Number.isFinite(candidateCompleteTrades)
    && candidateCompleteTrades >= 1;
  const baselineMetricsAvailable = Number.isFinite(baselineCompleteTrades)
    && baselineCompleteTrades >= 1;
  const gates = {
    metricsAvailable,
    researchExpectancyAboveBaseline: metricsAvailable
      && baselineMetricsAvailable
      && isStrictFinite(metrics.netExpectancyR)
      && isStrictFinite(baseline.netExpectancyR)
      && Number(metrics.netExpectancyR) > Number(baseline.netExpectancyR),
    researchProfitFactorAboveBaseline: metricsAvailable
      && baselineMetricsAvailable
      && isStrictFinite(metrics.profitFactor)
      && isStrictFinite(baseline.profitFactor)
      && Number(metrics.profitFactor) > Number(baseline.profitFactor),
    drawdownMateriallyImproved: metricsAvailable
      && baselineMetricsAvailable
      && isStrictFinite(metrics.maxDrawdown)
      && isStrictFinite(baseline.maxDrawdown)
      && Number(metrics.maxDrawdown) >= Number(baseline.maxDrawdown) + 0.05,
    notDominatedByOneAsset: metricsAvailable
      && isStrictFinite(metrics.maxAssetTradeShare)
      && Number(metrics.maxAssetTradeShare) <= 0.5,
    notDominatedByOneFold: metricsAvailable
      && isStrictFinite(metrics.maxFoldTradeShare)
      && Number(metrics.maxFoldTradeShare) <= 0.5,
    reasonableSampleSize: metricsAvailable && candidateCompleteTrades >= 10
  };
  const passed = Object.values(gates).every(Boolean);
  return {
    candidateId: candidate.strategyId,
    baselineReference: "old-window research baseline",
    gates,
    allGatesPassed: passed,
    researchStatus: passed ? "FORWARD_TEST_CANDIDATE" : "REJECTED_CANDIDATE",
    promisingEdge: false,
    reason: passed
      ? "Research gates passed; new unseen OOS is still required."
      : "At least one deterministic research gate failed."
  };
}

export function buildM36ForwardTestDecision(
  candidateComparisons = [],
  newUntouchedOosAvailable = false
) {
  const available = newUntouchedOosAvailable === true;
  const forwardTestCandidates = (Array.isArray(candidateComparisons)
    ? candidateComparisons
    : [])
    .filter((comparison) => comparison?.researchStatus === "FORWARD_TEST_CANDIDATE")
    .map((comparison) => ({
      candidateId: comparison.candidateId,
      status: "FORWARD_TEST_CANDIDATE",
      requiresNewUntouchedOos: !available,
      newUntouchedOosAvailable: available,
      promisingEdge: false
    }));
  return {
    forwardTestCandidates,
    validationVerdict: available
      ? "RESEARCH_COMPLETE_FORWARD_TEST_REQUIRED"
      : "NOT_READY_FOR_NEW_OOS"
  };
}
