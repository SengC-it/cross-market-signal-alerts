import fs from "node:fs";
import path from "node:path";
import { atr } from "../lib/indicators.js";

const ROOT = process.cwd();
const CACHE_DIR = path.join(ROOT, ".backtest-cache", "binance-futures-1h");
const OUTPUT = path.join(ROOT, "historical_model_comparison_2026-07-25.json");
const HOUR = 3_600_000;
const BASE_COST = 0.0012;
const COSTS = [BASE_COST, BASE_COST * 2, BASE_COST * 3];
const NEW_PLAN = {
  stopAtrMultiplier: 2.08,
  minStopPct: 0.0078,
  fallbackStopPct: 0.0234,
  rewardRiskRatio: 1.5,
  maxHoldingHours: 24,
  riskPerTrade: 0.0025,
  maxOpenPositions: 2,
  familyWindow: 80,
  familyMinTrades: 30,
  confidenceZ: 1.96
};

const datasets = [
  {
    id: "long_history",
    source: "production_dynamic_backtest.json",
    oldModel: "fixed_8h",
    splitTime: Date.parse("2025-01-01T00:00:00Z"),
    splitLabel: "2023-2024 calibration / 2025-2026H1 forward"
  },
  {
    id: "production_like_2026h1",
    source: "production_dynamic_email_backtest_latest_tp_sl_only_2026-01_06.json",
    oldModel: "email_tp_sl",
    splitTime: Date.parse("2026-04-01T00:00:00Z"),
    splitLabel: "2026Q1 calibration / 2026Q2 diagnostic forward"
  }
];

const candleCache = new Map();

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, file), "utf8"));
}

function loadCandles(symbol) {
  if (candleCache.has(symbol)) return candleCache.get(symbol);
  const files = fs.readdirSync(CACHE_DIR)
    .filter((name) => name.startsWith(`${symbol}-`) && name.endsWith(".json"));

  if (!files.length) {
    candleCache.set(symbol, []);
    return [];
  }

  const byTime = new Map();
  for (const file of files) {
    const rows = readJson(path.join(".backtest-cache", "binance-futures-1h", file));
    for (const row of rows) {
      const candle = Array.isArray(row)
        ? {
            openTime: Number(row[0]),
            open: Number(row[1]),
            high: Number(row[2]),
            low: Number(row[3]),
            close: Number(row[4])
          }
        : {
            openTime: Number(row.openTime),
            open: Number(row.open),
            high: Number(row.high),
            low: Number(row.low),
            close: Number(row.close)
          };
      byTime.set(candle.openTime, candle);
    }
  }
  const candles = [...byTime.values()].sort((a, b) => a.openTime - b.openTime);
  candleCache.set(symbol, candles);
  return candles;
}

function replayNewPlan(signal) {
  const candles = loadCandles(signal.symbol);
  const entryTime = Number(signal.entryTime);
  const entry = Number(signal.entry);
  const entryIndex = candles.findIndex((candle) => candle.openTime === entryTime);
  if (entryIndex < 14 || !Number.isFinite(entry) || entry <= 0) return null;

  const currentAtr = atr(candles, 14, entryIndex);
  const stopDistance = Number.isFinite(currentAtr)
    ? Math.max(currentAtr * NEW_PLAN.stopAtrMultiplier, entry * NEW_PLAN.minStopPct)
    : entry * NEW_PLAN.fallbackStopPct;
  const stopPct = stopDistance / entry;
  const isShort = signal.side === "short";
  const stopLoss = isShort ? entry + stopDistance : entry - stopDistance;
  const takeProfit = isShort
    ? entry - stopDistance * NEW_PLAN.rewardRiskRatio
    : entry + stopDistance * NEW_PLAN.rewardRiskRatio;
  const timeStopAt = entryTime + NEW_PLAN.maxHoldingHours * HOUR;

  for (let index = entryIndex + 1; index < candles.length; index++) {
    const candle = candles[index];
    const hitStop = isShort ? candle.high >= stopLoss : candle.low <= stopLoss;
    const hitTarget = isShort ? candle.low <= takeProfit : candle.high >= takeProfit;
    if (hitStop) {
      const gapExit = isShort ? Math.max(candle.open, stopLoss) : Math.min(candle.open, stopLoss);
      return completedTrade(signal, gapExit, candle.openTime, "stop_loss", stopPct);
    }
    if (hitTarget) return completedTrade(signal, takeProfit, candle.openTime, "take_profit", stopPct);
    if (candle.openTime + HOUR >= timeStopAt) {
      return completedTrade(signal, candle.close, candle.openTime, "time_stop", stopPct);
    }
  }
  return null;
}

