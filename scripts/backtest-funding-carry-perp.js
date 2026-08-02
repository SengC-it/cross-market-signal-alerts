import { readdir, readFile, writeFile } from "node:fs/promises";

const PRICE_CACHE_DIR = process.env.FUNDING_CARRY_PERP_PRICE_CACHE || ".backtest-cache/binance-futures-1h";
const FUNDING_CACHE_DIR = process.env.FUNDING_CARRY_PERP_FUNDING_CACHE || ".backtest-cache/v3-2-funding";
const START = Date.parse("2023-01-01T00:00:00Z");
const VALIDATION = Date.parse("2025-01-01T00:00:00Z");
const TEST = Date.parse("2026-01-01T00:00:00Z");
const END = Date.parse("2026-07-01T00:00:00Z");
const HOUR_MS = 60 * 60 * 1000;
const FOUR_HOUR_MS = 4 * HOUR_MS;
const MAX_HOLDING_HOURS = 48;
const MAX_HOLDING_MS = MAX_HOLDING_HOURS * HOUR_MS;
const BASE_COST = Number(process.env.FUNDING_CARRY_PERP_COST || 0.0012);
const ACCOUNT_RISK = Number(process.env.FUNDING_CARRY_PERP_ACCOUNT_RISK || 0.0025);
const MAX_LEVERAGE = Number(process.env.FUNDING_CARRY_PERP_MAX_LEVERAGE || 3);
const MAX_OPEN_POSITIONS = Number(process.env.FUNDING_CARRY_PERP_MAX_OPEN_POSITIONS || 3);
const MAX_AGGREGATE_RISK = Number(process.env.FUNDING_CARRY_PERP_MAX_AGGREGATE_RISK || 0.005);
const OUTPUT_FILE = process.env.FUNDING_CARRY_PERP_OUTPUT || "funding_carry_perp_backtest_2026-08-02.json";
const REQUIRE_PASS = process.env.FUNDING_CARRY_PERP_REQUIRE_PASS === "1";
const HISTORICAL_GATE_VERSION = "funding_carry_perp_historical_gate_v1";

const DEFAULT_ENTRY_THRESHOLDS = [0.0004, 0.0005, 0.0006, 0.0008];
const DEFAULT_EXIT_THRESHOLDS = [0.0001, 0.0002, 0.0003];
const DEFAULT_PERSISTENCE = [1, 2];
const DEFAULT_ATR_MULTIPLIERS = [1.5, 2, 2.5];
const DEFAULT_MIN_STOP_PCTS = [0.008, 0.012, 0.018];
const COST_STRESS_MULTIPLIERS = [1, 1.5, 2];

const TREND_RULES = Object.freeze([
  ...["sma", "ema"].flatMap((kind) => [20, 50, 100].flatMap((period) => [3, 6, 12].map((slopeBars) => ({
    id: `${kind}${period}_slope${slopeBars}`,
    type: "ma",
    kind,
    period,
    slopeBars
  })))),
  ...[6, 12, 24].map((lookback) => ({
    id: `momentum${lookback}`,
    type: "momentum",
    lookback
  }))
]);

function listEnv(name, fallback, parse = Number) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const values = raw.split(",").map((item) => parse(item.trim())).filter((item) => item != null && !Number.isNaN(item));
  return values.length ? values : fallback;
}

function selectedTrendRules() {
  const requested = process.env.FUNDING_CARRY_PERP_TREND_RULES;
  if (!requested) return TREND_RULES;
  const ids = new Set(requested.split(",").map((item) => item.trim()).filter(Boolean));
  const rules = TREND_RULES.filter((rule) => ids.has(rule.id));
  return rules.length ? rules : TREND_RULES;
}

function round(value, digits = 12) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function lowerBound(rows, time, getter = (row) => row.openTime) {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (getter(rows[mid]) < time) low = mid + 1;
    else high = mid;
  }
  return low;
}

function parseSymbol(name, rows) {
  const fromRow = rows.find((row) => row?.symbol)?.symbol;
  if (fromRow) return String(fromRow);
  return name.split("-")[0].split(",")[0];
}

