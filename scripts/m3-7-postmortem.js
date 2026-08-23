import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { loadM37Data, loadM37Dataset } from "../lib/validation/m3-7-data.js";
import {
  M37_OLD_WINDOW,
  buildM37FamilySignals,
  buildM37MarketContext,
  candidateDefinitionsHash,
  familyDefinitions,
  filterM37ResearchSignals
} from "../lib/validation/m3-7-strategy-family-reset.js";
import { runM37FamilyBacktest } from "../lib/validation/m3-7-strategy-family-reset.js";
import { isPrimaryOosTrade } from "../lib/validation/validation-metrics.js";
import {
  buildFamilyPostmortem,
  buildPostmortemReport,
  DIAGNOSTIC_SCOPE,
  diagnosticMetrics
} from "../lib/validation/m3-7-postmortem.js";

const BASE_RESEARCH_SHA = "15c3cdfe901bdaa633b23f4ba1c67b6f5a492598";
const EXPECTED_CANDIDATE_DEFINITIONS_HASH = "d368c1f83680d7b30418ff279af9e706e6486a4ba45415896aedbeb40908e3ff";
const HOUR_MS = 3600 * 1000;
const REPLAY_CHUNK_MS = 30 * 24 * HOUR_MS;
const REPLAY_CONTEXT_MS = 24 * HOUR_MS;
const DATA_DIR = argumentValue("--data-dir") || process.env.M3_7_DATA_DIR || ".local/m3-7-data";
const FORMAL_REPORT_PATH = argumentValue("--formal-report") || "artifacts/m3/m3-7-strategy-family-reset.json";
const REPORT_PATH = argumentValue("--output") || "artifacts/m3/m3-7-failure-postmortem.json";

