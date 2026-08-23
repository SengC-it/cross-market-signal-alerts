import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CONFIG } from "../lib/config.js";
import { evaluateDynamicProductionSignal, resolveDynamicPoolExistingAssets } from "../lib/strategies/dynamic-production.js";
import { rankDynamicPoolTickerDetails } from "../lib/signal-density-pool.js";
import { SIGNAL_DENSITY_CONFIG } from "../lib/signal-density-config.js";
import { directionalReturn, summarizeRankQuality, classifyRank11To25 } from "../lib/validation/signal-density-quality.js";

const CACHE_ROOT = process.env.V4_1_SIGNAL_CACHE_DIR || ".backtest-cache/binance-vision-futures-1h";
const START = Date.parse("2026-01-01T00:00:00.000Z");
const END = Date.parse("2026-07-01T00:00:00.000Z");
const MONTHS = ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"];
const ROUND_TRIP_COST = 0.0012;

const result = runQualityCheck();
console.log(JSON.stringify(result, null, 2));

function runQualityCheck() {
  const manifestPath = "production_dynamic_backtest.json";
  if (!existsSync(CACHE_ROOT) || !existsSync(manifestPath)) {
    throw new Error("V4_1_SIGNAL_DENSITY_DATA_REQUIRED: fixed local historical cache and manifest are required");
  }
  JSON.parse(readFileSync(manifestPath, "utf8"));
  const excluded = resolveDynamicPoolExistingAssets({ group: "all" });
  const cacheAssets = readdirSync(CACHE_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.endsWith("USDT"))
    .map((entry) => entry.name)
    .filter((asset) => asset === "BTCUSDT" || !excluded.has(asset))
    .sort();
  const requestedSymbols = [
    "BTCUSDT",
    ...cacheAssets.filter((asset) => asset !== "BTCUSDT").slice(0, 250)
  ];
  const datasets = requestedSymbols.map(loadDataset).filter(Boolean);
  const benchmark = datasets.find((dataset) => dataset.asset === "BTCUSDT");
  if (!benchmark || datasets.length < 3) {
    throw new Error("V4_1_SIGNAL_DENSITY_DATA_REQUIRED: BTCUSDT and a multi-asset fixed universe are required");
  }

  const datasetByAsset = new Map(datasets.map((dataset) => [dataset.asset, dataset]));
  const futuresSymbols = new Set(datasets.map((dataset) => dataset.asset));
  const lastSignalByAsset = new Map();
  const samplesByBand = { "1-10": [], "11-25": [] };
  const timestamps = benchmark.candles
    .map((candle) => candle.openTime)
    .filter((time) => time >= START && time < END);

  for (const signalTime of timestamps) {
    const tickerRows = datasets
      .map((dataset) => historicalTickerAt(dataset, signalTime))
      .filter(Boolean);
    const strongPool = rankDynamicPoolTickerDetails({
      tickers: tickerRows.map((row) => row.ticker),
      direction: "strong",
      existing: excluded,
      futuresSymbols,
      maxAssets: SIGNAL_DENSITY_CONFIG.dynamicStrongPoolMaxAssets
    });
    const benchmarkRow = benchmark.byTime.get(signalTime);
    const benchmarkPrior = benchmark.byTime.get(signalTime - 24 * 3600 * 1000);
    if (!benchmarkRow || !benchmarkPrior) continue;
    const benchmarkChange24h = benchmarkRow.close / benchmarkPrior.close - 1;

    for (const ranked of strongPool) {
      const dataset = datasetByAsset.get(ranked.symbol);
      const row = dataset ? dataset.byTime.get(signalTime) : null;
      const rankBand = ranked.dynamicPoolRankBand;
      if (!dataset || !row || !samplesByBand[rankBand] || row.index < 24) continue;
      const lastSignalAt = lastSignalByAsset.get(dataset.asset);
      if (Number.isFinite(lastSignalAt)
        && signalTime - lastSignalAt < CONFIG.assetSignalCooldownHours * 3600 * 1000) continue;

      const evaluation = evaluateDynamicProductionSignal({
        strategyId: "dynamic_relative_strength_breakout",
        candles: dataset.candles,
        signalIndex: row.index,
        benchmarkChange24h,
        hasOrderBook: false
      });
      if (!evaluation.scoreGatePassed) continue;
      const sample = buildSample(dataset, row.index, signalTime, ranked.dynamicPoolRank);
      if (!sample) continue;
      samplesByBand[rankBand].push(sample);
      lastSignalByAsset.set(dataset.asset, signalTime);
    }
  }

  const rank1To10 = summarizeRankQuality(samplesByBand["1-10"], { tradingCost: ROUND_TRIP_COST });
  const rank11To25 = summarizeRankQuality(samplesByBand["11-25"], { tradingCost: ROUND_TRIP_COST });
  return {
    schemaVersion: "v4.1-signal-density-quality-v1",
    dataSource: "fixed local Binance Vision USD-M 1h cache; no network fetch",
    strategyId: "dynamic_relative_strength_breakout",
    window: {
      start: new Date(START).toISOString(),
      end: new Date(END).toISOString(),
      folds: 5,
      holdHours: 8,
      roundTripCostProxy: ROUND_TRIP_COST
    },
    assets: datasets.map((dataset) => dataset.asset),
    assetsLoaded: datasets.length,
    fixedGates: {
      minMomentum24h: CONFIG.relativeStrengthMinMomentum24h,
      maxMomentum24h: CONFIG.relativeStrengthMaxMomentum24h,
      minRelativeStrength24h: CONFIG.relativeStrengthMinRelativeStrength24h,
      minVolumeMultiple: CONFIG.relativeStrengthMinVolumeMultiple,
      maxVolumeMultiple: CONFIG.relativeStrengthMaxVolumeMultiple,
      minQuoteVolume: CONFIG.dynamicSpotPoolMinQuoteVolume,
      poolMaxAssets: SIGNAL_DENSITY_CONFIG.dynamicStrongPoolMaxAssets,
      cooldownHours: CONFIG.assetSignalCooldownHours
    },
    rank1To10,
    rank11To25,
    rank11To25Policy: classifyRank11To25(rank11To25),
    parameterSearchPerformed: false,
    thresholdsChanged: false
  };
}