async function loadJsonDirectory(directory) {
  const names = (await readdir(directory)).filter((name) => name.endsWith(".json"));
  const rowsBySymbol = new Map();
  for (const name of names) {
    const parsed = JSON.parse(await readFile(`${directory}/${name}`, "utf8"));
    if (!Array.isArray(parsed) || !parsed.length) continue;
    const symbol = parseSymbol(name, parsed);
    rowsBySymbol.set(symbol, [...(rowsBySymbol.get(symbol) || []), ...parsed]);
  }
  return rowsBySymbol;
}

function normalizePrices(rows) {
  const normalized = rows
    .map((row) => ({
      openTime: Number(row.openTime),
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
      volume: Number(row.volume || 0),
      quoteVolume: Number(row.quoteVolume || 0)
    }))
    .filter((row) =>
      Number.isFinite(row.openTime)
      && row.openTime >= START
      && row.openTime < END
      && row.open > 0
      && row.high > 0
      && row.low > 0
      && row.close > 0
    )
    .sort((a, b) => a.openTime - b.openTime);
  return normalized.filter((row, index) => index === 0 || row.openTime !== normalized[index - 1].openTime);
}

function normalizeFunding(rows) {
  const normalized = rows
    .map((row) => ({
      fundingTime: Number(row.fundingTime),
      fundingRate: Number(row.fundingRate)
    }))
    .filter((row) =>
      Number.isFinite(row.fundingTime)
      && row.fundingTime >= START
      && row.fundingTime < END
      && Number.isFinite(row.fundingRate)
    )
    .sort((a, b) => a.fundingTime - b.fundingTime);
  return normalized.filter((row, index) => index === 0 || row.fundingTime !== normalized[index - 1].fundingTime);
}

function resampleFourHour(prices) {
  const groups = [];
  let current = null;
  for (const candle of prices) {
    const openTime = Math.floor(candle.openTime / FOUR_HOUR_MS) * FOUR_HOUR_MS;
    if (!current || current.openTime !== openTime) {
      if (current && current.count === 4) groups.push(current);
      current = {
        openTime,
        closeTime: openTime + FOUR_HOUR_MS,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        count: 1
      };
    } else if (candle.openTime === current.openTime + current.count * HOUR_MS) {
      current.high = Math.max(current.high, candle.high);
      current.low = Math.min(current.low, candle.low);
      current.close = candle.close;
      current.count++;
    } else {
      if (current.count === 4) groups.push(current);
      current = {
        openTime,
        closeTime: openTime + FOUR_HOUR_MS,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        count: 1
      };
    }
  }
  if (current?.count === 4) groups.push(current);
  return groups;
}

function buildRuleStates(fourHour, rules) {
  const closes = fourHour.map((row) => row.close);
  const states = new Map();
  for (const rule of rules) {
    const values = [];
    if (rule.type === "momentum") {
      for (let index = 0; index < closes.length; index++) {
        const prior = closes[index - rule.lookback];
        values.push(prior > 0 ? closes[index] / prior - 1 : null);
      }
    } else {
      const period = rule.period;
      let ema = null;
      const alpha = 2 / (period + 1);
      for (let index = 0; index < closes.length; index++) {
        if (rule.kind === "sma") {
          values.push(index + 1 >= period
            ? closes.slice(index - period + 1, index + 1).reduce((sum, value) => sum + value, 0) / period
            : null);
        } else {
          ema = ema == null ? closes[index] : alpha * closes[index] + (1 - alpha) * ema;
          values.push(index + 1 >= period ? ema : null);
        }
      }
    }
    states.set(rule.id, fourHour.map((row, index) => {
      if (rule.type === "momentum") {
        const value = values[index];
        return { long: Number.isFinite(value) && value > 0, short: Number.isFinite(value) && value < 0, value };
      }
      const ma = values[index];
      const prior = values[index - rule.slopeBars];
      return {
        long: Number.isFinite(ma) && Number.isFinite(prior) && row.close > ma && ma > prior,
        short: Number.isFinite(ma) && Number.isFinite(prior) && row.close < ma && ma < prior,
        value: ma,
        slope: Number.isFinite(ma) && Number.isFinite(prior) ? ma - prior : null
      };
    }));
  }
  return states;
}

