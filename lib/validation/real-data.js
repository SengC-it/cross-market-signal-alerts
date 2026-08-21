import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parseBinanceSymbolFilters } from "../trading/exchange-filters.js";
import {
  buildFundingCoverage,
  fetchHistoricalFunding,
  normalizeFundingEvents
} from "../market-data/funding-history.js";
import {
  CORE_SIGNAL_POLICY,
  replayDynamicProductionSignals
} from "./dynamic-production-replay.js";
import { DYNAMIC_STRATEGY_IDS, DYNAMIC_PRODUCTION_HOLD_HOURS } from "../strategies/dynamic-production.js";

export const M3_REAL_DATA_WINDOW = Object.freeze({
  start: "2025-08-01T00:00:00.000Z",
  end: "2026-08-01T00:00:00.000Z"
});

export const M3_REAL_MANIFEST_SHA256 =
  "fbff8c232a0d55d056b1772cc714d8344e5ebdbc8516311eaa8a696a86c6b970";

export const M3_REAL_DATA_INTERVALS = Object.freeze({
  candles: "1h",
  lowerTimeframe: "5m",
  benchmark: "4h"
});

export const M3_REAL_DATA_SOURCES = Object.freeze({
  futuresVision: "https://data.binance.vision/data/futures/um/monthly/klines",
  spotVision: "https://data.binance.vision/data/spot/monthly/klines",
  futuresExchangeInfo: "https://fapi.binance.com/fapi/v1/exchangeInfo",
  funding: "https://fapi.binance.com/fapi/v1/fundingRate"
});

export const HISTORICAL_BINANCE_VISION_UNIVERSE =
  "historical_binance_vision_archive";

const HOUR_MS = 3600 * 1000;
const FIVE_MINUTE_MS = 5 * 60 * 1000;
const FOUR_HOUR_MS = 4 * HOUR_MS;
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_CONCURRENCY = 4;
const USER_AGENT = "cross-market-signal-alerts/m3-real-data";

export function fixedM3Window({ start = M3_REAL_DATA_WINDOW.start, end = M3_REAL_DATA_WINDOW.end } = {}) {
  if (String(start) !== M3_REAL_DATA_WINDOW.start || String(end) !== M3_REAL_DATA_WINDOW.end) {
    throw new Error("M3_REAL_DATA_WINDOW_FIXED");
  }
  return {
    start: M3_REAL_DATA_WINDOW.start,
    end: M3_REAL_DATA_WINDOW.end,
    startTime: Date.parse(M3_REAL_DATA_WINDOW.start),
    endTime: Date.parse(M3_REAL_DATA_WINDOW.end)
  };
}

export function monthKeys(startTime, endTime) {
  const start = new Date(toTimestamp(startTime));
  const end = new Date(toTimestamp(endTime) - 1);
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  const last = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
  const months = [];
  while (cursor <= last) {
    months.push(`${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, "0")}`);
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return months;
}

export function normalizeKlineRows(rows, {
  startTime,
  endTime,
  intervalMs
} = {}) {
  const byTime = new Map();
  let invalidRows = 0;
  let duplicateBars = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    const values = Array.isArray(row) ? row : row?.values;
    const candle = Array.isArray(values) ? normalizeKline(values) : normalizeCandleObject(row);
    if (!candle || !Number.isFinite(candle.openTime)) {
      invalidRows++;
      continue;
    }
    if (Number.isFinite(startTime) && candle.openTime < startTime) continue;
    if (Number.isFinite(endTime) && candle.openTime >= endTime) continue;
    if (byTime.has(candle.openTime)) duplicateBars++;
    byTime.set(candle.openTime, candle);
  }
  const candles = [...byTime.values()].sort((left, right) => left.openTime - right.openTime);
  const quality = validateCandleSeries(candles, { startTime, endTime, intervalMs });
  return { candles, invalidRows, ...quality, duplicateBars };
}

export function validateCandleSeries(candles, {
  startTime,
  endTime,
  intervalMs
} = {}) {
  const rows = Array.isArray(candles) ? candles : [];
  const start = toTimestamp(startTime);
  const end = toTimestamp(endTime);
  const interval = Number(intervalMs);
  const expected = Number.isFinite(start) && Number.isFinite(end) && Number.isFinite(interval) && interval > 0
    ? Math.max(0, Math.floor((end - start) / interval))
    : null;
  const seen = new Set();
  let duplicateBars = 0;
  let finite = true;
  let aligned = true;
  let gapCount = 0;
  let missingBars = 0;
  let previous = null;
  for (const candle of rows) {
    const openTime = Number(candle?.openTime);
    if (seen.has(openTime)) duplicateBars++;
    seen.add(openTime);
    const numericValues = [candle?.open, candle?.high, candle?.low, candle?.close, candle?.volume, candle?.quoteVolume];
    if (!Number.isFinite(openTime) || numericValues.some((value) => !Number.isFinite(Number(value)))) finite = false;
    if (Number.isFinite(interval) && interval > 0 && Number.isFinite(openTime) && openTime % interval !== 0) aligned = false;
    if (previous != null && Number.isFinite(interval) && interval > 0) {
      const delta = openTime - previous;
      if (delta !== interval) {
        gapCount++;
        if (delta > interval) missingBars += Math.max(0, Math.floor(delta / interval) - 1);
      }
    }
    previous = openTime;
  }
  const uniqueActual = seen.size;
  if (expected != null) {
    const first = rows[0]?.openTime;
    const last = rows.at(-1)?.openTime;
    if (Number.isFinite(first) && first > start) {
      gapCount++;
      missingBars += Math.max(0, Math.floor((first - start) / interval));
    }
    if (Number.isFinite(last) && last + interval < end) {
      gapCount++;
      missingBars += Math.max(0, Math.floor((end - (last + interval)) / interval));
    }
    if (!rows.length && expected > 0) {
      gapCount = 1;
      missingBars = expected;
    }
    missingBars = Math.max(missingBars, expected - uniqueActual);
  }
  const firstOpenTime = rows[0]?.openTime ?? null;
  const lastOpenTime = rows.at(-1)?.openTime ?? null;
  const lastCloseTime = Number.isFinite(lastOpenTime) && Number.isFinite(interval)
    ? lastOpenTime + interval
    : null;
  return {
    barsExpected: expected,
    barsActual: uniqueActual,
    duplicateBars,
    missingBars,
    gapCount,
    firstOpenTime,
    lastCloseTime,
    timestampAligned: aligned,
    finite,
    complete: expected != null
      && uniqueActual === expected
      && duplicateBars === 0
      && missingBars === 0
      && gapCount === 0
      && timestampAligned(aligned, rows, start, end, interval)
      && finite
  };
}

