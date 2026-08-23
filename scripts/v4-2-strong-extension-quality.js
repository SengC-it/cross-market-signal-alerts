import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { CONFIG } from "../lib/config.js";
import {
  evaluateDynamicProductionSignal,
  resolveDynamicPoolExistingAssets
} from "../lib/strategies/dynamic-production.js";
import {
  evaluateStrongExtensionProductionSignal,
  STRONG_CORE_PROFILE,
  STRONG_EXTENSION_PROFILE,
  STRONG_EXTENSION_VARIANT,
  rankStrongExtensionPoolTickers
} from "../lib/strategies/strong-extension.js";
import { rankDynamicPoolTickerDetails } from "../lib/signal-density-pool.js";
import { SIGNAL_DENSITY_CONFIG } from "../lib/signal-density-config.js";
import {
  HISTORICAL_UNIVERSE_ASSET_COUNT,
  HISTORICAL_UNIVERSE_WINDOW,
  isHistoricalLifecycleActive,
  loadHistoricalBenchmark,
  loadHistoricalDataset,
  loadHistoricalUniverseIndex
} from "../lib/validation/historical-universe.js";

const DATA_DIR = ".local/m3-data";
const START = Date.parse(HISTORICAL_UNIVERSE_WINDOW.start);
const END = Date.parse(HISTORICAL_UNIVERSE_WINDOW.end);
const HOUR_MS = 3600 * 1000;
const MONTHS = 12;
const FOLD_COUNT = 5;
const HOLD_HOURS = 8;
const ROUND_TRIP_COST = 0.0012;
const ARTIFACT_PATH = "artifacts/v4/v4-2-strong-extension-quality.json";

