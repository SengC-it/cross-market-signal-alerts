import fs from "node:fs";
import path from "node:path";
import { buildV31Portfolio, V31_MODEL } from "../lib/v3-paper.js";

const ROOT = process.cwd();
const HOUR = 3_600_000;
const FOUR_HOURS = 4 * HOUR;
const WEEK = V31_MODEL.rebalanceHours * HOUR;
const DATA_START = Date.parse("2023-01-01T00:00:00Z");
const DATA_END = Date.parse("2026-07-01T00:00:00Z");
const PRICE_CACHE = path.join(ROOT, ".backtest-cache", "binance-futures-1h");
const FUNDING_CACHE = path.join(ROOT, ".backtest-cache", "v3-2-funding");
const OUTPUT = path.join(ROOT, "v3_2_exit_backtest_2026-07-25.json");
const BASE_ROUND_TRIP_COST = 0.0012;

const SPLITS = {
  train: {
    start: Date.parse("2023-01-01T00:00:00Z"),
    end: Date.parse("2025-01-01T00:00:00Z")
  },
  validation: {
    start: Date.parse("2025-01-01T00:00:00Z"),
    end: Date.parse("2026-01-01T00:00:00Z")
  },
  test: {
    start: Date.parse("2026-01-01T00:00:00Z"),
    end: Date.parse("2026-07-01T00:00:00Z")
  }
};

const EXIT_CANDIDATES = [
  { id: "v3_1_time_168h", type: "time" },
  ...[1, 1.5, 2, 2.5, 3].flatMap((stopAtr) =>
    [1, 1.5, 2, 2.5, 3].map((rewardRisk) => ({
      id: `v3_2_atr${stopAtr}_rr${rewardRisk}`,
      type: "atr_bracket",
      stopAtr,
      rewardRisk
    }))
  ),
  ...[2, 2.5, 3, 3.5, 4, 5].map((stopAtr) => ({
    id: `v3_2b_atr${stopAtr}_stop_only`,
    type: "atr_stop_only",
    stopAtr
  })),
  ...[2.5, 3.5, 4.5].flatMap((stopAtr) =>
    [2, 3].flatMap((activationR) =>
      [1, 1.5, 2].map((trailAtr) => ({
        id: `v3_2b_atr${stopAtr}_activate${activationR}r_trail${trailAtr}`,
        type: "atr_trailing",
        stopAtr,
        activationR,
        trailAtr
      }))
    )
  ),
  ...[0.02, 0.03, 0.04, 0.05, 0.06].flatMap((portfolioStop) =>
    [0.03, 0.05, 0.08, 0.12].map((portfolioTakeProfit) => ({
      id: `v3_2c_portfolio_sl${portfolioStop}_tp${portfolioTakeProfit}`,
      type: "portfolio_bracket",
      portfolioStop,
      portfolioTakeProfit
    }))
  ),
  ...[0.03, 0.05].flatMap((portfolioStop) =>
    [0.03, 0.05, 0.08].flatMap((activationReturn) =>
      [0.015, 0.025, 0.04].map((trailingDrawdown) => ({
        id: `v3_2c_portfolio_sl${portfolioStop}_activate${activationReturn}_trail${trailingDrawdown}`,
        type: "portfolio_trailing",
        portfolioStop,
        activationReturn,
        trailingDrawdown
      }))
    )
  )
];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
}

function round(value, digits = 8) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function mean(values) {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;
}

function sampleStandardDeviation(values) {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(
    values.reduce((sum, value) => sum + (value - average) ** 2, 0)
      / (values.length - 1)
  );
}