export function buildUniverseProvenance({
  assets = [],
  source = "current_exchangeInfo_snapshot",
  discoveryMethod = "current_exchangeInfo_snapshot",
  symbolFirstSeen = null,
  symbolLastSeen = null,
  symbolMetadata = null,
  historicalUniverseComplete = null
} = {}) {
  const normalizedAssets = [...new Set((Array.isArray(assets) ? assets : []).map(String).filter(Boolean))].sort();
  const historical = isHistoricalUniverseSource(source);
  return {
    universeSource: source,
    discoveryMethod,
    survivorshipBiasRisk: !historical,
    historicalUniverseComplete: historicalUniverseComplete == null ? historical : historicalUniverseComplete === true,
    assets: normalizedAssets,
    symbolFirstSeen,
    symbolLastSeen,
    symbolMetadata: Array.isArray(symbolMetadata) ? symbolMetadata : null
  };
}

/**
 * Convert Binance Vision object-list evidence into a causal monthly universe.
 * Membership at a replay timestamp is based only on archive objects whose
 * month is at or before that timestamp; no current exchange snapshot is used.
 */
export function buildHistoricalUniverseFromVisionListings({
  listings = [],
  startTime = M3_REAL_DATA_WINDOW.start,
  endTime = M3_REAL_DATA_WINDOW.end,
  source = HISTORICAL_BINANCE_VISION_UNIVERSE,
  discoveryMethod = "binance_vision_monthly_object_listing"
} = {}) {
  const window = fixedM3Window({
    start: new Date(toTimestamp(startTime)).toISOString(),
    end: new Date(toTimestamp(endTime)).toISOString()
  });
  const expectedMonths = monthKeys(window.startTime, window.endTime);
  const membership = new Map(expectedMonths.map((month) => [month, new Set()]));
  const metadata = [];
  for (const listing of Array.isArray(listings) ? listings : []) {
    const asset = String(listing?.asset || "").trim().toUpperCase();
    if (!isHistoricalPerpetualSymbol(asset)) continue;
    const objects = [...new Set((Array.isArray(listing?.objects)
      ? listing.objects
      : Array.isArray(listing?.keys) ? listing.keys : [])
      .map(String)
      .filter(Boolean))].sort();
    const months = [...new Set(objects
      .map(extractVisionMonth)
      .filter((month) => month && expectedMonths.includes(month)))].sort();
    if (!months.length) continue;
    for (const month of months) membership.get(month).add(asset);
    const firstMonth = months[0];
    const lastMonth = months.at(-1);
    metadata.push({
      asset,
      firstSeen: listing.firstSeen || monthStartIso(firstMonth),
      lastSeen: listing.lastSeen || monthEndIso(lastMonth),
      sourceEvidence: listing.sourceEvidence || {
        provider: "Binance Vision",
        interval: "1h",
        objects
      }
    });
  }
  metadata.sort((left, right) => left.asset.localeCompare(right.asset));
  const historicalUniverse = expectedMonths
    .filter((month) => membership.get(month).size > 0)
    .map((month) => ({
      time: monthStartIso(month),
      assets: [...membership.get(month)].sort()
    }));
  const missingMonths = expectedMonths.filter((month) => !membership.get(month).size);
  const complete = isHistoricalUniverseSource(source)
    && metadata.length > 0
    && missingMonths.length === 0;
  const assets = metadata.map((row) => row.asset);
  return {
    universeSource: source,
    discoveryMethod,
    historicalUniverseComplete: complete,
    assets,
    historicalUniverse,
    symbolMetadata: metadata,
    missingMonths,
    symbolFirstSeen: Object.fromEntries(metadata.map((row) => [row.asset, row.firstSeen])),
    symbolLastSeen: Object.fromEntries(metadata.map((row) => [row.asset, row.lastSeen]))
  };
}

/**
 * Discover historical USD-M perpetual membership from Binance Vision's
 * archive listing. A listing error is fatal: a partial archive must not be
 * presented as a complete historical universe.
 */
