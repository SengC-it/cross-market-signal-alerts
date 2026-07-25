import fs from "node:fs";
import path from "node:path";

const COST = 0.0012;
const ROOT = process.cwd();
const SIGNAL_GLOB_PREFIX = process.env.SIGNAL_PREFIX || "production_dynamic_email_backtest_refined_sl_tp_2026-";
const SOURCE_FILE = process.env.SOURCE_FILE || "";
const CACHE_DIR = path.join(ROOT, ".backtest-cache", "binance-futures-1h");
const OUTPUT_FILE = process.env.OUTPUT_FILE || "production_dynamic_email_backtest_refined_tp_sl_only_2026-01_06.json";

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function monthFromFile(file) {
  const match = file.match(/(2026-\d{2})/);
  return match ? match[1] : "unknown";
}

function loadSignals() {
  if (SOURCE_FILE) {
    const data = readJson(path.join(ROOT, SOURCE_FILE));
    const sourceMonth = monthFromFile(SOURCE_FILE);
    return data.trades.map((trade) => ({
      ...trade,
      month: trade.month || sourceMonth,
      sourceFile: SOURCE_FILE,
    }));
  }

  return fs
    .readdirSync(ROOT)
    .filter((name) => name.startsWith(SIGNAL_GLOB_PREFIX) && name.endsWith(".json"))
    .sort()
    .flatMap((name) => {
      const month = monthFromFile(name);
      const data = readJson(path.join(ROOT, name));
      return data.trades.map((trade) => ({ ...trade, month, sourceFile: name }));
    });
}

const candleCache = new Map();

function loadCandles(symbol) {
  if (candleCache.has(symbol)) return candleCache.get(symbol);

  const files = fs
    .readdirSync(CACHE_DIR)
    .filter((name) => name.startsWith(`${symbol}-`) && name.endsWith(".json"));

  const byTime = new Map();
  for (const file of files) {
    for (const row of readJson(path.join(CACHE_DIR, file))) {
      const candle = Array.isArray(row)
        ? {
            openTime: Number(row[0]),
            open: Number(row[1]),
            high: Number(row[2]),
            low: Number(row[3]),
            close: Number(row[4]),
          }
        : {
            openTime: Number(row.openTime),
            open: Number(row.open),
            high: Number(row.high),
            low: Number(row.low),
            close: Number(row.close),
          };
      if (Number.isFinite(candle.openTime)) byTime.set(candle.openTime, candle);
    }
  }

  const candles = [...byTime.values()].sort((a, b) => a.openTime - b.openTime);
  candleCache.set(symbol, candles);
  return candles;
}

function replayTrade(trade) {
  const candles = loadCandles(trade.symbol).filter((candle) => candle.openTime > trade.entryTime);
  const isShort = trade.side === "short";
  const stopLoss = Number(trade.executionPlan.stopLoss);
  const takeProfit = Number(trade.executionPlan.takeProfit);
  const entry = Number(trade.entry);

  for (const candle of candles) {
    const hitStop = isShort ? candle.high >= stopLoss : candle.low <= stopLoss;
    const hitTarget = isShort ? candle.low <= takeProfit : candle.high >= takeProfit;

    if (hitStop) {
      const rawReturn = isShort ? -(stopLoss / entry - 1) : stopLoss / entry - 1;
      return {
        ...trade,
        oldOutcome: trade.outcome,
        oldExit: trade.exit,
        oldExitTime: trade.exitTime,
        outcome: "stop_loss",
        exit: stopLoss,
        exitTime: candle.openTime,
        holdHours: (candle.openTime - trade.entryTime) / 3600000,
        rawReturn,
        netReturn: rawReturn - COST,
      };
    }

    if (hitTarget) {
      const rawReturn = isShort ? -(takeProfit / entry - 1) : takeProfit / entry - 1;
      return {
        ...trade,
        oldOutcome: trade.outcome,
        oldExit: trade.exit,
        oldExitTime: trade.exitTime,
        outcome: "take_profit",
        exit: takeProfit,
        exitTime: candle.openTime,
        holdHours: (candle.openTime - trade.entryTime) / 3600000,
        rawReturn,
        netReturn: rawReturn - COST,
      };
    }
  }

  const last = candles.at(-1);
  const markRawReturn = last
    ? isShort
      ? -(last.close / entry - 1)
      : last.close / entry - 1
    : null;

  return {
    ...trade,
    oldOutcome: trade.outcome,
    oldExit: trade.exit,
    oldExitTime: trade.exitTime,
    outcome: "open_unresolved",
    exit: null,
    exitTime: null,
    holdHours: last ? (last.openTime - trade.entryTime) / 3600000 : null,
    rawReturn: null,
    netReturn: null,
    markClose: last?.close ?? null,
    markTime: last?.openTime ?? null,
    markRawReturn,
    markNetReturn: markRawReturn == null ? null : markRawReturn - COST,
  };
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
  const avgHoldHours = closed.length
    ? closed.reduce((sum, trade) => sum + trade.holdHours, 0) / closed.length
    : 0;
  const markReturns = trades.map((trade) => trade.netReturn ?? trade.markNetReturn).filter((item) => item != null);

  return {
    signals: trades.length,
    closed: closed.length,
    openUnresolved: trades.length - closed.length,
    takeProfit: closed.filter((trade) => trade.outcome === "take_profit").length,
    stopLoss: closed.filter((trade) => trade.outcome === "stop_loss").length,
    winRate: closed.length ? wins.length / closed.length : 0,
    avgNetReturn: closed.length ? returns.reduce((sum, item) => sum + item, 0) / closed.length : 0,
    grossNetReturn: returns.reduce((sum, item) => sum + item, 0),
    compoundNetReturn: compound(returns),
    profitFactor: grossLoss < 0 ? grossProfit / Math.abs(grossLoss) : null,
    maxDrawdown: maxDrawdown(returns),
    avgHoldHours,
    markToMarketCompoundNetReturn: compound(markReturns),
  };
}

function groupBy(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return Object.fromEntries([...map.entries()].map(([key, values]) => [key, summarize(values)]));
}

const trades = loadSignals().map(replayTrade);
const result = {
  generatedAt: new Date().toISOString(),
  sourceSignalPrefix: SIGNAL_GLOB_PREFIX,
  assumptions: {
    exit: "No manual or expiry exit. Replay every email signal until the first email stop-loss or take-profit is touched by later 1h futures candles.",
    sameCandleCollision: "Conservative: stop-loss is counted before take-profit when both are touched inside the same 1h candle.",
    tradingCostRoundTrip: COST,
    unresolved: "Signals with no stop-loss or take-profit touch before cached data ends are excluded from realized returns and reported separately.",
  },
  summary: summarize(trades),
  byMonth: groupBy(trades, (trade) => trade.month),
  bySide: groupBy(trades, (trade) => trade.side),
  byOldOutcome: groupBy(trades, (trade) => trade.oldOutcome),
  trades,
};

fs.writeFileSync(path.join(ROOT, OUTPUT_FILE), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ output: OUTPUT_FILE, summary: result.summary, byMonth: result.byMonth, bySide: result.bySide }, null, 2));