function trendValid(states, combo, trendIndex, direction) {
  if (trendIndex == null || trendIndex < 0) return false;
  const side = direction > 0 ? "long" : "short";
  return combo.every((rule) => states.get(rule.id)?.[trendIndex]?.[side] === true);
}

function comboId(combo) {
  return combo.map((rule) => rule.id).join("+");
}

function buildTrendCombos(rules) {
  const combos = [];
  for (const rule of rules) combos.push([rule]);
  for (let first = 0; first < rules.length; first++) {
    for (let second = first + 1; second < rules.length; second++) combos.push([rules[first], rules[second]]);
  }
  return combos;
}

function atrAt(fourHour, index, period = 14) {
  if (index < period) return null;
  let total = 0;
  for (let cursor = index - period + 1; cursor <= index; cursor++) {
    const previousClose = fourHour[cursor - 1]?.close ?? fourHour[cursor].close;
    total += Math.max(
      fourHour[cursor].high - fourHour[cursor].low,
      Math.abs(fourHour[cursor].high - previousClose),
      Math.abs(fourHour[cursor].low - previousClose)
    );
  }
  return total / period;
}

function fundingPrefix(rows) {
  const prefix = [0];
  for (const row of rows) prefix.push(prefix.at(-1) + row.fundingRate);
  return prefix;
}

function fundingSum(rows, prefix, afterTime, throughTime) {
  const first = lowerBound(rows, afterTime + 1);
  const last = lowerBound(rows, throughTime + 1);
  return prefix[last] - prefix[first];
}

function findStopHit(prices, entryIndex, maxExitIndex, direction, stopPrice) {
  for (let index = entryIndex; index <= maxExitIndex && index < prices.length; index++) {
    const candle = prices[index];
    const hit = direction > 0 ? candle.low <= stopPrice : candle.high >= stopPrice;
    if (!hit) continue;
    const gapFill = direction > 0 ? candle.open <= stopPrice : candle.open >= stopPrice;
    return { index, price: gapFill ? candle.open : stopPrice };
  }
  return null;
}

function prepareSymbol(symbol, rawPrices, rawFunding, stopConfigs, exitThresholds, rules) {
  const prices = normalizePrices(rawPrices);
  const funding = normalizeFunding(rawFunding);
  const fourHour = resampleFourHour(prices);
  if (prices.length < 1000 || funding.length < 100 || fourHour.length < 260) return null;
  const states = buildRuleStates(fourHour, rules);
  const fundingPrefixValues = fundingPrefix(funding);
  const atrCache = new Map();
  const events = [];
  const minimumEntryTime = START + FOUR_HOUR_MS * 30;
  for (let fundingIndex = 0; fundingIndex < funding.length; fundingIndex++) {
    const fundingRow = funding[fundingIndex];
    if (fundingRow.fundingTime < minimumEntryTime || fundingRow.fundingTime >= END - MAX_HOLDING_MS) continue;
    const entryIndex = lowerBound(prices, fundingRow.fundingTime + HOUR_MS);
    const entryCandle = prices[entryIndex];
    if (!entryCandle || entryCandle.openTime >= END) continue;
    const trendIndex = lowerBound(fourHour, fundingRow.fundingTime + 1, (row) => row.closeTime) - 1;
    if (trendIndex < 0) continue;
    if (!atrCache.has(trendIndex)) atrCache.set(trendIndex, atrAt(fourHour, trendIndex));
    const atr = atrCache.get(trendIndex);
    if (!Number.isFinite(atr) || atr <= 0) continue;
    const direction = fundingRow.fundingRate > 0 ? -1 : 1;
    const sameSignStreak = (() => {
      let count = 0;
      for (let cursor = fundingIndex; cursor >= 0 && cursor > fundingIndex - 3; cursor--) {
        if (Math.sign(funding[cursor].fundingRate) !== Math.sign(fundingRow.fundingRate)) break;
        count++;
      }
      return count;
    })();
    const maxExitIndex = lowerBound(prices, entryCandle.openTime + MAX_HOLDING_MS);
    if (!prices[maxExitIndex]) continue;
    const stopHits = stopConfigs.map((stopConfig) => {
      const stopDistance = Math.max(atr * stopConfig.atrMultiplier, entryCandle.open * stopConfig.minStopPct);
      const stopPrice = direction > 0 ? entryCandle.open - stopDistance : entryCandle.open + stopDistance;
      return {
        stopPct: stopDistance / entryCandle.open,
        stopPrice,
        hit: findStopHit(prices, entryIndex, maxExitIndex, direction, stopPrice)
      };
    });
    const fundingExitIndices = exitThresholds.map((threshold) => {
      for (let cursor = fundingIndex + 1; cursor < funding.length; cursor++) {
        const row = funding[cursor];
        if (row.fundingTime >= entryCandle.openTime + MAX_HOLDING_MS) break;
        if (Math.sign(row.fundingRate) !== Math.sign(fundingRow.fundingRate) || Math.abs(row.fundingRate) < threshold) {
          return lowerBound(prices, row.fundingTime + HOUR_MS);
        }
      }
      return Infinity;
    });
    events.push({
      symbol,
      fundingIndex,
      fundingTime: fundingRow.fundingTime,
      fundingRate: fundingRow.fundingRate,
      absFundingRate: Math.abs(fundingRow.fundingRate),
      direction,
      sameSignStreak,
      entryIndex,
      entryTime: entryCandle.openTime,
      entryPrice: entryCandle.open,
      trendIndex,
      maxExitIndex,
      stopHits,
      fundingExitIndices,
      trendExitCache: new Map()
    });
  }
  return { symbol, prices, funding, fundingPrefix: fundingPrefixValues, fourHour, states, events, dataQuality: dataQuality(prices, funding) };
}

