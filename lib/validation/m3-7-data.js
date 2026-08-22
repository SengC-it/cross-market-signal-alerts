import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { inflateRawSync } from "node:zlib";
import {
  M3_REAL_DATA_INTERVALS,
  M3_REAL_DATA_SOURCES,
  loadM3RealInput,
  monthKeys,
  normalizeKlineRows
} from "./real-data.js";
import {
  buildFundingCoverage,
  fetchHistoricalFunding,
  normalizeFundingEvents
} from "../market-data/funding-history.js";
import {
  M37_FAMILY_DEFINITIONS,
  M37_FORWARD_SPEC,
  M37_OLD_WINDOW,
  buildM37FamilySignals,
  buildM37MarketContext,
  candidateDefinitionsHash,
  classifyM37ResearchBoundary,
  familyDefinitions
} from "./m3-7-strategy-family-reset.js";

const HOUR_MS = 3600 * 1000;
const FIVE_MINUTE_MS = 5 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 30000;

export const M37_RESEARCH_DATASET_ID = "M37_RESEARCH_DATA_2025_08_2026_08";

export async function prepareM37Data({
  sourceDir = ".local/m3-data",
  dataDir = ".local/m3-7-data",
  network = true,
  concurrency = 2,
  retainDatasets = true,
  onProgress = () => {}
} = {}) {
  const input = await loadM3RealInput({ dataDir: sourceDir });
  const outputRoot = resolve(dataDir);
  await mkdir(join(outputRoot, "datasets"), { recursive: true });
  await mkdir(join(outputRoot, "vision", "futures", "5m"), { recursive: true });
  await mkdir(join(outputRoot, "funding"), { recursive: true });

  const definitions = familyDefinitions();
  const baseDatasets = input.datasets
    .map((dataset) => normalizeHourlyDataset(dataset))
    .filter((dataset) => dataset.asset && dataset.candles.length > 0);
  const contextWithoutFunding = buildM37MarketContext({
    datasets: baseDatasets,
    benchmarkCandles: sliceCandles(input.benchmarkCandles),
    historicalUniverse: input.historicalUniverse,
    historicalUniverseMetadata: input.historicalUniverseMetadata,
    window: M37_OLD_WINDOW
  });

  const fundingResults = await prepareFundingData({
    datasets: baseDatasets,
    dataDir: outputRoot,
    network,
    concurrency,
    onProgress
  });
  const datasetsWithFunding = baseDatasets.map((dataset) => ({
    ...dataset,
    fundingEvents: fundingResults.get(dataset.asset)?.events || [],
    fundingCoverage: fundingResults.get(dataset.asset)?.coverage || incompleteCoverage(
      M37_OLD_WINDOW.start,
      M37_OLD_WINDOW.endExclusive,
      "FUNDING_DATA_NOT_PREPARED"
    )
  }));
  const signalContext = buildM37MarketContext({
    datasets: datasetsWithFunding,
    benchmarkCandles: sliceCandles(input.benchmarkCandles),
    historicalUniverse: input.historicalUniverse,
    historicalUniverseMetadata: input.historicalUniverseMetadata,
    window: M37_OLD_WINDOW
  });
  const signalsByFamily = Object.fromEntries(definitions.map((definition) => [
    definition.id,
    buildM37FamilySignals({ familyId: definition.id, context: signalContext })
  ]));
  const spanPlan = buildM37ResearchSpanPlan(signalsByFamily);
  const spansByFamily = spanPlan.spansByFamily;
  const allSpansByAsset = mergeSpansByAsset(Object.values(spansByFamily));
  const lowerCoverageByAsset = new Map();
  const datasetDescriptors = [];
  const retainedDatasets = [];
  const assets = datasetsWithFunding.map((dataset) => dataset.asset);
  await mapConcurrent(assets, concurrency, async (asset, index) => {
    const dataset = datasetsWithFunding[index];
    const spans = allSpansByAsset.get(asset) || [];
    const lower = await prepareLowerTimeframeData({
      asset,
      spans,
      dataDir: outputRoot,
      network
    });
    const lowerByFamily = Object.fromEntries(definitions.map((definition) => {
      const familySpans = spansByFamily[definition.id].get(asset) || [];
      return [definition.id, coverageForSpans(lower.candles, familySpans, "5m")];
    }));
    const finalDataset = {
      ...dataset,
      lowerTimeframeCandles: lower.candles,
      lowerTimeframe: "5m",
      lowerTimeframeCoverage: {
        status: lower.coverage.status,
        complete: lower.coverage.complete,
        requestedSpans: lower.coverage.requestedSpans,
        missingSpans: lower.coverage.missingSpans,
        byFamily: lowerByFamily
      }
    };
    const descriptor = { asset, path: `datasets/${asset}.json` };
    await writeJson(join(outputRoot, descriptor.path), finalDataset);
    datasetDescriptors.push(descriptor);
    lowerCoverageByAsset.set(asset, {
      status: lower.coverage.status,
      complete: lower.coverage.complete,
      requestedSpans: lower.coverage.requestedSpans,
      missingSpans: lower.coverage.missingSpans,
      byFamily: lowerByFamily
    });
    if (retainDatasets) retainedDatasets.push(finalDataset);
    onProgress({ phase: "5m", asset, index: index + 1, total: assets.length, status: lower.coverage.status });
  });

  const historicalUniverseAssets = new Set((input.historicalUniverse || [])
    .flatMap((row) => Array.isArray(row?.assets) ? row.assets : [])
    .map((asset) => String(asset).trim().toUpperCase())
    .filter(Boolean));
  const metadata = Array.isArray(input.historicalUniverseMetadata)
    ? input.historicalUniverseMetadata
    : [];
  const partialLifecycleAssetsIncluded = baseDatasets.filter((dataset) => {
    const first = Number(dataset.candles[0]?.openTime);
    const last = Number(dataset.candles.at(-1)?.openTime) + HOUR_MS;
    return first > Date.parse(M37_OLD_WINDOW.start) || last < Date.parse(M37_OLD_WINDOW.endExclusive);
  }).length;
  const newListingsIncluded = metadata.filter((row) => toTimestamp(row?.firstSeen) > Date.parse(M37_OLD_WINDOW.start)).length;
  const delistedAssetsIncluded = metadata.filter((row) => toTimestamp(row?.lastSeen) < Date.parse(M37_OLD_WINDOW.endExclusive)).length;
  const crossSectionalIncompleteTimestamps = signalContext.crossSectionalDiagnostics
    .filter((diagnostic) => diagnostic.crossSectionalUniverseComplete !== true).length;
  const coverageByFamily = Object.fromEntries(definitions.map((definition) => {
    const lower = assets.map((asset) => lowerCoverageByAsset.get(asset)?.byFamily?.[definition.id]);
    const lowerComplete = lower.length > 0 && lower.every((value) => value?.complete === true || value?.status === "NOT_REQUIRED");
    const fundingComplete = datasetsWithFunding.length > 0 && datasetsWithFunding.every((dataset) => {
      const coverage = dataset.fundingCoverage;
      return coverage?.complete === true;
    });
    return [definition.id, {
      signalCount: signalsByFamily[definition.id].length,
      researchBoundaryPurgedTrades: spanPlan.researchBoundaryPurgedByFamily[definition.id].length,
      signalRelevantLowerTfCoverage: coverageStatus(lowerComplete, lower.length > 0),
      signalRelevantFundingCoverage: coverageStatus(fundingComplete, datasetsWithFunding.length > 0),
      requestedLowerSpans: sumSpanCount(spansByFamily[definition.id]),
      fundingEventsAvailable: datasetsWithFunding.reduce((sum, dataset) => sum + dataset.fundingEvents.length, 0)
    }];
  }));
  const requiredHistoricalFundingAvailable = datasetsWithFunding.length > 0
    && datasetsWithFunding.every((dataset) => dataset.fundingCoverage?.complete === true);
  const researchDataQualityComplete = input.historicalUniverseComplete === true
    && crossSectionalIncompleteTimestamps === 0
    && requiredHistoricalFundingAvailable
    && Object.values(coverageByFamily).every((coverage) => coverage.signalRelevantLowerTfCoverage.complete === true
      && coverage.signalRelevantFundingCoverage.complete === true);
  const dataCoverage = {
    historicalUniverseAssetCount: historicalUniverseAssets.size,
    researchDatasetAssetCount: datasetDescriptors.length,
    partialLifecycleAssetsIncluded,
    newListingsIncluded,
    delistedAssetsIncluded,
    crossSectionalIncompleteTimestamps,
    signalRelevantFundingCoverage: coverageStatus(
      Object.values(coverageByFamily).every((coverage) => coverage.signalRelevantFundingCoverage.complete === true),
      true
    ),
    signalRelevantLowerTfCoverage: coverageStatus(
      Object.values(coverageByFamily).every((coverage) => coverage.signalRelevantLowerTfCoverage.complete === true),
      true
    ),
    fundingIncompleteTrades: 0,
    incompleteIntrabarTrades: 0,
    researchBoundaryPurgedTrades: Object.values(spanPlan.researchBoundaryPurgedByFamily)
      .reduce((sum, rows) => sum + rows.length, 0),
    researchBoundaryPurgedByFamily: Object.fromEntries(Object.entries(spanPlan.researchBoundaryPurgedByFamily)
      .map(([familyId, rows]) => [familyId, rows.length])),
    requiredHistoricalFundingAvailable,
    researchDataQualityComplete,
    byFamily: coverageByFamily
  };
  const index = {
    datasetId: M37_RESEARCH_DATASET_ID,
    sourceDataDir: resolve(sourceDir),
    dataSource: input.dataSource,
    windowStart: M37_OLD_WINDOW.start,
    windowEnd: M37_OLD_WINDOW.endExclusive,
    interval: M3_REAL_DATA_INTERVALS.candles,
    lowerTimeframe: "5m",
    benchmarkPath: "../m3-data/benchmark-BTCUSDT-4h.json",
    benchmarkCandles: sliceCandles(input.benchmarkCandles),
    datasets: datasetDescriptors.sort((left, right) => left.asset.localeCompare(right.asset)),
    historicalUniverse: input.historicalUniverse,
    historicalUniverseMetadata: input.historicalUniverseMetadata,
    historicalUniverseComplete: input.historicalUniverseComplete === true,
    universeSource: input.universeSource,
    exchangeFilterProvenance: input.exchangeFilterProvenance,
    candidateDefinitionsHash: candidateDefinitionsHash(definitions),
    candidateIds: definitions.map((definition) => definition.id),
    signalCounts: Object.fromEntries(Object.entries(signalsByFamily).map(([familyId, signals]) => [familyId, signals.length])),
    fundingEvaluation: signalContext.fundingEvaluation,
    dataCoverage,
    createdAt: new Date().toISOString(),
    networkRequested: network,
    preparationStatus: researchDataQualityComplete ? "COMPLETE" : "DATA_INCOMPLETE"
  };
  await writeJson(join(outputRoot, "index.json"), index);
  return {
    index,
    datasets: retainedDatasets,
    signalsByFamily,
    spansByFamily,
    researchBoundaryPurgedByFamily: spanPlan.researchBoundaryPurgedByFamily
  };
}

