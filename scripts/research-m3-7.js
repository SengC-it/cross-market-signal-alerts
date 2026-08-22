import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { loadM37Data } from "../lib/validation/m3-7-data.js";
import {
  M37_BASE_SHA,
  M37_FORWARD_SPEC,
  M37_OLD_WINDOW,
  M37_OLD_WINDOW_ROLE,
  M37_FORMAL_FORWARD_GATE,
  M37_RESEARCH_GATE,
  buildM37FamilySignals,
  buildM37ForwardSpec,
  buildM37MarketContext,
  candidateDefinitionsHash,
  familyDefinitions,
  fixedForwardWindowSplit,
  formalForwardVerdict,
  runM37FamilyBacktest,
  summarizeM37Research
} from "../lib/validation/m3-7-strategy-family-reset.js";

const DATA_DIR = argumentValue("--data-dir") || process.env.M3_7_DATA_DIR || ".local/m3-7-data";
const FORWARD_DATA_DIR = argumentValue("--forward-data-dir") || process.env.M3_7_FORWARD_DATA_DIR || null;
const REPORT_PATH = argumentValue("--output") || "artifacts/m3/m3-7-strategy-family-reset.json";
const FORWARD_SPEC_PATH = argumentValue("--forward-spec") || "artifacts/m3/m3-7-forward-spec.json";