export async function discoverHistoricalBinanceUniverse({
  startTime = M3_REAL_DATA_WINDOW.start,
  endTime = M3_REAL_DATA_WINDOW.end,
  concurrency = DEFAULT_CONCURRENCY,
  fetchImpl = fetchWithTimeout,
  listingBase = "https://s3-ap-northeast-1.amazonaws.com/data.binance.vision"
} = {}) {
  const window = fixedM3Window({
    start: new Date(toTimestamp(startTime)).toISOString(),
    end: new Date(toTimestamp(endTime)).toISOString()
  });
  const rootPrefix = "data/futures/um/monthly/klines/";
  const rootResponse = await fetchImpl(`${listingBase}?list-type=2&delimiter=%2F&prefix=${encodeURIComponent(rootPrefix)}`);
  if (!rootResponse?.ok) throw new Error("HISTORICAL_UNIVERSE_UNAVAILABLE");
  const rootXml = await rootResponse.text();
  const symbols = parseVisionCommonPrefixes(rootXml)
    .filter(isHistoricalPerpetualSymbol);
  if (!symbols.length) throw new Error("HISTORICAL_UNIVERSE_UNAVAILABLE");

  const listings = [];
  const errors = [];
  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= symbols.length) return;
      const asset = symbols[index];
      try {
        const prefix = `${rootPrefix}${asset}/1h/`;
        const objects = await listVisionObjects({ prefix, fetchImpl, listingBase });
        const windowObjects = objects.filter((object) => {
          const month = extractVisionMonth(object.key);
          return month && month >= monthKeys(window.startTime, window.endTime)[0]
            && month <= monthKeys(window.startTime, window.endTime).at(-1)
            && new RegExp(`/${asset}-1h-[0-9]{4}-[0-9]{2}\\.zip$`).test(object.key);
        });
        if (windowObjects.length) {
          listings.push({
            asset,
            objects: windowObjects.map((object) => object.key),
            sourceEvidence: {
              provider: "Binance Vision",
              listingPrefix: `${listingBase}?list-type=2&prefix=${prefix}`,
              objects: windowObjects.map((object) => object.key)
            }
          });
        }
      } catch (error) {
        errors.push({ asset, error: error?.message || String(error) });
      }
    }
  }
  await Promise.all(Array.from({
    length: Math.max(1, Math.min(Number(concurrency) || DEFAULT_CONCURRENCY, symbols.length))
  }, worker));
  if (errors.length) throw new Error("HISTORICAL_UNIVERSE_UNAVAILABLE");
  const result = buildHistoricalUniverseFromVisionListings({
    listings,
    startTime: window.startTime,
    endTime: window.endTime
  });
  if (!result.historicalUniverseComplete) throw new Error("HISTORICAL_UNIVERSE_UNAVAILABLE");
  return result;
}

export function buildExchangeFilterProvenance({
  filters,
  source = "CURRENT_SNAPSHOT_PROXY"
} = {}) {
  const valid = Boolean(filters && Number(filters.tickSize) > 0 && Number(filters.stepSize) > 0);
  return {
    filters: valid ? filters : { source, available: false },
    exchangeFilterProvenance: source,
    historicalExchangeFilterComplete: source === "HISTORICAL_EXCHANGE_INFO" && valid
  };
}

export function buildIncompleteFundingCoverage({ requestedStart, requestedEnd, reason = "FUNDING_NOT_PREPARED" } = {}) {
  return buildFundingCoverage({
    requestedStart,
    requestedEnd,
    complete: false,
    gaps: [{ start: requestedStart, end: requestedEnd, reason }],
    source: M3_REAL_DATA_SOURCES.funding,
    status: "FUNDING_DATA_MISSING"
  });
}

export function buildManifest({
  datasetId = "binance_usdm_m3_2025_08_2026_08",
  generatedAt = new Date().toISOString(),
  window = fixedM3Window(),
  sources = M3_REAL_DATA_SOURCES,
  assets = [],
  benchmark = null,
  universeProvenance = null,
  exchangeFilterProvenance = null,
  qualityFlags = {},
  checksums = {}
} = {}) {
  const normalizedAssets = (Array.isArray(assets) ? assets : [])
    .map((asset) => ({
      asset: asset.asset,
      candles1h: asset.candles1h || null,
      candles5m: asset.candles5m || null,
      funding: asset.funding || null,
      gapCounts: asset.gapCounts || null,
      fundingCoverage: asset.fundingCoverage || null,
      dataQuality: asset.dataQuality || null
    }))
    .sort((left, right) => String(left.asset).localeCompare(String(right.asset)));
  return {
    datasetId,
    generatedAt,
    windowStart: window.start,
    windowEnd: window.end,
    intervals: M3_REAL_DATA_INTERVALS,
    sources,
    assetCount: normalizedAssets.length,
    assets: normalizedAssets,
    benchmark,
    universeProvenance,
    exchangeFilterProvenance,
    checksums,
    dataQualityFlags: qualityFlags,
    policyScope: CORE_SIGNAL_POLICY,
    fullProductionPolicyValidated: false
  };
}

export async function loadM3RealInput({
  dataDir = ".local/m3-data",
  manifestPath = "artifacts/m3/manifest.json",
  expectedManifestSha256 = M3_REAL_MANIFEST_SHA256
} = {}) {
  const root = resolve(dataDir);
  const frozen = await verifyFrozenM3Data({
    dataDir,
    manifestPath,
    expectedManifestSha256
  });
  const { index, manifest, manifestSha256, manifestFile } = frozen;
  const benchmarkCandles = await readJson(join(root, index.benchmarkPath));
  const datasets = [];
  for (const descriptor of Array.isArray(index.datasets) ? index.datasets : []) {
    const dataset = await readJson(join(root, descriptor.path));
    datasets.push(dataset);
  }
  return {
    ...index,
    dataDir: root,
    manifest,
    manifestPath: manifestFile,
    manifestSha256,
    benchmarkCandles,
    datasets
  };
}