function dataQuality(prices, funding) {
  const priceGaps = prices.slice(1).map((row, index) => row.openTime - prices[index].openTime).filter((gap) => gap > HOUR_MS * 1.5);
  const fundingGaps = funding.slice(1).map((row, index) => row.fundingTime - funding[index].fundingTime).filter((gap) => gap > 8 * HOUR_MS * 1.5);
  return {
    priceRows: prices.length,
    fundingRows: funding.length,
    priceGaps: priceGaps.length,
    fundingGaps: fundingGaps.length,
    complete: priceGaps.length === 0 && fundingGaps.length === 0
  };
}

function trendExitIndex(prepared, event, combo) {
  const id = comboId(combo);
  if (event.trendExitCache.has(id)) return event.trendExitCache.get(id);
  let result = Infinity;
  const side = event.direction > 0 ? "long" : "short";
  for (let index = event.trendIndex + 1; index < prepared.fourHour.length; index++) {
    const row = prepared.fourHour[index];
    if (row.closeTime <= event.entryTime) continue;
    if (row.closeTime > event.entryTime + MAX_HOLDING_MS) break;
    const valid = combo.every((rule) => prepared.states.get(rule.id)?.[index]?.[side] === true);
    if (!valid) {
      result = lowerBound(prepared.prices, row.closeTime);
      break;
    }
  }
  event.trendExitCache.set(id, result);
  return result;
}