function completedTrade(signal, exit, exitTime, outcome, stopPct) {
  const isShort = signal.side === "short";
  const rawMove = exit / signal.entry - 1;
  return {
    symbol: signal.symbol,
    side: signal.side,
    entryTime: Number(signal.entryTime),
    exitTime,
    entry: Number(signal.entry),
    exit,
    outcome,
    stopPct,
    rawReturn: isShort ? -rawMove : rawMove
  };
}

function normalizeOldTrades(data, oldModel) {
  return (data.trades || []).flatMap((trade) => {
    if (oldModel !== "fixed_8h" && trade.rawReturn == null) return [];
    const rawReturn = oldModel === "fixed_8h"
      ? Number(trade.netReturn) + BASE_COST
      : Number(trade.rawReturn);
    if (!Number.isFinite(rawReturn)) return [];
    return [{
      symbol: trade.symbol,
      side: trade.side,
      entryTime: Number(trade.entryTime),
      exitTime: Number(trade.exitTime) || Number(trade.entryTime) + 8 * HOUR,
      outcome: trade.outcome || "fixed_8h",
      stopPct: Number(trade.executionPlan?.stopPct) || 0.03,
      rawReturn
    }];
  });
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function familyGate(priorTrades, cost) {
  const values = priorTrades.slice(-NEW_PLAN.familyWindow).map((trade) => trade.rawReturn - cost);
  if (values.length < NEW_PLAN.familyMinTrades) return { passed: false, state: "PAPER" };
  const average = mean(values);
  const variance = values.length > 1
    ? values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1)
    : 0;
  const lowerConfidenceBound = average - NEW_PLAN.confidenceZ * Math.sqrt(variance / values.length);
  return {
    passed: average > 0 && lowerConfidenceBound > 0,
    state: average <= 0 ? "HALTED" : lowerConfidenceBound <= 0 ? "PAPER" : "LIVE",
    average,
    lowerConfidenceBound
  };
}

function selectWithPortfolio(trades, cost, useGate) {
  const ordered = [...trades].sort((a, b) => a.entryTime - b.entryTime);
  const selected = [];
  const paperCompleted = [];
  let active = [];
  let gatePassedCandidates = 0;

  for (const trade of ordered) {
    for (const prior of ordered) {
      if (prior.exitTime < trade.entryTime && !paperCompleted.includes(prior)) paperCompleted.push(prior);
    }
    paperCompleted.sort((a, b) => a.exitTime - b.exitTime);
    const gate = useGate ? familyGate(paperCompleted, cost) : { passed: true, state: "LIVE" };
    if (!gate.passed) continue;
    gatePassedCandidates++;

    active = active.filter((position) => position.exitTime >= trade.entryTime);
    if (active.length >= NEW_PLAN.maxOpenPositions) continue;
    const sameSideRisk = active
      .filter((position) => position.side === trade.side)
      .reduce((sum, position) => sum + position.risk, 0);
    if (sameSideRisk + NEW_PLAN.riskPerTrade > 0.005) continue;

    const positionFraction = Math.min(1, NEW_PLAN.riskPerTrade / Math.max(trade.stopPct, 0.0001));
    const accountReturn = positionFraction * (trade.rawReturn - cost);
    const selectedTrade = {
      ...trade,
      risk: NEW_PLAN.riskPerTrade,
      positionFraction,
      accountReturn
    };
    selected.push(selectedTrade);
    active.push(selectedTrade);
  }
  return { selected, gatePassedCandidates };
}

function edgeSummary(trades, cost) {
  const returns = trades.map((trade) => trade.rawReturn - cost).filter(Number.isFinite);
  if (!returns.length) return emptySummary();
  const gains = returns.filter((value) => value > 0);
  const losses = returns.filter((value) => value <= 0);
  const averageNetReturn = mean(returns);
  const variance = returns.length > 1
    ? returns.reduce((sum, value) => sum + (value - averageNetReturn) ** 2, 0) / (returns.length - 1)
    : 0;
  return {
    trades: returns.length,
    winRate: gains.length / returns.length,
    averageNetReturn,
    lowerConfidenceBound95: averageNetReturn - 1.96 * Math.sqrt(variance / returns.length),
    sumNetReturn: returns.reduce((sum, value) => sum + value, 0),
    profitFactor: losses.length
      ? gains.reduce((sum, value) => sum + value, 0) / Math.abs(losses.reduce((sum, value) => sum + value, 0))
      : null
  };
}