export async function verifyFrozenM3Data({
  dataDir = ".local/m3-data",
  manifestPath = "artifacts/m3/manifest.json",
  expectedManifestSha256 = M3_REAL_MANIFEST_SHA256
} = {}) {
  const root = resolve(dataDir);
  const manifestFile = resolve(manifestPath);
  const indexFile = join(root, "index.json");
  if (!existsSync(manifestFile) || !existsSync(indexFile)) {
    throw new Error("M3_REAL_DATA_REQUIRED");
  }
  let manifest;
  let index;
  try {
    manifest = await readJson(manifestFile);
    index = await readJson(indexFile);
  } catch {
    throw new Error("M3_REAL_DATA_REQUIRED");
  }
  const manifestSha256 = await sha256File(manifestFile);
  if (expectedManifestSha256 && manifestSha256 !== expectedManifestSha256) {
    throw new Error("M3_DATA_HASH_MISMATCH: manifest");
  }
  assertFrozenMetadata({ index, manifest });
  const manifestFiles = manifest.checksums?.files;
  const indexFiles = index.checksums?.files;
  if (manifest.checksums?.algorithm !== "SHA-256"
    || !isStringHashMap(manifestFiles)
    || !isStringHashMap(indexFiles)
    || !sameStringHashMap(manifestFiles, indexFiles)) {
    throw new Error("M3_DATA_HASH_MISMATCH: checksum-index");
  }
  const requiredPaths = [
    index.benchmarkPath,
    ...(Array.isArray(index.datasets) ? index.datasets.map((descriptor) => descriptor?.path) : [])
  ];
  if (requiredPaths.some((path) => typeof path !== "string" || !manifestFiles[path])) {
    throw new Error("M3_DATA_HASH_MISMATCH: required-file-list");
  }
  for (const path of requiredPaths) {
    const file = resolveDataPath(root, path);
    if (!existsSync(file)) throw new Error(`M3_REAL_DATA_REQUIRED: ${path}`);
    if (await sha256File(file) !== manifestFiles[path]) {
      throw new Error(`M3_DATA_HASH_MISMATCH: ${path}`);
    }
  }
  return { root, index, manifest, manifestSha256, manifestFile };
}

