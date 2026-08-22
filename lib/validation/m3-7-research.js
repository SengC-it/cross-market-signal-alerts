import { runM37FamilyBacktest } from "./m3-7-strategy-family-reset.js";

export function researchDataQualityGate({ dataCoverage = {}, historicalUniverseComplete = false } = {}) {
  const checks = {
    providerGapPolicyFrozen: dataCoverage.providerGapPolicyFrozen === true,
    researchEffectiveDataQualityComplete: dataCoverage.researchEffectiveDataQualityComplete === true,
    unhandledProviderGapDependencies: strictZero(dataCoverage.unhandledProviderGapDependencies),
    requiredHistoricalFundingAvailable: dataCoverage.requiredHistoricalFundingAvailable === true,
    signalRelevantFundingCoverage: dataCoverage.signalRelevantFundingCoverage?.complete === true,
    signalRelevantLowerTfCoverage: dataCoverage.signalRelevantLowerTfCoverage?.complete === true,
    historicalUniverseComplete: historicalUniverseComplete === true,
    nonProviderCrossSectionalIncompleteTimestamps:
      strictZero(dataCoverage.nonProviderCrossSectionalIncompleteTimestamps)
  };
  return {
    complete: Object.values(checks).every(Boolean),
    checks,
    reasons: Object.entries(checks)
      .filter(([, passed]) => passed !== true)
      .map(([check]) => check)
  };
}

function strictZero(value) {
  return value !== null
    && value !== undefined
    && value !== ""
    && Number.isFinite(Number(value))
    && Number(value) === 0;
}

export async function runM37FamilyResearchByAsset({
  familyId,
  signals = [],
  datasetDescriptors = [],
  loadDataset,
  lowerTimeframe = "5m"
} = {}) {
  if (typeof loadDataset !== "function") throw new Error("M3_7_DATASET_LOADER_REQUIRED");
  const byAssetSide = new Map();
  for (const signal of Array.isArray(signals) ? signals : []) {
    const key = `${signal.asset}:${signal.side}`;
    if (!byAssetSide.has(key)) byAssetSide.set(key, []);
    byAssetSide.get(key).push(signal);
  }
  const tradeResults = [];
  const missedEntries = [];
  const entryStats = { signals: 0, planned: 0, entries: 0, noEntry: 0, missedEntry: 0 };
  for (const descriptor of Array.isArray(datasetDescriptors) ? datasetDescriptors : []) {
    const asset = String(descriptor?.asset || "").trim().toUpperCase();
    const hasSignals = ["LONG", "SHORT"].some((side) => (byAssetSide.get(`${asset}:${side}`) || []).length > 0);
    if (!hasSignals) continue;
    let dataset = await loadDataset(descriptor);
    try {
      for (const side of ["LONG", "SHORT"]) {
        const sideSignals = byAssetSide.get(`${asset}:${side}`) || [];
        if (!sideSignals.length) continue;
        const result = runM37FamilyBacktest({
          familyId,
          dataset,
          signals: sideSignals,
          executionModel: dataset.backtestOptions?.executionModel || {},
          fundingEvents: dataset.fundingEvents,
          fundingCoverage: dataset.fundingCoverage,
          lowerTimeframeCandles: dataset.lowerTimeframeCandles,
          lowerTimeframe,
          exchangeFilters: dataset.exchangeFilters
        });
        tradeResults.push(...result.tradeResults);
        missedEntries.push(...result.missedEntries);
        for (const key of Object.keys(entryStats)) entryStats[key] += Number(result.entryStats?.[key]) || 0;
      }
    } finally {
      // Keep at most one full dataset, including its lower-timeframe candles, live.
      dataset = null;
    }
  }
  return { tradeResults, missedEntries, entryStats };
}