if (!existsSync(resolve(DATA_DIR, "index.json"))) {
  failClosed("M3_7_DATA_REQUIRED");
} else {
  try {
    const input = await loadM37Data({ dataDir: DATA_DIR });
    assert.equal(input.datasetId, "M37_RESEARCH_DATA_2025_08_2026_08", "M3.7 dataset mismatch");
    assert.equal(input.windowStart, M37_OLD_WINDOW.start, "M3.7 old research start mismatch");
    assert.equal(input.windowEnd, M37_OLD_WINDOW.endExclusive, "M3.7 old research end mismatch");

    const definitions = familyDefinitions();
    assert.equal(definitions.length, 3, "M3.7 requires exactly three fixed families");
    assert.equal(candidateDefinitionsHash(definitions), candidateDefinitionsHash(familyDefinitions()));
    const forwardSpec = await createOrVerifyForwardSpec(FORWARD_SPEC_PATH, definitions);
    const datasets = input.datasets;
    assert.ok(datasets.length > 0, "M3.7 requires usable historical 1h datasets");
    assert.equal(input.historicalUniverseComplete, true, "M3.7 requires the historical universe");

    const context = buildM37MarketContext({
      datasets,
      benchmarkCandles: input.benchmarkCandles,
      historicalUniverse: input.historicalUniverse,
      historicalUniverseMetadata: input.historicalUniverseMetadata,
      preparedCoverage: input.dataCoverage,
      window: M37_OLD_WINDOW
    });
    const researchResults = {};
    const researchComparison = {};

    for (const definition of definitions) {
      const signals = buildM37FamilySignals({ familyId: definition.id, context });
      const replay = input.dataCoverage?.researchDataQualityComplete === true
        ? runFamilyResearch({
          familyId: definition.id,
          signals,
          datasets,
          lowerTimeframe: input.lowerTimeframe || "5m"
        })
        : emptyResearchReplay();
      const quality = buildResearchDataQuality({
        inputCoverage: input.dataCoverage,
        familyId: definition.id,
        context,
        tradeResults: replay.tradeResults
      });
      const result = summarizeM37Research({
        familyId: definition.id,
        signals,
        tradeResults: replay.tradeResults,
        missedEntries: replay.missedEntries,
        window: M37_OLD_WINDOW,
        dataQuality: quality
      });
      researchResults[definition.id] = {
        ...result,
        entryStats: replay.entryStats,
        historicalDatasetCount: datasets.length,
        historicalUniverseSource: input.universeSource,
        lowerTimeframe: input.lowerTimeframe || "5m",
        uniqueFundingEventsEvaluated: definition.id === "funding_extreme_crowding_reversal_v1"
          ? context.fundingEvaluation.uniqueFundingEventsEvaluated
          : null,
        duplicateFundingEventSignals: definition.id === "funding_extreme_crowding_reversal_v1"
          ? context.fundingEvaluation.duplicateFundingEventSignals
          : null
      };
      researchComparison[definition.id] = {
        familyId: definition.id,
        researchStatus: result.researchGate.status,
        allGatesPassed: result.researchGate.allGatesPassed,
        gates: result.researchGate.gates,
        promisingEdge: false,
        researchOnly: true,
        reason: result.researchGate.allGatesPassed
          ? "Research gates passed; registered for the fixed prospective forward window."
          : result.researchGate.status === "DATA_INCOMPLETE"
            ? "Required lifecycle, lower-timeframe, funding, or universe coverage is incomplete."
            : "At least one fixed research gate failed."
      };
    }

    const dataCoverage = summarizeReportCoverage({ inputCoverage: input.dataCoverage, researchResults, context });

    const forwardTestCandidates = Object.values(researchComparison)
      .filter((comparison) => comparison.researchStatus === "FORWARD_TEST_CANDIDATE")
      .map((comparison) => ({
        candidateId: comparison.familyId,
        status: "FORWARD_TEST_CANDIDATE",
        promisingEdge: false,
        requiresNewForwardWindow: true
      }));
    const rejectedCandidates = Object.values(researchComparison)
      .filter((comparison) => comparison.researchStatus === "REJECTED_CANDIDATE")
      .map((comparison) => ({
        candidateId: comparison.familyId,
        status: "REJECTED_CANDIDATE",
        failedGates: Object.entries(comparison.gates)
          .filter(([, passed]) => passed !== true)
          .map(([gate]) => gate)
      }));

    const interimForwardDataStatus = inspectForwardData(FORWARD_DATA_DIR);
    const formalForwardVerdict = formalForwardVerdictForCurrentWindow({
      interimForwardDataStatus,
      asOf: Date.now()
    });
    const report = {
      version: "V4-M3.7",
      frozenBaseSha: M37_BASE_SHA,
      oldWindowRole: M37_OLD_WINDOW_ROLE,
      oldWindow: M37_OLD_WINDOW,
      oldWindowFullyResearch: true,
      forwardSpec,
      candidateDefinitionsHash: candidateDefinitionsHash(definitions),
      familyDefinitions: definitions,
      researchResults,
      researchComparison,
      researchGate: M37_RESEARCH_GATE,
      forwardTestCandidates,
      rejectedCandidates,
      dataCoverage,
      interimForwardDataStatus,
      formalForwardVerdict,
      flags: {
        familyCount: 3,
        candidateCount: 3,
        parameterSearchPerformed: false,
        gridSearchPerformed: false,
        manualThresholdIteration: false,
        oldWindowPreviouslyObserved: true,
        familyDefinitionsChanged: false,
        interimResultsUsedForOptimization: false,
        holdoutUsedForNewUntouchedValidation: false,
        WeakChanged: false,
        StrongChanged: false,
        M2BChanged: false,
        enteredM4: false,
        mergedMain: false
      },
      legacyStrategyState: {
        dynamic_relative_weakness_breakdown: {
          status: "NEGATIVE_EDGE_BASELINE",
          deploymentMode: "SHADOW_ONLY",
          actionable: false
        },
        dynamic_relative_strength_breakout: {
          status: "KEEP_FOR_MORE_DATA",
          changed: false
        },
        m36WeakRedesignCandidates: "ALL_REJECTED_CANDIDATE"
      },
      dataSource: {
        source: input.dataSource,
        preparedDataDir: input.dataDir,
        sourceDataDir: input.sourceDataDir,
        historicalUniverseSource: input.universeSource,
        historicalUniverseComplete: input.historicalUniverseComplete,
        datasetCountLoaded: input.datasets.length,
        datasetCountResearch: datasets.length,
        interval: input.interval || "1h",
        lowerTimeframe: input.lowerTimeframe || "5m",
        execution: "TradeSpec + M2-B execution primitives"
      },
      formalForwardGate: M37_FORMAL_FORWARD_GATE
    };
    await mkdir(dirname(resolve(REPORT_PATH)), { recursive: true });
    await writeFile(resolve(REPORT_PATH), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({
      reportPath: resolve(REPORT_PATH),
      forwardSpecPath: resolve(FORWARD_SPEC_PATH),
      oldWindowRole: report.oldWindowRole,
      candidateDefinitionsHash: report.candidateDefinitionsHash,
      families: Object.values(researchResults).map(compactResearchResult),
      dataCoverage,
      forwardTestCandidates: report.forwardTestCandidates,
      rejectedCandidates: report.rejectedCandidates,
      interimForwardDataStatus,
      formalForwardVerdict
    }, null, 2));
  } catch (error) {
    failClosed(error?.message || String(error));
  }
}