function portfolioSummary(trades) {
  const ordered = [...trades].sort((a, b) => a.exitTime - b.exitTime);
  if (!ordered.length) return { ...emptySummary(), totalReturn: 0, maxDrawdown: 0 };
  let equity = 1;
  let peak = 1;
  let maxDrawdown = 0;
  let wins = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  for (const trade of ordered) {
    equity *= 1 + trade.accountReturn;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.min(maxDrawdown, equity / peak - 1);
    if (trade.accountReturn > 0) {
      wins++;
      grossProfit += trade.accountReturn;
    } else {
      grossLoss += trade.accountReturn;
    }
  }
  return {
    trades: ordered.length,
    winRate: wins / ordered.length,
    averageAccountReturn: mean(ordered.map((trade) => trade.accountReturn)),
    totalReturn: equity - 1,
    maxDrawdown,
    profitFactor: grossLoss < 0 ? grossProfit / Math.abs(grossLoss) : null
  };
}

function emptySummary() {
  return {
    trades: 0,
    winRate: null,
    averageNetReturn: null,
    lowerConfidenceBound95: null,
    sumNetReturn: 0,
    profitFactor: null
  };
}

function periodSummary(trades, cost, splitTime, useGate) {
  const allocation = selectWithPortfolio(trades, cost, useGate);
  const before = trades.filter((trade) => trade.entryTime < splitTime);
  const after = trades.filter((trade) => trade.entryTime >= splitTime);
  const selectedBefore = allocation.selected.filter((trade) => trade.entryTime < splitTime);
  const selectedAfter = allocation.selected.filter((trade) => trade.entryTime >= splitTime);
  return {
    tradeEdge: {
      all: edgeSummary(trades, cost),
      beforeSplit: edgeSummary(before, cost),
      afterSplit: edgeSummary(after, cost),
      byMonth: Object.fromEntries([...new Set(trades.map((trade) => monthKey(trade.entryTime)))].sort().map((month) => [
        month,
        edgeSummary(trades.filter((trade) => monthKey(trade.entryTime) === month), cost)
      ]))
    },
    portfolio: {
      all: portfolioSummary(allocation.selected),
      beforeSplit: portfolioSummary(selectedBefore),
      afterSplit: portfolioSummary(selectedAfter)
    },
    gatePassedCandidates: allocation.gatePassedCandidates
  };
}

function monthKey(time) {
  return new Date(time).toISOString().slice(0, 7);
}

function evaluateDataset(spec) {
  const data = readJson(spec.source);
  const signals = data.trades || [];
  const oldTrades = normalizeOldTrades(data, spec.oldModel);
  const newTrades = signals.map(replayNewPlan).filter(Boolean);
  return {
    source: spec.source,
    splitTime: new Date(spec.splitTime).toISOString(),
    splitLabel: spec.splitLabel,
    sourceSignals: signals.length,
    replayedNewTrades: newTrades.length,
    unresolvedNewTrades: signals.length - newTrades.length,
    costs: Object.fromEntries(COSTS.map((cost) => [
      `${Math.round(cost / BASE_COST)}x`,
      {
        roundTripCost: cost,
        old: periodSummary(oldTrades, cost, spec.splitTime, false),
        newUngated: periodSummary(newTrades, cost, spec.splitTime, false),
        newGated: periodSummary(newTrades, cost, spec.splitTime, true)
      }
    ]))
  };
}

const result = {
  generatedAt: new Date().toISOString(),
  purpose: "Compare the old signal model with trade_plan_v2 and the walk-forward family gate using only information available before each signal.",
  assumptions: {
    sharedSignals: "The comparison isolates exit/risk/gating effects by replaying the same historical signal events.",
    unavailable: [
      "Point-in-time delisted contract universe",
      "Historical order-book depth and spread",
      "Actual account fee tier, fills, funding payments and liquidation state",
      "Historical 50m USDT universe filter for every signal"
    ],
    oldPortfolioStopProxy: "Fixed-8h old trades use a 3% stop proxy only for account-risk sizing.",
    sameCandleCollision: "Conservative: stop is counted before target.",
    noLookAheadGate: "The family gate uses only paper trades whose exitTime is earlier than the next signal entryTime.",
    newPlan: NEW_PLAN
  },
  datasets: Object.fromEntries(datasets.map((dataset) => [dataset.id, evaluateDataset(dataset)]))
};

fs.writeFileSync(OUTPUT, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({
  output: path.basename(OUTPUT),
  datasets: Object.fromEntries(Object.entries(result.datasets).map(([key, value]) => [
    key,
    {
      sourceSignals: value.sourceSignals,
      replayedNewTrades: value.replayedNewTrades,
      oneX: value.costs["1x"]
    }
  ]))
}, null, 2));
