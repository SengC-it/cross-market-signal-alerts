import { readFile, writeFile } from "node:fs/promises";

const BASE_RISK = Number(process.env.TIERED_BASE_RISK || 0.0025);
const TACTICAL_RISK_MULTIPLIER = Number(process.env.TIERED_TACTICAL_RISK_MULTIPLIER || 0.35);
const MAX_OPEN_POSITIONS = Number(process.env.TIERED_MAX_OPEN_POSITIONS || 2);
const MAX_SAME_SIDE_RISK = Number(process.env.TIERED_MAX_SAME_SIDE_RISK || 0.005);
const OUTPUT_FILE = process.env.TIERED_OUTPUT_FILE || "tiered_dynamic_backtest_2026-01_06.json";

const LATEST_FILE = "production_dynamic_email_backtest_latest_tp_sl_only_2026-01_06.json";
const REFINED_FILE = "production_dynamic_email_backtest_refined_tp_sl_only_2026-01_06.json";

function signalKey(trade) {
  return [trade.symbol, trade.side, trade.entryTime].join("|");
}

function monthKey(time) {
  return new Date(Number(time)).toISOString().slice(0, 7);
}

function loadTrades(file) {
  return readFile(file, "utf8").then((raw) => {
    const data = JSON.parse(raw);
    return (data.trades || []).filter((trade) => (
      trade.outcome !== "open_unresolved"
      && Number.isFinite(Number(trade.entryTime))
      && Number.isFinite(Number(trade.exitTime))
      && Number.isFinite(Number(trade.netReturn))
      && Number.isFinite(Number(trade.executionPlan?.stopPct))
      && Number(trade.executionPlan.stopPct) > 0
    ));
  });
}

function edgeSummary(trades) {
  const returns = trades.map((trade) => Number(trade.netReturn)).filter(Number.isFinite);
  const gains = returns.filter((value) => value > 0);
  const losses = returns.filter((value) => value <= 0);
  return {
    signals: returns.length,
    winRate: returns.length ? gains.length / returns.length : null,
    averageNetReturn: returns.length ? returns.reduce((sum, value) => sum + value, 0) / returns.length : null,
    profitFactor: losses.length
      ? gains.reduce((sum, value) => sum + value, 0) / Math.abs(losses.reduce((sum, value) => sum + value, 0))
      : null
  };
}

function portfolioSummary(selected, inputSignals) {
  const ordered = [...selected].sort((a, b) => a.exitTime - b.exitTime || a.entryTime - b.entryTime);
  let equity = 1;
  let peak = 1;
  let maxDrawdown = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  for (const trade of ordered) {
    equity *= 1 + trade.accountReturn;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.min(maxDrawdown, equity / peak - 1);
    if (trade.accountReturn > 0) grossProfit += trade.accountReturn;
    else grossLoss += trade.accountReturn;
  }

  const counts = Object.fromEntries(
    [...new Set(inputSignals.map((trade) => monthKey(trade.entryTime)))].sort().map((month) => [
      month,
      inputSignals.filter((trade) => monthKey(trade.entryTime) === month).length
    ])
  );

  return {
    inputSignals: inputSignals.length,
    selectedTrades: ordered.length,
    signalCountByMonth: counts,
    minMonthlySignals: Math.min(...Object.values(counts)),
    maxMonthlySignals: Math.max(...Object.values(counts)),
    averageMonthlySignals: inputSignals.length / Math.max(1, Object.keys(counts).length),
    winRate: ordered.length ? ordered.filter((trade) => trade.accountReturn > 0).length / ordered.length : null,
    averageAccountReturn: ordered.length
      ? ordered.reduce((sum, trade) => sum + trade.accountReturn, 0) / ordered.length
      : null,
    totalReturn: equity - 1,
    maxDrawdown,
    profitFactor: grossLoss < 0 ? grossProfit / Math.abs(grossLoss) : null
  };
}

