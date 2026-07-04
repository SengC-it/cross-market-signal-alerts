import { writeFileSync } from "node:fs";
import { CONFIG } from "../lib/config.js";
import { getCryptoCandles, getFuturesCandles } from "../lib/market-data.js";
import { compareStrategyInversion, CRYPTO_STRATEGIES, FUTURES_STRATEGIES } from "../lib/strategies.js";

const options = parseArgs(process.argv.slice(2));
const startedAt = Date.now();
const report = {
  generatedAt: new Date().toISOString(),
  options,
  counts: {
    markets: options.markets.length,
    assets: 0,
    intervals: options.intervals.length,
    comparisons: 0,
    inverseCandidates: 0,
    inverseWatch: 0,
    warnings: 0
  },
  candidates: [],
  watch: [],
  comparisons: [],
  warnings: []
};

for (const market of options.markets) {
  const assets = selectAssets(market, options);
  const strategies = market === "spot" ? CRYPTO_STRATEGIES : FUTURES_STRATEGIES;
  const tradingCost = market === "spot" ? CONFIG.cryptoTradingCost : CONFIG.futuresTradingCost;
  const minTrades = market === "futures" && options.intervals.some((interval) => CONFIG.futuresScalpIntervals.includes(interval))
    ? CONFIG.futuresScalpMinTrades
    : CONFIG.minTrades;
  report.counts.assets += assets.length;

  for (const asset of assets) {
    for (const interval of options.intervals) {
      let candles;
      try {
        candles = market === "spot"
          ? await getCryptoCandles(asset, interval, options.limit)
          : await getFuturesCandles(asset, interval, options.limit);
      } catch (error) {
        report.warnings.push({
          market,
          asset,
          interval,
          warning: error instanceof Error ? error.message : String(error)
        });
        continue;
      }
      if (!Array.isArray(candles) || candles.length < 260) {
        report.warnings.push({
          market,
          asset,
          interval,
          warning: `insufficient candles: ${candles?.length ?? 0}`
        });
        continue;
      }

      for (const strategy of strategies) {
        const comparison = compareStrategyInversion({
          candles,
          strategy,
          interval,
          tradingCost,
          minTrades
        });
        const item = summarizeComparison({ market, asset, comparison });
        report.comparisons.push(item);
        if (comparison.recommendation === "inverse_candidate") report.candidates.push(item);
        if (comparison.recommendation === "inverse_watch") report.watch.push(item);
      }
    }
  }
}

report.comparisons.sort(sortByInverseEdge);
report.candidates.sort(sortByInverseEdge);
report.watch.sort(sortByInverseEdge);
report.counts.comparisons = report.comparisons.length;
report.counts.inverseCandidates = report.candidates.length;
report.counts.inverseWatch = report.watch.length;
report.counts.warnings = report.warnings.length;
report.elapsedMs = Date.now() - startedAt;

writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`);
printSummary(report);

function parseArgs(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = args[index + 1];
    if (next && !next.startsWith("--")) {
      values.set(key, next);
      index++;
    } else {
      values.set(key, "true");
    }
  }

  const market = values.get("market") || "futures";
  const markets = market === "all" ? ["spot", "futures"] : market.split(",").map((item) => item.trim()).filter(Boolean);
  return {
    markets,
    group: values.get("group") || "futures-core",
    assets: splitOption(values.get("assets")),
    intervals: splitOption(values.get("intervals") || "1h"),
    limit: Number(values.get("limit") || 1000),
    output: values.get("output") || "inverse_signal_report.json"
  };
}

function splitOption(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function selectAssets(market, options) {
  if (options.assets.length) return options.assets;
  if (CONFIG.scanGroups[options.group]?.length) return CONFIG.scanGroups[options.group];
  return market === "spot" ? CONFIG.cryptoAssets : CONFIG.futuresAssets;
}

function summarizeComparison({ market, asset, comparison }) {
  return {
    market,
    asset,
    interval: comparison.interval,
    strategyId: comparison.strategyId,
    strategyName: comparison.strategyName,
    originalDirection: comparison.direction,
    inverseDirection: comparison.inverseDirection,
    recommendation: comparison.recommendation,
    tradingCost: comparison.tradingCost,
    original: summarizePerformance(comparison.original),
    inverse: summarizePerformance(comparison.inverse),
    deltas: comparison.deltas
  };
}

function summarizePerformance(metrics) {
  if (!metrics) return null;
  return {
    trades: metrics.trades,
    winRate: metrics.winRate,
    totalReturn: metrics.totalReturn,
    cagr: metrics.cagr,
    averageReturn: metrics.averageReturn,
    profitFactor: metrics.profitFactor,
    maxDrawdown: metrics.maxDrawdown,
    outOfSample: metrics.outOfSample,
    recent: metrics.recent,
    sampleStart: metrics.sampleStart,
    sampleEnd: metrics.sampleEnd
  };
}

function sortByInverseEdge(a, b) {
  return (b.deltas?.outOfSampleTotalReturn ?? -Infinity) - (a.deltas?.outOfSampleTotalReturn ?? -Infinity);
}

function printSummary(summary) {
  console.log(`Inverse report written to ${summary.options.output}`);
  console.log(`Comparisons: ${summary.counts.comparisons}`);
  console.log(`Inverse candidates: ${summary.counts.inverseCandidates}`);
  console.log(`Inverse watch: ${summary.counts.inverseWatch}`);
  if (summary.counts.warnings) console.log(`Warnings: ${summary.counts.warnings}`);
  for (const item of summary.candidates.slice(0, 10)) {
    const originalReturn = formatPct(item.original?.totalReturn);
    const inverseReturn = formatPct(item.inverse?.totalReturn);
    const inverseOos = formatPct(item.inverse?.outOfSample?.totalReturn);
    console.log(`${item.market} ${item.asset} ${item.interval} ${item.strategyId}: original ${originalReturn}, inverse ${inverseReturn}, inverse OOS ${inverseOos}`);
  }
}

function formatPct(value) {
  if (!Number.isFinite(value)) return "N/A";
  return `${(value * 100).toFixed(2)}%`;
}
