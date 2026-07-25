import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const CACHE_DIR = path.join(ROOT, ".backtest-cache", "binance-futures-1h");
const SOURCE_FILE = path.join(ROOT, "production_dynamic_backtest.json");
const SELECTION_OUTPUT = path.join(ROOT, "robust_alpha_selection_2026-07-25.json");
const FINAL_OUTPUT = path.join(ROOT, "robust_alpha_research_2026-07-25.json");
const PERIODS_OUTPUT = path.join(ROOT, "robust_alpha_periods_2026-07-25.json");
const LEAVE_ONE_OUT_OUTPUT = path.join(
  ROOT,
  "v3_leave_one_out_validation_2026-07-25.json"
);
const INCLUDE_TEST = process.argv.includes("--include-test");
const EXPORT_PERIODS = process.argv.includes("--export-periods");
const LEAVE_ONE_OUT = process.argv.includes("--leave-one-out");

const HOUR = 3_600_000;
const DATA_START = Date.parse("2023-01-01T00:00:00Z");
const DATA_END = Date.parse("2026-07-01T00:00:00Z");
const BASE_ROUND_TRIP_COST = 0.0012;
const MIN_24H_QUOTE_VOLUME = 50_000_000;
const VOLATILITY_WINDOW_HOURS = 168;

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

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function round(value, digits = 6) {
  if (value == null || !Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}

function mean(values) {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;
}

function sampleStandardDeviation(values, average = mean(values)) {
  if (values.length < 2 || average == null) return 0;
  return Math.sqrt(
    values.reduce((sum, value) => sum + (value - average) ** 2, 0)
      / (values.length - 1)
  );
}

function loadSeries(symbol) {
  const exactFile = path.join(
    CACHE_DIR,
    `${symbol}-${DATA_START}-${DATA_END}.json`
  );
  if (!fs.existsSync(exactFile)) {
    throw new Error(`Missing frozen candle file for ${symbol}: ${exactFile}`);
  }

  const candles = readJson(exactFile).map((row) => ({
    openTime: Number(row.openTime),
    open: Number(row.open),
    close: Number(row.close),
    quoteVolume: Number(row.quoteVolume)
  }));

  const logReturns = new Array(candles.length).fill(0);
  const returnPrefix = new Array(candles.length + 1).fill(0);
  const returnSquarePrefix = new Array(candles.length + 1).fill(0);
  const volumePrefix = new Array(candles.length + 1).fill(0);

  for (let index = 0; index < candles.length; index++) {
    if (index > 0 && candles[index - 1].close > 0 && candles[index].close > 0) {
      logReturns[index] = Math.log(candles[index].close / candles[index - 1].close);
    }
    returnPrefix[index + 1] = returnPrefix[index] + logReturns[index];
    returnSquarePrefix[index + 1]
      = returnSquarePrefix[index] + logReturns[index] ** 2;
    volumePrefix[index + 1]
      = volumePrefix[index] + Math.max(0, candles[index].quoteVolume || 0);
  }

  const byTime = new Map();
  for (let index = 0; index < candles.length; index++) {
    const volumeStart = Math.max(0, index - 23);
    const volatilityStart = Math.max(1, index - VOLATILITY_WINDOW_HOURS + 1);
    const volatilityCount = index - volatilityStart + 1;
    const sum = returnPrefix[index + 1] - returnPrefix[volatilityStart];
    const sumSquares = returnSquarePrefix[index + 1]
      - returnSquarePrefix[volatilityStart];
    const variance = volatilityCount > 1
      ? Math.max(0, (sumSquares - sum ** 2 / volatilityCount) / (volatilityCount - 1))
      : 0;
    byTime.set(candles[index].openTime, {
      ...candles[index],
      quoteVolume24h: volumePrefix[index + 1] - volumePrefix[volumeStart],
      volatility168h: Math.sqrt(variance)
    });
  }

  return {
    symbol,
    firstTime: candles[0]?.openTime,
    lastTime: candles.at(-1)?.openTime,
    count: candles.length,
    byTime
  };
}

function buildCandidates() {
  const candidates = [];

  for (const lookbackHours of [24, 72, 168, 336, 720, 1440]) {
    for (const skipHours of [0, 4, 12]) {
      if (skipHours >= lookbackHours) continue;
      const rebalanceOptions = lookbackHours >= 720 ? [24, 72, 168] : [8, 24];
      for (const rebalanceHours of rebalanceOptions) {
        for (const positionsPerSide of [3, 5]) {
          candidates.push({
            family: "cross_sectional_momentum",
            lookbackHours,
            skipHours,
            rebalanceHours,
            positionsPerSide
          });
        }
      }
    }
  }

  for (const lookbackHours of [12, 24, 48]) {
    for (const rebalanceHours of [4, 8, 24]) {
      for (const positionsPerSide of [3, 5]) {
        candidates.push({
          family: "cross_sectional_reversal",
          lookbackHours,
          skipHours: 0,
          rebalanceHours,
          positionsPerSide
        });
      }
    }
  }

  for (const lookbackHours of [72, 168, 336, 720, 1440]) {
    for (const rebalanceHours of [24, 72]) {
      for (const positionCount of [5, 10]) {
        for (const minimumTrendZ of [0, 0.5]) {
          candidates.push({
            family: "time_series_trend",
            lookbackHours,
            skipHours: 4,
            rebalanceHours,
            positionCount,
            minimumTrendZ
          });
        }
      }
    }
  }

  for (const lookbackHours of [168, 336, 720, 1440]) {
    for (const rebalanceHours of [24, 72]) {
      for (const positionCount of [3, 5]) {
        for (const minimumRegimeZ of [0, 0.5]) {
          candidates.push({
            family: "btc_regime_momentum",
            lookbackHours,
            skipHours: 4,
            rebalanceHours,
            positionCount,
            minimumRegimeZ
          });
        }
      }
    }
  }

  return candidates.map((candidate) => ({
    id: [
      candidate.family,
      `lb${candidate.lookbackHours}`,
      `skip${candidate.skipHours}`,
      `reb${candidate.rebalanceHours}`,
      `n${candidate.positionsPerSide || candidate.positionCount}`,
      `z${candidate.minimumTrendZ ?? candidate.minimumRegimeZ ?? 0}`
    ].join("_"),
    ...candidate
  }));
}

function featureRow(symbol, series, signalTime, candidate) {
  const endTime = signalTime - candidate.skipHours * HOUR;
  const startTime = signalTime - candidate.lookbackHours * HOUR;
  const current = series.byTime.get(signalTime);
  const start = series.byTime.get(startTime);
  const end = series.byTime.get(endTime);
  if (!current || !start || !end || start.close <= 0 || end.close <= 0) return null;
  if (
    current.quoteVolume24h < MIN_24H_QUOTE_VOLUME
    || current.volatility168h <= 0
  ) return null;

  const rawMomentum = end.close / start.close - 1;
  return {
    symbol,
    rawMomentum,
    score: rawMomentum / current.volatility168h,
    trendZ: rawMomentum
      / (current.volatility168h * Math.sqrt(candidate.lookbackHours - candidate.skipHours))
  };
}

function selectWeights(rows, candidate, btcRegime) {
  if (candidate.family === "cross_sectional_momentum"
    || candidate.family === "cross_sectional_reversal") {
    const count = candidate.positionsPerSide;
    if (rows.length < count * 2) return null;
    const direction = candidate.family === "cross_sectional_reversal" ? -1 : 1;
    const ranked = rows
      .map((row) => ({ ...row, selectionScore: row.score * direction }))
      .sort((a, b) => a.selectionScore - b.selectionScore);
    const shorts = ranked.slice(0, count);
    const longs = ranked.slice(-count);
    const weights = new Map();
    for (const row of longs) weights.set(row.symbol, 0.5 / count);
    for (const row of shorts) weights.set(row.symbol, -0.5 / count);
    return weights;
  }

  if (candidate.family === "time_series_trend") {
    const selected = [...rows]
      .filter((row) =>
        row.rawMomentum !== 0
        && Math.abs(row.trendZ) >= candidate.minimumTrendZ
      )
      .sort((a, b) => Math.abs(b.score) - Math.abs(a.score))
      .slice(0, candidate.positionCount);
    if (selected.length < candidate.positionCount) return null;
    return new Map(selected.map((row) => [
      row.symbol,
      Math.sign(row.rawMomentum) / selected.length
    ]));
  }

  if (candidate.family === "btc_regime_momentum") {
    if (
      !Number.isFinite(btcRegime?.rawMomentum)
      || btcRegime.rawMomentum === 0
      || Math.abs(btcRegime.trendZ) < candidate.minimumRegimeZ
    ) return null;
    const isBull = btcRegime.rawMomentum > 0;
    const ranked = [...rows].sort((a, b) => a.score - b.score);
    const eligible = isBull
      ? ranked.filter((row) => row.rawMomentum > 0).slice(-candidate.positionCount)
      : ranked.filter((row) => row.rawMomentum < 0).slice(0, candidate.positionCount);
    if (eligible.length < candidate.positionCount) return null;
    const weight = (isBull ? 1 : -1) / eligible.length;
    return new Map(eligible.map((row) => [row.symbol, weight]));
  }

  return null;
}

function calculatePeriod(
  signalTime,
  entryTime,
  exitTime,
  candidate,
  symbols,
  seriesBySymbol
) {
  const rows = [];
  for (const symbol of symbols) {
    const row = featureRow(
      symbol,
      seriesBySymbol.get(symbol),
      signalTime,
      candidate
    );
    if (row) rows.push(row);
  }

  const btcRow = featureRow(
    "BTCUSDT",
    seriesBySymbol.get("BTCUSDT"),
    signalTime,
    candidate
  );
  const weights = selectWeights(rows, candidate, btcRow);
  if (!weights) return null;

  let rawReturn = 0;
  const positions = [];
  for (const [symbol, weight] of weights) {
    const series = seriesBySymbol.get(symbol);
    const entry = series.byTime.get(entryTime);
    const exit = series.byTime.get(exitTime);
    if (!entry || !exit || entry.open <= 0 || exit.open <= 0) return null;
    const assetReturn = exit.open / entry.open - 1;
    rawReturn += weight * assetReturn;
    const delayedReturns = {};
    for (const delayHours of [1, 4]) {
      const delayedEntry = series.byTime.get(entryTime + delayHours * HOUR);
      const delayedExit = series.byTime.get(exitTime + delayHours * HOUR);
      delayedReturns[`${delayHours}h`] = delayedEntry
        && delayedExit
        && delayedEntry.open > 0
        && delayedExit.open > 0
        ? delayedExit.open / delayedEntry.open - 1
        : null;
    }
    positions.push({ symbol, weight, assetReturn, delayedReturns });
  }

  const benchmarkSeries = seriesBySymbol.get("BTCUSDT");
  const benchmarkEntry = benchmarkSeries.byTime.get(entryTime);
  const benchmarkExit = benchmarkSeries.byTime.get(exitTime);
  const benchmarkReturns = {
    baseline: benchmarkEntry && benchmarkExit
      ? benchmarkExit.open / benchmarkEntry.open - 1
      : null
  };
  for (const delayHours of [1, 4]) {
    const delayedEntry = benchmarkSeries.byTime.get(entryTime + delayHours * HOUR);
    const delayedExit = benchmarkSeries.byTime.get(exitTime + delayHours * HOUR);
    benchmarkReturns[`${delayHours}h`] = delayedEntry && delayedExit
      ? delayedExit.open / delayedEntry.open - 1
      : null;
  }

  return {
    signalTime,
    entryTime,
    exitTime,
    rawReturn,
    benchmarkReturns,
    positions
  };
}

function alignEntryTime(startTime, rebalanceHours) {
  const interval = rebalanceHours * HOUR;
  return Math.ceil(startTime / interval) * interval;
}

function generatePeriods(candidate, split, symbols, seriesBySymbol) {
  const periods = [];
  const interval = candidate.rebalanceHours * HOUR;
  const warmup = Math.max(candidate.lookbackHours, VOLATILITY_WINDOW_HOURS) * HOUR;
  let entryTime = alignEntryTime(Math.max(split.start, DATA_START + warmup), candidate.rebalanceHours);

  while (entryTime + interval <= split.end) {
    const signalTime = entryTime - HOUR;
    const period = calculatePeriod(
      signalTime,
      entryTime,
      entryTime + interval,
      candidate,
      symbols,
      seriesBySymbol
    );
    if (period) periods.push(period);
    entryTime += interval;
  }
  return periods;
}

function summarizePeriods(periods, costMultiplier, rebalanceHours) {
  const oneWayCost = BASE_ROUND_TRIP_COST / 2 * costMultiplier;
  const netReturns = [];
  const turnovers = [];
  let priorWeights = new Map();
  for (let index = 0; index < periods.length; index++) {
    const targetWeights = new Map(
      periods[index].positions.map((position) => [position.symbol, position.weight])
    );
    const allSymbols = new Set([...priorWeights.keys(), ...targetWeights.keys()]);
    let turnover = 0;
    for (const symbol of allSymbols) {
      turnover += Math.abs(
        (targetWeights.get(symbol) || 0) - (priorWeights.get(symbol) || 0)
      );
    }
    if (index === periods.length - 1) {
      turnover += [...targetWeights.values()]
        .reduce((sum, weight) => sum + Math.abs(weight), 0);
    }
    turnovers.push(turnover);
    netReturns.push(periods[index].rawReturn - oneWayCost * turnover);
    priorWeights = targetWeights;
  }
  if (!netReturns.length) {
    return {
      periods: 0,
      totalReturn: null,
      cagr: null,
      averageNetReturn: null,
      winRate: null,
      profitFactor: null,
      sharpe: null,
      maxDrawdown: null,
      positiveMonthRate: null,
      months: 0
    };
  }

  let equity = 1;
  let grossEquity = 1;
  let peak = 1;
  let maxDrawdown = 0;
  let positiveSum = 0;
  let negativeSum = 0;
  const monthly = new Map();

  for (let index = 0; index < periods.length; index++) {
    const netReturn = netReturns[index];
    grossEquity *= Math.max(0, 1 + periods[index].rawReturn);
    equity *= Math.max(0, 1 + netReturn);
    peak = Math.max(peak, equity);
    maxDrawdown = Math.min(maxDrawdown, equity / peak - 1);
    if (netReturn > 0) positiveSum += netReturn;
    else negativeSum += netReturn;
    const month = new Date(periods[index].entryTime).toISOString().slice(0, 7);
    monthly.set(month, (monthly.get(month) || 1) * Math.max(0, 1 + netReturn));
  }

  const average = mean(netReturns);
  const averageRawReturn = mean(periods.map((period) => period.rawReturn));
  const standardDeviation = sampleStandardDeviation(netReturns, average);
  const startTime = periods[0].entryTime;
  const endTime = periods.at(-1).exitTime;
  const durationDays = Math.max(1, (endTime - startTime) / 86_400_000);
  const positiveMonths = [...monthly.values()].filter((value) => value > 1).length;
  const annualPeriods = 365.25 * 24 / rebalanceHours;

  return {
    periods: periods.length,
    totalReturn: round(equity - 1),
    grossTotalReturn: round(grossEquity - 1),
    cagr: equity > 0 ? round(equity ** (365.25 / durationDays) - 1) : null,
    averageRawReturn: round(averageRawReturn),
    averageNetReturn: round(average),
    lowerConfidenceBound95: round(
      average - 1.96 * standardDeviation / Math.sqrt(netReturns.length)
    ),
    winRate: round(netReturns.filter((value) => value > 0).length / netReturns.length),
    profitFactor: negativeSum < 0 ? round(positiveSum / Math.abs(negativeSum)) : null,
    sharpe: standardDeviation > 0
      ? round(average / standardDeviation * Math.sqrt(annualPeriods))
      : null,
    maxDrawdown: round(maxDrawdown),
    positiveMonthRate: round(positiveMonths / monthly.size),
    months: monthly.size,
    byMonth: Object.fromEntries(
      [...monthly.entries()].map(([month, value]) => [month, round(value - 1)])
    ),
    averageTurnover: round(mean(turnovers)),
    totalModeledCost: round(
      turnovers.reduce((sum, turnover) => sum + turnover * oneWayCost, 0)
    ),
    assumedOneWayCost: oneWayCost
  };
}

function evaluateCandidate(candidate, split, symbols, seriesBySymbol) {
  const periods = generatePeriods(candidate, split, symbols, seriesBySymbol);
  return {
    cost1x: summarizePeriods(periods, 1, candidate.rebalanceHours),
    cost2x: summarizePeriods(periods, 2, candidate.rebalanceHours),
    periods
  };
}

function stabilityKey(candidate) {
  return [
    candidate.family,
    `reb${candidate.rebalanceHours}`,
    `n${candidate.positionsPerSide || candidate.positionCount}`
  ].join("_");
}

function conservativeScore(result) {
  const train = result.train.cost2x;
  const validation = result.validation.cost2x;
  if (train.cagr == null || validation.cagr == null) return -Infinity;
  return Math.min(train.cagr, validation.cagr)
    + 0.1 * Math.min(train.sharpe || 0, validation.sharpe || 0)
    + 0.05 * Math.min(
      train.positiveMonthRate || 0,
      validation.positiveMonthRate || 0
    );
}

function meetsResearchGate(result) {
  const train = result.train;
  const validation = result.validation;
  return train.cost1x.totalReturn > 0
    && validation.cost1x.totalReturn > 0
    && train.cost2x.totalReturn > 0
    && validation.cost2x.totalReturn > 0
    && train.cost2x.profitFactor > 1
    && validation.cost2x.profitFactor > 1
    && train.cost1x.maxDrawdown > -0.35
    && validation.cost1x.maxDrawdown > -0.25;
}

function summarizeResult(result) {
  return {
    candidate: result.candidate,
    researchGate: result.researchGate,
    stability: result.stability,
    conservativeScore: round(result.conservativeScore),
    train: result.train,
    validation: result.validation
  };
}

function selectionFingerprint(candidate) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(candidate))
    .digest("hex");
}