function loadMarketSeries(symbol) {
  const file = path.join(
    PRICE_CACHE,
    `${symbol}-${DATA_START}-${DATA_END}.json`
  );
  if (!fs.existsSync(file)) {
    throw new Error(`Missing frozen price cache: ${file}`);
  }
  const hourly = readJson(file).map((row) => ({
    openTime: Number(row.openTime),
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: Number(row.volume),
    quoteVolume: Number(row.quoteVolume)
  }));
  const hourlyIndex = new Map(hourly.map((row, index) => [row.openTime, index]));
  const fourHour = aggregateFourHour(hourly);
  const fourHourIndex = new Map(
    fourHour.map((row, index) => [row.openTime, index])
  );
  return { symbol, hourly, hourlyIndex, fourHour, fourHourIndex };
}

function aggregateFourHour(hourly) {
  const rows = [];
  const byTime = new Map(hourly.map((row) => [row.openTime, row]));
  const first = Math.ceil((hourly[0]?.openTime || 0) / FOUR_HOURS) * FOUR_HOURS;
  const last = hourly.at(-1)?.openTime || 0;
  for (let openTime = first; openTime + 3 * HOUR <= last; openTime += FOUR_HOURS) {
    const group = [0, 1, 2, 3].map((offset) => byTime.get(openTime + offset * HOUR));
    if (group.some((row) => !row)) continue;
    rows.push({
      openTime,
      open: group[0].open,
      high: Math.max(...group.map((row) => row.high)),
      low: Math.min(...group.map((row) => row.low)),
      close: group[3].close,
      volume: group.reduce((sum, row) => sum + row.volume, 0),
      quoteVolume: group.reduce((sum, row) => sum + row.quoteVolume, 0)
    });
  }
  return rows;
}

function loadFundingSeries(symbol) {
  const file = path.join(
    FUNDING_CACHE,
    `${symbol}-${DATA_START}-${DATA_END}.json`
  );
  if (!fs.existsSync(file)) {
    throw new Error(
      `Missing funding cache: ${file}. Run powershell -File scripts/download-v3-2-funding.ps1`
    );
  }
  const rows = readJson(file)
    .map((row) => ({
      fundingTime: Number(row.fundingTime),
      fundingRate: Number(row.fundingRate)
    }))
    .filter((row) =>
      Number.isFinite(row.fundingTime) && Number.isFinite(row.fundingRate)
    )
    .sort((a, b) => a.fundingTime - b.fundingTime);
  const times = rows.map((row) => row.fundingTime);
  const prefix = [0];
  for (const row of rows) prefix.push(prefix.at(-1) + row.fundingRate);
  return { times, prefix, count: rows.length };
}

function upperBound(values, target) {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (values[middle] <= target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function fundingSum(series, entryTime, exitTime) {
  const start = upperBound(series.times, entryTime);
  const end = upperBound(series.times, exitTime);
  return series.prefix[end] - series.prefix[start];
}

function atrBeforeEntry(series, entryTime, period = 14) {
  const entryIndex = series.fourHourIndex.get(entryTime);
  if (!Number.isInteger(entryIndex) || entryIndex < period) return null;
  let total = 0;
  for (let index = entryIndex - period; index < entryIndex; index++) {
    const candle = series.fourHour[index];
    const previousClose = series.fourHour[index - 1]?.close;
    if (!(previousClose > 0)) return null;
    total += Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose)
    );
  }
  return total / period;
}

function alignUp(value, interval) {
  return Math.ceil(value / interval) * interval;
}

function generatePortfolios(split, marketBySymbol) {
  const fourHourBySymbol = new Map(
    [...marketBySymbol].map(([symbol, series]) => [symbol, series.fourHour])
  );
  const warmup = (
    V31_MODEL.lookbackHours
    + V31_MODEL.skipHours
    + 4
  ) * HOUR;
  const periods = [];
  let entryTime = alignUp(Math.max(split.start, DATA_START + warmup), WEEK);
  while (entryTime + WEEK <= split.end) {
    try {
      const portfolio = buildV31Portfolio({
        seriesBySymbol: fourHourBySymbol,
        rebalanceTime: entryTime
      });
      periods.push({
        entryTime,
        exitTime: entryTime + WEEK,
        predictedBeta: portfolio.predictedBeta,
        targets: portfolio.targets
      });
    } catch {
      // Historical listings and missing candles can make an early week ineligible.
    }
    entryTime += WEEK;
  }
  return periods;
}