export async function loadM37Data({ dataDir = ".local/m3-7-data" } = {}) {
  const root = resolve(dataDir);
  if (!existsSync(join(root, "index.json"))) throw new Error("M3_7_DATA_REQUIRED");
  const index = JSON.parse(await readFile(join(root, "index.json"), "utf8"));
  const datasets = [];
  for (const descriptor of Array.isArray(index.datasets) ? index.datasets : []) {
    const path = resolve(root, descriptor.path);
    if (!existsSync(path)) throw new Error(`M3_7_DATA_REQUIRED: ${descriptor.path}`);
    datasets.push(JSON.parse(await readFile(path, "utf8")));
  }
  const benchmarkCandles = Array.isArray(index.benchmarkCandles)
    ? index.benchmarkCandles
    : existsSync(resolve(root, index.benchmarkPath || ""))
      ? JSON.parse(await readFile(resolve(root, index.benchmarkPath), "utf8"))
      : [];
  return { ...index, dataDir: root, datasets, benchmarkCandles };
}

function normalizeHourlyDataset(dataset) {
  return {
    ...dataset,
    asset: String(dataset?.asset || "").trim().toUpperCase(),
    candles: sliceCandles(dataset?.candles),
    lowerTimeframeCandles: [],
    fundingEvents: [],
    fundingCoverage: null
  };
}