export async function prepareM3RealData({
  dataDir = ".local/m3-data",
  manifestPath = "artifacts/m3/manifest.json",
  symbols = null,
  maxAssets = null,
  universeFile = null,
  concurrency = DEFAULT_CONCURRENCY,
  executionModel = {},
  onProgress = () => {}
} = {}) {
  const window = fixedM3Window();
  const root = resolve(dataDir);
  await mkdir(root, { recursive: true });
  await mkdir(join(root, "datasets"), { recursive: true });
  await mkdir(dirname(resolve(manifestPath)), { recursive: true });

  const exchangeInfo = await fetchJson(M3_REAL_DATA_SOURCES.futuresExchangeInfo);
  const externalUniverse = universeFile
    ? await readJson(resolve(universeFile))
    : await discoverHistoricalBinanceUniverse({
      startTime: window.startTime,
      endTime: window.endTime,
      concurrency
    });
  const universeRows = externalUniverse?.historicalUniverse || externalUniverse?.rows || externalUniverse;
  const universeSource = externalUniverse?.universeSource
    || null;
  if (!isHistoricalUniverseSource(universeSource)
    || externalUniverse?.historicalUniverseComplete !== true
    || !Array.isArray(universeRows)
    || !universeRows.length) {
    throw new Error("HISTORICAL_UNIVERSE_UNAVAILABLE");
  }
  const universeAssets = Array.isArray(symbols) && symbols.length
    ? symbols
    : Array.isArray(externalUniverse?.assets) && externalUniverse.assets.length
      ? externalUniverse.assets
      : [];
  if (!universeAssets.length) throw new Error("HISTORICAL_UNIVERSE_UNAVAILABLE");
  const normalizedSymbols = [...new Set(universeAssets.map((symbol) => String(symbol).trim().toUpperCase()).filter(Boolean))]
    .sort()
    .slice(0, Number.isFinite(Number(maxAssets)) && Number(maxAssets) > 0 ? Number(maxAssets) : undefined);
  const universeProvenance = buildUniverseProvenance({
    assets: normalizedSymbols,
    source: universeSource,
    discoveryMethod: externalUniverse
      ? externalUniverse.discoveryMethod || "external_universe_input"
      : "binance_vision_monthly_object_listing",
    symbolFirstSeen: filterSymbolMap(externalUniverse.symbolFirstSeen, normalizedSymbols),
    symbolLastSeen: filterSymbolMap(externalUniverse.symbolLastSeen, normalizedSymbols),
    symbolMetadata: filterSymbolMetadata(externalUniverse.symbolMetadata, normalizedSymbols),
    historicalUniverseComplete: externalUniverse.historicalUniverseComplete
  });
  const historicalUniverse = universeRows;

  const oneHour = await fetchSeriesForSymbols({
    symbols: normalizedSymbols,
    interval: M3_REAL_DATA_INTERVALS.candles,
    startTime: window.startTime,
    endTime: window.endTime,
    market: "futures",
    dataDir: root,
    concurrency,
    onProgress
  });
  const benchmark = await fetchVisionSeries({
    symbol: "BTCUSDT",
    interval: M3_REAL_DATA_INTERVALS.benchmark,
    startTime: window.startTime,
    endTime: window.endTime,
    market: "spot",
    dataDir: root
  });
  if (!benchmark.candles.length) throw new Error("M3_REAL_DATA_DOWNLOAD_BLOCKED: spot BTCUSDT 4h");

  const replayDatasets = normalizedSymbols
    .map((asset) => ({ asset, candles: oneHour.get(asset)?.candles || [] }))
    .filter((dataset) => oneHour.get(dataset.asset)?.complete === true);
  const replayInputExcludedAssets = normalizedSymbols
    .filter((asset) => !replayDatasets.some((dataset) => dataset.asset === asset));
  const replayByStrategy = Object.fromEntries(DYNAMIC_STRATEGY_IDS.map((strategyId) => [strategyId, replayDynamicProductionSignals({
    datasets: replayDatasets,
    strategyId,
    interval: M3_REAL_DATA_INTERVALS.candles,
    benchmarkCandles: benchmark.candles,
    benchmarkInterval: M3_REAL_DATA_INTERVALS.benchmark,
    futuresSymbols: normalizedSymbols,
    historicalUniverse,
    historicalUniverseComplete: universeProvenance.historicalUniverseComplete,
    universeSource,
    dataSource: "BINANCE_VISION_REAL_DATA",
    productionPolicy: CORE_SIGNAL_POLICY
  })]));
  const signalSpans = buildSignalSpans(replayByStrategy);
  const exchangeFilterRows = new Map((exchangeInfo?.symbols || []).map((row) => [row.symbol, row]));
  const datasets = [];
  for (const asset of normalizedSymbols) {
    const oneHourData = oneHour.get(asset) || emptySeries(window.startTime, window.endTime, HOUR_MS);
    const span = signalSpans.get(asset);
    const lowerStart = Math.max(window.startTime, span?.start ?? window.startTime);
    const lowerEnd = Math.min(window.endTime, span?.end ?? window.endTime);
    const hasReplaySpan = Boolean(span && lowerEnd > lowerStart);
    const lower = hasReplaySpan
      ? await fetchVisionSeries({
        symbol: asset,
        interval: M3_REAL_DATA_INTERVALS.lowerTimeframe,
        startTime: lowerStart,
        endTime: lowerEnd,
        market: "futures",
        dataDir: root
      })
      : emptySeries(lowerStart, lowerEnd, FIVE_MINUTE_MS);
    const funding = hasReplaySpan
      ? await fetchFundingForSpan({ asset, startTime: lowerStart, endTime: lowerEnd })
      : {
        events: [],
        fundingCoverage: buildIncompleteFundingCoverage({
          requestedStart: lowerStart,
          requestedEnd: lowerEnd,
          reason: "NO_PRIMARY_SIGNAL_SPAN"
        })
      };
    const currentFilters = parseBinanceSymbolFilters(exchangeFilterRows.get(asset) || {});
    const filterProvenance = buildExchangeFilterProvenance({
      filters: currentFilters,
      source: "CURRENT_SNAPSHOT_PROXY"
    });
    const dataset = {
      asset,
      candles: oneHourData.candles,
      lowerTimeframeCandles: lower.candles,
      fundingEvents: normalizeFundingEvents(funding.events),
      fundingCoverage: funding.fundingCoverage,
      exchangeFilters: filterProvenance.filters,
      marketType: "futures",
      tradePlanType: "futures",
      backtestOptions: {
        marketType: "futures",
        tradePlanType: "futures",
        executionModel: {
          marketType: "futures",
          exchangeRulesRequired: true,
          ...executionModel
        }
      }
    };
    const descriptor = { asset, path: `datasets/${asset}.json` };
    await writeJson(join(root, descriptor.path), dataset);
    datasets.push({ descriptor, dataset, oneHourData, lower, funding, filterProvenance });
  }
  const finalReplayDatasets = datasets
    .map(({ dataset }) => dataset)
    .filter((dataset) => Array.isArray(dataset.candles) && dataset.candles.length === 8760);
  const finalReplayByStrategy = Object.fromEntries(DYNAMIC_STRATEGY_IDS.map((strategyId) => [strategyId, replayDynamicProductionSignals({
    datasets: finalReplayDatasets,
    strategyId,
    interval: M3_REAL_DATA_INTERVALS.candles,
    benchmarkCandles: benchmark.candles,
    benchmarkInterval: M3_REAL_DATA_INTERVALS.benchmark,
    futuresSymbols: normalizedSymbols,
    historicalUniverse,
    historicalUniverseComplete: universeProvenance.historicalUniverseComplete,
    universeSource,
    dataSource: "BINANCE_VISION_REAL_DATA",
    productionPolicy: CORE_SIGNAL_POLICY
  })]));
  await writeJson(join(root, "benchmark-BTCUSDT-4h.json"), benchmark.candles);
  const dataChecksums = {};
  for (const { descriptor } of datasets) {
    dataChecksums[descriptor.path] = await sha256File(join(root, descriptor.path));
  }
  dataChecksums["benchmark-BTCUSDT-4h.json"] = await sha256File(join(root, "benchmark-BTCUSDT-4h.json"));
  const index = {
    datasetId: "binance_usdm_m3_2025_08_2026_08",
    dataSource: "BINANCE_VISION_REAL_DATA",
    windowStart: window.start,
    windowEnd: window.end,
    interval: M3_REAL_DATA_INTERVALS.candles,
    benchmarkInterval: M3_REAL_DATA_INTERVALS.benchmark,
    benchmarkPath: "benchmark-BTCUSDT-4h.json",
    benchmarkSource: M3_REAL_DATA_SOURCES.spotVision,
    benchmarkAsset: "BTCUSDT",
    datasets: datasets.map(({ descriptor }) => descriptor),
    historicalUniverse,
    universeSource,
    universeProvenance,
    exchangeFilterProvenance: "CURRENT_SNAPSHOT_PROXY",
    historicalExchangeFilterComplete: false,
    survivorshipBiasRisk: universeProvenance.survivorshipBiasRisk,
    policyScope: CORE_SIGNAL_POLICY,
    fullProductionPolicyValidated: false,
    checksums: {
      algorithm: "SHA-256",
      files: dataChecksums,
      providerChecksumsVerified: false,
      providerChecksumReason: "Binance Vision monthly endpoint did not publish a checksum sidecar in this run"
    },
    replayDiagnostics: Object.fromEntries(Object.entries(finalReplayByStrategy).map(([strategyId, replay]) => [strategyId, {
      signals: replay.signals.length,
      primaryEligibleSignals: replay.replaySignalsPrimaryEligible,
      excludedSignals: replay.replaySignalsExcluded,
      excludedByReason: replay.excludedByReason,
      quality: replay.quality
    }])),
    replayInputAssetCount: replayDatasets.length,
    replayInputExcludedAssets,
    historicalUniverseComplete: universeProvenance.historicalUniverseComplete,
    historicalUniverseMetadata: universeProvenance.symbolMetadata
  };
  await writeJson(join(root, "index.json"), index);

  const manifestAssets = datasets.map(({ dataset, oneHourData, lower, funding }) => ({
    asset: dataset.asset,
    candles1h: seriesManifest(oneHourData),
    candles5m: seriesManifest(lower),
    funding: {
      eventCount: funding.events.length,
      coverage: funding.fundingCoverage
    },
    gapCounts: {
      oneHour: oneHourData.gapCount,
      lowerTimeframe: lower.gapCount
    },
    fundingCoverage: funding.fundingCoverage,
    dataQuality: {
      oneHour: oneHourData.complete ? "COMPLETE" : "INCOMPLETE",
      lowerTimeframe: lower.complete ? "COMPLETE" : "INCOMPLETE",
      funding: funding.fundingCoverage?.complete === true ? "COMPLETE" : "INCOMPLETE"
    }
  }));
  const manifest = buildManifest({
    assets: manifestAssets,
    benchmark: seriesManifest(benchmark),
    universeProvenance,
    exchangeFilterProvenance: {
      exchangeFilterProvenance: "CURRENT_SNAPSHOT_PROXY",
      historicalExchangeFilterComplete: false
    },
    checksums: {
      algorithm: "SHA-256",
      files: dataChecksums,
      providerChecksumsVerified: false,
      providerChecksumReason: "Binance Vision monthly endpoint did not publish a checksum sidecar in this run"
    },
    qualityFlags: {
      survivorshipBiasRisk: universeProvenance.survivorshipBiasRisk,
      historicalUniverseComplete: universeProvenance.historicalUniverseComplete,
      historicalExchangeFilterComplete: false,
      fullProductionPolicyValidated: false,
      policyScope: CORE_SIGNAL_POLICY
    }
  });
  await writeJson(resolve(manifestPath), manifest);
  return { index, manifest, manifestPath: resolve(manifestPath), replayByStrategy };
}