function simulatePosition({
  target,
  period,
  candidate,
  market,
  funding
}) {
  const entryPrice = Number(target.referencePrice);
  const direction = target.side === "LONG" ? 1 : -1;
  const entryIndex = market.hourlyIndex.get(period.entryTime);
  const timeExitIndex = market.hourlyIndex.get(period.exitTime);
  if (
    !Number.isInteger(entryIndex)
    || !Number.isInteger(timeExitIndex)
    || !(entryPrice > 0)
  ) return null;

  let stopLoss = null;
  let takeProfit = null;
  let currentAtr = null;
  let stopDistance = null;
  if (candidate.type !== "time") {
    currentAtr = atrBeforeEntry(market, period.entryTime);
    if (!(currentAtr > 0)) return null;
    stopDistance = currentAtr * candidate.stopAtr;
    stopLoss = direction > 0
      ? entryPrice - stopDistance
      : entryPrice + stopDistance;
    if (candidate.type === "atr_bracket") {
      takeProfit = direction > 0
        ? entryPrice + stopDistance * candidate.rewardRisk
        : entryPrice - stopDistance * candidate.rewardRisk;
    }
    if (!(stopLoss > 0) || (takeProfit != null && !(takeProfit > 0))) return null;
  }

  let exitPrice = market.hourly[timeExitIndex].open;
  let exitTime = period.exitTime;
  let outcome = "time_exit";
  let maximumFavorableExcursion = 0;
  let maximumAdverseExcursion = 0;
  let activeStop = stopLoss;
  let trailingActive = false;
  let favorableExtreme = entryPrice;

  for (let index = entryIndex; index < timeExitIndex; index++) {
    const candle = market.hourly[index];
    const favorable = direction > 0
      ? candle.high / entryPrice - 1
      : 1 - candle.low / entryPrice;
    const adverse = direction > 0
      ? candle.low / entryPrice - 1
      : 1 - candle.high / entryPrice;
    maximumFavorableExcursion = Math.max(maximumFavorableExcursion, favorable);
    maximumAdverseExcursion = Math.min(maximumAdverseExcursion, adverse);

    if (candidate.type === "time") continue;
    const hitStop = direction > 0
      ? candle.low <= activeStop
      : candle.high >= activeStop;
    const hitTarget = candidate.type === "atr_bracket" && (
      direction > 0
        ? candle.high >= takeProfit
        : candle.low <= takeProfit
    );

    if (hitStop) {
      exitPrice = direction > 0
        ? Math.min(candle.open, activeStop)
        : Math.max(candle.open, activeStop);
      exitTime = candle.openTime;
      outcome = trailingActive ? "trailing_take_profit" : "stop_loss";
      break;
    }
    if (hitTarget) {
      exitPrice = takeProfit;
      exitTime = candle.openTime;
      outcome = "take_profit";
      break;
    }

    if (candidate.type === "atr_trailing") {
      favorableExtreme = direction > 0
        ? Math.max(favorableExtreme, candle.high)
        : Math.min(favorableExtreme, candle.low);
      const favorableDistance = direction > 0
        ? favorableExtreme - entryPrice
        : entryPrice - favorableExtreme;
      if (favorableDistance >= stopDistance * candidate.activationR) {
        trailingActive = true;
        const candidateStop = direction > 0
          ? favorableExtreme - currentAtr * candidate.trailAtr
          : favorableExtreme + currentAtr * candidate.trailAtr;
        activeStop = direction > 0
          ? Math.max(activeStop, candidateStop)
          : Math.min(activeStop, candidateStop);
      }
    }
  }

  const priceReturn = direction * (exitPrice / entryPrice - 1);
  const fundingRate = fundingSum(funding, period.entryTime, exitTime);
  const fundingReturn = -direction * fundingRate;
  return {
    symbol: target.symbol,
    side: target.side,
    weight: Math.abs(Number(target.targetWeight)),
    entryPrice: round(entryPrice, 12),
    exitPrice: round(exitPrice, 12),
    stopLoss: round(stopLoss, 12),
    takeProfit: round(takeProfit, 12),
    entryTime: period.entryTime,
    exitTime,
    holdingHours: round((exitTime - period.entryTime) / HOUR, 4),
    outcome,
    priceReturn: round(priceReturn),
    fundingReturn: round(fundingReturn),
    grossReturn: round(priceReturn + fundingReturn),
    maximumFavorableExcursion: round(maximumFavorableExcursion),
    maximumAdverseExcursion: round(maximumAdverseExcursion)
  };
}

