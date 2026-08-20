import { INCOMPLETE_EXCHANGE_FILTERS, INCOMPLETE_FUNDING } from "./execution-model.js";
import { INCOMPLETE_INTRABAR_DATA } from "../trading/replay-engine.js";

export function aggregateMetrics(tradeResults = [], diagnostics = {}) {
  const trades = Array.isArray(tradeResults) ? tradeResults : [];
  const missedEntries = Array.isArray(diagnostics.missedEntries)
    ? diagnostics.missedEntries
    : [];
  const entryStats = diagnostics.entryStats || {};
  const signals = Number(diagnostics.signals ?? entryStats.signals) || 0;
  const explicitMissedEntries = typeof diagnostics.missedEntries === "number"
    ? diagnostics.missedEntries
    : null;
  const missedEntryCount = Number.isFinite(explicitMissedEntries)
    ? explicitMissedEntries
    : missedEntries.length || (
    (Number(entryStats.noEntry) || 0) + (Number(entryStats.missedEntry) || 0)
    );
  const isDegraded = (trade) => Boolean(
    trade.ambiguousIntrabar === true
    || (trade.dataQuality != null && trade.dataQuality !== "COMPLETE")
  );
  const baseDiagnostics = {
    completeTrades: trades.filter((trade) => !isDegraded(trade)).length,
    degradedTrades: trades.filter(isDegraded).length,
    ambiguousTrades: trades.filter((trade) => trade.ambiguousIntrabar === true).length,
    missedEntries: missedEntryCount,
    noEntryRate: signals > 0 ? missedEntryCount / signals : null,
    fundingIncompleteTrades: trades.filter((trade) =>
      trade.dataQuality === INCOMPLETE_FUNDING
      || trade.dataQualityComponents?.funding === INCOMPLETE_FUNDING
    ).length,
    intrabarIncompleteTrades: trades.filter((trade) =>
      trade.dataQuality === INCOMPLETE_INTRABAR_DATA
      || trade.dataQualityComponents?.intrabar === INCOMPLETE_INTRABAR_DATA
    ).length
  };

  if (!trades.length) {
    return {
      ...emptyMetrics(),
      ...baseDiagnostics
    };
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
    dataQuality: trades.some((trade) => trade.dataQuality === INCOMPLETE_FUNDING
      || trade.dataQualityComponents?.funding === INCOMPLETE_FUNDING)
      ? INCOMPLETE_FUNDING
      : trades.some((trade) => trade.dataQuality === INCOMPLETE_EXCHANGE_FILTERS
        || trade.dataQualityComponents?.exchangeFilters === INCOMPLETE_EXCHANGE_FILTERS)
        ? INCOMPLETE_EXCHANGE_FILTERS
        : trades.some((trade) => trade.dataQuality === INCOMPLETE_INTRABAR_DATA
          || trade.dataQualityComponents?.intrabar === INCOMPLETE_INTRABAR_DATA)
        ? INCOMPLETE_INTRABAR_DATA
        : "COMPLETE",
    ...baseDiagnostics
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
