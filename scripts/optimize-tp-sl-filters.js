import fs from "node:fs";

const SOURCE_FILE = process.env.SOURCE_FILE || "production_dynamic_email_backtest_latest_tp_sl_only_2026-01_06.json";
const MIN_SIGNALS = Number(process.env.MIN_SIGNALS || 180);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
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

function byMonth(trades) {
  return Object.fromEntries(
    [...new Set(trades.map((trade) => trade.month))].sort().map((month) => [
      month,
      summarize(trades.filter((trade) => trade.month === month)),
    ]),
  );
}

function passLong(trade, cfg) {
  if (!cfg.longEnabled) return false;
  return (
    trade.momentum24h >= cfg.longMomMin &&
    trade.momentum24h <= cfg.longMomMax &&
    trade.relative >= cfg.longRelMin &&
    trade.volumeMultiple >= cfg.longVolMin &&
    trade.volumeMultiple <= cfg.longVolMax &&
    trade.recommendationScore >= cfg.longScoreMin
  );
}

function passShort(trade, cfg) {
  if (!cfg.shortEnabled) return false;
  return (
    trade.momentum24h >= cfg.shortMomMin &&
    trade.momentum24h <= cfg.shortMomMax &&
    trade.relative <= cfg.shortRelMax &&
    trade.volumeMultiple >= cfg.shortVolMin &&
    trade.volumeMultiple <= cfg.shortVolMax &&
    trade.recommendationScore >= cfg.shortScoreMin
  );
}

function applyConfig(trades, cfg) {
  return trades
    .filter((trade) => (trade.side === "long" ? passLong(trade, cfg) : passShort(trade, cfg)))
    .sort((a, b) => a.entryTime - b.entryTime);
}

const source = readJson(SOURCE_FILE);
const trades = source.trades;

const configs = [];
for (const longRelMin of [0.08, 0.1, 0.12, 0.14, 0.16]) {
  for (const longVolMax of [1.8, 2.0]) {
    for (const longScoreMin of [85, 87, 89]) {
      for (const shortMomMin of [-0.13, -0.12, -0.11, -0.1]) {
        for (const shortVolMin of [2.75, 3.0, 3.25]) {
          for (const shortVolMax of [3.25, 3.5]) {
            for (const shortScoreMin of [85, 87, 89]) {
              configs.push({
                longEnabled: true,
                shortEnabled: true,
                longMomMin: 0.08,
                longMomMax: 0.1,
                longRelMin,
                longVolMin: 1.5,
                longVolMax,
                longScoreMin,
                shortMomMin,
                shortMomMax: -0.08,
                shortRelMax: -0.03,
                shortVolMin,
                shortVolMax,
                shortScoreMin,
              });
            }
          }
        }
      }
    }
  }
}

const evaluated = configs
  .map((cfg) => {
    const picked = applyConfig(trades, cfg);
    const summary = summarize(picked);
    const months = byMonth(picked);
    const monthValues = Object.values(months);
    const negativeMonths = monthValues.filter((item) => item.compound < 0).length;
    const worstMonth = Math.min(...monthValues.map((item) => item.compound));
    return { cfg, summary, months, negativeMonths, worstMonth };
  })
  .filter((item) => item.summary.closed >= MIN_SIGNALS)
  .sort((a, b) => {
    const scoreA = a.summary.compound - Math.abs(a.summary.maxDd) * 0.8 - a.negativeMonths * 0.2 + a.summary.pf * 0.1;
    const scoreB = b.summary.compound - Math.abs(b.summary.maxDd) * 0.8 - b.negativeMonths * 0.2 + b.summary.pf * 0.1;
    return scoreB - scoreA;
  });

const notable = {
  baseline: source.summary,
  top: evaluated.slice(0, 10),
  bestPf: [...evaluated].sort((a, b) => b.summary.pf - a.summary.pf).slice(0, 5),
  bestDrawdown: [...evaluated].sort((a, b) => b.summary.maxDd - a.summary.maxDd).slice(0, 5),
};

console.log(JSON.stringify(notable, null, 2));