const source = readJson(SOURCE_FILE);
const symbols = [...source.symbols];
if (!symbols.includes("BTCUSDT")) {
  throw new Error("BTCUSDT is required for regime calculation");
}

const seriesBySymbol = new Map(
  symbols.map((symbol) => [symbol, loadSeries(symbol)])
);
const candidates = buildCandidates();
const results = [];

for (const candidate of candidates) {
  const train = evaluateCandidate(
    candidate,
    SPLITS.train,
    symbols,
    seriesBySymbol
  );
  const validation = evaluateCandidate(
    candidate,
    SPLITS.validation,
    symbols,
    seriesBySymbol
  );
  results.push({
    candidate,
    train: { cost1x: train.cost1x, cost2x: train.cost2x },
    validation: { cost1x: validation.cost1x, cost2x: validation.cost2x }
  });
}

const stabilityGroups = new Map();
for (const result of results) {
  const key = stabilityKey(result.candidate);
  const group = stabilityGroups.get(key) || [];
  group.push(result);
  stabilityGroups.set(key, group);
}

for (const result of results) {
  const group = stabilityGroups.get(stabilityKey(result.candidate));
  const positiveAt2x = group.filter((item) =>
    item.train.cost2x.totalReturn > 0 && item.validation.cost2x.totalReturn > 0
  ).length;
  result.researchGate = meetsResearchGate(result);
  result.stability = {
    group: stabilityKey(result.candidate),
    candidates: group.length,
    positiveTrainAndValidationAt2x: positiveAt2x,
    positiveRate: round(positiveAt2x / group.length),
    passed: positiveAt2x / group.length >= 0.5
  };
  result.conservativeScore = conservativeScore(result);
}

