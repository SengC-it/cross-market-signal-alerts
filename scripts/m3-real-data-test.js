import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG } from "../lib/config.js";
import {
  M3_REAL_DATA_SOURCES,
  M3_REAL_DATA_INTERVALS,
  M3_REAL_DATA_WINDOW,
  M3_REAL_MANIFEST_SHA256,
  HISTORICAL_BINANCE_VISION_UNIVERSE,
  PROVIDER_CHECKSUM_STATUS,
  buildExchangeFilterProvenance,
  buildManifest,
  buildHistoricalUniverseFromVisionListings,
  buildUniverseProvenance,
  fixedM3Window,
  loadM3RealInput,
  normalizeKlineRows,
  sha256File,
  summarizeExecutionCostModel,
  validateCandleSeries,
  verifyBinanceVisionChecksum,
  verifyFrozenM3Data
} from "../lib/validation/real-data.js";
import { DYNAMIC_STRATEGY_IDS, evaluateDynamicProductionSignal } from "../lib/strategies/dynamic-production.js";
import { buildFundingCoverage } from "../lib/market-data/funding-history.js";
import { createExecutionModel } from "../lib/backtest/execution-model.js";
import { simulateTrade } from "../lib/backtest/trade-simulator.js";
import { createTradeSpec } from "../lib/trading/trade-spec.js";

const HOUR = 3600 * 1000;
const FIVE_MINUTES = 5 * 60 * 1000;
const BASE = Date.parse(M3_REAL_DATA_WINDOW.start);

assert.deepEqual(fixedM3Window(), {
  start: M3_REAL_DATA_WINDOW.start,
  end: M3_REAL_DATA_WINDOW.end,
  startTime: BASE,
  endTime: Date.parse(M3_REAL_DATA_WINDOW.end)
});
assert.throws(() => fixedM3Window({ end: "2026-08-02T00:00:00.000Z" }), /M3_REAL_DATA_WINDOW_FIXED/);

const completeRows = [
  [BASE, 100, 101, 99, 100.5, 10, 0, 1005],
  [BASE + HOUR, 100.5, 102, 100, 101, 11, 0, 1111]
];
const complete = normalizeKlineRows(completeRows, {
  startTime: BASE,
  endTime: BASE + 2 * HOUR,
  intervalMs: HOUR
});
assert.equal(complete.complete, true, "complete futures 1h candles should validate");
assert.equal(complete.barsExpected, 2);
assert.equal(complete.barsActual, 2);

const duplicateAndFuture = normalizeKlineRows([
  ...completeRows,
  completeRows[1],
  [BASE + 2 * HOUR, 101, 103, 100, 102, 12, 0, 1224]
], {
  startTime: BASE,
  endTime: BASE + 2 * HOUR,
  intervalMs: HOUR
});
assert.equal(duplicateAndFuture.candles.length, 2, "future candles must not be included");
assert.equal(duplicateAndFuture.duplicateBars, 1, "duplicate bars must be reported");

const gap = validateCandleSeries([
  completeRows[0].slice(0),
  [BASE + 2 * HOUR, 101, 103, 100, 102, 12, 0, 1224]
].map((row) => ({
  openTime: row[0], open: row[1], high: row[2], low: row[3], close: row[4], volume: row[5], quoteVolume: row[7]
})), {
  startTime: BASE,
  endTime: BASE + 3 * HOUR,
  intervalMs: HOUR
});
assert.equal(gap.gapCount, 1);
assert.equal(gap.missingBars, 1);
assert.equal(gap.complete, false);

const lower = normalizeKlineRows([
  [BASE, 100, 100.5, 99.5, 100.2, 1, 0, 100.2],
  [BASE + FIVE_MINUTES, 100.2, 100.7, 100, 100.6, 1, 0, 100.6]
], {
  startTime: BASE,
  endTime: BASE + 2 * FIVE_MINUTES,
  intervalMs: FIVE_MINUTES
});
assert.equal(lower.complete, true, "5m lower-timeframe coverage should validate independently");

const fundingCoverage = buildFundingCoverage({
  requestedStart: BASE,
  requestedEnd: BASE + 8 * HOUR,
  events: [{ time: BASE + 8 * HOUR, rate: 0.0001 }],
  complete: true,
  source: M3_REAL_DATA_SOURCES.funding
});
assert.equal(fundingCoverage.complete, true);
assert.equal(fundingCoverage.eventCount, 1);