const result = runQualityCheck();
mkdirSync(dirname(ARTIFACT_PATH), { recursive: true });
writeFileSync(ARTIFACT_PATH, `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(JSON.stringify(result, null, 2));

function runQualityCheck() {
  const index = loadHistoricalUniverseIndex({ dataDir: DATA_DIR });
  const benchmarkRaw = loadHistoricalBenchmark({
    dataDir: DATA_DIR,
    benchmarkPath: index.benchmarkPath
  });
  const metadataByAsset = new Map(
    index.historicalUniverseMetadata.map((metadata) => [metadata.asset, metadata])
  );
  const datasets = index.datasets.map((descriptor) => {
    const raw = loadHistoricalDataset({ dataDir: DATA_DIR, descriptor });
    return compactDataset(raw, metadataByAsset.get(descriptor.asset));
  });
  const benchmark = datasets.find((dataset) => dataset.asset === "BTCUSDT");
  if (!benchmark || datasets.length !== HISTORICAL_UNIVERSE_ASSET_COUNT) {
    throw new Error("V4_2_SIGNAL_DENSITY_DATA_REQUIRED: complete 805-asset universe and BTCUSDT benchmark are required");
  }

  const existing = resolveDynamicPoolExistingAssets({ group: "all" });
  const futuresSymbols = new Set(datasets.map((dataset) => dataset.asset));
  const samplesByVariant = {
    [STRONG_CORE_PROFILE.variant]: [],
    [STRONG_EXTENSION_VARIANT]: []
  };
  const cursors = new Map(datasets.map((dataset) => [dataset.asset, 0]));
  const lastSignalByAsset = new Map();
  const signalTimes = [];

  for (let benchmarkIndex = 0; benchmarkIndex < benchmark.length; benchmarkIndex += 1) {
    const signalTime = benchmark.openTime[benchmarkIndex];
    if (signalTime < START || signalTime >= END) continue;
    const benchmarkChange24h = benchmarkMomentumAt(benchmark, benchmarkIndex);
    if (!Number.isFinite(benchmarkChange24h)) continue;
    signalTimes.push(signalTime);

    const tickerRows = [];
    for (const dataset of datasets) {
      if (!isHistoricalLifecycleActive(dataset.metadata, signalTime)) continue;
      const indexAtTime = advanceCursor(dataset, cursors.get(dataset.asset), signalTime);
      cursors.set(dataset.asset, indexAtTime);
      if (indexAtTime < 0 || !dataset.contiguous24[indexAtTime]) continue;
      const previousClose = dataset.close[indexAtTime - 24];
      const currentClose = dataset.close[indexAtTime];
      if (!Number.isFinite(previousClose) || previousClose <= 0 || !Number.isFinite(currentClose)) continue;
      tickerRows.push({
        dataset,
        index: indexAtTime,
        ticker: {
          symbol: dataset.asset,
          lastPrice: currentClose,
          priceChangePercent: (currentClose / previousClose - 1) * 100,
          quoteVolume: dataset.quote24[indexAtTime]
        }
      });
    }

    const coreRanked = rankDynamicPoolTickerDetails({
      tickers: tickerRows.map((row) => row.ticker),
      direction: "strong",
      existing,
      futuresSymbols,
      maxAssets: SIGNAL_DENSITY_CONFIG.dynamicStrongPoolMaxAssets
    });
    const extensionSymbols = rankStrongExtensionPoolTickers({
      tickers: tickerRows.map((row) => row.ticker),
      existing,
      futuresSymbols,
      maxAssets: SIGNAL_DENSITY_CONFIG.dynamicStrongPoolMaxAssets
    });
    const extensionRankByAsset = new Map(extensionSymbols.map((asset, rank) => [asset, rank + 1]));
    const rowByAsset = new Map(tickerRows.map((row) => [row.dataset.asset, row]));

    for (const ranked of coreRanked) {
      evaluateAndRecord({
        variant: STRONG_CORE_PROFILE.variant,
        row: rowByAsset.get(ranked.symbol),
        rank: ranked.dynamicPoolRank,
        signalTime,
        benchmarkChange24h,
        lastSignalByAsset,
        samples: samplesByVariant[STRONG_CORE_PROFILE.variant]
      });
    }
    for (const asset of extensionSymbols) {
      evaluateAndRecord({
        variant: STRONG_EXTENSION_VARIANT,
        row: rowByAsset.get(asset),
        rank: extensionRankByAsset.get(asset),
        signalTime,
        benchmarkChange24h,
        lastSignalByAsset,
        samples: samplesByVariant[STRONG_EXTENSION_VARIANT]
      });
    }
  }

  const core = summarize(samplesByVariant[STRONG_CORE_PROFILE.variant]);
  const extension = summarize(samplesByVariant[STRONG_EXTENSION_VARIANT]);
  const combined = summarize([
    ...samplesByVariant[STRONG_CORE_PROFILE.variant],
    ...samplesByVariant[STRONG_EXTENSION_VARIANT]
  ]);
  const extensionVerdict = classifyExtension(extension);
  const coreSignalsPerMonth = core.signalsPerMonth;
  const extensionSignalsPerMonth = extension.signalsPerMonth;
  const combinedSignalsPerMonth = combined.signalsPerMonth;

  return {
    schemaVersion: "v4.2-strong-extension-quality-v1",
    dataSource: "fixed local Binance Vision USD-M 1h historical universe; no network fetch",
    strategyId: "dynamic_relative_strength_breakout",
    variants: {
      core: STRONG_CORE_PROFILE.variant,
      extension: STRONG_EXTENSION_VARIANT
    },
    window: {
      start: new Date(START).toISOString(),
      end: new Date(END).toISOString(),
      months: MONTHS,
      folds: FOLD_COUNT,
      holdHours: HOLD_HOURS,
      roundTripCostProxy: ROUND_TRIP_COST,
      signalFrequencyBasis: "all gated signals"
    },
    historicalUniverse: {
      assetsLoaded: datasets.length,
      datasetDescriptors: index.datasets.length,
      historicalUniverseComplete: index.historicalUniverseComplete,
      survivorshipBiasRisk: index.survivorshipBiasRisk,
      lifecycleAware: true,
      signalTimestamps: signalTimes.length
    },
    fixedGates: {
      core: { ...STRONG_CORE_PROFILE, maxPoolAssets: SIGNAL_DENSITY_CONFIG.dynamicStrongPoolMaxAssets },
      extension: { ...STRONG_EXTENSION_PROFILE, maxPoolAssets: SIGNAL_DENSITY_CONFIG.dynamicStrongPoolMaxAssets },
      costProxyRoundTripPct: ROUND_TRIP_COST
    },
    core,
    extension,
    combined,
    coreSignalsPerMonth,
    extensionSignalsPerMonth,
    combinedSignalsPerMonth,
    extensionVerdict,
    estimatedHumanVisibleSignalsPerMonth: coreSignalsPerMonth
      + (extensionVerdict.classification === "STRONG_OBSERVATION" ? extensionSignalsPerMonth : 0),
    parameterSearchPerformed: false,
    thresholdsChanged: false
  };
}

function compactDataset(raw, metadata) {
  if (!raw?.asset || !metadata || !Array.isArray(raw.candles)) {
    throw new Error("V4_2_SIGNAL_DENSITY_DATA_REQUIRED: every dataset needs candles and lifecycle metadata");
  }
  const rows = raw.candles
    .map((candle) => ({
      openTime: Number(candle.openTime),
      open: Number(candle.open),
      high: Number(candle.high),
      low: Number(candle.low),
      close: Number(candle.close),
      volume: Number(candle.volume),
      quoteVolume: Number(candle.quoteVolume)
    }))
    .filter((candle) => Number.isFinite(candle.openTime) && Number.isFinite(candle.close) && candle.close > 0)
    .sort((left, right) => left.openTime - right.openTime);
  const length = rows.length;
  const dataset = {
    asset: raw.asset,
    metadata,
    length,
    openTime: new Float64Array(length),
    open: new Float64Array(length),
    high: new Float64Array(length),
    low: new Float64Array(length),
    close: new Float64Array(length),
    volume: new Float64Array(length),
    quoteVolume: new Float64Array(length),
    quote24: new Float64Array(length),
    contiguous24: new Uint8Array(length)
  };
  let quoteSum = 0;
  for (let index = 0; index < length; index += 1) {
    const row = rows[index];
    dataset.openTime[index] = row.openTime;
    dataset.open[index] = row.open;
    dataset.high[index] = row.high;
    dataset.low[index] = row.low;
    dataset.close[index] = row.close;
    dataset.volume[index] = row.volume;
    dataset.quoteVolume[index] = Number.isFinite(row.quoteVolume)
      ? row.quoteVolume
      : row.volume * row.close;
    quoteSum += dataset.quoteVolume[index];
    if (index >= 24) quoteSum -= dataset.quoteVolume[index - 24];
    if (index >= 24 && dataset.openTime[index] - dataset.openTime[index - 24] === 24 * HOUR_MS) {
      dataset.contiguous24[index] = 1;
    }
    dataset.quote24[index] = index >= 23 ? quoteSum : 0;
  }
  return dataset;
}

function advanceCursor(dataset, cursor, signalTime) {
  let index = Math.max(0, Number(cursor) || 0);
  while (index < dataset.length && dataset.openTime[index] < signalTime) index += 1;
  return index < dataset.length && dataset.openTime[index] === signalTime ? index : -1;
}

function benchmarkMomentumAt(dataset, index) {
  if (index < 24 || !dataset.contiguous24[index]) return null;
  const previous = dataset.close[index - 24];
  const current = dataset.close[index];
  return Number.isFinite(previous) && previous > 0 && Number.isFinite(current)
    ? current / previous - 1
    : null;
}

function evaluateAndRecord({
  variant,
  row,
  rank,
  signalTime,
  benchmarkChange24h,
  lastSignalByAsset,
  samples
}) {
  if (!row || !Number.isInteger(row.index) || row.index < 24) return;
  const lastSignalAt = lastSignalByAsset.get(row.dataset.asset);
  if (Number.isFinite(lastSignalAt)
    && signalTime - lastSignalAt < CONFIG.assetSignalCooldownHours * HOUR_MS) return;
  const candles = materializeEvaluationCandles(row.dataset, row.index);
  const evaluation = variant === STRONG_EXTENSION_VARIANT
    ? evaluateStrongExtensionProductionSignal({ candles, signalIndex: 24, benchmarkChange24h, hasOrderBook: false })
    : evaluateDynamicProductionSignal({
      strategyId: "dynamic_relative_strength_breakout",
      candles,
      signalIndex: 24,
      benchmarkChange24h,
      hasOrderBook: false
    });
  if (!evaluation.scoreGatePassed) return;
  samples.push(buildSample(row.dataset, row.index, signalTime, rank, variant));
  lastSignalByAsset.set(row.dataset.asset, signalTime);
}

function materializeEvaluationCandles(dataset, index) {
  const start = index - 24;
  return Array.from({ length: 25 }, (_, offset) => {
    const sourceIndex = start + offset;
    return {
      openTime: dataset.openTime[sourceIndex],
      open: dataset.open[sourceIndex],
      high: dataset.high[sourceIndex],
      low: dataset.low[sourceIndex],
      close: dataset.close[sourceIndex],
      volume: dataset.volume[sourceIndex],
      quoteVolume: dataset.quoteVolume[sourceIndex]
    };
  });
}

function buildSample(dataset, index, signalTime, rank, variant) {
  const entry = dataset.close[index];
  const complete = index + HOLD_HOURS < dataset.length
    && Array.from({ length: HOLD_HOURS }, (_, offset) => (
      dataset.openTime[index + offset] === dataset.openTime[index] + offset * HOUR_MS
    )).every(Boolean);
  const return1h = complete ? directionalReturn(entry, dataset.close[index + 1]) : null;
  const return4h = complete ? directionalReturn(entry, dataset.close[index + 4]) : null;
  const return8h = complete ? directionalReturn(entry, dataset.close[index + 8]) : null;
  const excursion = complete
    ? Array.from({ length: HOLD_HOURS }, (_, offset) => index + 1 + offset)
    : [];
  return {
    asset: dataset.asset,
    variant,
    signalTime,
    month: new Date(signalTime).toISOString().slice(0, 7),
    rank,
    fold: Math.min(FOLD_COUNT - 1, Math.max(0, Math.floor(((signalTime - START) / (END - START)) * FOLD_COUNT))),
    complete,
    return1h,
    return4h,
    return8h,
    mfe8h: complete ? Math.max(...excursion.map((offset) => dataset.high[offset] / entry - 1)) : null,
    mae8h: complete ? Math.min(...excursion.map((offset) => dataset.low[offset] / entry - 1)) : null
  };
}

function summarize(samples) {
  const complete = samples.filter((sample) => sample.complete);
  const net4h = complete.map((sample) => sample.return4h - ROUND_TRIP_COST);
  const net8h = complete.map((sample) => sample.return8h - ROUND_TRIP_COST);
  const folds = Array.from({ length: FOLD_COUNT }, (_, index) => {
    const foldSamples = complete.filter((sample) => sample.fold === index);
    const foldNet4h = foldSamples.map((sample) => sample.return4h - ROUND_TRIP_COST);
    const averageNet4h = average(foldNet4h);
    return {
      fold: index + 1,
      signals: foldSamples.length,
      netExpectancy4h: averageNet4h,
      positive: Number.isFinite(averageNet4h) && averageNet4h > 0,
      assets: [...new Set(foldSamples.map((sample) => sample.asset))]
    };
  });
  const assetCounts = countBy(complete, (sample) => sample.asset);
  const monthlySignalCounts = countBy(samples, (sample) => sample.month);
  const assetEntries = Object.entries(assetCounts).sort((left, right) => right[1] - left[1]);
  const maxAsset = assetEntries[0]?.[0] || null;
  const maxAssetCount = assetEntries[0]?.[1] || 0;
  const maxAssetShare = complete.length ? maxAssetCount / complete.length : null;
  return {
    signals: samples.length,
    completeSignals: complete.length,
    signalsPerMonth: samples.length / MONTHS,
    positiveRate1h: positiveRate(complete.map((sample) => sample.return1h)),
    positiveRate4h: positiveRate(complete.map((sample) => sample.return4h)),
    positiveRate8h: positiveRate(complete.map((sample) => sample.return8h)),
    avgDirectionalReturn1h: average(complete.map((sample) => sample.return1h)),
    avgDirectionalReturn4h: average(complete.map((sample) => sample.return4h)),
    avgDirectionalReturn8h: average(complete.map((sample) => sample.return8h)),
    avgNetDirectionalReturn4h: average(net4h),
    avgNetDirectionalReturn8h: average(net8h),
    pf4h: profitFactor(net4h),
    pf8h: profitFactor(net8h),
    positiveFolds: folds.filter((fold) => fold.positive).length,
    negativeFolds: folds.filter((fold) => fold.signals > 0 && !fold.positive).length,
    mae8h: average(complete.map((sample) => sample.mae8h)),
    mfe8h: average(complete.map((sample) => sample.mfe8h)),
    maxAssetShare,
    assetConcentration: { maxAsset, maxAssetCount, maxAssetShare, assetCounts },
    monthlySignalCounts,
    folds
  };
}

function classifyExtension(summary) {
  const gates = {
    completeSignals: summary.completeSignals >= 30,
    signalsPerMonth: summary.signalsPerMonth >= 2,
    net4hPositive: finite(summary.avgNetDirectionalReturn4h) && summary.avgNetDirectionalReturn4h > 0,
    net8hPositive: finite(summary.avgNetDirectionalReturn8h) && summary.avgNetDirectionalReturn8h > 0,
    pf4hAtLeast110: finite(summary.pf4h) && summary.pf4h >= 1.10,
    pf8hAtLeast110: finite(summary.pf8h) && summary.pf8h >= 1.10,
    positiveFoldsAtLeast3Of5: summary.positiveFolds >= 3,
    maxAssetShareAtMost25Pct: finite(summary.maxAssetShare) && summary.maxAssetShare <= 0.25
  };
  const passed = Object.values(gates).every(Boolean);
  return {
    classification: passed ? "STRONG_OBSERVATION" : "SHADOW_OBSERVATION_ONLY",
    gates,
    reason: passed
      ? "固定 10–15% extension 满足全部预注册 promotion gates。"
      : "固定 10–15% extension 未满足全部预注册 promotion gates，fail closed 为 shadow only。"
  };
}

function finite(value) {
  return value !== null && value !== undefined && Number.isFinite(Number(value));
}

function directionalReturn(entry, exit) {
  return finite(entry) && Number(entry) > 0 && finite(exit) ? Number(exit) / Number(entry) - 1 : null;
}

function average(values) {
  const finiteValues = values.filter(Number.isFinite);
  return finiteValues.length
    ? finiteValues.reduce((sum, value) => sum + value, 0) / finiteValues.length
    : null;
}

function positiveRate(values) {
  const finiteValues = values.filter(Number.isFinite);
  return finiteValues.length
    ? finiteValues.filter((value) => value > 0).length / finiteValues.length
    : null;
}

function profitFactor(values) {
  const finiteValues = values.filter(Number.isFinite);
  const gains = finiteValues.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const losses = finiteValues.filter((value) => value < 0).reduce((sum, value) => sum + Math.abs(value), 0);
  return losses > 0 ? gains / losses : gains > 0 ? Infinity : null;
}

function countBy(values, keyFn) {
  return values.reduce((counts, value) => {
    const key = keyFn(value);
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
}