async function createOrVerifyForwardSpec(path, definitions) {
  const expected = buildM37ForwardSpec();
  assert.deepEqual(expected.candidateIds, definitions.map((definition) => definition.id));
  if (existsSync(resolve(path))) {
    const existing = JSON.parse(await readFile(resolve(path), "utf8"));
    assert.deepEqual({ ...existing, split: expected.split }, expected, "M3_7_FORWARD_SPEC_LOCK_MISMATCH");
    if (JSON.stringify(existing) !== JSON.stringify(expected)) {
      await writeFile(resolve(path), `${JSON.stringify(expected, null, 2)}\n`, "utf8");
    }
    return expected;
  }
  await mkdir(dirname(resolve(path)), { recursive: true });
  await writeFile(resolve(path), `${JSON.stringify(expected, null, 2)}\n`, "utf8");
  return expected;
}

function runFamilyResearch({ familyId, signals, datasets, lowerTimeframe }) {
  const byAssetSide = new Map();
  for (const signal of signals) {
    const key = `${signal.asset}:${signal.side}`;
    if (!byAssetSide.has(key)) byAssetSide.set(key, []);
    byAssetSide.get(key).push(signal);
  }
  const tradeResults = [];
  const missedEntries = [];
  const entryStats = { signals: 0, planned: 0, entries: 0, noEntry: 0, missedEntry: 0 };
  for (const dataset of datasets) {
    for (const side of ["LONG", "SHORT"]) {
      const sideSignals = byAssetSide.get(`${dataset.asset}:${side}`) || [];
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
  }
  return { tradeResults, missedEntries, entryStats };
}

function emptyResearchReplay() {
  return {
    tradeResults: [],
    missedEntries: [],
    entryStats: { signals: 0, planned: 0, entries: 0, noEntry: 0, missedEntry: 0 }
  };
}

function inspectForwardData(dataDir) {
  if (!dataDir || !existsSync(resolve(dataDir, "index.json"))) {
    return {
      status: "NOT_CONFIGURED",
      available: false,
      dataSource: null,
      coverageStart: null,
      coverageEndExclusive: null,
      completeWindow: false,
      usedForOptimization: false
    };
  }
  try {
    const index = JSON.parse(readFileSync(resolve(dataDir, "index.json"), "utf8"));
    const coverageStart = index.windowStart || index.coverageStart || null;
    const coverageEndExclusive = index.windowEnd || index.coverageEndExclusive || null;
    const completeWindow = coverageStart === M37_FORWARD_SPEC.start
      && coverageEndExclusive === M37_FORWARD_SPEC.endExclusive;
    return {
      status: completeWindow ? "CACHED_FORWARD_DATA" : "INTERIM_SHADOW_ONLY",
      available: true,
      dataSource: index.dataSource || resolve(dataDir),
      coverageStart,
      coverageEndExclusive,
      completeWindow,
      usedForOptimization: false
    };
  } catch {
    return {
      status: "INVALID_FORWARD_DATA",
      available: false,
      dataSource: resolve(dataDir),
      coverageStart: null,
      coverageEndExclusive: null,
      completeWindow: false,
      usedForOptimization: false
    };
  }
}

function formalForwardVerdictForCurrentWindow({ interimForwardDataStatus, asOf }) {
  if (!interimForwardDataStatus.completeWindow) {
    return formalForwardVerdict({ asOf, completeTrades: 0 });
  }
  return formalForwardVerdict({
    asOf,
    completeTrades: 0
  });
}

function compactResearchResult(result) {
  return {
    familyId: result.familyId,
    signals: result.signals,
    completeTrades: result.completeTrades,
    degradedTrades: result.degradedTrades,
    grossExpectancyR: result.metrics.grossExpectancyR,
    netExpectancyR: result.metrics.netExpectancyR,
    profitFactor: result.metrics.profitFactor,
    winRate: result.metrics.winRate,
    maxDrawdown: result.metrics.maxDrawdown,
    positiveResearchFolds: result.positiveResearchFolds,
    negativeResearchFolds: result.negativeResearchFolds,
    fundingIncompleteTrades: result.dataQuality.fundingIncompleteTrades,
    incompleteIntrabarTrades: result.dataQuality.incompleteIntrabarTrades,
    researchDataQualityComplete: result.researchDataQualityComplete,
    researchStatus: result.researchGate.status
  };
}

function buildResearchDataQuality({ inputCoverage, familyId, context, tradeResults }) {
  const familyCoverage = inputCoverage?.byFamily?.[familyId] || {};
  const fundingIncompleteTrades = (Array.isArray(tradeResults) ? tradeResults : [])
    .filter((trade) => trade.dataQuality === "INCOMPLETE_FUNDING"
      || trade.dataQualityComponents?.funding === "INCOMPLETE_FUNDING").length;
  const incompleteIntrabarTrades = (Array.isArray(tradeResults) ? tradeResults : [])
    .filter((trade) => trade.dataQuality === "INCOMPLETE_INTRABAR_DATA"
      || trade.dataQualityComponents?.intrabar === "INCOMPLETE_INTRABAR_DATA").length;
  const crossSectionalIncompleteTimestamps = context.crossSectionalDiagnostics
    .filter((diagnostic) => diagnostic.crossSectionalUniverseComplete !== true).length;
  const researchDataQualityComplete = inputCoverage?.researchDataQualityComplete === true
    && familyCoverage.signalRelevantFundingCoverage?.complete === true
    && familyCoverage.signalRelevantLowerTfCoverage?.complete === true
    && fundingIncompleteTrades === 0
    && incompleteIntrabarTrades === 0
    && crossSectionalIncompleteTimestamps === 0;
  return {
    degradedTrades: Array.isArray(tradeResults)
      ? tradeResults.filter((trade) => trade.dataQuality !== "COMPLETE").length
      : 0,
    fundingIncompleteTrades,
    incompleteIntrabarTrades,
    crossSectionalIncompleteTimestamps,
    requiredHistoricalFundingAvailable: inputCoverage?.requiredHistoricalFundingAvailable === true,
    signalRelevantFundingCoverage: familyCoverage.signalRelevantFundingCoverage || null,
    signalRelevantLowerTfCoverage: familyCoverage.signalRelevantLowerTfCoverage || null,
    researchDataQualityComplete
  };
}

function summarizeReportCoverage({ inputCoverage, researchResults, context }) {
  const results = Object.values(researchResults);
  const fundingIncompleteTrades = results.reduce((sum, result) => sum + Number(result.dataQuality?.fundingIncompleteTrades || 0), 0);
  const incompleteIntrabarTrades = results.reduce((sum, result) => sum + Number(result.dataQuality?.incompleteIntrabarTrades || 0), 0);
  return {
    ...(inputCoverage || {}),
    fundingIncompleteTrades,
    incompleteIntrabarTrades,
    crossSectionalIncompleteTimestamps: context.crossSectionalDiagnostics
      .filter((diagnostic) => diagnostic.crossSectionalUniverseComplete !== true).length,
    researchDataQualityComplete: results.length > 0 && results.every((result) => result.researchDataQualityComplete === true)
  };
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || null : null;
}

function failClosed(message) {
  console.error(message);
  process.exitCode = 1;
}