function simulateCandidate(candidate, portfolios, marketBySymbol, fundingBySymbol) {
  const periods = [];
  for (const period of portfolios) {
    if (candidate.type.startsWith("portfolio_")) {
      const portfolioResult = simulatePortfolioExit({
        period,
        candidate,
        marketBySymbol,
        fundingBySymbol
      });
      if (portfolioResult) periods.push(portfolioResult);
      continue;
    }
    const positions = period.targets.map((target) =>
      simulatePosition({
        target,
        period,
        candidate,
        market: marketBySymbol.get(target.symbol),
        funding: fundingBySymbol.get(target.symbol)
      })
    );
    if (positions.some((position) => !position)) continue;
    const grossReturn = positions.reduce(
      (sum, position) => sum + position.weight * position.grossReturn,
      0
    );
    const baseCost = positions.reduce(
      (sum, position) => sum + position.weight * BASE_ROUND_TRIP_COST,
      0
    );
    periods.push({
      entryTime: period.entryTime,
      exitTime: period.exitTime,
      predictedBeta: period.predictedBeta,
      grossReturn: round(grossReturn),
      baseCost: round(baseCost),
      positions
    });
  }
  return periods;
}

function simulatePortfolioExit({
  period,
  candidate,
  marketBySymbol,
  fundingBySymbol
}) {
  const targetRows = period.targets.map((target) => {
    const market = marketBySymbol.get(target.symbol);
    const entryIndex = market.hourlyIndex.get(period.entryTime);
    const timeExitIndex = market.hourlyIndex.get(period.exitTime);
    if (!Number.isInteger(entryIndex) || !Number.isInteger(timeExitIndex)) {
      return null;
    }
    return {
      target,
      market,
      funding: fundingBySymbol.get(target.symbol),
      entryIndex,
      timeExitIndex,
      entryPrice: Number(target.referencePrice),
      direction: target.side === "LONG" ? 1 : -1,
      weight: Math.abs(Number(target.targetWeight))
    };
  });
  if (targetRows.some((row) => !row || !(row.entryPrice > 0))) return null;

  let exitTime = period.exitTime;
  let outcome = "time_exit";
  let highWatermark = 0;
  let trailingActive = false;
  const steps = targetRows[0].timeExitIndex - targetRows[0].entryIndex;

  for (let offset = 0; offset < steps; offset++) {
    const candleTime = period.entryTime + offset * HOUR;
    let markedReturn = -BASE_ROUND_TRIP_COST / 2;
    for (const row of targetRows) {
      const candle = row.market.hourly[row.entryIndex + offset];
      if (!candle || candle.openTime !== candleTime) return null;
      const priceReturn = row.direction * (candle.close / row.entryPrice - 1);
      const fundingReturn = -row.direction * fundingSum(
        row.funding,
        period.entryTime,
        candle.openTime
      );
      markedReturn += row.weight * (priceReturn + fundingReturn);
    }
    highWatermark = Math.max(highWatermark, markedReturn);

    const hitHardStop = markedReturn <= -candidate.portfolioStop;
    const hitFixedTarget = candidate.type === "portfolio_bracket"
      && markedReturn >= candidate.portfolioTakeProfit;
    if (
      candidate.type === "portfolio_trailing"
      && highWatermark >= candidate.activationReturn
    ) {
      trailingActive = true;
    }
    const hitTrailingTarget = candidate.type === "portfolio_trailing"
      && trailingActive
      && markedReturn <= highWatermark - candidate.trailingDrawdown;

    if (hitHardStop || hitFixedTarget || hitTrailingTarget) {
      exitTime = candleTime + HOUR;
      outcome = hitHardStop
        ? "portfolio_stop_loss"
        : hitFixedTarget
          ? "portfolio_take_profit"
          : "portfolio_trailing_take_profit";
      break;
    }
  }

  const positions = targetRows.map((row) => {
    const exitIndex = row.market.hourlyIndex.get(exitTime);
    if (!Number.isInteger(exitIndex)) return null;
    const exitPrice = row.market.hourly[exitIndex].open;
    const priceReturn = row.direction * (exitPrice / row.entryPrice - 1);
    const fundingReturn = -row.direction * fundingSum(
      row.funding,
      period.entryTime,
      exitTime
    );
    let maximumFavorableExcursion = 0;
    let maximumAdverseExcursion = 0;
    for (let index = row.entryIndex; index < exitIndex; index++) {
      const candle = row.market.hourly[index];
      const favorable = row.direction > 0
        ? candle.high / row.entryPrice - 1
        : 1 - candle.low / row.entryPrice;
      const adverse = row.direction > 0
        ? candle.low / row.entryPrice - 1
        : 1 - candle.high / row.entryPrice;
      maximumFavorableExcursion = Math.max(maximumFavorableExcursion, favorable);
      maximumAdverseExcursion = Math.min(maximumAdverseExcursion, adverse);
    }
    return {
      symbol: row.target.symbol,
      side: row.target.side,
      weight: row.weight,
      entryPrice: round(row.entryPrice, 12),
      exitPrice: round(exitPrice, 12),
      stopLoss: null,
      takeProfit: null,
      entryTime: period.entryTime,
      exitTime,
      holdingHours: round((exitTime - period.entryTime) / HOUR, 4),
      outcome,
      priceReturn: round(priceReturn),
      fundingReturn: round(fundingReturn),
      grossReturn: round(priceReturn + fundingReturn),
      maximumFavorableExcursion: round(maximumFavorableExcursion),
      maximumAdverseExcursion: round(maximumAdverseExcursion)
    };
  });
  if (positions.some((position) => !position)) return null;

  return {
    entryTime: period.entryTime,
    exitTime: period.exitTime,
    actualExitTime: exitTime,
    predictedBeta: period.predictedBeta,
    grossReturn: round(positions.reduce(
      (sum, position) => sum + position.weight * position.grossReturn,
      0
    )),
    baseCost: round(positions.reduce(
      (sum, position) => sum + position.weight * BASE_ROUND_TRIP_COST,
      0
    )),
    positions
  };
}