function selectPortfolio(trades, riskMultiplier) {
  const ordered = [...trades].sort((a, b) => a.entryTime - b.entryTime || a.exitTime - b.exitTime);
  const selected = [];
  let active = [];
  for (const trade of ordered) {
    active = active.filter((position) => position.exitTime >= trade.entryTime);
    const riskBudget = BASE_RISK * riskMultiplier;
    const sameSideRisk = active
      .filter((position) => position.side === trade.side)
      .reduce((sum, position) => sum + position.riskBudget, 0);
    if (active.length >= MAX_OPEN_POSITIONS || sameSideRisk + riskBudget > MAX_SAME_SIDE_RISK) continue;

    const stopPct = Number(trade.executionPlan.stopPct);
    const positionFraction = Math.min(1, riskBudget / stopPct);
    const selectedTrade = {
      ...trade,
      riskBudget,
      positionFraction,
      accountReturn: positionFraction * Number(trade.netReturn)
    };
    selected.push(selectedTrade);
    active.push(selectedTrade);
  }
  return selected;
}

const [latest, refined] = await Promise.all([
  loadTrades(LATEST_FILE),
  loadTrades(REFINED_FILE)
]);
const refinedKeys = new Set(refined.map(signalKey));
const tactical = latest.filter((trade) => !refinedKeys.has(signalKey(trade)));
const refinedLongLatestShort = [
  ...refined.filter((trade) => trade.side === "long"),
  ...latest.filter((trade) => trade.side === "short")
].sort((a, b) => a.entryTime - b.entryTime);
const tiered = [
  ...refined.map((trade) => ({ ...trade, tier: "core", riskMultiplier: 1 })),
  ...tactical.map((trade) => ({ ...trade, tier: "tactical", riskMultiplier: TACTICAL_RISK_MULTIPLIER }))
];

const variants = {
  coreOnly: {
    assumptions: { coreSignals: "refined", riskMultiplier: 1 },
    edge: edgeSummary(refined),
    portfolio: portfolioSummary(selectPortfolio(refined, 1), refined)
  },
  latestFullRisk: {
    assumptions: { signals: "latest", riskMultiplier: 1 },
    edge: edgeSummary(latest),
    portfolio: portfolioSummary(selectPortfolio(latest, 1), latest)
  },
  refinedLongLatestShort: {
    assumptions: {
      longSignals: "refined",
      shortSignals: "latest",
      riskMultiplier: 1,
      note: "The short side is the higher-frequency side in the source data; this is a candidate to validate out of sample."
    },
    edge: edgeSummary(refinedLongLatestShort),
    portfolio: portfolioSummary(
      selectPortfolio(refinedLongLatestShort, 1),
      refinedLongLatestShort
    )
  },
  tieredCorePlusTactical: {
    assumptions: {
      coreSignals: "refined",
      tacticalSignals: "latest minus refined by symbol/side/entryTime",
      tacticalRiskMultiplier: TACTICAL_RISK_MULTIPLIER
    },
    edge: edgeSummary(tiered),
    portfolio: portfolioSummary(
      selectPortfolio(tiered, 1),
      tiered
    ),
    coreSignalCount: refined.length,
    tacticalSignalCount: tactical.length
  }
};

const result = {
  generatedAt: new Date().toISOString(),
  purpose: "Compare a high-quality core signal tier with a lower-risk tactical tier without treating overlapping trade compounding as account P&L.",
  assumptions: {
    latestFile: LATEST_FILE,
    refinedFile: REFINED_FILE,
    tradingCost: "Included in source netReturn",
    baseRiskPerTrade: BASE_RISK,
    tacticalRiskMultiplier: TACTICAL_RISK_MULTIPLIER,
    maxOpenPositions: MAX_OPEN_POSITIONS,
    maxSameSideRisk: MAX_SAME_SIDE_RISK,
    overlapHandling: "Account-level selection enforces open-position and same-side risk caps; unselected overlapping candidates are skipped."
  },
  variants
};

await writeFile(OUTPUT_FILE, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