function buildTrade(prepared, event, config, combo, costMultiplier) {
  const stop = event.stopHits[config.stopIndex];
  const fundingExit = event.fundingExitIndices[config.exitIndex];
  const trendExit = trendExitIndex(prepared, event, combo);
  const candidates = [
    { index: event.maxExitIndex, reason: "max_holding", priority: 3, price: null },
    { index: fundingExit, reason: "funding_threshold", priority: 2, price: null },
    { index: trendExit, reason: "trend_reversal", priority: 1, price: null }
  ];
  if (stop?.hit) candidates.push({ index: stop.hit.index, reason: "atr_stop", priority: 0, price: stop.hit.price });
  const exit = candidates
    .filter((item) => Number.isFinite(item.index) && item.index >= event.entryIndex)
    .sort((a, b) => a.index - b.index || a.priority - b.priority)[0];
  if (!exit) return null;
  const exitCandle = prepared.prices[exit.index];
  if (!exitCandle) return null;
  const exitPrice = exit.price ?? exitCandle.open;
  const priceReturn = event.direction * (exitPrice / event.entryPrice - 1);
  const fundingReturn = -event.direction * fundingSum(
    prepared.funding,
    prepared.fundingPrefix,
    event.entryTime,
    exitCandle.openTime
  );
  const tradingCost = BASE_COST * costMultiplier;
  const netReturn = priceReturn + fundingReturn - tradingCost;
  const stopPct = stop?.stopPct ?? null;
  const positionWeight = Number.isFinite(stopPct) && stopPct > 0
    ? Math.min(MAX_LEVERAGE, ACCOUNT_RISK / stopPct)
    : 0;
  return {
    symbol: event.symbol,
    direction: event.direction,
    side: event.direction > 0 ? "LONG" : "SHORT",
    entryTime: event.entryTime,
    exitTime: exitCandle.openTime,
    entryPrice: event.entryPrice,
    exitPrice,
    fundingRate: event.fundingRate,
    fundingReturn,
    priceReturn,
    grossReturn: priceReturn + fundingReturn,
    tradingCost,
    netReturn,
    holdingHours: (exitCandle.openTime - event.entryTime) / HOUR_MS,
    exitReason: exit.reason,
    stopPct,
    stopPrice: stop?.stopPrice ?? null,
    positionWeight,
    accountRisk: positionWeight * stopPct,
    accountReturn: positionWeight * netReturn,
    trendRules: combo.map((rule) => rule.id)
  };
}

function selectPortfolio(rawTrades) {
  const candidates = [...rawTrades].sort((a, b) =>
    a.entryTime - b.entryTime
    || Math.abs(b.fundingRate) - Math.abs(a.fundingRate)
    || a.symbol.localeCompare(b.symbol)
  );
  const open = [];
  const selected = [];
  for (const trade of candidates) {
    for (let index = open.length - 1; index >= 0; index--) {
      if (open[index].exitTime <= trade.entryTime) open.splice(index, 1);
    }
    const currentRisk = open.reduce((sum, item) => sum + item.accountRisk, 0);
    if (open.length >= MAX_OPEN_POSITIONS || currentRisk + trade.accountRisk > MAX_AGGREGATE_RISK + 1e-12) continue;
    selected.push(trade);
    open.push(trade);
  }
  return selected;
}

function monthCount(windowStart, windowEnd) {
  if (!Number.isFinite(windowStart) || !Number.isFinite(windowEnd) || windowEnd <= windowStart) return 0;
  const start = new Date(windowStart);
  const end = new Date(windowEnd);
  let cursor = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1);
  const last = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1);
  let count = 0;
  while (cursor < last || (cursor === last && end.getUTCDate() > 1)) {
    count++;
    const date = new Date(cursor);
    cursor = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
  }
  return count;
}