const frozenExecutionCost = summarizeExecutionCostModel({
  executionModel: {
    marketType: "futures",
    exchangeRulesRequired: true,
    legacyRoundTripCostPct: CONFIG.futuresTradingCost
  }
});
assert.equal(frozenExecutionCost.source, "CONFIG.futuresTradingCost");
assert.equal(frozenExecutionCost.roundTripFeePct, CONFIG.futuresTradingCost);
assert.equal(frozenExecutionCost.entryFeePct, CONFIG.futuresTradingCost / 2);
assert.equal(frozenExecutionCost.exitFeePct, CONFIG.futuresTradingCost / 2);

const feeSpec = createTradeSpec({
  side: "LONG",
  interval: "1h",
  signalCandleOpenTime: BASE,
  signalCandleCloseTime: BASE + HOUR,
  signalAvailableAt: BASE + HOUR,
  entryEligibleAt: BASE + HOUR,
  referencePrice: 100,
  stopLoss: 95,
  takeProfit: 105,
  maxHoldingHours: 4
});
const feeCandles = [
  { openTime: BASE, open: 100, high: 101, low: 99, close: 100 },
  { openTime: BASE + HOUR, open: 100, high: 101, low: 99, close: 100 },
  { openTime: BASE + 2 * HOUR, open: 100, high: 105, low: 99, close: 105 }
];
const feeModel = createExecutionModel({
  marketType: "spot",
  exchangeRulesRequired: false,
  legacyRoundTripCostPct: CONFIG.futuresTradingCost
});
const noFeeModel = createExecutionModel({
  marketType: "spot",
  exchangeRulesRequired: false,
  legacyRoundTripCostPct: 0
});
const tradeWithFee = simulateTrade({
  tradeSpec: feeSpec,
  candles: feeCandles,
  entryIndex: 1,
  executionModel: feeModel
});
const tradeWithoutFee = simulateTrade({
  tradeSpec: feeSpec,
  candles: feeCandles,
  entryIndex: 1,
  executionModel: noFeeModel
});
assert.ok(tradeWithFee.totalFeePct > 0);
assert.notEqual(tradeWithFee.netReturnPct, tradeWithoutFee.netReturnPct);

const checksumBytes = Buffer.from("m3-vision-zip");
const checksumHash = createHash("sha256").update(checksumBytes).digest("hex");
assert.equal(
  verifyBinanceVisionChecksum({ bytes: checksumBytes, checksumText: `${checksumHash}  archive.zip` }).status,
  PROVIDER_CHECKSUM_STATUS.VERIFIED
);
assert.equal(
  verifyBinanceVisionChecksum({ bytes: checksumBytes, checksumText: `${"0".repeat(64)}  archive.zip` }).status,
  PROVIDER_CHECKSUM_STATUS.MISMATCH
);
assert.equal(
  verifyBinanceVisionChecksum({ bytes: checksumBytes, checksumText: null }).status,
  PROVIDER_CHECKSUM_STATUS.CHECKSUM_UNAVAILABLE
);

const currentUniverse = buildUniverseProvenance({
  assets: ["ETHUSDT", "BTCUSDT"],
  source: "current_exchangeInfo_snapshot"
});
assert.equal(currentUniverse.survivorshipBiasRisk, true);
assert.equal(currentUniverse.historicalUniverseComplete, false);
const historicalUniverse = buildUniverseProvenance({
  assets: ["BTCUSDT"],
  source: "historical_listed_universe"
});
assert.equal(historicalUniverse.survivorshipBiasRisk, false);