if (!existsSync(resolve(DATA_DIR, "index.json"))) {
  failClosed("M3_7_DATA_REQUIRED");
} else if (!existsSync(resolve(FORMAL_REPORT_PATH))) {
  failClosed("M3_7_FORMAL_RESEARCH_ARTIFACT_REQUIRED");
} else {
  try {
    const formalReport = JSON.parse(await readFile(resolve(FORMAL_REPORT_PATH), "utf8"));
    assert.equal(formalReport.candidateDefinitionsHash, EXPECTED_CANDIDATE_DEFINITIONS_HASH, "M3_7_CANDIDATE_HASH_MISMATCH");
    assert.equal(candidateDefinitionsHash(familyDefinitions()), EXPECTED_CANDIDATE_DEFINITIONS_HASH, "M3_7_DEFINITIONS_CHANGED");
    assert.equal(formalReport.oldWindowFullyResearch, true, "M3_7_FORMAL_WINDOW_NOT_FROZEN");
    assert.deepEqual(formalReport.forwardTestCandidates, [], "M3_7_FORWARD_CANDIDATE_STATE_CHANGED");

    const input = await loadM37Data({ dataDir: DATA_DIR, includeLowerTimeframe: false });
    assert.equal(input.datasetId, "M37_RESEARCH_DATA_2025_08_2026_08", "M3_7_DATASET_MISMATCH");
    assert.equal(input.windowStart, M37_OLD_WINDOW.start, "M3_7_WINDOW_START_MISMATCH");
    assert.equal(input.windowEnd, M37_OLD_WINDOW.endExclusive, "M3_7_WINDOW_END_MISMATCH");

    const inputDataCoverage = {
      ...(input.dataCoverage || {}),
      nonProviderCrossSectionalIncompleteTimestamps:
        input.dataCoverage?.nonProviderCrossSectionalIncompleteTimestamps
        ?? input.providerGapPolicy?.nonProviderCrossSectionalIncompleteTimestamps
    };
    const context = buildM37MarketContext({
      datasets: input.datasets,
      benchmarkCandles: input.benchmarkCandles,
      historicalUniverse: input.historicalUniverse,
      historicalUniverseMetadata: input.historicalUniverseMetadata,
      preparedCoverage: inputDataCoverage,
      historicalUniverseComplete: input.historicalUniverseComplete,
      providerGapRegistry: input.providerGapRegistry,
      window: M37_OLD_WINDOW
    });
    const definitions = familyDefinitions();
    const signalsByFamily = {};
    for (const definition of definitions) {
      const rawSignals = buildM37FamilySignals({ familyId: definition.id, context });
      signalsByFamily[definition.id] = filterM37ResearchSignals({
        familyId: definition.id,
        signals: rawSignals,
        window: M37_OLD_WINDOW
      }).eligibleSignals;
    }

    const familyDiagnostics = {};
    for (const definition of definitions) {
      console.log(`postmortem replay: ${definition.id}`);
      const replay = await replayFamily({
        familyId: definition.id,
        signals: signalsByFamily[definition.id],
        datasetDescriptors: input.datasetDescriptors,
        dataDir: input.dataDir,
        lowerTimeframe: input.lowerTimeframe || "5m",
        formalResult: formalReport.researchResults?.[definition.id]
      });
      familyDiagnostics[definition.id] = buildFamilyPostmortem({
        familyId: definition.id,
        trades: replay.tradeResults,
        signals: signalsByFamily[definition.id],
        formalResult: formalReport.researchResults?.[definition.id],
        window: M37_OLD_WINDOW
      });
      familyDiagnostics[definition.id].replay.entryStats = replay.entryStats;
      familyDiagnostics[definition.id].replay.missedEntries = replay.missedEntries;
      console.log(JSON.stringify({
        familyId: definition.id,
        completeTrades: familyDiagnostics[definition.id].replay.completeTrades,
        netExpectancyR: familyDiagnostics[definition.id].replay.metrics.netExpectancyR,
        grossExpectancyR: familyDiagnostics[definition.id].replay.metrics.grossExpectancyR,
        diagnosticScope: DIAGNOSTIC_SCOPE.classification
      }));
    }

    const report = buildPostmortemReport({
      baseReport: formalReport,
      familyDiagnostics,
      frozenBaseSha: BASE_RESEARCH_SHA,
      candidateDefinitionsHash: EXPECTED_CANDIDATE_DEFINITIONS_HASH
    });
    await mkdir(dirname(resolve(REPORT_PATH)), { recursive: true });
    await writeFile(resolve(REPORT_PATH), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({
      reportPath: resolve(REPORT_PATH),
      baseResearchSha: report.baseResearchSha,
      candidateDefinitionsHash: report.candidateDefinitionsHash,
      families: Object.values(familyDiagnostics).map((family) => ({
        familyId: family.familyId,
        completeTrades: family.replay.completeTrades,
        grossExpectancyR: family.replay.metrics.grossExpectancyR,
        netExpectancyR: family.replay.metrics.netExpectancyR,
        failureClassification: family.failureClassification
      })),
      implementationVerdict: report.implementationVerdict,
      forwardTestCandidates: report.forwardTestCandidates,
      formalForwardVerdict: report.formalForwardVerdict,
      flags: report.flags
    }, null, 2));
  } catch (error) {
    failClosed(error?.stack || error?.message || String(error));
  }
}