async function fetchSeriesForSymbols({ symbols, interval, startTime, endTime, market, dataDir, concurrency, onProgress }) {
  const result = new Map();
  await mapConcurrent(symbols, concurrency, async (symbol, index) => {
    try {
      const series = await fetchVisionSeries({ symbol, interval, startTime, endTime, market, dataDir });
      result.set(symbol, series);
      onProgress({ phase: "1h", symbol, index: index + 1, total: symbols.length, bars: series.candles.length });
    } catch (error) {
      result.set(symbol, emptySeries(startTime, endTime, intervalMs(interval)));
      onProgress({ phase: "1h", symbol, index: index + 1, total: symbols.length, error: error.message });
    }
  });
  return result;
}

async function listVisionObjects({ prefix, fetchImpl, listingBase }) {
  const objects = [];
  let continuationToken = null;
  do {
    const params = new URLSearchParams({
      "list-type": "2",
      prefix
    });
    if (continuationToken) params.set("continuation-token", continuationToken);
    const response = await fetchImpl(`${listingBase}?${params.toString()}`);
    if (response?.status === 404) return [];
    if (!response?.ok) throw new Error("HISTORICAL_UNIVERSE_UNAVAILABLE");
    const xml = await response.text();
    objects.push(...parseVisionObjectRows(xml));
    continuationToken = parseVisionContinuationToken(xml);
  } while (continuationToken);
  return objects;
}

