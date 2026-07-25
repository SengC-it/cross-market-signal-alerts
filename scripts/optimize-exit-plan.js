import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const SOURCE_FILE = process.env.SOURCE_FILE || "production_dynamic_email_backtest_refined_tp_sl_only_2026-01_06.json";
const CACHE_DIR = path.join(ROOT, ".backtest-cache", "binance-futures-1h");
const COST = 0.0012;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

const candleCache = new Map();

function loadCandles(symbol) {
  if (candleCache.has(symbol)) return candleCache.get(symbol);
  const files = fs.existsSync(CACHE_DIR)
    ? fs.readdirSync(CACHE_DIR).filter((name) => name.startsWith(`${symbol}-`) && name.endsWith(".json"))
    : [];
  const byTime = new Map();
  for (const file of files) {
    for (const row of readJson(path.join(CACHE_DIR, file))) {
      const candle = Array.isArray(row)
        ? { openTime: Number(row[0]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]) }
        : { openTime: Number(row.openTime), high: Number(row.high), low: Number(row.low), close: Number(row.close) };
      if (Number.isFinite(candle.openTime)) byTime.set(candle.openTime, candle);
    }
  }
  const candles = [...byTime.values()].sort((a, b) => a.openTime - b.openTime);
  candleCache.set(symbol, candles);
  return candles;
}

function passesRecommendedSignalFilter(trade) {
  if (trade.side === "long") {
    return trade.recommendationScore >= 87;
  }
  return trade.momentum24h >= -0.10;
}

function replay(trade, { stopScale, rr }) {
  const entry = Number(trade.entry);
  const isShort = trade.side === "short";
  const baseStopDistance = Math.abs(Number(trade.executionPlan.stopLoss) - entry);
  const stopDistance = baseStopDistance * stopScale;
  const stopLoss = isShort ? entry + stopDistance : entry - stopDistance;
  const takeProfit = isShort ? entry - stopDistance * rr : entry + stopDistance * rr;
  const candles = loadCandles(trade.symbol).filter((candle) => candle.openTime > trade.entryTime);

  for (const candle of candles) {
    const hitStop = isShort ? candle.high >= stopLoss : candle.low <= stopLoss;
    const hitTarget = isShort ? candle.low <= takeProfit : candle.high >= takeProfit;
    if (hitStop) {
      const rawReturn = isShort ? -(stopLoss / entry - 1) : stopLoss / entry - 1;
      return { ...trade, outcome: "stop_loss", exitTime: candle.openTime, netReturn: rawReturn - COST };
    }
    if (hitTarget) {
      const rawReturn = isShort ? -(takeProfit / entry - 1) : takeProfit / entry - 1;
      return { ...trade, outcome: "take_profit", exitTime: candle.openTime, netReturn: rawReturn - COST };
    }
  }
  return { ...trade, outcome: "open_unresolved", exitTime: null, netReturn: null };
}

function compound(returns) {
  return returns.reduce((value, item) => value * (1 + item), 1) - 1;
}

function maxDrawdown(returns) {
  let equity = 1;
  let peak = 1;
  let maxDd = 0;
  for (const item of returns) {
    equity *= 1 + item;
    peak = Math.max(peak, equity);
    maxDd = Math.min(maxDd, equity / peak - 1);
  }
  return maxDd;
}

function summarize(trades) {
  const closed = trades.filter((trade) => trade.outcome !== "open_unresolved");
  const returns = closed.map((trade) => trade.netReturn);
  const wins = closed.filter((trade) => trade.netReturn > 0);
  const grossProfit = closed.filter((trade) => trade.netReturn > 0).reduce((sum, trade) => sum + trade.netReturn, 0);
  const grossLoss = closed.filter((trade) => trade.netReturn <= 0).reduce((sum, trade) => sum + trade.netReturn, 0);
  return {
    signals: trades.length,
    closed: closed.length,
    open: trades.length - closed.length,
    takeProfit: closed.filter((trade) => trade.outcome === "take_profit").length,
    stopLoss: closed.filter((trade) => trade.outcome === "stop_loss").length,
    winRate: closed.length ? wins.length / closed.length : 0,
    avg: closed.length ? returns.reduce((sum, item) => sum + item, 0) / closed.length : 0,
    gross: returns.reduce((sum, item) => sum + item, 0),
    compound: compound(returns),
    pf: grossLoss < 0 ? grossProfit / Math.abs(grossLoss) : null,
    maxDd: maxDrawdown(returns),
  };
}

function groupByMonth(trades) {
  const months = [...new Set(trades.map((trade) => trade.month))].sort();
  return Object.fromEntries(months.map((month) => [month, summarize(trades.filter((trade) => trade.month === month))]));
}

const source = readJson(path.join(ROOT, SOURCE_FILE));
const allSignals = source.trades.sort((a, b) => a.entryTime - b.entryTime);
const recommendedSignals = allSignals.filter(passesRecommendedSignalFilter);

const stopScales = [0.75, 0.85, 1, 1.15, 1.3];
const rewardRiskRatios = [1.2, 1.5, 1.8, 2.0, 2.2, 2.5, 3.0];
const cohorts = [
  ["current_240", allSignals],
  ["recommended_signal_filter", recommendedSignals],
];

const results = [];
for (const [cohort, signals] of cohorts) {
  for (const stopScale of stopScales) {
    for (const rr of rewardRiskRatios) {
      const trades = signals.map((trade) => replay(trade, { stopScale, rr }));
      const summary = summarize(trades);
      const months = groupByMonth(trades);
      const negativeMonths = Object.values(months).filter((item) => item.compound < 0).length;
      const worstMonth = Math.min(...Object.values(months).map((item) => item.compound));
      results.push({ cohort, stopScale, rr, summary, months, negativeMonths, worstMonth });
    }
  }
}

const ranked = results.sort((a, b) => {
  const scoreA = a.summary.compound - Math.abs(a.summary.maxDd) * 1.2 - a.negativeMonths * 0.35 + a.summary.pf * 0.15;
  const scoreB = b.summary.compound - Math.abs(b.summary.maxDd) * 1.2 - b.negativeMonths * 0.35 + b.summary.pf * 0.15;
  return scoreB - scoreA;
});

const output = {
  source: SOURCE_FILE,
  baseline: source.summary,
  cohorts: Object.fromEntries(cohorts.map(([name, signals]) => [name, signals.length])),
  top: ranked.slice(0, 12),
  currentExitByCohort: results.filter((item) => item.stopScale === 1 && item.rr === 1.8),
};

fs.writeFileSync(path.join(ROOT, "exit_plan_optimization_2026h1.json"), `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify(output, null, 2));