function sliceCandles(candles) {
  return (Array.isArray(candles) ? candles : [])
    .filter((candle) => Number(candle?.openTime) >= Date.parse(M37_OLD_WINDOW.start)
      && Number(candle?.openTime) < Date.parse(M37_OLD_WINDOW.endExclusive))
    .sort((left, right) => Number(left.openTime) - Number(right.openTime));
}

export function buildM37ResearchSpanPlan(signalsByFamily = {}, window = M37_OLD_WINDOW) {
  const researchBoundaryPurgedByFamily = {};
  const spansByFamily = Object.fromEntries(M37_FAMILY_DEFINITIONS.map((definition) => {
    const spans = new Map();
    const purged = [];
    researchBoundaryPurgedByFamily[definition.id] = purged;
    for (const signal of signalsByFamily?.[definition.id] || []) {
      const boundary = classifyM37ResearchBoundary({
        familyId: definition.id,
        signal,
        window
      });
      if (boundary.status === "PURGED_RESEARCH_BOUNDARY") {
        purged.push({
          familyId: definition.id,
          asset: signal.asset,
          side: signal.side,
          signalCandleOpenTime: signal.signalCandleOpenTime,
          signalAvailableAt: boundary.signalAvailableAt,
          entryEligibleAt: boundary.entryEligibleAt,
          maxHoldingTime: boundary.maxHoldingTime,
          reason: boundary.reason,
          reasons: boundary.reasons
        });
        continue;
      }
      if (!boundary.eligible) continue;
      const start = boundary.entryEligibleAt;
      const end = boundary.maxHoldingTime;
      if (!spans.has(signal.asset)) spans.set(signal.asset, []);
      spans.get(signal.asset).push({ start, end });
    }
    for (const [asset, rows] of spans) spans.set(asset, mergeSpans(rows));
    return [definition.id, spans];
  }));
  return { spansByFamily, researchBoundaryPurgedByFamily };
}