function summarize(periods, costMultiplier) {
  if (!periods.length) return emptySummary();
  const returns = periods.map(
    (period) => period.grossReturn - period.baseCost * costMultiplier
  );
  let equity = 1;
  let peak = 1;
  let maxDrawdown = 0;
  let positiveSum = 0;
  let negativeSum = 0;
  const monthly = new Map();
  for (let index = 0; index < periods.length; index++) {
    const value = returns[index];
    equity *= Math.max(0, 1 + value);
    peak = Math.max(peak, equity);
    maxDrawdown = Math.min(maxDrawdown, equity / peak - 1);
    if (value > 0) positiveSum += value;
    else negativeSum += value;
    const month = new Date(periods[index].entryTime).toISOString().slice(0, 7);
    monthly.set(month, (monthly.get(month) || 1) * Math.max(0, 1 + value));
  }

  const average = mean(returns);
  const deviation = sampleStandardDeviation(returns);
  const durationDays = Math.max(
    1,
    (periods.at(-1).exitTime - periods[0].entryTime) / 86_400_000
  );
  const positions = periods.flatMap((period) => period.positions);
  const outcomes = Object.fromEntries(
    [
      "stop_loss",
      "take_profit",
      "trailing_take_profit",
      "portfolio_stop_loss",
      "portfolio_take_profit",
      "portfolio_trailing_take_profit",
      "time_exit"
    ].map((outcome) => [
      outcome,
      positions.filter((position) => position.outcome === outcome).length
    ])
  );
  const contributionBySymbol = new Map();
  for (const period of periods) {
    for (const position of period.positions) {
      const net = position.weight * (
        position.grossReturn - BASE_ROUND_TRIP_COST * costMultiplier
      );
      contributionBySymbol.set(
        position.symbol,
        (contributionBySymbol.get(position.symbol) || 0) + net
      );
    }
  }

  return {
    observations: periods.length,
    totalReturn: round(equity - 1),
    cagr: equity > 0 ? round(equity ** (365.25 / durationDays) - 1) : null,
    averageNetReturn: round(average),
    lowerConfidenceBound95: round(
      average - 1.96 * deviation / Math.sqrt(returns.length)
    ),
    winRate: round(returns.filter((value) => value > 0).length / returns.length),
    profitFactor: negativeSum < 0 ? round(positiveSum / Math.abs(negativeSum)) : null,
    sharpe: deviation > 0 ? round(average / deviation * Math.sqrt(52)) : null,
    maxDrawdown: round(maxDrawdown),
    positiveMonthRate: round(
      [...monthly.values()].filter((value) => value > 1).length / monthly.size
    ),
    averageHoldingHours: round(mean(positions.map((position) => position.holdingHours))),
    averageMfe: round(mean(positions.map((position) => position.maximumFavorableExcursion))),
    averageMae: round(mean(positions.map((position) => position.maximumAdverseExcursion))),
    outcomes,
    totalModeledCost: round(
      periods.reduce((sum, period) => sum + period.baseCost * costMultiplier, 0)
    ),
    topContributors: [...contributionBySymbol]
      .map(([symbol, value]) => ({ symbol, value: round(value) }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 10)
  };
}

function emptySummary() {
  return {
    observations: 0,
    totalReturn: null,
    cagr: null,
    averageNetReturn: null,
    lowerConfidenceBound95: null,
    winRate: null,
    profitFactor: null,
    sharpe: null,
    maxDrawdown: null,
    positiveMonthRate: null
  };
}

function summarizeAllCosts(periods) {
  return {
    cost1x: summarize(periods, 1),
    cost2x: summarize(periods, 2),
    cost3x: summarize(periods, 3)
  };
}

function selectionScore(result, baseline) {
  const train = result.train.cost2x;
  const validation = result.validation.cost2x;
  if (
    !(train.totalReturn > 0)
    || !(validation.totalReturn > 0)
    || !(validation.profitFactor > 1)
    || validation.maxDrawdown < baseline.validation.cost2x.maxDrawdown
  ) return -Infinity;
  return Math.min(train.cagr, validation.cagr)
    + 0.15 * Math.min(train.sharpe || 0, validation.sharpe || 0)
    + 0.5 * Math.min(train.maxDrawdown, validation.maxDrawdown);
}

function descriptiveScore(result) {
  const train = result.train.cost2x;
  const validation = result.validation.cost2x;
  if (train.cagr == null || validation.cagr == null) return -Infinity;
  return Math.min(train.cagr, validation.cagr)
    + 0.15 * Math.min(train.sharpe || 0, validation.sharpe || 0)
    + 0.5 * Math.min(train.maxDrawdown, validation.maxDrawdown);
}

function selectionChecks(result, baseline) {
  return {
    trainCost2Positive: result.train.cost2x.totalReturn > 0,
    validationCost2Positive: result.validation.cost2x.totalReturn > 0,
    validationProfitFactor: result.validation.cost2x.profitFactor > 1,
    validationDrawdownNoWorse:
      result.validation.cost2x.maxDrawdown
      >= baseline.validation.cost2x.maxDrawdown
  };
}

function buildSelectionDiagnostics(results) {
  const summarize = (items) => ({
    candidates: items.length,
    trainCost2Positive: items.filter(
      (result) => result.train.cost2x.totalReturn > 0
    ).length,
    validationCost2Positive: items.filter(
      (result) => result.validation.cost2x.totalReturn > 0
    ).length,
    positiveInTrainAndValidation: items.filter(
      (result) =>
        result.train.cost2x.totalReturn > 0
        && result.validation.cost2x.totalReturn > 0
    ).length,
    passedSelectionGate: items.filter(
      (result) => result.selectionScore != null
    ).length
  });
  const alternatives = results.filter(
    (result) => result.candidate.type !== "time"
  );
  const independent = alternatives.filter(
    (result) => !result.candidate.type.startsWith("portfolio_")
  );
  const portfolio = alternatives.filter(
    (result) => result.candidate.type.startsWith("portfolio_")
  );
  return {
    alternatives: summarize(alternatives),
    independent: summarize(independent),
    portfolio: summarize(portfolio),
    byType: Object.fromEntries(
      [...new Set(alternatives.map((result) => result.candidate.type))]
        .map((type) => [
          type,
          summarize(
            alternatives.filter((result) => result.candidate.type === type)
          )
        ])
    )
  };
}

const marketBySymbol = new Map(
  V31_MODEL.universe.map((symbol) => [symbol, loadMarketSeries(symbol)])
);
const fundingBySymbol = new Map(
  V31_MODEL.universe.map((symbol) => [symbol, loadFundingSeries(symbol)])
);
const portfoliosBySplit = Object.fromEntries(
  Object.entries(SPLITS).map(([name, split]) => [
    name,
    generatePortfolios(split, marketBySymbol)
  ])
);

const selectionResults = [];
for (const candidate of EXIT_CANDIDATES) {
  const trainPeriods = simulateCandidate(
    candidate,
    portfoliosBySplit.train,
    marketBySymbol,
    fundingBySymbol
  );
  const validationPeriods = simulateCandidate(
    candidate,
    portfoliosBySplit.validation,
    marketBySymbol,
    fundingBySymbol
  );
  const result = {
    candidate,
    train: summarizeAllCosts(trainPeriods),
    validation: summarizeAllCosts(validationPeriods)
  };
  selectionResults.push(result);
}

const baseline = selectionResults.find((result) => result.candidate.type === "time");
for (const result of selectionResults) {
  result.selectionChecks = selectionChecks(result, baseline);
  result.descriptiveScore = round(descriptiveScore(result));
  result.selectionScore = round(selectionScore(result, baseline));
}
const selectionDiagnostics = buildSelectionDiagnostics(selectionResults);
const ranked = [...selectionResults].sort(
  (a, b) => (b.selectionScore ?? -Infinity) - (a.selectionScore ?? -Infinity)
);
const selected = ranked.find((result) => result.candidate.type !== "time");
if (!selected || selected.selectionScore == null) {
  const descriptiveRanking = [...selectionResults]
    .filter((result) => result.candidate.type !== "time")
    .sort(
      (a, b) =>
        (b.descriptiveScore ?? -Infinity) - (a.descriptiveScore ?? -Infinity)
    );
  const failedResult = {
    generatedAt: new Date().toISOString(),
    protocol: "docs/V3_2_EXIT_PROTOCOL_2026-07-25.md",
    selectionStatus: "no_candidate_passed",
    data: {
      start: new Date(DATA_START).toISOString(),
      end: new Date(DATA_END).toISOString(),
      symbols: V31_MODEL.universe,
      fundingRecords: Object.fromEntries(
        [...fundingBySymbol].map(([symbol, series]) => [symbol, series.count])
      ),
      portfolios: Object.fromEntries(
        Object.entries(portfoliosBySplit).map(([name, periods]) => [name, periods.length])
      )
    },
    selectionDiagnostics,
    baseline: {
      candidate: baseline.candidate,
      train: baseline.train,
      validation: baseline.validation
    },
    closestCandidates: descriptiveRanking.slice(0, 10),
    allSelectionResults: selectionResults,
    frozenTest: null,
    deploymentGate: {
      passed: false,
      reason: "No ATR stop-loss/take-profit candidate passed train and validation"
    }
  };
  fs.writeFileSync(OUTPUT, `${JSON.stringify(failedResult, null, 2)}\n`);
  console.log(JSON.stringify({
    output: OUTPUT,
    selectionStatus: failedResult.selectionStatus,
    baseline: failedResult.baseline,
    closestCandidates: failedResult.closestCandidates.slice(0, 5),
    deploymentGate: failedResult.deploymentGate
  }, null, 2));
  process.exit(0);
}

const testCandidates = [baseline.candidate, selected.candidate];
const frozenTest = Object.fromEntries(testCandidates.map((candidate) => {
  const periods = simulateCandidate(
    candidate,
    portfoliosBySplit.test,
    marketBySymbol,
    fundingBySymbol
  );
  return [candidate.id, {
    summaries: summarizeAllCosts(periods),
    periods
  }];
}));

const selectedTest = frozenTest[selected.candidate.id].summaries;
const baselineTest = frozenTest[baseline.candidate.id].summaries;
const deploymentGate = {
  passed: false,
  checks: {
    testCost2Positive: selectedTest.cost2x.totalReturn > 0,
    testBeatsBaselineCost2:
      selectedTest.cost2x.totalReturn > baselineTest.cost2x.totalReturn,
    testProfitFactor: selectedTest.cost2x.profitFactor >= 1.15,
    testDrawdown: selectedTest.cost2x.maxDrawdown >= -0.12,
    testCost3Nonnegative: selectedTest.cost3x.totalReturn >= 0,
    testConfidence: selectedTest.cost2x.lowerConfidenceBound95 > 0,
    testPositiveMonths: selectedTest.cost2x.positiveMonthRate >= 0.6
  }
};
deploymentGate.passed = Object.values(deploymentGate.checks).every(Boolean);

const result = {
  generatedAt: new Date().toISOString(),
  protocol: "docs/V3_2_EXIT_PROTOCOL_2026-07-25.md",
  data: {
    start: new Date(DATA_START).toISOString(),
    end: new Date(DATA_END).toISOString(),
    symbols: V31_MODEL.universe,
    fundingRecords: Object.fromEntries(
      [...fundingBySymbol].map(([symbol, series]) => [symbol, series.count])
    ),
    portfolios: Object.fromEntries(
      Object.entries(portfoliosBySplit).map(([name, periods]) => [name, periods.length])
    )
  },
  selectionDiagnostics,
  baseline: {
    candidate: baseline.candidate,
    train: baseline.train,
    validation: baseline.validation,
    test: baselineTest
  },
  selected: {
    candidate: selected.candidate,
    selectionScore: selected.selectionScore,
    train: selected.train,
    validation: selected.validation,
    test: selectedTest
  },
  topSelectionResults: ranked.slice(0, 10),
  frozenTest,
  deploymentGate
};

fs.writeFileSync(OUTPUT, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({
  output: OUTPUT,
  baseline: result.baseline,
  selected: result.selected,
  deploymentGate
}, null, 2));