async function replayFamily({ familyId, signals, datasetDescriptors, dataDir, lowerTimeframe, formalResult }) {
  const byAssetSide = new Map();
  for (const signal of Array.isArray(signals) ? signals : []) {
    const key = `${String(signal.asset).toUpperCase()}:${signal.side}`;
    if (!byAssetSide.has(key)) byAssetSide.set(key, []);
    byAssetSide.get(key).push(signal);
  }
  const signalDetails = new Map((Array.isArray(signals) ? signals : [])
    .map((signal) => [`${String(signal.asset).toUpperCase()}:${signal.side}:${Number(signal.signalCandleOpenTime)}`, signal.details || {}]));
  const tradeResults = [];
  const missedEntries = [];
  const entryStats = { signals: 0, planned: 0, entries: 0, noEntry: 0, missedEntry: 0 };
  for (let descriptorIndex = 0; descriptorIndex < (Array.isArray(datasetDescriptors) ? datasetDescriptors.length : 0); descriptorIndex++) {
    const descriptor = datasetDescriptors[descriptorIndex];
    const asset = String(descriptor?.asset || "").trim().toUpperCase();
    const hasSignals = ["LONG", "SHORT"].some((side) => (byAssetSide.get(`${asset}:${side}`) || []).length > 0);
    if (!hasSignals) continue;
    let dataset = await loadM37Dataset({ dataDir, descriptor });
    try {
      for (const side of ["LONG", "SHORT"]) {
        const sideSignals = byAssetSide.get(`${asset}:${side}`) || [];
        if (!sideSignals.length) continue;
        const sideReplay = await replaySideInChunks({
          familyId,
          dataset,
          signals: sideSignals,
          lowerTimeframe,
          signalDetails
        });
        tradeResults.push(...sideReplay.tradeResults);
        missedEntries.push(...sideReplay.missedEntries);
        for (const key of Object.keys(entryStats)) entryStats[key] += Number(sideReplay.entryStats?.[key]) || 0;
      }
    } finally {
      dataset = null;
    }
    if ((descriptorIndex + 1) % 50 === 0) {
      console.log(`postmortem replay: ${familyId} ${descriptorIndex + 1}/${datasetDescriptors.length}`);
    }
  }
  const expectedByAsset = new Map((formalResult?.byAsset || []).map((row) => [String(row.key), row]));
  const actualByAsset = new Map();
  for (const trade of tradeResults.filter(isPrimaryOosTrade)) {
    const key = String(trade.asset || "UNKNOWN");
    if (!actualByAsset.has(key)) actualByAsset.set(key, []);
    actualByAsset.get(key).push(trade);
  }
  const reconciliationAssets = [...new Set([...expectedByAsset.keys(), ...actualByAsset.keys()])]
    .filter((asset) => {
      const expected = expectedByAsset.get(asset) || {};
      const actual = actualByAsset.get(asset) || [];
      const actualMetrics = diagnosticMetrics(actual);
      return Number(expected.trades || 0) !== actual.length
        || Math.abs(Number(expected.netExpectancyR || 0) - Number(actualMetrics.netExpectancyR || 0)) > 1e-9;
    });
  if (reconciliationAssets.length) {
    const replacementTrades = [];
    const replacementMisses = [];
    for (const asset of reconciliationAssets) {
      const descriptor = datasetDescriptors.find((row) => String(row?.asset || "").trim().toUpperCase() === asset);
      if (!descriptor) continue;
      const assetSignals = (Array.isArray(signals) ? signals : [])
        .filter((signal) => String(signal.asset).toUpperCase() === asset);
      const exact = await replayFullAsset({
        familyId,
        asset,
        descriptor,
        signals: assetSignals,
        dataDir,
        lowerTimeframe,
        signalDetails
      });
      replacementTrades.push(...exact.tradeResults);
      replacementMisses.push(...exact.missedEntries);
      console.log(`postmortem exact reconciliation: ${familyId} ${asset}`);
    }
    const retained = tradeResults.filter((trade) => !reconciliationAssets.includes(String(trade.asset || "UNKNOWN")));
    tradeResults.length = 0;
    for (const trade of retained) tradeResults.push(trade);
    for (const trade of replacementTrades) tradeResults.push(trade);
    const retainedMisses = missedEntries.filter((entry) => !reconciliationAssets.includes(String(entry.asset || entry.dataset?.asset || "UNKNOWN")));
    missedEntries.length = 0;
    for (const entry of retainedMisses) missedEntries.push(entry);
    for (const entry of replacementMisses) missedEntries.push(entry);
  }
  entryStats.entries = tradeResults.length;
  entryStats.planned = Math.max(0, entryStats.signals - missedEntries.length);
  entryStats.noEntry = missedEntries.filter((entry) => entry.status === "NO_ENTRY").length;
  entryStats.missedEntry = missedEntries.filter((entry) => entry.status === "MISSED_ENTRY").length;
  return { tradeResults, missedEntries, entryStats };
}

async function replayFullAsset({ familyId, asset, descriptor, signals, dataDir, lowerTimeframe, signalDetails }) {
  let dataset = await loadM37Dataset({ dataDir, descriptor });
  try {
    const tradeResults = [];
    const missedEntries = [];
    for (const side of ["LONG", "SHORT"]) {
      const sideSignals = (Array.isArray(signals) ? signals : []).filter((signal) => signal.side === side);
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
      for (const trade of result.tradeResults || []) {
        tradeResults.push({
          ...trade,
          signalDetails: signalDetails.get(`${asset}:${trade.side}:${Number(trade.signalCandleOpenTime)}`) || {},
          researchFold: null
        });
      }
      missedEntries.push(...(result.missedEntries || []));
    }
    return { tradeResults, missedEntries };
  } finally {
    dataset = null;
  }
}