const ranked = [...results].sort(
  (a, b) => b.conservativeScore - a.conservativeScore
);
const strictCandidates = ranked.filter(
  (result) => result.researchGate && result.stability.passed
);
const gatedCandidates = ranked.filter((result) => result.researchGate);
const selectedResult = strictCandidates[0] || gatedCandidates[0] || ranked[0];
const selectionTier = strictCandidates.length
  ? "research_gate_and_stability"
  : gatedCandidates.length
    ? "research_gate_only"
    : "fallback_only_not_deployable";

const selection = {
  generatedAt: new Date().toISOString(),
  methodology: {
    objective: "Maximize the weaker of train and validation performance after 2x costs",
    noLookahead: "Signals use closed hour t; entries use hour t+1 open",
    universe: "Frozen 20-symbol production universe with point-in-time liquidity filtering",
    liquidityFilter: {
      minimumTrailing24hQuoteVolume: MIN_24H_QUOTE_VOLUME
    },
    grossExposure: 1,
    leverage: 1,
    costModel: {
      baseRoundTripCost: BASE_ROUND_TRIP_COST,
      conservativeSelectionCost: BASE_ROUND_TRIP_COST * 2,
      note: "Costs are charged on actual target-weight turnover; funding is unavailable"
    },
    splits: SPLITS,
    candidateCount: candidates.length,
    testReadDuringSelection: false
  },
  dataCoverage: [...seriesBySymbol.values()].map((series) => ({
    symbol: series.symbol,
    start: new Date(series.firstTime).toISOString(),
    end: new Date(series.lastTime).toISOString(),
    candles: series.count
  })),
  selectionTier,
  strictCandidateCount: strictCandidates.length,
  researchGateCandidateCount: gatedCandidates.length,
  selected: {
    candidate: selectedResult.candidate,
    fingerprint: selectionFingerprint(selectedResult.candidate),
    researchGate: selectedResult.researchGate,
    stability: selectedResult.stability,
    conservativeScore: round(selectedResult.conservativeScore),
    train: selectedResult.train,
    validation: selectedResult.validation
  },
  topCandidates: ranked.slice(0, 15).map(summarizeResult)
};