function summary(trades, returnField = "accountReturn", windowStart = null, windowEnd = null) {
  const ordered = [...trades].sort((a, b) => a.exitTime - b.exitTime || a.entryTime - b.entryTime);
  const returns = ordered.map((trade) => Number(trade[returnField] ?? 0)).filter(Number.isFinite);
  const calendarMonths = monthCount(windowStart, windowEnd);
  if (!returns.length) {
    return {
      trades: 0,
      totalReturn: 0,
      averageNetReturn: null,
      winRate: null,
      profitFactor: null,
      maxDrawdown: 0,
      positiveMonthRate: calendarMonths ? 0 : null,
      months: calendarMonths,
      signalsPerMonth: 0,
      maxSignalGapDays: calendarMonths ? (windowEnd - windowStart) / 86_400_000 : null,
      averageHoldingHours: null
    };
  }
  let equity = 1;
  let peak = 1;
  let maxDrawdown = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  for (const value of returns) {
    equity *= 1 + value;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.min(maxDrawdown, equity / peak - 1);
    if (value > 0) grossProfit += value;
    else grossLoss += value;
  }
  const monthly = new Map();
  if (calendarMonths) {
    const start = new Date(windowStart);
    let cursor = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1);
    const end = new Date(windowEnd);
    const last = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1);
    while (cursor < last || (cursor === last && end.getUTCDate() > 1)) {
      monthly.set(new Date(cursor).toISOString().slice(0, 7), 1);
      const date = new Date(cursor);
      cursor = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
    }
  }
  const entryTimes = [];
  for (const trade of ordered) {
    entryTimes.push(trade.entryTime);
    const month = new Date(trade.entryTime).toISOString().slice(0, 7);
    monthly.set(month, (monthly.get(month) || 1) * (1 + Number(trade[returnField] ?? 0)));
  }
  const monthReturns = [...monthly.values()].map((value) => value - 1);
  const boundaryTimes = [
    ...(Number.isFinite(windowStart) ? [windowStart] : []),
    ...entryTimes,
    ...(Number.isFinite(windowEnd) ? [windowEnd] : [])
  ].sort((a, b) => a - b);
  const gaps = boundaryTimes.slice(1).map((time, index) => (time - boundaryTimes[index]) / 86_400_000);
  return {
    trades: returns.length,
    totalReturn: equity - 1,
    averageNetReturn: mean(returns),
    winRate: returns.filter((value) => value > 0).length / returns.length,
    profitFactor: grossLoss < 0 ? grossProfit / Math.abs(grossLoss) : grossProfit > 0 ? Infinity : 0,
    maxDrawdown,
    positiveMonthRate: monthReturns.length ? monthReturns.filter((value) => value > 0).length / monthReturns.length : null,
    months: calendarMonths || monthReturns.length,
    signalsPerMonth: returns.length / Math.max(1, calendarMonths || monthReturns.length),
    maxSignalGapDays: gaps.length ? Math.max(...gaps) : null,
    averageHoldingHours: mean(ordered.map((trade) => trade.holdingHours))
  };
}

function periodMetrics(trades) {
  const ordered = [...trades].sort((a, b) => a.entryTime - b.entryTime);
  return {
    all: summary(ordered),
    train: summary(ordered.filter((trade) => trade.entryTime >= START && trade.entryTime < VALIDATION), "accountReturn", START, VALIDATION),
    validation: summary(ordered.filter((trade) => trade.entryTime >= VALIDATION && trade.entryTime < TEST), "accountReturn", VALIDATION, TEST),
    test: summary(ordered.filter((trade) => trade.entryTime >= TEST && trade.entryTime < END), "accountReturn", TEST, END)
  };
}

function gateForPeriod(metrics, minimumTrades) {
  return {
    sample: metrics.trades >= minimumTrades,
    averagePositive: metrics.averageNetReturn > 0,
    pf: Number(metrics.profitFactor) >= 1.15,
    totalPositive: metrics.totalReturn > 0,
    drawdown: Math.abs(metrics.maxDrawdown) <= 0.2,
    positiveMonths: Number(metrics.positiveMonthRate) >= 0.5,
    frequency: Number(metrics.signalsPerMonth) >= 8,
    signalGap: metrics.maxSignalGapDays == null || metrics.maxSignalGapDays <= 14
  };
}

function baseResearchGate(metrics, stressMetrics, dataComplete) {
  const train = gateForPeriod(metrics.train, 120);
  const validation = gateForPeriod(metrics.validation, 40);
  const test = gateForPeriod(metrics.test, 24);
  const checks = {
    dataComplete,
    train: Object.values(train).every(Boolean),
    validation: Object.values(validation).every(Boolean),
    test: Object.values(test).every(Boolean),
    costStress: stressMetrics.test.averageNetReturn > 0 && Number(stressMetrics.test.profitFactor) >= 1.05
  };
  return {
    passed: Object.values(checks).every(Boolean),
    checks,
    train,
    validation,
    test,
    stress: {
      averageNetReturn: stressMetrics.test.averageNetReturn,
      profitFactor: stressMetrics.test.profitFactor,
      totalReturn: stressMetrics.test.totalReturn,
      maxDrawdown: stressMetrics.test.maxDrawdown
    },
    passedCount: Object.values(checks).filter(Boolean).length
  };
}

function trainRankScore(metrics) {
  const drawdown = Math.max(0.05, Math.abs(metrics.train.maxDrawdown || 0));
  return (metrics.train.averageNetReturn || -Infinity) / drawdown;
}