function mergeSpansByAsset(familyMaps) {
  const result = new Map();
  for (const familyMap of familyMaps) {
    for (const [asset, spans] of familyMap) {
      if (!result.has(asset)) result.set(asset, []);
      result.get(asset).push(...spans);
    }
  }
  for (const [asset, spans] of result) result.set(asset, mergeSpans(spans));
  return result;
}

function mergeSpans(spans) {
  const sorted = (Array.isArray(spans) ? spans : [])
    .map((span) => ({ start: Number(span.start), end: Number(span.end) }))
    .filter((span) => Number.isFinite(span.start) && Number.isFinite(span.end) && span.end > span.start)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const merged = [];
  for (const span of sorted) {
    const previous = merged.at(-1);
    if (previous && span.start <= previous.end) previous.end = Math.max(previous.end, span.end);
    else merged.push({ ...span });
  }
  return merged;
}

async function prepareFundingData({ datasets, dataDir, network, concurrency, onProgress }) {
  const result = new Map();
  await mapConcurrent(datasets.map((dataset) => dataset.asset), concurrency, async (asset, index) => {
    const dataset = datasets.find((row) => row.asset === asset);
    const cachePath = join(dataDir, "funding", `${asset}.json`);
    let prepared = await readCachedFunding(cachePath);
    if (network && prepared?.coverage?.complete !== true) prepared = null;
    if (!prepared && network) {
      const fetched = await fetchHistoricalFunding({
        asset,
        startTime: M37_OLD_WINDOW.start,
        endTime: M37_OLD_WINDOW.endExclusive,
        fetchImpl: fetchWithTimeout,
        source: M3_REAL_DATA_SOURCES.funding
      });
      prepared = { events: normalizeFundingEvents(fetched.events), coverage: fetched.fundingCoverage };
      await writeJson(cachePath, prepared);
    }
    if (!prepared) {
      const existingEvents = normalizeFundingEvents(dataset?.fundingEvents);
      prepared = {
        events: existingEvents,
        coverage: incompleteCoverage(M37_OLD_WINDOW.start, M37_OLD_WINDOW.endExclusive, "FUNDING_DATA_NOT_PREPARED")
      };
    }
    result.set(asset, prepared);
    onProgress({ phase: "funding", asset, index: index + 1, total: datasets.length, status: prepared.coverage?.status });
  });
  return result;
}