const historicalListings = Array.from({ length: 12 }, (_, index) => {
  const date = new Date(Date.UTC(2025, 7 + index, 1));
  const month = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
  return `data/futures/um/monthly/klines/OLDUSDT/1h/OLDUSDT-1h-${month}.zip`;
});
const archiveUniverse = buildHistoricalUniverseFromVisionListings({
  listings: [
    { asset: "OLDUSDT", objects: historicalListings },
    { asset: "FUTUREUSDT", objects: historicalListings.slice(5) },
    { asset: "DELISTEDUSDT", objects: historicalListings.slice(0, 6) }
  ],
  source: HISTORICAL_BINANCE_VISION_UNIVERSE
});
assert.equal(archiveUniverse.historicalUniverseComplete, true);
const archiveProvenance = buildUniverseProvenance({
  assets: archiveUniverse.assets,
  source: HISTORICAL_BINANCE_VISION_UNIVERSE,
  discoveryMethod: archiveUniverse.discoveryMethod,
  symbolFirstSeen: archiveUniverse.symbolFirstSeen,
  symbolLastSeen: archiveUniverse.symbolLastSeen,
  symbolMetadata: archiveUniverse.symbolMetadata,
  historicalUniverseComplete: archiveUniverse.historicalUniverseComplete
});
assert.equal(archiveProvenance.survivorshipBiasRisk, false);
assert.equal(archiveProvenance.historicalUniverseComplete, true);
assert.ok(archiveUniverse.symbolMetadata.find((row) => row.asset === "OLDUSDT")?.sourceEvidence);
assert.ok(archiveUniverse.historicalUniverse[0].assets.includes("OLDUSDT"));
assert.equal(archiveUniverse.historicalUniverse[0].assets.includes("FUTUREUSDT"), false);
assert.ok(archiveUniverse.historicalUniverse[5].assets.includes("FUTUREUSDT"));
assert.ok(archiveUniverse.historicalUniverse[0].assets.includes("DELISTEDUSDT"));
assert.equal(archiveUniverse.historicalUniverse[6].assets.includes("DELISTEDUSDT"), false);
assert.equal(archiveUniverse.symbolMetadata.find((row) => row.asset === "DELISTEDUSDT")?.lastSeen, "2026-02-01T00:00:00.000Z");
const gapUniverse = buildHistoricalUniverseFromVisionListings({
  listings: [{ asset: "OLDUSDT", objects: historicalListings.slice(0, 11) }],
  source: HISTORICAL_BINANCE_VISION_UNIVERSE
});
assert.equal(gapUniverse.historicalUniverseComplete, false);
assert.ok(gapUniverse.missingMonths.includes("2026-07"));

const filters = buildExchangeFilterProvenance({
  filters: { tickSize: 0.1, stepSize: 0.001 },
  source: "CURRENT_SNAPSHOT_PROXY"
});
assert.equal(filters.historicalExchangeFilterComplete, false);
assert.equal(filters.filters.tickSize, 0.1);

const manifestArgs = {
  generatedAt: "2026-08-20T00:00:00.000Z",
  assets: [{
    asset: "ETHUSDT",
    candles1h: complete,
    candles5m: lower,
    funding: { eventCount: 1 },
    gapCounts: { oneHour: 0, lowerTimeframe: 0 },
    dataQuality: { oneHour: "COMPLETE" }
  }, {
    asset: "BTCUSDT",
    candles1h: complete,
    candles5m: lower,
    funding: { eventCount: 1 },
    gapCounts: { oneHour: 0, lowerTimeframe: 0 },
    dataQuality: { oneHour: "COMPLETE" }
  }],
  benchmark: complete,
  universeProvenance: currentUniverse,
  exchangeFilterProvenance: filters,
  qualityFlags: { survivorshipBiasRisk: true }
};
assert.equal(
  JSON.stringify(buildManifest(manifestArgs)),
  JSON.stringify(buildManifest(manifestArgs)),
  "manifest generation must be deterministic for the same inputs"
);
assert.equal(buildManifest(manifestArgs).sources.spotVision, M3_REAL_DATA_SOURCES.spotVision);
assert.equal(
  await sha256File("artifacts/m3/manifest.json"),
  M3_REAL_MANIFEST_SHA256,
  "the committed manifest must remain frozen"
);
const committedReport = JSON.parse(await readFile("artifacts/m3/m3-real-validation-report.json", "utf8"));
assert.deepEqual(Object.keys(committedReport.strategies).sort(), [...DYNAMIC_STRATEGY_IDS].sort());
assert.equal(committedReport.dataset.universeSource, HISTORICAL_BINANCE_VISION_UNIVERSE);
assert.equal(committedReport.quality.exchangeFilterTemporalQuality, "CURRENT_SNAPSHOT_PROXY");
assert.equal(committedReport.quality.orderBookAvailabilitySensitive, true);
assert.equal(committedReport.quality.productionPolicyComplete, false);
assert.equal(committedReport.quality.coreSignalPolicyComplete, true);
assert.equal(committedReport.fullProductionPolicyValidated, false);
assert.equal(committedReport.productionPolicyComplete, false);
assert.equal(committedReport.executionCostModel.roundTripFeePct, CONFIG.futuresTradingCost);
assert.equal(committedReport.executionCostModel.entryFeePct, CONFIG.futuresTradingCost / 2);
assert.equal(committedReport.executionCostModel.exitFeePct, CONFIG.futuresTradingCost / 2);
assert.equal(committedReport.providerChecksum.mismatchedFiles, 0);
for (const strategyId of DYNAMIC_STRATEGY_IDS) {
  const report = committedReport.strategies[strategyId];
  assert.equal(report.validationVerdict, "PROVISIONAL");
  const expectedStatisticalVerdict = strategyId === "dynamic_relative_weakness_breakdown"
    ? "NEGATIVE_EDGE"
    : "INSUFFICIENT_DATA";
  assert.equal(report.statisticalVerdict, expectedStatisticalVerdict);
  if (strategyId === "dynamic_relative_weakness_breakdown") {
    assert.ok(report.aggregateOOS.completeTrades >= 60);
    assert.ok(report.aggregateOOS.expectancyR <= 0);
    assert.ok(report.holdout.expectancyR <= 0);
  }
  assert.equal(report.promotableToM4, false);
  assert.equal(report.orderBookAvailabilitySensitive, true);
  assert.equal(report.flags.strategyParametersChanged, false);
  assert.equal(report.flags.parameterSearchPerformed, false);
  assert.equal(report.flags.holdoutUsedForOptimization, false);
  assert.ok(report.aggregateOOS.feeDrag > 0);
  assert.equal(report.developmentEnd, report.holdoutStart);
  assert.ok(report.walkForward.folds.every((fold) => fold.testEnd <= report.holdoutStart));
}

