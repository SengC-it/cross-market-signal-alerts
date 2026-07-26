import fs from "node:fs";
import path from "node:path";
import { buildV31Portfolio, V31_MODEL } from "../lib/v3-paper.js";

const ROOT = process.cwd();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const FOUR_HOURS = 4 * HOUR;
const WEEK = V31_MODEL.rebalanceHours * HOUR;
const DATA_START = Date.parse("2023-01-01T00:00:00Z");
const RESEARCH_END = Date.parse("2026-01-01T00:00:00Z");
const CACHE_END = Date.parse("2026-07-01T00:00:00Z");
const PRICE_CACHE = path.join(ROOT, ".backtest-cache", "binance-futures-1h");
const FUNDING_CACHE = path.join(ROOT, ".backtest-cache", "v3-2-funding");
const OUTPUT = path.join(ROOT, "v3_3_risk_control_backtest_2026-07-25.json");
const BASE_ROUND_TRIP_COST = 0.0012;
const MIN_GROSS_EXPOSURE = 0.25;
const VOLATILITY_WARMUP_DAYS = 60;

const SPLITS = {
  train: {
    start: DATA_START,
    end: Date.parse("2025-01-01T00:00:00Z")
  },
  validation: {
    start: Date.parse("2025-01-01T00:00:00Z"),
    end: RESEARCH_END
  }
};

const BASELINE = Object.freeze({
  id: "v3_1_fixed_gross_1",
  volatilityLookbackDays: null,
  targetAnnualVolatility: null,
  maximumGrossExposure: 1,
  catastropheStop: null,
  breakerDrawdown: null,
  breakerCooldownWeeks: 0
});

const VOLATILITY_CANDIDATES = [30, 60].flatMap((volatilityLookbackDays) =>
  [0.15, 0.2, 0.25].flatMap((targetAnnualVolatility) =>
    [1, 1.25].map((maximumGrossExposure) => ({
      id: [
        "v3_3_vol",
        volatilityLookbackDays,
        targetAnnualVolatility,
        maximumGrossExposure
      ].join("_"),
      volatilityLookbackDays,
      targetAnnualVolatility,
      maximumGrossExposure,
      catastropheStop: null,
      breakerDrawdown: null,
      breakerCooldownWeeks: 0
    }))
  )
);

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

function percentile(sortedValues, probability) {
  if (!sortedValues.length) return null;
  const index = (sortedValues.length - 1) * probability;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sortedValues[lower];
  const weight = index - lower;
  return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
}

function createRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function aggregateFourHour(hourly) {
  const rows = [];
  const byTime = new Map(hourly.map((row) => [row.openTime, row]));
  const first = Math.ceil((hourly[0]?.openTime || 0) / FOUR_HOURS) * FOUR_HOURS;
  const last = hourly.at(-1)?.openTime || 0;
  for (let openTime = first; openTime + 3 * HOUR <= last; openTime += FOUR_HOURS) {
    const group = [0, 1, 2, 3].map((offset) =>
      byTime.get(openTime + offset * HOUR)
    );
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

function loadMarketSeries(symbol) {
  const file = path.join(
    PRICE_CACHE,
    `${symbol}-${DATA_START}-${CACHE_END}.json`
  );
  if (!fs.existsSync(file)) {
    throw new Error(`Missing frozen price cache: ${file}`);
  }
  const hourly = readJson(file)
    .map((row) => ({
      openTime: Number(row.openTime),
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
      volume: Number(row.volume),
      quoteVolume: Number(row.quoteVolume)
    }))
    .filter((row) =>
      row.openTime >= DATA_START && row.openTime <= RESEARCH_END
    );
  const hourlyIndex = new Map(hourly.map((row, index) => [row.openTime, index]));
  const fourHour = aggregateFourHour(hourly);
  return { symbol, hourly, hourlyIndex, fourHour };
}

function loadFundingSeries(symbol) {
  const file = path.join(
    FUNDING_CACHE,
    `${symbol}-${DATA_START}-${CACHE_END}.json`
  );
  if (!fs.existsSync(file)) {
    throw new Error(
      `Missing funding cache: ${file}. Run scripts/download-v3-2-funding.ps1`
    );
  }
  const rows = readJson(file)
    .map((row) => ({
      fundingTime: Number(row.fundingTime),
      fundingRate: Number(row.fundingRate)
    }))
    .filter((row) =>
      Number.isFinite(row.fundingTime)
      && Number.isFinite(row.fundingRate)
      && row.fundingTime <= RESEARCH_END
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

function alignUp(value, interval) {
  return Math.ceil(value / interval) * interval;
}

function generatePortfolios(split, marketBySymbol) {
  const fourHourBySymbol = new Map(
    [...marketBySymbol].map(([symbol, series]) => [symbol, series.fourHour])
  );
  const signalWarmup = (
    V31_MODEL.lookbackHours
    + V31_MODEL.skipHours
    + 4
  ) * HOUR;
  const researchWarmup = VOLATILITY_WARMUP_DAYS * DAY + HOUR;
  const periods = [];
  let entryTime = alignUp(
    Math.max(split.start, DATA_START + signalWarmup, DATA_START + researchWarmup),
    WEEK
  );
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
      // Early listings can make a historical week ineligible.
    }
    entryTime += WEEK;
  }
  return periods;
}

function forecastPortfolioVolatility({
  period,
  lookbackDays,
  marketBySymbol
}) {
  if (!lookbackDays) return null;
  const closeTimes = Array.from(
    { length: lookbackDays + 1 },
    (_, index) =>
      period.entryTime
      - HOUR
      - (lookbackDays - index) * DAY
  );
  const closesBySymbol = new Map();
  for (const target of period.targets) {
    const market = marketBySymbol.get(target.symbol);
    const closes = closeTimes.map((time) => {
      const index = market.hourlyIndex.get(time);
      return Number.isInteger(index) ? market.hourly[index].close : null;
    });
    if (closes.some((close) => !(close > 0))) return null;
    closesBySymbol.set(target.symbol, closes);
  }
  const dailyReturns = [];
  for (let day = 1; day < closeTimes.length; day++) {
    let portfolioReturn = 0;
    for (const target of period.targets) {
      const closes = closesBySymbol.get(target.symbol);
      portfolioReturn += Number(target.targetWeight)
        * (closes[day] / closes[day - 1] - 1);
    }
    dailyReturns.push(portfolioReturn);
  }
  return sampleStandardDeviation(dailyReturns) * Math.sqrt(365);
}

function grossExposureFor(candidate, forecastVolatility) {
  if (!candidate.targetAnnualVolatility) return 1;
  if (!(forecastVolatility > 0)) return null;
  return Math.min(
    candidate.maximumGrossExposure,
    Math.max(
      MIN_GROSS_EXPOSURE,
      candidate.targetAnnualVolatility / forecastVolatility
    )
  );
}

function buildTargetRows(period, marketBySymbol, fundingBySymbol) {
  return period.targets.map((target) => {
    const market = marketBySymbol.get(target.symbol);
    const entryIndex = market.hourlyIndex.get(period.entryTime);
    const timeExitIndex = market.hourlyIndex.get(period.exitTime);
    const entryPrice = Number(target.referencePrice);
    if (
      !Number.isInteger(entryIndex)
      || !Number.isInteger(timeExitIndex)
      || !(entryPrice > 0)
    ) return null;
    return {
      target,
      market,
      funding: fundingBySymbol.get(target.symbol),
      entryIndex,
      timeExitIndex,
      entryPrice,
      direction: target.side === "LONG" ? 1 : -1,
      baseWeight: Math.abs(Number(target.targetWeight))
    };
  });
}

function markedPortfolioReturn({
  rows,
  period,
  candleTime,
  offset,
  grossExposure
}) {
  let markedReturn = -BASE_ROUND_TRIP_COST * grossExposure / 2;
  for (const row of rows) {
    const candle = row.market.hourly[row.entryIndex + offset];
    if (!candle || candle.openTime !== candleTime) return null;
    const priceReturn = row.direction * (candle.close / row.entryPrice - 1);
    const fundingReturn = -row.direction * fundingSum(
      row.funding,
      period.entryTime,
      candle.openTime
    );
    markedReturn += grossExposure
      * row.baseWeight
      * (priceReturn + fundingReturn);
  }
  return markedReturn;
}

function simulateTradePeriod({
  period,
  candidate,
  marketBySymbol,
  fundingBySymbol
}) {
  const forecastVolatility = forecastPortfolioVolatility({
    period,
    lookbackDays: candidate.volatilityLookbackDays,
    marketBySymbol
  });
  const grossExposure = grossExposureFor(candidate, forecastVolatility);
  if (!(grossExposure > 0)) return null;

  const rows = buildTargetRows(period, marketBySymbol, fundingBySymbol);
  if (rows.some((row) => !row)) return null;

  let actualExitTime = period.exitTime;
  let outcome = "time_exit";
  if (candidate.catastropheStop) {
    const steps = rows[0].timeExitIndex - rows[0].entryIndex;
    for (let offset = 0; offset < steps; offset++) {
      const candleTime = period.entryTime + offset * HOUR;
      const markedReturn = markedPortfolioReturn({
        rows,
        period,
        candleTime,
        offset,
        grossExposure
      });
      if (markedReturn == null) return null;
      if (markedReturn <= -candidate.catastropheStop) {
        actualExitTime = candleTime + HOUR;
        outcome = "catastrophe_stop";
        break;
      }
    }
  }

  const positions = rows.map((row) => {
    const exitIndex = row.market.hourlyIndex.get(actualExitTime);
    if (!Number.isInteger(exitIndex)) return null;
    const exitPrice = row.market.hourly[exitIndex].open;
    const priceReturn = row.direction * (exitPrice / row.entryPrice - 1);
    const fundingReturn = -row.direction * fundingSum(
      row.funding,
      period.entryTime,
      actualExitTime
    );
    return {
      symbol: row.target.symbol,
      side: row.target.side,
      weight: round(row.baseWeight * grossExposure),
      entryPrice: round(row.entryPrice, 12),
      exitPrice: round(exitPrice, 12),
      entryTime: period.entryTime,
      exitTime: actualExitTime,
      holdingHours: round((actualExitTime - period.entryTime) / HOUR, 4),
      outcome,
      priceReturn: round(priceReturn),
      fundingReturn: round(fundingReturn),
      grossReturn: round(priceReturn + fundingReturn)
    };
  });
  if (positions.some((position) => !position)) return null;

  return {
    entryTime: period.entryTime,
    exitTime: period.exitTime,
    actualExitTime,
    predictedBeta: round(period.predictedBeta * grossExposure, 12),
    forecastAnnualVolatility: round(forecastVolatility),
    grossExposure: round(grossExposure),
    grossReturn: round(positions.reduce(
      (sum, position) => sum + position.weight * position.grossReturn,
      0
    )),
    baseCost: round(grossExposure * BASE_ROUND_TRIP_COST),
    outcome,
    breakerTriggered: false,
    positions
  };
}

function applyBreaker(periods, candidate) {
  if (!candidate.breakerDrawdown) return periods;
  let equity = 1;
  let highWatermark = 1;
  let cooldownRemaining = 0;
  return periods.map((period) => {
    if (cooldownRemaining > 0) {
      cooldownRemaining -= 1;
      if (cooldownRemaining === 0) highWatermark = equity;
      return {
        ...period,
        actualExitTime: period.entryTime,
        forecastAnnualVolatility: null,
        grossExposure: 0,
        grossReturn: 0,
        baseCost: 0,
        outcome: "breaker_cash",
        positions: [],
        breakerTriggered: false,
        breakerCooldownRemaining: cooldownRemaining
      };
    }

    const netReturnAtTwoTimesCost =
      period.grossReturn - period.baseCost * 2;
    equity *= Math.max(0, 1 + netReturnAtTwoTimesCost);
    highWatermark = Math.max(highWatermark, equity);
    const drawdown = equity / highWatermark - 1;
    const breakerTriggered = drawdown <= -candidate.breakerDrawdown;
    if (breakerTriggered) {
      cooldownRemaining = candidate.breakerCooldownWeeks;
    }
    return {
      ...period,
      breakerTriggered,
      breakerDrawdown: round(drawdown),
      breakerCooldownRemaining: cooldownRemaining
    };
  });
}

function simulateCandidate(
  candidate,
  portfolios,
  marketBySymbol,
  fundingBySymbol
) {
  const periods = [];
  for (const period of portfolios) {
    const result = simulateTradePeriod({
      period,
      candidate,
      marketBySymbol,
      fundingBySymbol
    });
    if (result) periods.push(result);
  }
  return applyBreaker(periods, candidate);
}

function compoundedReturn(values) {
  return values.reduce(
    (equity, value) => equity * Math.max(0, 1 + value),
    1
  ) - 1;
}

function summarize(periods, costMultiplier) {
  if (!periods.length) return null;
  const returns = periods.map(
    (period) => period.grossReturn - period.baseCost * costMultiplier
  );
  let equity = 1;
  let peak = 1;
  let maxDrawdown = 0;
  let positiveSum = 0;
  let negativeSum = 0;
  const monthlyReturns = new Map();
  const halfYearValues = new Map();
  const quarterValues = new Map();
  for (let index = 0; index < periods.length; index++) {
    const value = returns[index];
    equity *= Math.max(0, 1 + value);
    peak = Math.max(peak, equity);
    maxDrawdown = Math.min(maxDrawdown, equity / peak - 1);
    if (value > 0) positiveSum += value;
    else negativeSum += value;
    const date = new Date(periods[index].entryTime);
    const month = date.toISOString().slice(0, 7);
    monthlyReturns.set(
      month,
      (monthlyReturns.get(month) || 1) * Math.max(0, 1 + value)
    );
    const half = `${date.getUTCFullYear()}H${date.getUTCMonth() < 6 ? 1 : 2}`;
    if (!halfYearValues.has(half)) halfYearValues.set(half, []);
    halfYearValues.get(half).push(value);
    const quarter = `${date.getUTCFullYear()}Q${
      Math.floor(date.getUTCMonth() / 3) + 1
    }`;
    if (!quarterValues.has(quarter)) quarterValues.set(quarter, []);
    quarterValues.get(quarter).push(value);
  }

  const average = mean(returns);
  const deviation = sampleStandardDeviation(returns);
  const durationDays = Math.max(
    1,
    (periods.at(-1).exitTime - periods[0].entryTime) / DAY
  );
  const symbolContribution = new Map();
  for (const period of periods) {
    for (const position of period.positions) {
      symbolContribution.set(
        position.symbol,
        (symbolContribution.get(position.symbol) || 0)
          + position.weight * position.grossReturn
      );
    }
  }
  const contributors = [...symbolContribution]
    .map(([symbol, value]) => ({ symbol, value: round(value) }))
    .sort((a, b) => b.value - a.value);
  const positiveContribution = contributors
    .filter((row) => row.value > 0)
    .reduce((sum, row) => sum + row.value, 0);
  const halfYearReturns = Object.fromEntries(
    [...halfYearValues].map(([half, values]) => [
      half,
      round(compoundedReturn(values))
    ])
  );
  const quarterReturns = Object.fromEntries(
    [...quarterValues].map(([quarter, values]) => [
      quarter,
      round(compoundedReturn(values))
    ])
  );

  return {
    observations: periods.length,
    totalReturn: round(equity - 1),
    cagr: round(equity ** (365 / durationDays) - 1),
    averageNetReturn: round(average),
    lowerConfidenceBound95: round(
      average - 1.96 * deviation / Math.sqrt(returns.length)
    ),
    winRate: round(returns.filter((value) => value > 0).length / returns.length),
    profitFactor: round(
      negativeSum < 0 ? positiveSum / Math.abs(negativeSum) : null
    ),
    sharpe: round(deviation > 0 ? average / deviation * Math.sqrt(52) : null),
    maxDrawdown: round(maxDrawdown),
    positiveMonthRate: round(
      [...monthlyReturns.values()].filter((value) => value > 1).length
        / monthlyReturns.size
    ),
    averageGrossExposure: round(mean(periods.map((period) => period.grossExposure))),
    averageActiveGrossExposure: round(mean(
      periods
        .filter((period) => period.grossExposure > 0)
        .map((period) => period.grossExposure)
    )),
    catastropheExits: periods.filter(
      (period) => period.outcome === "catastrophe_stop"
    ).length,
    breakerTriggers: periods.filter(
      (period) => period.breakerTriggered
    ).length,
    cashWeeks: periods.filter(
      (period) => period.outcome === "breaker_cash"
    ).length,
    averageHoldingHours: round(mean(
      periods
        .filter((period) => period.grossExposure > 0)
        .map((period) => (period.actualExitTime - period.entryTime) / HOUR)
    )),
    totalModeledCost: round(
      periods.reduce((sum, period) => sum + period.baseCost, 0) * costMultiplier
    ),
    halfYearReturns,
    positiveHalfYears: Object.values(halfYearReturns)
      .filter((value) => value > 0).length,
    quarterReturns,
    positiveQuarters: Object.values(quarterReturns)
      .filter((value) => value > 0).length,
    topPositiveContributorShare: round(
      positiveContribution > 0
        ? (contributors[0]?.value || 0) / positiveContribution
        : null
    ),
    topContributors: contributors.slice(0, 10)
  };
}

function summarizeAllCosts(periods) {
  return {
    cost1x: summarize(periods, 1),
    cost2x: summarize(periods, 2),
    cost3x: summarize(periods, 3)
  };
}

function blockBootstrap(periods, {
  costMultiplier = 2,
  iterations = 10_000,
  blockSize = 4,
  seed = 33
} = {}) {
  const returns = periods.map(
    (period) => period.grossReturn - period.baseCost * costMultiplier
  );
  const random = createRandom(seed);
  const totals = [];
  for (let iteration = 0; iteration < iterations; iteration++) {
    const sampled = [];
    while (sampled.length < returns.length) {
      const start = Math.floor(random() * returns.length);
      for (
        let offset = 0;
        offset < blockSize && sampled.length < returns.length;
        offset++
      ) {
        sampled.push(returns[(start + offset) % returns.length]);
      }
    }
    totals.push(compoundedReturn(sampled));
  }
  totals.sort((a, b) => a - b);
  return {
    iterations,
    blockSizeWeeks: blockSize,
    probabilityPositive: round(
      totals.filter((value) => value > 0).length / totals.length
    ),
    p05: round(percentile(totals, 0.05)),
    median: round(percentile(totals, 0.5)),
    p95: round(percentile(totals, 0.95))
  };
}

function exposureDistribution(periods) {
  const values = periods
    .map((period) => period.grossExposure)
    .filter((value) => value > 0)
    .sort((a, b) => a - b);
  return {
    minimum: round(values[0]),
    p25: round(percentile(values, 0.25)),
    median: round(percentile(values, 0.5)),
    p75: round(percentile(values, 0.75)),
    p95: round(percentile(values, 0.95)),
    maximum: round(values.at(-1))
  };
}

function changedPeriods(referencePeriods, candidatePeriods) {
  const referenceByTime = new Map(
    referencePeriods.map((period) => [period.entryTime, period])
  );
  return candidatePeriods
    .map((candidate) => {
      const reference = referenceByTime.get(candidate.entryTime);
      if (!reference) return null;
      const referenceNet =
        reference.grossReturn - reference.baseCost * 2;
      const candidateNet =
        candidate.grossReturn - candidate.baseCost * 2;
      if (
        Math.abs(referenceNet - candidateNet) < 1e-10
        && reference.outcome === candidate.outcome
      ) return null;
      return {
        entryDate: new Date(candidate.entryTime).toISOString().slice(0, 10),
        referenceOutcome: reference.outcome,
        candidateOutcome: candidate.outcome,
        referenceHoldingHours: round(
          (reference.actualExitTime - reference.entryTime) / HOUR,
          4
        ),
        candidateHoldingHours: round(
          (candidate.actualExitTime - candidate.entryTime) / HOUR,
          4
        ),
        referenceNetReturnCost2x: round(referenceNet),
        candidateNetReturnCost2x: round(candidateNet),
        difference: round(candidateNet - referenceNet)
      };
    })
    .filter(Boolean);
}

function leaveOneOutDiagnostics(periods) {
  const netReturns = periods.map(
    (period) => period.grossReturn - period.baseCost * 2
  );
  const rows = periods.map((excluded, excludedIndex) => {
    const remaining = periods.filter((_, index) => index !== excludedIndex);
    const remainingReturns = netReturns.filter(
      (_, index) => index !== excludedIndex
    );
    const halfYears = new Map();
    for (let index = 0; index < remaining.length; index++) {
      const date = new Date(remaining[index].entryTime);
      const half = `${date.getUTCFullYear()}H${
        date.getUTCMonth() < 6 ? 1 : 2
      }`;
      if (!halfYears.has(half)) halfYears.set(half, []);
      halfYears.get(half).push(remainingReturns[index]);
    }
    const halfYearReturns = Object.fromEntries(
      [...halfYears].map(([half, values]) => [
        half,
        compoundedReturn(values)
      ])
    );
    return {
      excludedDate: new Date(excluded.entryTime).toISOString().slice(0, 10),
      totalReturn: compoundedReturn(remainingReturns),
      bothValidationHalfYearsPositive:
        (halfYearReturns["2025H1"] || 0) > 0
        && (halfYearReturns["2025H2"] || 0) > 0
    };
  });
  return {
    removals: rows.length,
    allRemainProfitable: rows.every((row) => row.totalReturn > 0),
    minimumTotalReturn: round(Math.min(...rows.map((row) => row.totalReturn))),
    maximumTotalReturn: round(Math.max(...rows.map((row) => row.totalReturn))),
    bothValidationHalfYearsPositiveRate: round(
      rows.filter((row) => row.bothValidationHalfYearsPositive).length
        / rows.length
    ),
    halfYearFailures: rows
      .filter((row) => !row.bothValidationHalfYearsPositive)
      .map((row) => ({
        excludedDate: row.excludedDate,
        totalReturn: round(row.totalReturn)
      }))
  };
}

function selectionChecks(result, baseline) {
  const trainHalfYears = result.train.cost2x.halfYearReturns;
  const validationHalfYears = result.validation.cost2x.halfYearReturns;
  return {
    trainCost2Positive: result.train.cost2x.totalReturn > 0,
    validationBeatsBaseline:
      result.validation.cost2x.totalReturn
      > baseline.validation.cost2x.totalReturn,
    validationProfitFactor: result.validation.cost2x.profitFactor >= 1.15,
    validationDrawdownNoWorse:
      result.validation.cost2x.maxDrawdown
      >= baseline.validation.cost2x.maxDrawdown,
    validationCost3Nonnegative:
      result.validation.cost3x.totalReturn >= 0,
    bothValidationHalfYearsPositive:
      (validationHalfYears["2025H1"] || 0) > 0
      && (validationHalfYears["2025H2"] || 0) > 0,
    atLeastThreeTrainingHalfYearsPositive:
      ["2023H1", "2023H2", "2024H1", "2024H2"]
        .filter((half) => (trainHalfYears[half] || 0) > 0).length >= 3
  };
}

function scoreCandidate(result) {
  if (!Object.values(result.selectionChecks).every(Boolean)) return null;
  return descriptiveScore(result);
}

function descriptiveScore(result) {
  const train = result.train.cost2x;
  const validation = result.validation.cost2x;
  return round(
    Math.min(train.cagr, validation.cagr)
    + 0.15 * Math.min(train.sharpe || 0, validation.sharpe || 0)
    + 0.5 * Math.min(train.maxDrawdown, validation.maxDrawdown)
  );
}

function evaluateCandidate(
  candidate,
  portfoliosBySplit,
  marketBySymbol,
  fundingBySymbol,
  baseline
) {
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
  if (baseline) {
    result.selectionChecks = selectionChecks(result, baseline);
    result.passedCheckCount = Object.values(result.selectionChecks)
      .filter(Boolean).length;
    result.descriptiveScore = descriptiveScore(result);
    result.selectionScore = scoreCandidate(result);
  }
  return { result, periods: { train: trainPeriods, validation: validationPeriods } };
}

function rankStage(evaluations) {
  return [...evaluations].sort(
    (left, right) => {
      const scoreDifference =
        (right.result.selectionScore ?? -Infinity)
        - (left.result.selectionScore ?? -Infinity);
      if (Number.isFinite(scoreDifference) && scoreDifference !== 0) {
        return scoreDifference;
      }
      const checkDifference =
        (right.result.passedCheckCount || 0)
        - (left.result.passedCheckCount || 0);
      if (checkDifference !== 0) return checkDifference;
      return (right.result.descriptiveScore ?? -Infinity)
        - (left.result.descriptiveScore ?? -Infinity);
    }
  );
}

function publicEvaluation(evaluation) {
  return evaluation.result;
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

const baselineEvaluation = evaluateCandidate(
  BASELINE,
  portfoliosBySplit,
  marketBySymbol,
  fundingBySymbol,
  null
);
const baseline = baselineEvaluation.result;

const stage1Ranked = rankStage(VOLATILITY_CANDIDATES.map((candidate) =>
  evaluateCandidate(
    candidate,
    portfoliosBySplit,
    marketBySymbol,
    fundingBySymbol,
    baseline
  )
));
const stage1Selected = stage1Ranked.find(
  (evaluation) => evaluation.result.selectionScore != null
);
const stage1Anchor = stage1Selected || stage1Ranked[0] || null;

let stage2Ranked = [];
let stage2Selected = null;
let stage2Anchor = null;
let stage3Ranked = [];
let stage3Selected = null;
let stage3Anchor = null;
if (stage1Anchor) {
  const stage2Candidates = [null, 0.08, 0.1, 0.12, 0.15].map(
    (catastropheStop) => ({
      ...stage1Anchor.result.candidate,
      id: `${stage1Anchor.result.candidate.id}_cat_${
        catastropheStop == null ? "none" : catastropheStop
      }`,
      catastropheStop
    })
  );
  stage2Ranked = rankStage(stage2Candidates.map((candidate) =>
    evaluateCandidate(
      candidate,
      portfoliosBySplit,
      marketBySymbol,
      fundingBySymbol,
      baseline
    )
  ));
  stage2Selected = stage2Ranked.find(
    (evaluation) => evaluation.result.selectionScore != null
  );
  stage2Anchor = stage2Selected || stage2Ranked[0] || null;
}

if (stage2Anchor) {
  const breakerOptions = [
    { breakerDrawdown: null, breakerCooldownWeeks: 0 },
    ...[0.1, 0.15, 0.2].flatMap((breakerDrawdown) =>
      [2, 4].map((breakerCooldownWeeks) => ({
        breakerDrawdown,
        breakerCooldownWeeks
      }))
    )
  ];
  const stage3Candidates = breakerOptions.map((option) => ({
    ...stage2Anchor.result.candidate,
    ...option,
    id: `${stage2Anchor.result.candidate.id}_breaker_${
      option.breakerDrawdown == null
        ? "none"
        : `${option.breakerDrawdown}_${option.breakerCooldownWeeks}w`
    }`
  }));
  stage3Ranked = rankStage(stage3Candidates.map((candidate) =>
    evaluateCandidate(
      candidate,
      portfoliosBySplit,
      marketBySymbol,
      fundingBySymbol,
      baseline
    )
  ));
  stage3Selected = stage3Ranked.find(
    (evaluation) => evaluation.result.selectionScore != null
  );
  stage3Anchor = stage3Selected || stage3Ranked[0] || null;
}

const finalEvaluation = stage3Selected || stage2Selected || stage1Selected;
const diagnosticEvaluation =
  finalEvaluation || stage3Anchor || stage2Anchor || stage1Anchor;
const bootstrap = finalEvaluation
  ? {
      baselineValidation: blockBootstrap(
        baselineEvaluation.periods.validation,
        { seed: 31 }
      ),
      candidateValidation: blockBootstrap(
        finalEvaluation.periods.validation,
        { seed: 33 }
      )
    }
  : null;
const diagnosticBootstrap = !finalEvaluation && diagnosticEvaluation
  ? {
      baselineValidation: blockBootstrap(
        baselineEvaluation.periods.validation,
        { seed: 31 }
      ),
      candidateValidation: blockBootstrap(
        diagnosticEvaluation.periods.validation,
        { seed: 33 }
      )
    }
  : null;
const finalResearchGate = finalEvaluation ? {
  validationReturnBeatsBaseline:
    finalEvaluation.result.validation.cost2x.totalReturn
    > baseline.validation.cost2x.totalReturn,
  validationProfitFactorBeatsBaseline:
    finalEvaluation.result.validation.cost2x.profitFactor
    > baseline.validation.cost2x.profitFactor,
  validationDrawdownWithin12Percent:
    finalEvaluation.result.validation.cost2x.maxDrawdown >= -0.12,
  bootstrapProbabilityAtLeast80Percent:
    bootstrap.candidateValidation.probabilityPositive >= 0.8,
  topContributorShareBelow40Percent:
    finalEvaluation.result.validation.cost2x.topPositiveContributorShare < 0.4,
  bothValidationHalfYearsPositive:
    Object.values(
      finalEvaluation.result.selectionChecks
        ? {
            h1: finalEvaluation.result.validation.cost2x
              .halfYearReturns["2025H1"] > 0,
            h2: finalEvaluation.result.validation.cost2x
              .halfYearReturns["2025H2"] > 0
          }
        : {}
    ).every(Boolean)
} : null;

const researchPassed = finalResearchGate
  ? Object.values(finalResearchGate).every(Boolean)
  : false;
const bootstrapSensitivity = finalEvaluation
  ? Object.fromEntries([2, 4, 8, 13].map((blockSize) => [
      `${blockSize}w`,
      {
        baseline: blockBootstrap(
          baselineEvaluation.periods.validation,
          { blockSize, seed: 31 + blockSize }
        ),
        candidate: blockBootstrap(
          finalEvaluation.periods.validation,
          { blockSize, seed: 33 + blockSize }
        )
      }
    ]))
  : null;
const ablation = {
  baseline: {
    candidate: baseline.candidate,
    train: baseline.train,
    validation: baseline.validation
  },
  volatilityTarget: stage1Selected ? stage1Selected.result : null,
  catastropheStop: stage2Selected ? stage2Selected.result : null,
  drawdownBreaker: stage3Selected ? stage3Selected.result : null
};
const mechanismDiagnostics = {
  validationExposureDistribution: finalEvaluation
    ? exposureDistribution(finalEvaluation.periods.validation)
    : null,
  validationLeaveOneWeekOut: finalEvaluation
    ? leaveOneOutDiagnostics(finalEvaluation.periods.validation)
    : null,
  catastropheChangedValidationWeeks:
    stage1Selected && stage2Selected
      ? changedPeriods(
          stage1Selected.periods.validation,
          stage2Selected.periods.validation
        )
      : [],
  breakerChangedTrainingWeeks:
    stage2Selected && stage3Selected
      ? changedPeriods(
          stage2Selected.periods.train,
          stage3Selected.periods.train
        )
      : [],
  breakerChangedValidationWeeks:
    stage2Selected && stage3Selected
      ? changedPeriods(
          stage2Selected.periods.validation,
          stage3Selected.periods.validation
        )
      : []
};
const result = {
  generatedAt: new Date().toISOString(),
  protocol: "docs/V3_3_RISK_CONTROL_PROTOCOL_2026-07-25.md",
  researchWindow: {
    start: new Date(DATA_START).toISOString(),
    endExclusive: new Date(RESEARCH_END).toISOString(),
    explicitlyExcludedFromSelection: "2026-01-01 onward",
    hasNewFrozenHistoricalTest: false
  },
  data: {
    symbols: V31_MODEL.universe,
    fundingRecords: Object.fromEntries(
      [...fundingBySymbol].map(([symbol, series]) => [symbol, series.count])
    ),
    portfolios: Object.fromEntries(
      Object.entries(portfoliosBySplit).map(([name, periods]) => [
        name,
        periods.length
      ])
    )
  },
  baseline,
  stages: {
    volatilityTarget: {
      selected: stage1Selected ? publicEvaluation(stage1Selected) : null,
      diagnosticAnchor: stage1Anchor ? publicEvaluation(stage1Anchor) : null,
      ranking: stage1Ranked.slice(0, 12).map(publicEvaluation)
    },
    catastropheStop: {
      selected: stage2Selected ? publicEvaluation(stage2Selected) : null,
      diagnosticAnchor: stage2Anchor ? publicEvaluation(stage2Anchor) : null,
      ranking: stage2Ranked.map(publicEvaluation)
    },
    drawdownBreaker: {
      selected: stage3Selected ? publicEvaluation(stage3Selected) : null,
      diagnosticAnchor: stage3Anchor ? publicEvaluation(stage3Anchor) : null,
      ranking: stage3Ranked.map(publicEvaluation)
    }
  },
  finalCandidate: finalEvaluation ? finalEvaluation.result : null,
  diagnosticCandidate:
    diagnosticEvaluation && !finalEvaluation
      ? diagnosticEvaluation.result
      : null,
  bootstrap,
  bootstrapSensitivity,
  diagnosticBootstrap,
  ablation,
  mechanismDiagnostics,
  finalResearchGate: {
    passed: researchPassed,
    checks: finalResearchGate
  },
  deploymentGate: {
    passed: false,
    reason: researchPassed
      ? "Research candidate lacks a new untouched historical test and requires 52 forward PAPER weeks"
      : "Research stability gates failed"
  }
};

fs.writeFileSync(OUTPUT, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({
  output: OUTPUT,
  data: result.data,
  baseline: {
    train: baseline.train.cost2x,
    validation: baseline.validation.cost2x
  },
  selectedStages: {
    volatilityTarget: result.stages.volatilityTarget.selected?.candidate || null,
    catastropheStop: result.stages.catastropheStop.selected?.candidate || null,
    drawdownBreaker: result.stages.drawdownBreaker.selected?.candidate || null
  },
  diagnosticAnchors: {
    volatilityTarget:
      result.stages.volatilityTarget.diagnosticAnchor?.candidate || null,
    catastropheStop:
      result.stages.catastropheStop.diagnosticAnchor?.candidate || null,
    drawdownBreaker:
      result.stages.drawdownBreaker.diagnosticAnchor?.candidate || null
  },
  finalCandidate: result.finalCandidate,
  diagnosticCandidate: result.diagnosticCandidate,
  bootstrap,
  bootstrapSensitivity,
  diagnosticBootstrap,
  mechanismDiagnostics,
  finalResearchGate: result.finalResearchGate,
  deploymentGate: result.deploymentGate
}, null, 2));