async function prepareLowerTimeframeData({ asset, spans, dataDir, network }) {
  if (!spans.length) return emptyLowerResult("NOT_REQUIRED");
  const rows = [];
  const missingSpans = [];
  for (const month of monthKeysForSpans(spans)) {
    try {
      const monthRows = await readOrFetchVisionMonth({ asset, month, dataDir, network });
      rows.push(...monthRows);
    } catch (error) {
      missingSpans.push({ month, reason: error?.message || String(error) });
    }
  }
  const candles = normalizeKlineRows(rows, {
    startTime: Math.min(...spans.map((span) => span.start)),
    endTime: Math.max(...spans.map((span) => span.end)),
    intervalMs: FIVE_MINUTE_MS
  }).candles;
  const coverage = coverageForSpans(candles, spans, "5m");
  coverage.missingSpans.push(...missingSpans);
  coverage.complete = coverage.complete && missingSpans.length === 0;
  coverage.status = coverage.complete ? "COMPLETE" : "INCOMPLETE_INTRABAR_DATA";
  return { candles, coverage };
}

function coverageForSpans(candles, spans, interval) {
  const intervalMs = interval === "5m" ? FIVE_MINUTE_MS : HOUR_MS;
  if (!spans.length) return { status: "NOT_REQUIRED", complete: true, requestedSpans: [], missingSpans: [] };
  const byTime = new Set((Array.isArray(candles) ? candles : []).map((candle) => Number(candle.openTime)));
  const missingSpans = [];
  for (const span of spans) {
    for (let time = span.start; time < span.end; time += intervalMs) {
      if (!byTime.has(time)) {
        missingSpans.push({ start: time, end: span.end, reason: "COVERAGE_GAP" });
        break;
      }
    }
  }
  return {
    status: missingSpans.length ? "INCOMPLETE" : "COMPLETE",
    complete: missingSpans.length === 0,
    requestedSpans: spans.map((span) => ({ ...span })),
    missingSpans
  };
}

async function readOrFetchVisionMonth({ asset, month, dataDir, network }) {
  const path = join(dataDir, "vision", "futures", "5m", asset, `${month}.json`);
  if (existsSync(path)) return JSON.parse(await readFile(path, "utf8"));
  if (!network) throw new Error("M3_7_LOWER_TF_DATA_NOT_PREPARED");
  const url = `${M3_REAL_DATA_SOURCES.futuresVision}/${asset}/5m/${asset}-5m-${month}.zip`;
  const response = await fetchWithTimeout(url);
  if (response.status === 404) throw new Error(`LOWER_TF_ARCHIVE_NOT_FOUND:${month}`);
  if (!response.ok) throw new Error(`LOWER_TF_DOWNLOAD_FAILED:${response.status}`);
  const rows = parseVisionZip(Buffer.from(await response.arrayBuffer()));
  await mkdir(dirname(path), { recursive: true });
  await writeJson(path, rows);
  return rows;
}

