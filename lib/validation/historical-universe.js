import { readFileSync } from "node:fs";
import { join } from "node:path";

export const HISTORICAL_UNIVERSE_WINDOW = Object.freeze({
  start: "2025-08-01T00:00:00.000Z",
  end: "2026-08-01T00:00:00.000Z"
});

export const HISTORICAL_UNIVERSE_ASSET_COUNT = 805;

export function loadHistoricalUniverseIndex({ dataDir = ".local/m3-data" } = {}) {
  const index = JSON.parse(readFileSync(join(dataDir, "index.json"), "utf8"));
  if (index.windowStart !== HISTORICAL_UNIVERSE_WINDOW.start
    || index.windowEnd !== HISTORICAL_UNIVERSE_WINDOW.end
    || index.interval !== "1h"
    || index.datasets?.length !== HISTORICAL_UNIVERSE_ASSET_COUNT
    || index.historicalUniverseComplete !== true
    || index.survivorshipBiasRisk !== false
    || index.historicalUniverseMetadata?.length !== HISTORICAL_UNIVERSE_ASSET_COUNT) {
    throw new Error("V4_HISTORICAL_UNIVERSE_INVALID: fixed 805-asset lifecycle-aware universe is required");
  }
  return index;
}

export function loadHistoricalDataset({ dataDir = ".local/m3-data", descriptor } = {}) {
  if (!descriptor?.path) throw new Error("V4_HISTORICAL_DATASET_INVALID: dataset descriptor path is required");
  return JSON.parse(readFileSync(join(dataDir, descriptor.path), "utf8"));
}

export function loadHistoricalBenchmark({ dataDir = ".local/m3-data", benchmarkPath } = {}) {
  if (!benchmarkPath) throw new Error("V4_HISTORICAL_BENCHMARK_INVALID: benchmark path is required");
  return JSON.parse(readFileSync(join(dataDir, benchmarkPath), "utf8"));
}

export function isHistoricalLifecycleActive(metadata, timestamp) {
  const time = Number(timestamp);
  const firstSeen = Date.parse(metadata?.firstSeen || "");
  const lastSeen = Date.parse(metadata?.lastSeen || "");
  return Number.isFinite(time)
    && Number.isFinite(firstSeen)
    && Number.isFinite(lastSeen)
    && firstSeen <= time
    && time < lastSeen;
}
