import { INCOMPLETE_FUNDING } from "./execution-model.js";

export function aggregateMetrics(tradeResults = []) {
  const trades = Array.isArray(tradeResults) ? tradeResults : [];
  if (!trades.length) {
    return emptyMetrics();
  }

  const netReturns = trades.map((trade) => Number(trade.netReturnPct) || 0);
  const realizedRs = trades.map((trade) => Number(trade.realizedR) || 0);
  const winners = trades.filter((trade) => Number(trade.netReturnPct) > 0);
  const losers = trades.filter((trade) => Number(trade.netReturnPct) <= 0);
  const positiveNet = netReturns.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const negativeNet = netReturns.filter((value) => value < 0).reduce((sum, value) => sum + value, 0);
  const averageNetReturn = netReturns.reduce((sum, value) => sum + value, 0) / trades.length;
  const avgWinR = winners.length
    ? winners.reduce((sum, trade) => sum + (Number(trade.realizedR) || 0), 0) / winners.length
    : 0;
  const avgLossR = losers.length
    ? losers.reduce((sum, trade) => sum + (Number(trade.realizedR) || 0), 0) / losers.length
    : 0;
  let equity = 1;
  let peak = 1;
  let maxDrawdown = 0;
  for (const value of netReturns) {
    equity *= 1 + value;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.min(maxDrawdown, equity / peak - 1);
  }

  return {
    trades: trades.length,
    winRate: winners.length / trades.length,
    avgWinR,
    avgLossR,
    payoffRatio: avgLossR < 0 ? avgWinR / Math.abs(avgLossR) : Infinity,
    profitFactor: negativeNet < 0 ? positiveNet / Math.abs(negativeNet) : Infinity,
    expectancyR: realizedRs.reduce((sum, value) => sum + value, 0) / trades.length,
    averageNetReturn,
    totalNetReturn: equity - 1,
    maxDrawdown,
    feeDrag: sumField(trades, "totalFeePct"),
    spreadDrag: sumField(trades, "spreadCostPct"),
    slippageDrag: sumField(trades, "slippageCostPct"),
    fundingDrag: -sumField(trades, "fundingPct"),
    dataQuality: trades.some((trade) => trade.dataQuality === INCOMPLETE_FUNDING)
      ? INCOMPLETE_FUNDING
      : "COMPLETE"
  };
}

function emptyMetrics() {
  return {
    trades: 0,
    winRate: null,
    avgWinR: 0,
    avgLossR: 0,
    payoffRatio: null,
    profitFactor: null,
    expectancyR: null,
    averageNetReturn: null,
    totalNetReturn: 0,
    maxDrawdown: 0,
    feeDrag: 0,
    spreadDrag: 0,
    slippageDrag: 0,
    fundingDrag: 0,
    dataQuality: "COMPLETE"
  };
}

function sumField(trades, field) {
  return trades.reduce((sum, trade) => sum + (Number(trade[field]) || 0), 0);
}