function compareCandidates(a, b) {
  return trainRankScore(b.metrics) - trainRankScore(a.metrics)
    || Number(b.metrics.train.profitFactor || 0) - Number(a.metrics.train.profitFactor || 0)
    || Math.abs(a.metrics.train.maxDrawdown || 0) - Math.abs(b.metrics.train.maxDrawdown || 0)
    || a.config.trendRules.length - b.config.trendRules.length
    || b.metrics.train.trades - a.metrics.train.trades;
}

function buildConfigs(rules) {
  const entryThresholds = listEnv("FUNDING_CARRY_PERP_ENTRY_THRESHOLDS", DEFAULT_ENTRY_THRESHOLDS);
  const exitThresholds = listEnv("FUNDING_CARRY_PERP_EXIT_THRESHOLDS", DEFAULT_EXIT_THRESHOLDS);
  const persistence = listEnv("FUNDING_CARRY_PERP_PERSISTENCE", DEFAULT_PERSISTENCE);
  const atrMultipliers = listEnv("FUNDING_CARRY_PERP_ATR_MULTIPLIERS", DEFAULT_ATR_MULTIPLIERS);
  const minStopPcts = listEnv("FUNDING_CARRY_PERP_MIN_STOP_PCTS", DEFAULT_MIN_STOP_PCTS);
  const combos = buildTrendCombos(rules);
  return combos.flatMap((combo) => entryThresholds.flatMap((entryThreshold) => exitThresholds
    .filter((exitThreshold) => exitThreshold < entryThreshold)
    .flatMap((exitThreshold) => persistence.flatMap((confirmationEvents) => atrMultipliers.flatMap((atrMultiplier) => minStopPcts
      .map((minStopPct) => ({
        trendRules: combo,
        entryThreshold,
        exitThreshold,
        confirmationEvents,
        atrMultiplier,
        minStopPct
      })))))));
}

function configLabel(config) {
  return {
    trendRules: config.trendRules.map((rule) => rule.id),
    entryThreshold: config.entryThreshold,
    exitThreshold: config.exitThreshold,
    confirmationEvents: config.confirmationEvents,
    atrMultiplier: config.atrMultiplier,
    minStopPct: config.minStopPct,
    maxHoldingHours: MAX_HOLDING_HOURS
  };
}

function runConfig(config, preparedSymbols, costMultiplier = 1) {
  const stopConfigs = preparedSymbols[0]?.stopConfigs || [];
  const stopIndex = stopConfigs.findIndex((item) => item.atrMultiplier === config.atrMultiplier && item.minStopPct === config.minStopPct);
  const exitIndex = preparedSymbols[0]?.exitThresholds?.findIndex((value) => value === config.exitThreshold) ?? -1;
  if (stopIndex < 0 || exitIndex < 0) return { rawTrades: [], selectedTrades: [], metrics: periodMetrics([]) };
  const rawTrades = [];
  for (const prepared of preparedSymbols) {
    for (const event of prepared.events) {
      if (event.absFundingRate < config.entryThreshold || event.sameSignStreak < config.confirmationEvents) continue;
      if (!trendValid(prepared.states, config.trendRules, event.trendIndex, event.direction)) continue;
      const trade = buildTrade(prepared, event, { ...config, stopIndex, exitIndex }, config.trendRules, costMultiplier);
      if (trade) rawTrades.push(trade);
    }
  }
  const selectedTrades = selectPortfolio(rawTrades);
  return { rawTrades, selectedTrades, metrics: periodMetrics(selectedTrades) };
}

function toSerializable(value) {
  if (value === Infinity) return null;
  if (Array.isArray(value)) return value.map(toSerializable);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toSerializable(item)]));
  return value;
}

