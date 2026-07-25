import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const SOURCE_FILE = process.env.SOURCE_FILE || "production_dynamic_email_backtest_latest_tp_sl_only_2026-01_06.json";
const CACHE_DIR = path.join(ROOT, ".backtest-cache", "binance-futures-1h");
const COST = 0.0012;
const MIN_SIGNALS = Number(process.env.MIN_SIGNALS || 100);

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

function pass(trade, cfg) {
  if (trade.side === "long") {
    return (
      trade.momentum24h >= 0.08 &&
      trade.momentum24h <= 0.10 &&
      trade.relative >= cfg.longRelMin &&
      trade.volumeMultiple >= 1.5 &&
      trade.volumeMultiple <= cfg.longVolMax &&
      trade.recommendationScore >= cfg.longScoreMin
    );
  }
  return (
    trade.momentum24h >= cfg.shortMomMin &&
    trade.momentum24h <= -0.08 &&
    trade.relative <= -0.03 &&
    trade.volumeMultiple >= cfg.shortVolMin &&
    trade.volumeMultiple <= cfg.shortVolMax &&
    trade.recommendationScore >= cfg.shortScoreMin
  );
}

function replay(trade, exitCfg) {
  const entry = Number(trade.entry);
  const isShort = trade.side === "short";
  const baseStopDistance = Math.abs(Number(trade.executionPlan.stopLoss) - entry);
  const stopDistance = baseStopDistance * exitCfg.stopScale;
  const stopLoss = isShort ? entry + stopDistance : entry - stopDistance;
  const takeProfit = isShort ? entry - stopDistance * exitCfg.rr : entry + stopDistance * exitCfg.rr;
  const candles = loadCandles(trade.symbol).filter((candle) => candle.openTime > trade.entryTime);

  for (const candle of candles) {
    const hitStop = isShort ? candle.high >= stopLoss : candle.low <= stopLoss;
    const hitTarget = isShort ? candle.low <= takeProfit : candle.high >= takeProfit;
    if (hitStop) {
      const rawReturn = isShort ? -(stopLoss / entry - 1) : stopLoss / entry - 1;
      return { ...trade, outcome: "stop_loss", netReturn: rawReturn - COST };
    }
    if (hitTarget) {
      const rawReturn = isShort ? -(takeProfit / entry - 1) : takeProfit / entry - 1;
      return { ...trade, outcome: "take_profit", netReturn: rawReturn - COST };
    }
  }
  return { ...trade, outcome: "open_unresolved", netReturn: null };
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

function monthly(trades) {
  const months = [...new Set(trades.map((trade) => trade.month))].sort();
  return Object.fromEntries(months.map((month) => [month, summarize(trades.filter((trade) => trade.month === month))]));
}

const source = readJson(path.join(ROOT, SOURCE_FILE));
const allTrades = source.trades.sort((a, b) => a.entryTime - b.entryTime);

const signalConfigs = [];
for (const longRelMin of [0.08, 0.10, 0.12, 0.14, 0.16]) {
  for (const longVolMax of [1.8, 2.0]) {
    for (const longScoreMin of [85, 87, 89]) {
      for (const shortMomMin of [-0.13, -0.12, -0.11, -0.10]) {
        for (const shortVolMin of [2.75, 3.0, 3.25]) {
          for (const shortVolMax of [3.25, 3.5]) {
            for (const shortScoreMin of [85, 87]) {
              signalConfigs.push({ longRelMin, longVolMax, longScoreMin, shortMomMin, shortVolMin, shortVolMax, shortScoreMin });
            }
          }
        }
      }
    }
  }
}

const exitConfigs = [];
for (const stopScale of [0.75, 0.85, 1, 1.15, 1.3]) {
  for (const rr of [1.2, 1.5, 1.8, 2.0, 2.2, 2.5, 3.0]) {
    exitConfigs.push({ stopScale, rr });
  }
}

const results = [];
for (const signalCfg of signalConfigs) {
  const selected = allTrades.filter((trade) => pass(trade, signalCfg));
  if (selected.length < MIN_SIGNALS) continue;
  for (const exitCfg of exitConfigs) {
    const trades = selected.map((trade) => replay(trade, exitCfg));
    const summary = summarize(trades);
    const months = monthly(trades);
    const monthValues = Object.values(months);
    const negativeMonths = monthValues.filter((item) => item.compound < 0).length;
    const worstMonth = Math.min(...monthValues.map((item) => item.compound));
    results.push({ signalCfg, exitCfg, summary, months, negativeMonths, worstMonth });
  }
}

const rank = (items, predicate) => items
  .filter(predicate)
  .sort((a, b) => b.summary.compound - a.summary.compound);

const output = {
  source: SOURCE_FILE,
  minSignals: MIN_SIGNALS,
  evaluated: results.length,
  maxProfit: rank(results, (item) => item.summary.closed >= MIN_SIGNALS).slice(0, 10),
  maxProfitWithNoNegativeMonths: rank(results, (item) => item.negativeMonths === 0 && item.summary.closed >= MIN_SIGNALS).slice(0, 10),
  maxProfitWithDrawdown30: rank(results, (item) => item.summary.maxDd >= -0.30 && item.summary.closed >= MIN_SIGNALS).slice(0, 10),
  maxProfitWithNoNegativeMonthsAndDrawdown30: rank(
    results,
    (item) => item.negativeMonths === 0 && item.summary.maxDd >= -0.30 && item.summary.closed >= MIN_SIGNALS,
  ).slice(0, 10),
};

fs.writeFileSync(path.join(ROOT, "combined_strategy_optimization_2026h1.json"), `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify(output, null, 2));