async function replaySideInChunks({ familyId, dataset, signals, lowerTimeframe, signalDetails }) {
  const orderedSignals = [...signals].sort((left, right) => Number(left.signalCandleOpenTime) - Number(right.signalCandleOpenTime));
  const firstSignalTime = Number(orderedSignals[0]?.signalCandleOpenTime);
  const lastSignalTime = Number(orderedSignals.at(-1)?.signalCandleOpenTime);
  const seenTradeKeys = new Set();
  const tradeResults = [];
  const missedEntries = [];
  const entryStats = { signals: 0, planned: 0, entries: 0, noEntry: 0, missedEntry: 0 };
  if (!Number.isFinite(firstSignalTime) || !Number.isFinite(lastSignalTime)) {
    return { tradeResults, missedEntries, entryStats };
  }

  for (let chunkStart = firstSignalTime; chunkStart <= lastSignalTime; chunkStart += REPLAY_CHUNK_MS) {
    const chunkEnd = Math.min(lastSignalTime + HOUR_MS, chunkStart + REPLAY_CHUNK_MS);
    const contextStart = chunkStart - REPLAY_CONTEXT_MS;
    const contextEnd = chunkEnd + REPLAY_CONTEXT_MS;
    const windowSignals = orderedSignals.filter((signal) => {
      const time = Number(signal.signalCandleOpenTime);
      return time >= contextStart && time < contextEnd;
    });
    const windowCandles = (Array.isArray(dataset.candles) ? dataset.candles : [])
      .filter((candle) => Number(candle.openTime) >= contextStart && Number(candle.openTime) < contextEnd + HOUR_MS);
    const windowLower = (Array.isArray(dataset.lowerTimeframeCandles) ? dataset.lowerTimeframeCandles : [])
      .filter((candle) => Number(candle.openTime) >= contextStart && Number(candle.openTime) < contextEnd);
    const windowDataset = {
      ...dataset,
      candles: windowCandles,
      lowerTimeframeCandles: windowLower
    };
    const result = runM37FamilyBacktest({
      familyId,
      dataset: windowDataset,
      signals: windowSignals,
      executionModel: dataset.backtestOptions?.executionModel || {},
      fundingEvents: dataset.fundingEvents,
      fundingCoverage: dataset.fundingCoverage,
      lowerTimeframeCandles: windowLower,
      lowerTimeframe,
      exchangeFilters: dataset.exchangeFilters
    });
    for (const trade of result.tradeResults || []) {
      const signalTime = Number(trade.signalCandleOpenTime);
      if (signalTime < chunkStart || signalTime >= chunkEnd) continue;
      const key = `${trade.side}:${signalTime}`;
      if (seenTradeKeys.has(key)) continue;
      seenTradeKeys.add(key);
      tradeResults.push({
        ...trade,
        signalDetails: signalDetails.get(`${String(dataset.asset).toUpperCase()}:${trade.side}:${signalTime}`) || {},
        researchFold: null
      });
    }
    const coreSignals = orderedSignals.filter((signal) => {
      const time = Number(signal.signalCandleOpenTime);
      return time >= chunkStart && time < chunkEnd;
    });
    entryStats.signals += coreSignals.length;
    entryStats.entries += (result.tradeResults || [])
      .filter((trade) => Number(trade.signalCandleOpenTime) >= chunkStart
        && Number(trade.signalCandleOpenTime) < chunkEnd).length;
    for (const missed of result.missedEntries || []) {
      const time = signalOpenTime(missed);
      if (time >= chunkStart && time < chunkEnd) missedEntries.push(missed);
    }
  }
  entryStats.planned = Math.max(0, entryStats.signals - missedEntries.length);
  entryStats.noEntry = missedEntries.filter((entry) => entry.status === "NO_ENTRY").length;
  entryStats.missedEntry = missedEntries.filter((entry) => entry.status === "MISSED_ENTRY").length;
  return { tradeResults, missedEntries, entryStats };
}

function signalOpenTime(record) {
  return Number(record?.signalCandleOpenTime ?? record?.signal?.signalCandleOpenTime);
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || null : null;
}

function failClosed(message) {
  console.error(message);
  process.exitCode = 1;
}