fs.writeFileSync(SELECTION_OUTPUT, `${JSON.stringify(selection, null, 2)}\n`);
console.log(JSON.stringify({
  output: SELECTION_OUTPUT,
  selectionTier,
  strictCandidateCount: strictCandidates.length,
  researchGateCandidateCount: gatedCandidates.length,
  selected: selection.selected
}, null, 2));

if (EXPORT_PERIODS) {
  const periodsBySplit = Object.fromEntries(
    Object.entries(SPLITS).map(([name, split]) => [
      name,
      generatePeriods(
        selectedResult.candidate,
        split,
        symbols,
        seriesBySymbol
      )
    ])
  );
  fs.writeFileSync(PERIODS_OUTPUT, `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    candidate: selectedResult.candidate,
    fingerprint: selection.selected.fingerprint,
    splits: SPLITS,
    periodsBySplit
  })}\n`);
  console.log(JSON.stringify({
    output: PERIODS_OUTPUT,
    periods: Object.fromEntries(
      Object.entries(periodsBySplit).map(([name, periods]) => [name, periods.length])
    )
  }, null, 2));
}

if (LEAVE_ONE_OUT) {
  const byExcludedSymbol = {};
  for (const excludedSymbol of symbols) {
    const reducedUniverse = symbols.filter((symbol) => symbol !== excludedSymbol);
    byExcludedSymbol[excludedSymbol] = Object.fromEntries(
      Object.entries(SPLITS).map(([name, split]) => {
        const periods = generatePeriods(
          selectedResult.candidate,
          split,
          reducedUniverse,
          seriesBySymbol
        );
        return [name, {
          cost1x: summarizePeriods(
            periods,
            1,
            selectedResult.candidate.rebalanceHours
          ),
          cost2x: summarizePeriods(
            periods,
            2,
            selectedResult.candidate.rebalanceHours
          )
        }];
      })
    );
  }
  fs.writeFileSync(LEAVE_ONE_OUT_OUTPUT, `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    candidate: selectedResult.candidate,
    fingerprint: selection.selected.fingerprint,
    note: "Price returns plus modeled turnover costs; funding is excluded",
    byExcludedSymbol
  }, null, 2)}\n`);
  console.log(JSON.stringify({
    output: LEAVE_ONE_OUT_OUTPUT,
    excludedSymbols: Object.keys(byExcludedSymbol).length
  }, null, 2));
}