function monthKeysForSpans(spans) {
  return [...new Set(spans.flatMap((span) => monthKeys(span.start, span.end)))].sort();
}

function incompleteCoverage(start, end, reason) {
  return buildFundingCoverage({
    requestedStart: start,
    requestedEnd: end,
    complete: false,
    gaps: [{ start, end, reason }],
    source: M3_REAL_DATA_SOURCES.funding,
    status: "FUNDING_DATA_MISSING"
  });
}

function emptyLowerResult(status = "INCOMPLETE_INTRABAR_DATA") {
  return {
    candles: [],
    coverage: {
      status,
      complete: status === "NOT_REQUIRED",
      requestedSpans: [],
      missingSpans: status === "NOT_REQUIRED" ? [] : [{ reason: "LOWER_TF_DATA_NOT_PREPARED" }]
    }
  };
}

function coverageStatus(complete, applicable) {
  return {
    status: !applicable ? "NOT_REQUIRED" : complete ? "COMPLETE" : "INCOMPLETE",
    complete: !applicable || complete
  };
}

function sumSpanCount(familyMap) {
  return [...familyMap.values()].reduce((sum, spans) => sum + spans.length, 0);
}

async function readCachedFunding(path) {
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    const coverage = value?.coverage;
    if (coverage?.requestedStart !== Date.parse(M37_OLD_WINDOW.start)
      || coverage?.requestedEnd !== Date.parse(M37_OLD_WINDOW.endExclusive)) return null;
    return {
      events: normalizeFundingEvents(value.events),
      coverage
    };
  } catch {
    return null;
  }
}

async function mapConcurrent(values, concurrency, worker) {
  const rows = Array.isArray(values) ? values : [];
  let cursor = 0;
  async function run() {
    while (true) {
      const index = cursor++;
      if (index >= rows.length) return;
      try {
        await worker(rows[index], index);
      } catch {
        // The caller records missing coverage in its per-asset result. One
        // unavailable archive must not discard unrelated lifecycle assets.
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(Number(concurrency) || 1, rows.length || 1)) }, run));
}

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function parseVisionZip(buffer) {
  const entries = [];
  let offset = 0;
  while (offset + 30 <= buffer.length) {
    if (buffer.readUInt32LE(offset) !== 0x04034b50) break;
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const dataStart = offset + 30 + nameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buffer.length) break;
    const compressed = buffer.subarray(dataStart, dataEnd);
    const content = method === 0 ? compressed : method === 8 ? inflateRawSync(compressed) : null;
    if (!content) throw new Error(`M3_7_ZIP_METHOD_UNSUPPORTED:${method}`);
    entries.push(content.toString("utf8"));
    offset = dataEnd;
  }
  if (!entries.length) throw new Error("M3_7_ZIP_EMPTY");
  const rows = [];
  for (const content of entries) {
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim() || !/^\s*\d/.test(line)) continue;
      const values = line.split(",");
      const openTime = Number(values[0]);
      const open = Number(values[1]);
      const high = Number(values[2]);
      const low = Number(values[3]);
      const close = Number(values[4]);
      const volume = Number(values[5]);
      const quoteVolume = Number(values[7]);
      if ([openTime, open, high, low, close, volume].every(Number.isFinite)) {
        rows.push({ openTime, open, high, low, close, volume, quoteVolume });
      }
    }
  }
  return rows;
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value)}\n`, "utf8");
}

function toTimestamp(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value instanceof Date) return value.getTime();
  if (value == null || value === "") return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}