function loadDataset(asset) {
  const rows = [];
  for (const month of MONTHS) {
    const file = join(CACHE_ROOT, asset, month, `${asset}-1h-${month}.csv`);
    if (!existsSync(file)) continue;
    const lines = readFileSync(file, "utf8").trim().split(/\r?\n/);
    for (const line of lines.slice(1)) {
      const parts = line.split(",");
      const openTime = Number(parts[0]);
      const close = Number(parts[4]);
      const high = Number(parts[2]);
      const low = Number(parts[3]);
      const volume = Number(parts[5]);
      const quoteVolume = Number(parts[7]);
      if (!Number.isFinite(openTime) || !Number.isFinite(close) || close <= 0) continue;
      rows.push({ openTime, close, high, low, volume, quoteVolume });
    }
  }
  rows.sort((left, right) => left.openTime - right.openTime);
  const candles = rows.filter((candle) => candle.openTime >= START - 36 * 3600 * 1000 && candle.openTime < END + 9 * 3600 * 1000);
  if (candles.length < 48) return null;
  return {
    asset,
    candles,
    byTime: new Map(candles.map((candle, index) => [candle.openTime, { ...candle, index }]))
  };
}

function historicalTickerAt(dataset, signalTime) {
  const current = dataset.byTime.get(signalTime);
  const prior = dataset.byTime.get(signalTime - 24 * 3600 * 1000);
  if (!current || !prior || prior.close <= 0) return null;
  let quoteVolume = 0;
  for (let offset = 0; offset < 24; offset++) {
    const candle = dataset.byTime.get(signalTime - offset * 3600 * 1000);
    if (!candle) return null;
    quoteVolume += Number(candle.quoteVolume) || 0;
  }
  return {
    symbol: dataset.asset,
    index: current.index,
    ticker: {
      symbol: dataset.asset,
      lastPrice: current.close,
      priceChangePercent: (current.close / prior.close - 1) * 100,
      quoteVolume
    }
  };
}

function buildSample(dataset, index, signalTime, rank) {
  const entry = dataset.candles[index]?.close;
  const future = [1, 4, 8].map((offset) => dataset.candles[index + offset]);
  if (!Number.isFinite(entry) || future.some((candle) => !candle)) return null;
  const excursion = dataset.candles.slice(index + 1, index + 9);
  const return1h = directionalReturn(entry, future[0].close, "LONG");
  const return4h = directionalReturn(entry, future[1].close, "LONG");
  const return8h = directionalReturn(entry, future[2].close, "LONG");
  return {
    signalTime,
    rank,
    fold: Math.min(4, Math.max(0, Math.floor(((signalTime - START) / (END - START)) * 5))),
    return1h,
    return4h,
    return8h,
    mfe8h: Math.max(...excursion.map((candle) => candle.high / entry - 1)),
    mae8h: Math.min(...excursion.map((candle) => candle.low / entry - 1))
  };
}