const temp = await mkdtemp(join(tmpdir(), "m3-real-data-test-"));
try {
  const checksumPath = join(temp, "checksum.txt");
  await writeFile(checksumPath, "m3-real-data\n", "utf8");
  assert.equal((await sha256File(checksumPath)).length, 64);
  assert.equal((await readFile(checksumPath, "utf8")), "m3-real-data\n");

  const fixtureDataDir = join(temp, "data");
  const fixtureDatasetPath = join(fixtureDataDir, "datasets", "TESTUSDT.json");
  const fixtureBenchmarkPath = join(fixtureDataDir, "benchmark.json");
  await mkdir(join(fixtureDataDir, "datasets"), { recursive: true });
  const fixtureDataset = JSON.stringify({ asset: "TESTUSDT", candles: [] });
  const fixtureBenchmark = JSON.stringify([]);
  await writeFile(fixtureDatasetPath, fixtureDataset, "utf8");
  await writeFile(fixtureBenchmarkPath, fixtureBenchmark, "utf8");
  const fixtureFiles = {
    "datasets/TESTUSDT.json": await sha256File(fixtureDatasetPath),
    "benchmark.json": await sha256File(fixtureBenchmarkPath)
  };
  const fixtureIndex = {
    datasetId: "fixture-m3",
    windowStart: M3_REAL_DATA_WINDOW.start,
    windowEnd: M3_REAL_DATA_WINDOW.end,
    interval: M3_REAL_DATA_INTERVALS.candles,
    benchmarkInterval: M3_REAL_DATA_INTERVALS.benchmark,
    benchmarkPath: "benchmark.json",
    datasets: [{ asset: "TESTUSDT", path: "datasets/TESTUSDT.json" }],
    universeSource: HISTORICAL_BINANCE_VISION_UNIVERSE,
    historicalUniverseComplete: true,
    survivorshipBiasRisk: false,
    historicalUniverse: [{ time: M3_REAL_DATA_WINDOW.start, assets: ["TESTUSDT"] }],
    executionCostModel: frozenExecutionCost,
    checksums: { algorithm: "SHA-256", files: fixtureFiles }
  };
  await writeFile(join(fixtureDataDir, "index.json"), `${JSON.stringify(fixtureIndex)}\n`, "utf8");
  const fixtureManifestObject = {
    datasetId: "fixture-m3",
    generatedAt: "2026-08-20T00:00:00.000Z",
    windowStart: M3_REAL_DATA_WINDOW.start,
    windowEnd: M3_REAL_DATA_WINDOW.end,
    intervals: M3_REAL_DATA_INTERVALS,
    sources: M3_REAL_DATA_SOURCES,
    assetCount: 1,
    assets: [{ asset: "TESTUSDT" }],
    benchmark: {},
    universeProvenance: {
      universeSource: HISTORICAL_BINANCE_VISION_UNIVERSE,
      survivorshipBiasRisk: false,
      historicalUniverseComplete: true
    },
    exchangeFilterProvenance: { exchangeFilterProvenance: "CURRENT_SNAPSHOT_PROXY" },
    executionCostModel: frozenExecutionCost,
    checksums: { algorithm: "SHA-256", files: fixtureFiles }
  };
  const fixtureManifestPath = join(temp, "manifest.json");
  await writeFile(fixtureManifestPath, `${JSON.stringify(fixtureManifestObject)}\n`, "utf8");
  const fixtureManifestSha256 = await sha256File(fixtureManifestPath);
  const loadedFixture = await loadM3RealInput({
    dataDir: fixtureDataDir,
    manifestPath: fixtureManifestPath,
    expectedManifestSha256: fixtureManifestSha256
  });
  assert.equal(loadedFixture.manifestSha256, fixtureManifestSha256);

  const mismatchedProviderManifest = {
    ...fixtureManifestObject,
    providerChecksum: {
      verifiedFiles: 0,
      unavailableFiles: 0,
      mismatchedFiles: 1,
      status: PROVIDER_CHECKSUM_STATUS.MISMATCH
    }
  };
  await writeFile(fixtureManifestPath, `${JSON.stringify(mismatchedProviderManifest)}\n`, "utf8");
  const mismatchedProviderManifestSha256 = await sha256File(fixtureManifestPath);
  await assert.rejects(
    () => verifyFrozenM3Data({
      dataDir: fixtureDataDir,
      manifestPath: fixtureManifestPath,
      expectedManifestSha256: mismatchedProviderManifestSha256
    }),
    /M3_DATA_HASH_MISMATCH: provider-checksum/
  );
  await writeFile(fixtureManifestPath, `${JSON.stringify(fixtureManifestObject)}\n`, "utf8");

  await writeFile(fixtureManifestPath, `${JSON.stringify({
    ...fixtureManifestObject,
    windowEnd: "2026-08-02T00:00:00.000Z"
  })}\n`, "utf8");
  await assert.rejects(
    () => verifyFrozenM3Data({
      dataDir: fixtureDataDir,
      manifestPath: fixtureManifestPath,
      expectedManifestSha256: fixtureManifestSha256
    }),
    /M3_DATA_HASH_MISMATCH/
  );
  await writeFile(fixtureManifestPath, `${JSON.stringify(fixtureManifestObject)}\n`, "utf8");

  await unlink(fixtureDatasetPath);
  await assert.rejects(
    () => verifyFrozenM3Data({
      dataDir: fixtureDataDir,
      manifestPath: fixtureManifestPath,
      expectedManifestSha256: fixtureManifestSha256
    }),
    /M3_REAL_DATA_REQUIRED/
  );
  await writeFile(fixtureDatasetPath, fixtureDataset, "utf8");
  await writeFile(fixtureDatasetPath, "altered\n", "utf8");
  await assert.rejects(
    () => verifyFrozenM3Data({
      dataDir: fixtureDataDir,
      manifestPath: fixtureManifestPath,
      expectedManifestSha256: fixtureManifestSha256
    }),
    /M3_DATA_HASH_MISMATCH/
  );
} finally {
  await rm(temp, { recursive: true, force: true });
}