if (INCLUDE_TEST) {
  const test = evaluateCandidate(
    selectedResult.candidate,
    SPLITS.test,
    symbols,
    seriesBySymbol
  );
  const deploymentGate = selectedResult.researchGate
    && selectedResult.stability.passed
    && test.cost1x.totalReturn > 0
    && test.cost1x.profitFactor > 1
    && test.cost2x.totalReturn > 0
    && test.cost2x.profitFactor > 1
    && test.cost1x.maxDrawdown > -0.20;
  const final = {
    ...selection,
    testWasFrozenUntilAfterSelection: true,
    frozenTest: {
      cost1x: test.cost1x,
      cost2x: test.cost2x,
      cost3x: summarizePeriods(test.periods, 3, selectedResult.candidate.rebalanceHours)
    },
    deploymentGate: {
      passed: deploymentGate,
      requirements: [
        "Passed train/validation research gate",
        "At least 50% of parameter-family variants profitable in train and validation at 2x costs",
        "Frozen test profitable with profit factor above 1 at 1x and 2x costs",
        "Frozen test max drawdown better than -20%"
      ]
    },
    caveats: [
      "The symbol list is today's production universe, so delisted losers are absent (survivorship bias)",
      "Historical funding rates are not available in the local cache",
      "Market impact is approximated by elevated all-in costs rather than order-book replay",
      "A positive backtest is not a guarantee of future profit"
    ]
  };
  fs.writeFileSync(FINAL_OUTPUT, `${JSON.stringify(final, null, 2)}\n`);
  console.log(JSON.stringify({
    output: FINAL_OUTPUT,
    fingerprint: final.selected.fingerprint,
    frozenTest: final.frozenTest,
    deploymentGate: final.deploymentGate
  }, null, 2));
}