function parseVisionCommonPrefixes(xml) {
  return [...String(xml || "").matchAll(
    /<CommonPrefixes><Prefix>data\/futures\/um\/monthly\/klines\/([^<]+)\/<\/Prefix><\/CommonPrefixes>/g
  )].map((match) => match[1]);
}

function parseVisionObjectRows(xml) {
  return [...String(xml || "").matchAll(/<Key>([^<]+)<\/Key>/g)]
    .map((match) => ({ key: match[1] }));
}

function parseVisionContinuationToken(xml) {
  return String(xml || "").match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/)?.[1] || null;
}

function isHistoricalPerpetualSymbol(value) {
  return /^[\p{L}\p{N}]+USDT$/u.test(String(value || ""));
}

function isHistoricalUniverseSource(source) {
  return source === HISTORICAL_BINANCE_VISION_UNIVERSE
    || source === "historical_listed_universe";
}

function extractVisionMonth(value) {
  return String(value || "").match(/-1h-([0-9]{4}-[0-9]{2})\.zip$/)?.[1] || null;
}

function monthStartIso(month) {
  const [year, monthNumber] = String(month).split("-").map(Number);
  return new Date(Date.UTC(year, monthNumber - 1, 1)).toISOString();
}

function monthEndIso(month) {
  const [year, monthNumber] = String(month).split("-").map(Number);
  return new Date(Date.UTC(year, monthNumber, 1)).toISOString();
}

function filterSymbolMap(value, assets) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const allowed = new Set(assets);
  return Object.fromEntries(Object.entries(value).filter(([asset]) => allowed.has(asset)));
}

function filterSymbolMetadata(value, assets) {
  if (!Array.isArray(value)) return null;
  const allowed = new Set(assets);
  return value.filter((row) => allowed.has(row?.asset));
}

async function fetchVisionSeries({ symbol, interval, startTime, endTime, market, dataDir }) {
  const intervalMsValue = intervalMs(interval);
  const rows = [];
  for (const month of monthKeys(startTime, endTime)) {
    const cachePath = join(dataDir, "vision", market, interval, symbol, `${month}.json`);
    if (existsSync(cachePath)) {
      rows.push(...await readJson(cachePath));
      continue;
    }
    const base = market === "spot" ? M3_REAL_DATA_SOURCES.spotVision : M3_REAL_DATA_SOURCES.futuresVision;
    const url = `${base}/${symbol}/${interval}/${symbol}-${interval}-${month}.zip`;
    const response = await fetchWithTimeout(url);
    if (response.status === 404) continue;
    if (!response.ok) throw new Error(`M3_REAL_DATA_DOWNLOAD_BLOCKED: ${url} ${response.status}`);
    const zip = Buffer.from(await response.arrayBuffer());
    const parsed = parseVisionZip(zip);
    await mkdir(dirname(cachePath), { recursive: true });
    await writeJson(cachePath, parsed);
    rows.push(...parsed);
  }
  return normalizeKlineRows(rows, { startTime, endTime, intervalMs: intervalMsValue });
}

async function fetchFundingForSpan({ asset, startTime, endTime }) {
  const result = await fetchHistoricalFunding({
    asset,
    startTime,
    endTime,
    fetchImpl: fetchWithTimeout,
    source: M3_REAL_DATA_SOURCES.funding
  });
  return {
    events: result.events,
    fundingCoverage: result.fundingCoverage
  };
}

function buildSignalSpans(replays) {
  const spans = new Map();
  for (const replay of Object.values(replays)) {
    for (const signal of replay.signals || []) {
      const start = Number(signal.entryEligibleAt);
      const end = start + DYNAMIC_PRODUCTION_HOLD_HOURS * HOUR_MS + HOUR_MS;
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      const current = spans.get(signal.asset);
      spans.set(signal.asset, {
        start: current ? Math.min(current.start, start) : start,
        end: current ? Math.max(current.end, end) : end
      });
    }
  }
  return spans;
}

function parseVisionZip(buffer) {
  const entries = [];
  let offset = 0;
  while (offset + 30 <= buffer.length) {
    const signature = buffer.readUInt32LE(offset);
    if (signature !== 0x04034b50) break;
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const dataStart = offset + 30 + nameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buffer.length) break;
    const compressed = buffer.subarray(dataStart, dataEnd);
    let content;
    if (method === 0) content = compressed;
    else if (method === 8) content = inflateRawSync(compressed);
    else throw new Error(`M3_REAL_DATA_ZIP_METHOD_UNSUPPORTED: ${method}`);
    entries.push(content.toString("utf8"));
    offset = dataEnd;
  }
  if (!entries.length) throw new Error("M3_REAL_DATA_ZIP_EMPTY");
  const rows = [];
  for (const content of entries) {
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim() || !/^\s*\d/.test(line)) continue;
      const values = line.split(",");
      const candle = normalizeKline(values);
      if (candle) rows.push(candle);
    }
  }
  return rows;
}

function normalizeKline(values) {
  if (!Array.isArray(values)) return null;
  const openTime = normalizeTimestampUnit(values[0]);
  const candle = {
    openTime,
    open: Number(values[1]),
    high: Number(values[2]),
    low: Number(values[3]),
    close: Number(values[4]),
    volume: Number(values[5]),
    quoteVolume: Number(values[7])
  };
  if (!Number.isFinite(openTime)) return null;
  return candle;
}

