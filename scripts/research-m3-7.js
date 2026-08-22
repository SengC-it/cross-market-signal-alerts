import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  M3_REAL_DATA_INTERVALS,
  M3_REAL_MANIFEST_SHA256,
  loadM3RealInput
} from "../lib/validation/real-data.js";
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

const DATA_DIR = argumentValue("--data-dir") || process.env.M3_REAL_DATA_DIR || ".local/m3-data";
const FORWARD_DATA_DIR = argumentValue("--forward-data-dir") || process.env.M3_7_FORWARD_DATA_DIR || null;
const REPORT_PATH = argumentValue("--output") || "artifacts/m3/m3-7-strategy-family-reset.json";
const FORWARD_SPEC_PATH = argumentValue("--forward-spec") || "artifacts/m3/m3-7-forward-spec.json";

if (!existsSync(resolve(DATA_DIR, "index.json"))) {
  failClosed("M3_REAL_DATA_REQUIRED");
} else {
  try {
    const input = await loadM3RealInput({ dataDir: DATA_DIR });
    assert.equal(input.manifestSha256, M3_REAL_MANIFEST_SHA256, "M3.7 requires the frozen M3 manifest");
    assert.equal(input.windowStart, M37_OLD_WINDOW.start, "M3.7 old research start mismatch");
    assert.equal(input.windowEnd, M37_OLD_WINDOW.endExclusive, "M3.7 old research end mismatch");

    const definitions = familyDefinitions();
    assert.equal(definitions.length, 3, "M3.7 requires exactly three fixed families");
    assert.equal(candidateDefinitionsHash(definitions), candidateDefinitionsHash(familyDefinitions()));
    const forwardSpec = await createOrVerifyForwardSpec(FORWARD_SPEC_PATH, definitions);
    const datasets = input.datasets.filter(isCompleteHourlyDataset);
    // Release unusable asset payloads before building the cross-sectional context.
    input.datasets = datasets;
    assert.ok(datasets.length > 0, "M3.7 requires usable historical 1h datasets");
    assert.equal(input.historicalUniverseComplete, true, "M3.7 requires the historical universe");

    const context = buildM37MarketContext({
      datasets,
      benchmarkCandles: input.benchmarkCandles,
      historicalUniverse: input.historicalUniverse,
      window: M37_OLD_WINDOW
    });
    const researchResults = {};
    const researchComparison = {};

    for (const definition of definitions) {
      const signals = buildM37FamilySignals({ familyId: definition.id, context });
      const replay = runFamilyResearch({
        familyId: definition.id,
        signals,
        datasets,
        lowerTimeframe: M3_REAL_DATA_INTERVALS.lowerTimeframe
      });
      const result = summarizeM37Research({
        familyId: definition.id,
        signals,
        tradeResults: replay.tradeResults,
        missedEntries: replay.missedEntries,
        window: M37_OLD_WINDOW
      });
      researchResults[definition.id] = {
        ...result,
        entryStats: replay.entryStats,
        historicalDatasetCount: datasets.length,
        historicalUniverseSource: input.universeSource,
        lowerTimeframe: M3_REAL_DATA_INTERVALS.lowerTimeframe
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
          : "At least one fixed research gate failed."
      };
    }

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
      interimForwardDataStatus,
      formalForwardVerdict,
      flags: {
        familyCount: 3,
        candidateCount: 3,
        parameterSearchPerformed: false,
        gridSearchPerformed: false,
        manualThresholdIteration: false,
        oldWindowPreviouslyObserved: true,
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
        frozenManifestSha256: input.manifestSha256,
        historicalUniverseSource: input.universeSource,
        historicalUniverseComplete: input.historicalUniverseComplete,
        datasetCountLoaded: input.datasets.length,
        datasetCountResearch: datasets.length,
        interval: M3_REAL_DATA_INTERVALS.candles,
        lowerTimeframe: M3_REAL_DATA_INTERVALS.lowerTimeframe,
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
    assert.deepEqual(existing, expected, "M3_7_FORWARD_SPEC_LOCK_MISMATCH");
    return existing;
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
    researchStatus: result.researchGate.status
  };
}

function isCompleteHourlyDataset(dataset) {
  const candles = dataset?.candles;
  if (!Array.isArray(candles) || candles.length !== 8760) return false;
  const start = Date.parse(M37_OLD_WINDOW.start);
  const end = Date.parse(M37_OLD_WINDOW.endExclusive);
  return Number(candles[0]?.openTime) === start
    && Number(candles.at(-1)?.openTime) + 3600 * 1000 === end
    && candles.every((candle, index) => index === 0
      || Number(candle?.openTime) - Number(candles[index - 1]?.openTime) === 3600 * 1000);
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || null : null;
}

function failClosed(message) {
  console.error(message);
  process.exitCode = 1;
}