async function main() {
  const [priceBySymbol, fundingBySymbol] = await Promise.all([
    loadJsonDirectory(PRICE_CACHE_DIR),
    loadJsonDirectory(FUNDING_CACHE_DIR)
  ]);
  const rules = selectedTrendRules();
  const stopConfigs = DEFAULT_ATR_MULTIPLIERS.flatMap((atrMultiplier) => DEFAULT_MIN_STOP_PCTS.map((minStopPct) => ({ atrMultiplier, minStopPct })));
  const exitThresholds = DEFAULT_EXIT_THRESHOLDS;
  const preparedSymbols = [];
  for (const [symbol, rawPrices] of priceBySymbol.entries()) {
    const rawFunding = fundingBySymbol.get(symbol);
    if (!rawFunding) continue;
    const prepared = prepareSymbol(symbol, rawPrices, rawFunding, stopConfigs, exitThresholds, rules);
    if (prepared) {
      prepared.stopConfigs = stopConfigs;
      prepared.exitThresholds = exitThresholds;
      preparedSymbols.push(prepared);
    }
  }
  if (!preparedSymbols.length) throw new Error("No complete futures price/funding datasets found");

  const configs = buildConfigs(rules);
  const results = [];
  for (const config of configs) {
    const base = runConfig(config, preparedSymbols, 1);
    const stress = runConfig(config, preparedSymbols, 1.5);
    const stress2 = runConfig(config, preparedSymbols, 2);
    const dataComplete = preparedSymbols.every((item) => item.dataQuality.complete);
    const gate = baseResearchGate(base.metrics, stress.metrics, dataComplete);
    results.push({
      config: configLabel(config),
      metrics: base.metrics,
      stressMetrics: stress.metrics,
      costStressMetrics: {
        "1.5x": stress.metrics,
        "2x": stress2.metrics
      },
      gate,
      rawSignalCount: base.rawTrades.length,
      selectedTradeCount: base.selectedTrades.length,
      trainRankScore: trainRankScore(base.metrics)
    });
  }

  const trainEligible = results.filter((item) => {
    const train = gateForPeriod(item.metrics.train, 120);
    return Object.values(train).every(Boolean);
  }).sort(compareCandidates);
  const selected = trainEligible[0] || [...results].sort(compareCandidates)[0] || null;
  const deploymentGatePassed = Boolean(selected?.gate.passed);
  const result = toSerializable({
    generatedAt: new Date().toISOString(),
    purpose: "Perpetual-only funding carry with price PnL, funding PnL, trend confirmation, ATR stop, 48-hour maximum holding, portfolio risk caps and strict no-lookahead train/validation/test gates.",
    assumptions: {
      priceCache: PRICE_CACHE_DIR,
      fundingCache: FUNDING_CACHE_DIR,
      symbols: preparedSymbols.map((item) => item.symbol),
      baseRoundTripCost: BASE_COST,
      costStressMultipliers: COST_STRESS_MULTIPLIERS,
      accountRiskPerTrade: ACCOUNT_RISK,
      maxLeverage: MAX_LEVERAGE,
      maxOpenPositions: MAX_OPEN_POSITIONS,
      maxAggregateRisk: MAX_AGGREGATE_RISK,
      maxHoldingHours: MAX_HOLDING_HOURS,
      gateVersion: HISTORICAL_GATE_VERSION,
      entryTiming: "after a closed funding observation, next 1h candle open",
      sideMapping: "positive funding -> SHORT; negative funding -> LONG",
      split: { train: "2023-01-01 through 2024-12-31", validation: "2025-01-01 through 2025-12-31", test: "2026-01-01 through 2026-06-30" }
    },
    search: {
      trendRules: rules,
      evaluated: results.length,
      trainEligible: trainEligible.length,
      selectedOnTrain: selected?.config || null,
      selectionUsesTest: false
    },
    historicalGatePassed: deploymentGatePassed,
    deploymentGatePassed,
    selectedCandidate: selected,
    topTrainCandidates: trainEligible.slice(0, 20),
    topAllCandidates: [...results].sort(compareCandidates).slice(0, 20),
    passingCandidates: results.filter((item) => item.gate.passed).slice(0, 20),
    dataQuality: Object.fromEntries(preparedSymbols.map((item) => [item.symbol, item.dataQuality]))
  });
  await writeFile(OUTPUT_FILE, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({
    evaluated: configs.length,
    symbols: preparedSymbols.length,
    trainEligible: trainEligible.length,
    selectedOnTrain: selected?.config || null,
    deploymentGatePassed,
    selectedGate: selected?.gate || null
  }, null, 2));
  if (REQUIRE_PASS && !deploymentGatePassed) process.exitCode = 1;
}

await main();