function normalizeTimestampUnit(value) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp)) return null;
  // Binance Vision spot archives may encode timestamps in microseconds while
  // USD-M futures archives and the application use milliseconds.
  if (timestamp >= 1e17) return timestamp / 1e6;
  if (timestamp >= 1e14) return timestamp / 1e3;
  return timestamp;
}

function normalizeCandleObject(row) {
  if (!row || typeof row !== "object") return null;
  return normalizeKline([
    row.openTime,
    row.open,
    row.high,
    row.low,
    row.close,
    row.volume,
    null,
    row.quoteVolume
  ]);
}

function seriesManifest(series) {
  return {
    barsExpected: series.barsExpected,
    barsActual: series.barsActual,
    duplicateBars: series.duplicateBars,
    missingBars: series.missingBars,
    gapCount: series.gapCount,
    firstOpenTime: series.firstOpenTime,
    lastCloseTime: series.lastCloseTime,
    complete: series.complete
  };
}

function emptySeries(startTime, endTime, intervalValue) {
  return {
    candles: [],
    ...validateCandleSeries([], { startTime, endTime, intervalMs: intervalValue })
  };
}

async function fetchJson(url) {
  const response = await fetchWithTimeout(url);
  if (!response.ok) throw new Error(`M3_REAL_DATA_DOWNLOAD_BLOCKED: ${url} ${response.status}`);
  return response.json();
}

async function fetchWithTimeout(url) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { "user-agent": USER_AGENT },
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS)
      });
      if (response.ok || response.status === 404) return response;
      lastError = new Error(`${response.status}`);
      if (![429, 500, 502, 503, 504].includes(response.status)) return response;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500 * (attempt + 1)));
  }
  throw new Error(`M3_REAL_DATA_DOWNLOAD_BLOCKED: ${lastError?.message || url}`);
}

async function mapConcurrent(items, concurrency, worker) {
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(Number(concurrency) || DEFAULT_CONCURRENCY, items.length || 1)) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await worker(items[index], index);
    }
  });
  await Promise.all(workers);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value)}\n`, "utf8");
}

function intervalMs(interval) {
  if (interval === "5m") return FIVE_MINUTE_MS;
  if (interval === "4h") return FOUR_HOUR_MS;
  if (interval === "1h") return HOUR_MS;
  throw new Error(`M3_REAL_DATA_INTERVAL_UNSUPPORTED: ${interval}`);
}

function timestampAligned(aligned, rows, start, end, interval) {
  if (!aligned || !rows.length || !Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(interval)) return false;
  return rows[0].openTime === start && rows.at(-1).openTime + interval === end;
}

function assertFrozenMetadata({ index, manifest }) {
  const windowIsValid = index?.windowStart === M3_REAL_DATA_WINDOW.start
    && index?.windowEnd === M3_REAL_DATA_WINDOW.end
    && manifest?.windowStart === M3_REAL_DATA_WINDOW.start
    && manifest?.windowEnd === M3_REAL_DATA_WINDOW.end;
  const intervalsAreValid = manifest?.intervals?.candles === M3_REAL_DATA_INTERVALS.candles
    && manifest?.intervals?.lowerTimeframe === M3_REAL_DATA_INTERVALS.lowerTimeframe
    && manifest?.intervals?.benchmark === M3_REAL_DATA_INTERVALS.benchmark
    && index?.interval === M3_REAL_DATA_INTERVALS.candles
    && index?.benchmarkInterval === M3_REAL_DATA_INTERVALS.benchmark;
  const indexAssets = Array.isArray(index?.datasets) ? index.datasets.map((dataset) => dataset?.asset).sort() : [];
  const manifestAssets = Array.isArray(manifest?.assets) ? manifest.assets.map((asset) => asset?.asset).sort() : [];
  const historicalUniverseIsValid = index?.universeSource === HISTORICAL_BINANCE_VISION_UNIVERSE
    && manifest?.universeProvenance?.universeSource === HISTORICAL_BINANCE_VISION_UNIVERSE
    && index?.historicalUniverseComplete === true
    && manifest?.universeProvenance?.historicalUniverseComplete === true
    && index?.survivorshipBiasRisk === false
    && manifest?.universeProvenance?.survivorshipBiasRisk === false
    && Array.isArray(index?.historicalUniverse)
    && index.historicalUniverse.length > 0;
  if (!windowIsValid
    || !intervalsAreValid
    || !historicalUniverseIsValid
    || !index?.datasetId
    || index.datasetId !== manifest?.datasetId
    || index?.assetCount != null && Number(index.assetCount) !== Number(manifest.assetCount)
    || indexAssets.length !== manifestAssets.length
    || indexAssets.some((asset, index) => asset !== manifestAssets[index])) {
    throw new Error("M3_DATA_HASH_MISMATCH: frozen-metadata");
  }
}

function isStringHashMap(value) {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.values(value).every((hash) => typeof hash === "string" && /^[a-f0-9]{64}$/i.test(hash));
}

function sameStringHashMap(left, right) {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
}

function resolveDataPath(root, path) {
  const file = resolve(root, path);
  const relativePath = relative(root, file);
  if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`M3_DATA_HASH_MISMATCH: unsafe-path:${path}`);
  }
  return file;
}

function toTimestamp(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value instanceof Date) return value.getTime();
  if (value == null || value === "") return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

export async function sha256File(path) {
  const bytes = await readFile(path);
  return createHash("sha256").update(bytes).digest("hex");
}

export function relativeDataPath(root, path) {
  return relative(resolve(root), resolve(path)).replaceAll("\\", "/");
}