const frozenThresholds = {
  relativeStrengthMinMomentum24h: CONFIG.relativeStrengthMinMomentum24h,
  relativeStrengthMaxMomentum24h: CONFIG.relativeStrengthMaxMomentum24h,
  relativeWeaknessMinMomentum24h: CONFIG.relativeWeaknessMinMomentum24h,
  relativeWeaknessMaxMomentum24h: CONFIG.relativeWeaknessMaxMomentum24h,
  dynamicTradeMinRecommendationScore: CONFIG.dynamicTradeMinRecommendationScore,
  futuresStopAtrMultiplier: CONFIG.futuresStopAtrMultiplier,
  futuresRewardRiskRatio: CONFIG.futuresRewardRiskRatio
};
const strategyCandles = Array.from({ length: 30 }, (_, index) => ({
  openTime: BASE + index * HOUR,
  open: 100,
  high: 101,
  low: 99,
  close: 100,
  volume: 100,
  quoteVolume: 10000
}));
for (const strategyId of DYNAMIC_STRATEGY_IDS) {
  evaluateDynamicProductionSignal({
    strategyId,
    candles: strategyCandles,
    signalIndex: 29,
    benchmarkChange24h: 0
  });
}
for (const [key, value] of Object.entries(frozenThresholds)) assert.equal(CONFIG[key], value, `${key} changed during real-data validation`);

console.log(JSON.stringify({
  test: "m3-real-data",
  window: M3_REAL_DATA_WINDOW,
  benchmarkSource: M3_REAL_DATA_SOURCES.spotVision,
  currentUniverseIsProvisional: currentUniverse.survivorshipBiasRisk,
  currentFiltersAreProvisional: !filters.historicalExchangeFilterComplete,
  passed: true
}, null, 2));
