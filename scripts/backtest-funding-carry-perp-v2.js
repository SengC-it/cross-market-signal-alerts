import { readdir, readFile, writeFile } from "node:fs/promises";

const PRICE_ROOT = process.env.FUNDING_CARRY_V2_PRICE_CACHE || ".backtest-cache/binance-vision-futures-1h";
const PRICE_JSON_ROOT = process.env.FUNDING_CARRY_V2_PRICE_JSON_CACHE || ".backtest-cache/binance-futures-1h";
const FUNDING_ROOT = process.env.FUNDING_CARRY_V2_FUNDING_CACHE || ".backtest-cache/v3-2-funding";
const BACKTEST_MODE = process.env.FUNDING_CARRY_V2_MODE || "paper-candidate";
if (!["paper-candidate", "research-grid"].includes(BACKTEST_MODE)) throw new Error(`Unsupported FUNDING_CARRY_V2_MODE: ${BACKTEST_MODE}`);
const PAPER_CANDIDATE_MODE = BACKTEST_MODE === "paper-candidate";
const UNIVERSE_FILE = process.env.FUNDING_CARRY_V2_UNIVERSE_FILE || (PAPER_CANDIDATE_MODE ? "funding_carry_v2_universe_100_complete_2026-08-02.json" : "funding_carry_v2_universe_2026-08-02.json");
const OUTPUT_FILE = process.env.FUNDING_CARRY_V2_OUTPUT || "funding_carry_v2_backtest_2026-08-02.json";
const START = Date.parse("2023-01-01T00:00:00Z");
const VALIDATION = Date.parse("2025-01-01T00:00:00Z");
const TEST = Date.parse("2026-01-01T00:00:00Z");
const END = Date.parse("2026-07-01T00:00:00Z");
const HOUR_MS = 60 * 60 * 1000;
const FOUR_HOUR_MS = 4 * HOUR_MS;
const ACCOUNT_RISK = Number(process.env.FUNDING_CARRY_V2_ACCOUNT_RISK || 0.0025);
const MAX_LEVERAGE = Number(process.env.FUNDING_CARRY_V2_MAX_LEVERAGE || 3);
const MAX_OPEN_POSITIONS = Number(process.env.FUNDING_CARRY_V2_MAX_OPEN_POSITIONS || 3);
const MAX_AGGREGATE_RISK = Number(process.env.FUNDING_CARRY_V2_MAX_AGGREGATE_RISK || 0.005);
const BASE_COST = Number(process.env.FUNDING_CARRY_V2_COST || 0.0012);
const TARGET_UNIVERSE_SIZE = Number(process.env.FUNDING_CARRY_V2_UNIVERSE_SIZE || (PAPER_CANDIDATE_MODE ? 100 : 50));
const MIN_UNIVERSE_SIZE = Number(process.env.FUNDING_CARRY_V2_MIN_UNIVERSE_SIZE || TARGET_UNIVERSE_SIZE);
const REQUIRE_PASS = process.env.FUNDING_CARRY_PERP_V2_REQUIRE_PASS === "1";
const GATE_VERSION = "funding_carry_perp_v2_historical_gate_v1";
const COST_STRESS_MULTIPLIERS = [1.5, 2];
const SIGNAL_FILTER_EXPANSION_LIMIT = Math.max(50, Number(process.env.FUNDING_CARRY_V2_FILTER_EXPANSION_LIMIT || 50));
const FIXED_FUNDING_REVERSION = process.env.FUNDING_CARRY_V2_FUNDING_REVERSION == null
  ? PAPER_CANDIDATE_MODE
  : process.env.FUNDING_CARRY_V2_FUNDING_REVERSION === "1";
const TREND_COMBINATION_MODE = process.env.FUNDING_CARRY_V2_TREND_COMBINATION_MODE || (PAPER_CANDIDATE_MODE ? "single" : "single_or_pair");
const FIXED_TREND_RULE_IDS = (process.env.FUNDING_CARRY_V2_TREND_RULE_IDS == null
  ? ""
  : process.env.FUNDING_CARRY_V2_TREND_RULE_IDS)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

function parseGridValues(raw, fallback, allowed, name) {
  if (!raw) return fallback;
  const values = [...new Set(String(raw).split(",").map((value) => Number(value.trim())).filter(Number.isFinite))];
  if (!values.length || values.some((value) => !allowed.includes(value))) {
    throw new Error(`${name} must contain only values from ${allowed.join(",")}`);
  }
  return values;
}

const Z_WINDOWS = parseGridValues(process.env.FUNDING_CARRY_V2_Z_WINDOW_VALUES, PAPER_CANDIDATE_MODE ? [90] : [90, 180, 270], [90, 180, 270], "FUNDING_CARRY_V2_Z_WINDOW_VALUES");
const ENTRY_Z = parseGridValues(process.env.FUNDING_CARRY_V2_ENTRY_Z_VALUES, PAPER_CANDIDATE_MODE ? [1] : [1, 1.5, 2], [1, 1.5, 2], "FUNDING_CARRY_V2_ENTRY_Z_VALUES");
const MIN_ABS_FUNDING = parseGridValues(process.env.FUNDING_CARRY_V2_MIN_ABS_FUNDING_VALUES, PAPER_CANDIDATE_MODE ? [0.0002] : [0.0002, 0.0003, 0.0004], [0.0002, 0.0003, 0.0004], "FUNDING_CARRY_V2_MIN_ABS_FUNDING_VALUES");
const EXIT_Z = parseGridValues(process.env.FUNDING_CARRY_V2_EXIT_Z_VALUES, PAPER_CANDIDATE_MODE ? [0.5] : [0.25, 0.5, 0.75], [0.25, 0.5, 0.75], "FUNDING_CARRY_V2_EXIT_Z_VALUES");
const CONFIRMATION = parseGridValues(process.env.FUNDING_CARRY_V2_CONFIRMATION_VALUES, PAPER_CANDIDATE_MODE ? [2] : [1, 2], [1, 2], "FUNDING_CARRY_V2_CONFIRMATION_VALUES");
const ATR_MULTIPLIERS = parseGridValues(process.env.FUNDING_CARRY_V2_ATR_MULTIPLIER_VALUES, PAPER_CANDIDATE_MODE ? [2] : [1.5, 2, 2.5], [1.5, 2, 2.5], "FUNDING_CARRY_V2_ATR_MULTIPLIER_VALUES");
const MIN_STOP_PCTS = parseGridValues(process.env.FUNDING_CARRY_V2_MIN_STOP_PCT_VALUES, PAPER_CANDIDATE_MODE ? [0.012] : [0.008, 0.012, 0.018], [0.008, 0.012, 0.018], "FUNDING_CARRY_V2_MIN_STOP_PCT_VALUES");
const MAX_HOLDING_HOURS = parseGridValues(process.env.FUNDING_CARRY_V2_MAX_HOLDING_HOURS_VALUES, PAPER_CANDIDATE_MODE ? [48] : [24, 48, 72], [24, 48, 72], "FUNDING_CARRY_V2_MAX_HOLDING_HOURS_VALUES");
const VOLATILITY_LOOKBACK = 90;
const VOLATILITY_PERCENTILE = 0.9;

const TREND_RULES = Object.freeze([
  ...["sma", "ema"].flatMap((kind) => [20, 50, 100].flatMap((period) => [3, 6, 12].map((slopeBars) => ({
    id: `${kind}${period}_slope${slopeBars}`,
    type: "ma",
    kind,
    period,
    slopeBars
  })))),
  ...[6, 12, 24].map((lookback) => ({ id: `momentum${lookback}`, type: "momentum", lookback }))
]);
const TREND_RULES_BY_ID = new Map(TREND_RULES.map((rule) => [rule.id, rule]));

function mean(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : null;
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

function percentile(values, ratio) {
  const sorted = values.filter(Number.isFinite).toSorted((a, b) => a - b);
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((sorted.length - 1) * ratio)));
  return sorted[index];
}

function parseKlineArray(fields) {
  return {
    openTime: Number(fields[0]),
    open: Number(fields[1]),
    high: Number(fields[2]),
    low: Number(fields[3]),
    close: Number(fields[4]),
    volume: Number(fields[5]),
    quoteVolume: Number(fields[7])
  };
}

function normalizePriceRows(rows) {
  return rows
    .map((row) => Array.isArray(row) ? parseKlineArray(row) : {
      openTime: Number(row.openTime),
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
      volume: Number(row.volume || 0),
      quoteVolume: Number(row.quoteVolume || 0)
    })
    .filter((row) => Number.isFinite(row.openTime)
      && row.openTime >= START
      && row.openTime < END
      && row.open > 0
      && row.high > 0
      && row.low > 0
      && row.close > 0)
    .sort((a, b) => a.openTime - b.openTime)
    .filter((row, index, ordered) => index === 0 || row.openTime !== ordered[index - 1].openTime);
}

function normalizeFundingRows(rows) {
  return rows
    .map((row) => ({ fundingTime: Number(row.fundingTime), fundingRate: Number(row.fundingRate) }))
    .filter((row) => Number.isFinite(row.fundingTime)
      && row.fundingTime >= START
      && row.fundingTime < END
      && Number.isFinite(row.fundingRate))
    .sort((a, b) => a.fundingTime - b.fundingTime)
    .filter((row, index, ordered) => index === 0 || row.fundingTime !== ordered[index - 1].fundingTime);
}

async function loadVisionPrices(symbol) {
  const symbolRoot = `${PRICE_ROOT}/${symbol}`;
  let months;
  try {
    months = await readdir(symbolRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const rows = [];
  for (const month of months.filter((entry) => entry.isDirectory())) {
    const files = await readdir(`${symbolRoot}/${month.name}`);
    for (const file of files.filter((name) => name.endsWith(".csv"))) {
      const text = await readFile(`${symbolRoot}/${month.name}/${file}`, "utf8");
      for (const line of text.split(/\r?\n/)) {
        if (!line || line.startsWith("open_time,")) continue;
        const fields = line.split(",");
        if (fields.length >= 8) rows.push(parseKlineArray(fields));
      }
    }
  }
  return normalizePriceRows(rows);
}

async function loadJsonPrices(symbol) {
  let names;
  try {
    names = (await readdir(PRICE_JSON_ROOT)).filter((name) => name.startsWith(`${symbol}-`) && name.endsWith(".json"));
  } catch {
    return [];
  }
  const rows = [];
  for (const name of names) {
    try {
      const parsed = JSON.parse(await readFile(`${PRICE_JSON_ROOT}/${name}`, "utf8"));
      if (Array.isArray(parsed)) rows.push(...parsed);
    } catch {
      // Ignore corrupt shards; data quality will fail if no complete series remains.
    }
  }
  return normalizePriceRows(rows);
}

async function loadPrices(symbol) {
  const vision = await loadVisionPrices(symbol);
  return vision.length ? vision : loadJsonPrices(symbol);
}

async function loadFunding(symbol) {
  let names;
  try {
    names = (await readdir(FUNDING_ROOT)).filter((name) => name.startsWith(`${symbol}-`) && name.endsWith(".json"));
  } catch {
    return [];
  }
  const rows = [];
  for (const name of names) {
    try {
      const parsed = JSON.parse(await readFile(`${FUNDING_ROOT}/${name}`, "utf8"));
      if (Array.isArray(parsed)) rows.push(...parsed);
    } catch {
      // Data quality gate handles missing history.
    }
  }
  return normalizeFundingRows(rows);
}

function resampleFourHour(prices) {
  const groups = [];
  let current = null;
  for (const candle of prices) {
    const openTime = Math.floor(candle.openTime / FOUR_HOUR_MS) * FOUR_HOUR_MS;
    if (!current || current.openTime !== openTime) {
      if (current?.count === 4) groups.push(current);
      current = { openTime, closeTime: openTime + FOUR_HOUR_MS, open: candle.open, high: candle.high, low: candle.low, close: candle.close, count: 1 };
    } else if (candle.openTime === current.openTime + current.count * HOUR_MS) {
      current.high = Math.max(current.high, candle.high);
      current.low = Math.min(current.low, candle.low);
      current.close = candle.close;
      current.count++;
    } else {
      if (current.count === 4) groups.push(current);
      current = { openTime, closeTime: openTime + FOUR_HOUR_MS, open: candle.open, high: candle.high, low: candle.low, close: candle.close, count: 1 };
    }
  }
  if (current?.count === 4) groups.push(current);
  return groups;
}

function sma(values, period) {
  if (values.length < period) return null;
  return values.slice(-period).reduce((sum, value) => sum + value, 0) / period;
}

function ema(values, period) {
  if (values.length < period) return null;
  const alpha = 2 / (period + 1);
  let value = values.slice(0, period).reduce((sum, item) => sum + item, 0) / period;
  for (const item of values.slice(period)) value = alpha * item + (1 - alpha) * value;
  return value;
}

function atrAt(candles, index, period = 14) {
  if (index < period) return null;
  let total = 0;
  for (let cursor = index - period + 1; cursor <= index; cursor++) {
    const previous = candles[cursor - 1]?.close ?? candles[cursor].close;
    total += Math.max(candles[cursor].high - candles[cursor].low, Math.abs(candles[cursor].high - previous), Math.abs(candles[cursor].low - previous));
  }
  return total / period;
}

function buildTrendStates(fourHour) {
  const closes = fourHour.map((row) => row.close);
  const states = new Map();
  for (const rule of TREND_RULES) {
    const values = [];
    if (rule.type === "momentum") {
      for (let index = 0; index < closes.length; index++) {
        const prior = closes[index - rule.lookback];
        values.push(prior > 0 ? closes[index] / prior - 1 : null);
      }
    } else {
      let lastEma = null;
      const alpha = 2 / (rule.period + 1);
      for (let index = 0; index < closes.length; index++) {
        if (rule.kind === "sma") {
          values.push(index + 1 >= rule.period ? closes.slice(index - rule.period + 1, index + 1).reduce((sum, value) => sum + value, 0) / rule.period : null);
        } else {
          lastEma = lastEma == null ? closes[index] : alpha * closes[index] + (1 - alpha) * lastEma;
          values.push(index + 1 >= rule.period ? lastEma : null);
        }
      }
    }
    states.set(rule.id, fourHour.map((row, index) => {
      if (rule.type === "momentum") {
        const value = values[index];
        return { long: Number.isFinite(value) && value > 0, short: Number.isFinite(value) && value < 0, value };
      }
      const value = values[index];
      const prior = values[index - rule.slopeBars];
      return {
        long: Number.isFinite(value) && Number.isFinite(prior) && row.close > value && value > prior,
        short: Number.isFinite(value) && Number.isFinite(prior) && row.close < value && value < prior,
        value,
        slope: Number.isFinite(value) && Number.isFinite(prior) ? value - prior : null
      };
    }));
  }
  return states;
}

function buildVolatilityStates(fourHour) {
  const atrPct = fourHour.map((row, index) => {
    const value = atrAt(fourHour, index);
    return Number.isFinite(value) && row.close > 0 ? value / row.close : null;
  });
  return fourHour.map((row, index) => {
    const prior = atrPct.slice(Math.max(0, index - VOLATILITY_LOOKBACK), index).filter(Number.isFinite);
    const cap = percentile(prior, VOLATILITY_PERCENTILE);
    return {
      atrPct: atrPct[index],
      cap,
      valid: Number.isFinite(atrPct[index]) && Number.isFinite(cap) && atrPct[index] <= cap
    };
  });
}

function buildFundingFeatures(funding) {
  const output = new Map();
  for (const window of Z_WINDOWS) {
    const values = funding.map((row, index) => {
      const prior = funding.slice(Math.max(0, index - window), index).map((item) => item.fundingRate);
      if (prior.length < window) return { z: null, signedZ: null };
      const average = mean(prior);
      const variance = mean(prior.map((value) => (value - average) ** 2));
      const deviation = Math.sqrt(variance || 0);
      if (!Number.isFinite(deviation) || deviation <= 0) return { z: null, signedZ: null };
      const z = (funding[index].fundingRate - average) / deviation;
      return { z, signedZ: Math.sign(funding[index].fundingRate) * z };
    });
    output.set(window, values);
  }
  return output;
}

function dataQuality(prices, funding) {
  const priceGaps = prices.slice(1).map((row, index) => row.openTime - prices[index].openTime).filter((gap) => gap > HOUR_MS * 1.5);
  const fundingGaps = funding.slice(1).map((row, index) => row.fundingTime - funding[index].fundingTime).filter((gap) => gap > 8 * HOUR_MS * 1.5);
  const expectedHours = (END - START) / HOUR_MS;
  return {
    priceRows: prices.length,
    fundingRows: funding.length,
    priceCoverage: prices.length / expectedHours,
    fundingCoverage: funding.length / ((END - START) / (8 * HOUR_MS)),
    priceGaps: priceGaps.length,
    fundingGaps: fundingGaps.length,
    complete: priceGaps.length === 0 && fundingGaps.length === 0
  };
}

async function prepareSymbol(symbol) {
  const [prices, funding] = await Promise.all([loadPrices(symbol), loadFunding(symbol)]);
  const fourHour = resampleFourHour(prices);
  if (prices.length < 1000 || funding.length < 100 || fourHour.length < 260) return null;
  const trendStates = buildTrendStates(fourHour);
  const volatilityStates = buildVolatilityStates(fourHour);
  const fundingFeatures = buildFundingFeatures(funding);
  const fundingPrefix = [0];
  for (const row of funding) fundingPrefix.push(fundingPrefix.at(-1) + row.fundingRate);
  const events = [];
  for (let fundingIndex = 0; fundingIndex < funding.length; fundingIndex++) {
    const row = funding[fundingIndex];
    if (row.fundingTime < START + 270 * 8 * HOUR_MS || row.fundingTime >= END - 72 * HOUR_MS) continue;
    const entryIndex = lowerBound(prices, row.fundingTime + HOUR_MS);
    const entryCandle = prices[entryIndex];
    if (!entryCandle) continue;
    const trendIndex = lowerBound(fourHour, row.fundingTime + 1, (item) => item.closeTime) - 1;
    if (trendIndex < 0) continue;
    const atr = atrAt(fourHour, trendIndex);
    if (!Number.isFinite(atr) || !volatilityStates[trendIndex]?.valid) continue;
    events.push({
      symbol,
      fundingIndex,
      fundingTime: row.fundingTime,
      fundingRate: row.fundingRate,
      absFundingRate: Math.abs(row.fundingRate),
      direction: row.fundingRate > 0 ? -1 : 1,
      entryIndex,
      entryTime: entryCandle.openTime,
      entryPrice: entryCandle.open,
      trendIndex,
      atr,
      volatility: volatilityStates[trendIndex]
    });
  }
  return { symbol, prices, funding, fundingPrefix, fourHour, trendStates, volatilityStates, fundingFeatures, events, dataQuality: dataQuality(prices, funding) };
}

function trendValid(states, combo, index, direction) {
  const alignment = arguments.length >= 5 && arguments[4] === "opposite" ? -direction : direction;
  const side = alignment > 0 ? "long" : "short";
  return combo.every((rule) => states.get(rule.id)?.[index]?.[side] === true);
}

function buildTrendCombos() {
  const selectedRules = FIXED_TREND_RULE_IDS.length
    ? FIXED_TREND_RULE_IDS.map((id) => TREND_RULES_BY_ID.get(id)).filter(Boolean)
    : TREND_RULES;
  if (FIXED_TREND_RULE_IDS.length && selectedRules.length !== FIXED_TREND_RULE_IDS.length) {
    throw new Error(`Unknown FUNDING_CARRY_V2_TREND_RULE_IDS value: ${FIXED_TREND_RULE_IDS.join(",")}`);
  }
  const singles = selectedRules.map((rule) => [rule]);
  if (TREND_COMBINATION_MODE === "single") return singles;
  if (TREND_COMBINATION_MODE !== "single_or_pair") throw new Error(`Unsupported FUNDING_CARRY_V2_TREND_COMBINATION_MODE: ${TREND_COMBINATION_MODE}`);
  const pairs = [];
  for (let leftIndex = 0; leftIndex < selectedRules.length; leftIndex++) {
    for (let rightIndex = leftIndex + 1; rightIndex < selectedRules.length; rightIndex++) {
      pairs.push([selectedRules[leftIndex], selectedRules[rightIndex]]);
    }
  }
  return [...singles, ...pairs];
}

function comboId(combo) {
  return combo.map((rule) => rule.id).join("+");
}

function signalConfigKey(config) {
  return [comboId(config.trendRules), config.trendAlignment || "same", config.fundingSide || "both", config.marketTrendRule || "none", config.marketTrendAlignment || "same", config.fundingReversion ? "reversion" : "any", config.minFundingAtrRatio || 0, config.zWindow, config.entryZ, config.minAbsFunding, config.confirmation].join("|");
}

function signalGroupKey(config) {
  return [comboId(config.trendRules), config.trendAlignment || "same", config.fundingSide || "both", config.marketTrendRule || "none", config.marketTrendAlignment || "same", config.zWindow].join("|");
}

function fundingSum(rows, afterTime, throughTime) {
  return rows.filter((row) => row.fundingTime > afterTime && row.fundingTime <= throughTime).reduce((sum, row) => sum + row.fundingRate, 0);
}

function fundingSumFast(prepared, afterTime, throughTime) {
  const startIndex = lowerBound(prepared.funding, afterTime, (row) => row.fundingTime);
  const endIndex = lowerBound(prepared.funding, throughTime + 1, (row) => row.fundingTime);
  return (prepared.fundingPrefix?.[endIndex] ?? 0) - (prepared.fundingPrefix?.[startIndex] ?? 0);
}

function stopHit(prices, entryIndex, maxExitIndex, direction, stopPrice) {
  for (let index = entryIndex; index <= maxExitIndex && index < prices.length; index++) {
    const candle = prices[index];
    const hit = direction > 0 ? candle.low <= stopPrice : candle.high >= stopPrice;
    if (!hit) continue;
    const gap = direction > 0 ? candle.open <= stopPrice : candle.open >= stopPrice;
    return { index, price: gap ? candle.open : stopPrice };
  }
  return null;
}

function trendExitIndex(prepared, event, combo, maxHoldingHours) {
  const alignment = event.trendAlignment === "opposite" ? -event.direction : event.direction;
  const side = alignment > 0 ? "long" : "short";
  for (let index = event.trendIndex + 1; index < prepared.fourHour.length; index++) {
    const row = prepared.fourHour[index];
    if (row.closeTime <= event.entryTime) continue;
    if (row.closeTime > event.entryTime + maxHoldingHours * HOUR_MS) break;
    if (!combo.every((rule) => prepared.trendStates.get(rule.id)?.[index]?.[side] === true)) return lowerBound(prepared.prices, row.closeTime);
  }
  return Infinity;
}

function fundingExitIndex(prepared, event, config) {
  const features = prepared.fundingFeatures.get(config.zWindow);
  for (let index = event.fundingIndex + 1; index < prepared.funding.length; index++) {
    const row = prepared.funding[index];
    if (row.fundingTime >= event.entryTime + config.maxHoldingHours * HOUR_MS) break;
    const feature = features?.[index];
    if (!feature || Math.sign(row.fundingRate) !== Math.sign(event.fundingRate) || feature.signedZ < config.exitZ) {
      return lowerBound(prepared.prices, row.fundingTime + HOUR_MS);
    }
  }
  return Infinity;
}

function buildTrade(prepared, event, config) {
  const stopDistance = Math.max(event.atr * config.atrMultiplier, event.entryPrice * config.minStopPct);
  const stopPrice = event.direction > 0 ? event.entryPrice - stopDistance : event.entryPrice + stopDistance;
  const maxExitIndex = lowerBound(prepared.prices, event.entryTime + config.maxHoldingHours * HOUR_MS);
  const maxExit = { index: maxExitIndex, reason: "max_holding", priority: 3, price: null };
  const fundingExit = { index: fundingExitIndex(prepared, event, config), reason: "funding_threshold", priority: 2, price: null };
  const trendExit = { index: trendExitIndex(prepared, { ...event, trendAlignment: config.trendAlignment }, config.trendRules, config.maxHoldingHours), reason: "trend_reversal", priority: 1, price: null };
  const hit = stopHit(prepared.prices, event.entryIndex, maxExitIndex, event.direction, stopPrice);
  const candidates = [maxExit, fundingExit, trendExit];
  if (hit) candidates.push({ index: hit.index, reason: "atr_stop", priority: 0, price: hit.price });
  const exit = candidates.filter((item) => Number.isFinite(item.index) && item.index >= event.entryIndex).sort((a, b) => a.index - b.index || a.priority - b.priority)[0];
  const exitCandle = prepared.prices[exit?.index];
  if (!exitCandle) return null;
  const exitPrice = exit.price ?? exitCandle.open;
  const priceReturn = event.direction * (exitPrice / event.entryPrice - 1);
  const fundingReturn = -event.direction * fundingSum(prepared.funding, event.entryTime, exitCandle.openTime);
  const netReturn = priceReturn + fundingReturn - BASE_COST;
  const stopPct = stopDistance / event.entryPrice;
  const positionWeight = Math.min(MAX_LEVERAGE, ACCOUNT_RISK / stopPct);
  return {
    symbol: event.symbol,
    direction: event.direction,
    side: event.direction > 0 ? "LONG" : "SHORT",
    entryTime: event.entryTime,
    exitTime: exitCandle.openTime,
    entryPrice: event.entryPrice,
    exitPrice,
    fundingRate: event.fundingRate,
    signedZ: prepared.fundingFeatures.get(config.zWindow)?.[event.fundingIndex]?.signedZ ?? null,
    priceReturn,
    fundingReturn,
    grossReturn: priceReturn + fundingReturn,
    tradingCost: BASE_COST,
    netReturn,
    holdingHours: (exitCandle.openTime - event.entryTime) / HOUR_MS,
    exitReason: exit.reason,
    stopPct,
    stopPrice,
    positionWeight,
    accountRisk: positionWeight * stopPct,
    accountReturn: positionWeight * netReturn,
    trendRules: config.trendRules.map((rule) => rule.id),
    trendAlignment: config.trendAlignment || "same",
    zWindow: config.zWindow,
    entryZ: config.entryZ,
    minAbsFunding: config.minAbsFunding,
    maxHoldingHours: config.maxHoldingHours
  };
}

function selectPortfolio(trades, options = {}) {
  const ordered = [...trades].sort((a, b) => a.entryTime - b.entryTime || Math.abs(b.signedZ || 0) - Math.abs(a.signedZ || 0) || a.symbol.localeCompare(b.symbol));
  const open = [];
  const selected = [];
  for (const trade of ordered) {
    for (let index = open.length - 1; index >= 0; index--) if (open[index].exitTime <= trade.entryTime) open.splice(index, 1);
    const currentRisk = open.reduce((sum, item) => sum + item.accountRisk, 0);
    if (options.dedupeActiveSymbol && open.some((item) => item.symbol === trade.symbol)) continue;
    if (open.length >= MAX_OPEN_POSITIONS || currentRisk + trade.accountRisk > MAX_AGGREGATE_RISK + 1e-12) continue;
    selected.push(trade);
    open.push(trade);
  }
  return selected;
}

function monthCount(start, end) {
  let cursor = Date.UTC(new Date(start).getUTCFullYear(), new Date(start).getUTCMonth(), 1);
  const last = Date.UTC(new Date(end).getUTCFullYear(), new Date(end).getUTCMonth(), 1);
  let count = 0;
  while (cursor < last || (cursor === last && new Date(end).getUTCDate() > 1)) {
    count++;
    const date = new Date(cursor);
    cursor = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
  }
  return count;
}

function summary(trades, start = null, end = null) {
  const ordered = [...trades].sort((a, b) => a.exitTime - b.exitTime || a.entryTime - b.entryTime);
  const returns = ordered.map((trade) => trade.accountReturn).filter(Number.isFinite);
  const months = Number.isFinite(start) && Number.isFinite(end) ? monthCount(start, end) : 0;
  if (!returns.length) return { trades: 0, totalReturn: 0, averageNetReturn: null, winRate: null, profitFactor: 0, maxDrawdown: 0, positiveMonthRate: months ? 0 : null, months, signalsPerMonth: 0, maxSignalGapDays: months ? (end - start) / 86_400_000 : null, averageHoldingHours: null };
  let equity = 1;
  let peak = 1;
  let drawdown = 0;
  let profit = 0;
  let loss = 0;
  for (const value of returns) {
    equity *= 1 + value;
    peak = Math.max(peak, equity);
    drawdown = Math.min(drawdown, equity / peak - 1);
    if (value > 0) profit += value;
    else loss += value;
  }
  const monthly = new Map();
  if (months) {
    let cursor = Date.UTC(new Date(start).getUTCFullYear(), new Date(start).getUTCMonth(), 1);
    const last = Date.UTC(new Date(end).getUTCFullYear(), new Date(end).getUTCMonth(), 1);
    while (cursor < last || (cursor === last && new Date(end).getUTCDate() > 1)) {
      monthly.set(new Date(cursor).toISOString().slice(0, 7), 1);
      const date = new Date(cursor);
      cursor = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
    }
  }
  const entries = [];
  for (const trade of ordered) {
    entries.push(trade.entryTime);
    const key = new Date(trade.entryTime).toISOString().slice(0, 7);
    monthly.set(key, (monthly.get(key) || 1) * (1 + trade.accountReturn));
  }
  const boundaries = [...(Number.isFinite(start) ? [start] : []), ...entries, ...(Number.isFinite(end) ? [end] : [])].sort((a, b) => a - b);
  const gaps = boundaries.slice(1).map((time, index) => (time - boundaries[index]) / 86_400_000);
  const monthReturns = [...monthly.values()].map((value) => value - 1);
  return {
    trades: returns.length,
    totalReturn: equity - 1,
    averageNetReturn: mean(returns),
    winRate: returns.filter((value) => value > 0).length / returns.length,
    profitFactor: loss < 0 ? profit / Math.abs(loss) : profit > 0 ? Infinity : 0,
    maxDrawdown: drawdown,
    positiveMonthRate: monthReturns.length ? monthReturns.filter((value) => value > 0).length / monthReturns.length : null,
    months: months || monthReturns.length,
    signalsPerMonth: returns.length / Math.max(1, months || monthReturns.length),
    maxSignalGapDays: gaps.length ? Math.max(...gaps) : null,
    averageHoldingHours: mean(ordered.map((trade) => trade.holdingHours))
  };
}

function metrics(trades) {
  return {
    all: summary(trades),
    train: summary(trades.filter((trade) => trade.entryTime >= START && trade.entryTime < VALIDATION), START, VALIDATION),
    validation: summary(trades.filter((trade) => trade.entryTime >= VALIDATION && trade.entryTime < TEST), VALIDATION, TEST),
    test: summary(trades.filter((trade) => trade.entryTime >= TEST && trade.entryTime < END), TEST, END)
  };
}

function componentSummary(trades) {
  const rows = trades.filter((trade) => Number.isFinite(trade.positionWeight));
  const sum = (getter) => rows.reduce((total, trade) => total + getter(trade), 0);
  return {
    trades: rows.length,
    priceAccountReturn: sum((trade) => trade.positionWeight * trade.priceReturn),
    fundingAccountReturn: sum((trade) => trade.positionWeight * trade.fundingReturn),
    costAccountReturn: sum((trade) => -trade.positionWeight * trade.tradingCost),
    netAccountReturn: sum((trade) => trade.accountReturn),
    longTrades: rows.filter((trade) => trade.direction > 0).length,
    shortTrades: rows.filter((trade) => trade.direction < 0).length,
    stopTrades: rows.filter((trade) => trade.exitReason === "atr_stop").length,
    fundingExitTrades: rows.filter((trade) => trade.exitReason === "funding_threshold").length,
    trendExitTrades: rows.filter((trade) => trade.exitReason === "trend_reversal").length,
    maxHoldTrades: rows.filter((trade) => trade.exitReason === "max_holding").length
  };
}

function componentMetrics(trades) {
  return {
    all: componentSummary(trades),
    train: componentSummary(trades.filter((trade) => trade.entryTime >= START && trade.entryTime < VALIDATION)),
    validation: componentSummary(trades.filter((trade) => trade.entryTime >= VALIDATION && trade.entryTime < TEST)),
    test: componentSummary(trades.filter((trade) => trade.entryTime >= TEST && trade.entryTime < END))
  };
}

function gatePeriod(item, minimumTrades) {
  return {
    sample: item.trades >= minimumTrades,
    averagePositive: item.averageNetReturn > 0,
    pf: Number(item.profitFactor) >= 1.15,
    totalPositive: item.totalReturn > 0,
    drawdown: Math.abs(item.maxDrawdown) <= 0.2,
    positiveMonths: Number(item.positiveMonthRate) >= 0.5,
    frequency: Number(item.signalsPerMonth) >= 8,
    signalGap: item.maxSignalGapDays == null || item.maxSignalGapDays <= 14
  };
}

function gatePeriodPassed(item, includeFrequencyAndGap) {
  const required = ["sample", "averagePositive", "pf", "totalPositive", "drawdown", "positiveMonths"];
  if (includeFrequencyAndGap) required.push("frequency", "signalGap");
  return required.every((key) => item[key]);
}

function gate(metricsValue, stressMetrics, dataComplete, universeSize) {
  const train = gatePeriod(metricsValue.train, 120);
  const validation = gatePeriod(metricsValue.validation, 40);
  const test = gatePeriod(metricsValue.test, 24);
  const checks = {
    dataComplete,
    universeSize: universeSize >= MIN_UNIVERSE_SIZE,
    train: gatePeriodPassed(train, false),
    validation: gatePeriodPassed(validation, false),
    test: gatePeriodPassed(test, true),
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

function trainRankScore(item) {
  const drawdown = Math.max(0.01, Math.abs(item.metrics.train.maxDrawdown || 0));
  return (item.metrics.train.averageNetReturn || -Infinity) / drawdown;
}

function compareCandidates(a, b) {
  return trainRankScore(b) - trainRankScore(a)
    || Number(b.metrics.train.profitFactor || 0) - Number(a.metrics.train.profitFactor || 0)
    || Math.abs(a.metrics.train.maxDrawdown || 0) - Math.abs(b.metrics.train.maxDrawdown || 0)
    || a.config.trendRules.length - b.config.trendRules.length
    || b.metrics.train.trades - a.metrics.train.trades;
}

function buildSignalConfigs(combos) {
  const configs = [];
  for (const trendRules of combos) for (const zWindow of Z_WINDOWS) for (const entryZ of ENTRY_Z) for (const minAbsFunding of MIN_ABS_FUNDING) for (const confirmation of CONFIRMATION) {
    configs.push({ trendRules, zWindow, entryZ, minAbsFunding, confirmation, fundingReversion: FIXED_FUNDING_REVERSION });
  }
  return configs;
}

function expandSignalConfig(signalConfig) {
  const configs = [];
  for (const exitZ of EXIT_Z) for (const atrMultiplier of ATR_MULTIPLIERS) for (const minStopPct of MIN_STOP_PCTS) for (const maxHoldingHours of MAX_HOLDING_HOURS) {
    configs.push({ ...signalConfig, exitZ, atrMultiplier, minStopPct, maxHoldingHours });
  }
  return configs;
}

function compareSignalFilters(a, b) {
  const aTrain = a.metrics.train;
  const bTrain = b.metrics.train;
  const aEligible = aTrain.trades >= 120 && aTrain.signalsPerMonth >= 8;
  const bEligible = bTrain.trades >= 120 && bTrain.signalsPerMonth >= 8;
  return Number(bEligible) - Number(aEligible)
    || trainRankScore(b) - trainRankScore(a)
    || Number(bTrain.profitFactor || 0) - Number(aTrain.profitFactor || 0)
    || Math.abs(aTrain.maxDrawdown || 0) - Math.abs(bTrain.maxDrawdown || 0)
    || a.config.trendRules.length - b.config.trendRules.length
    || bTrain.trades - aTrain.trades;
}

function configLabel(config) {
  return {
    trendRules: config.trendRules.map((rule) => rule.id),
    trendAlignment: config.trendAlignment || "same",
    fundingSide: config.fundingSide || "both",
    dedupeActiveSymbol: Boolean(config.dedupeActiveSymbol),
    minFundingAtrRatio: config.minFundingAtrRatio || 0,
    fundingReversion: Boolean(config.fundingReversion),
    marketTrendRule: config.marketTrendRule || null,
    marketTrendAlignment: config.marketTrendAlignment || "same",
    zWindow: config.zWindow,
    entryZ: config.entryZ,
    minAbsFunding: config.minAbsFunding,
    exitZ: config.exitZ,
    confirmation: config.confirmation,
    atrMultiplier: config.atrMultiplier,
    minStopPct: config.minStopPct,
    maxHoldingHours: config.maxHoldingHours
  };
}

function parseProbeConfig(value) {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Probe config must be an object");
  const trendRuleIds = parsed.trendRules == null || parsed.trendRules === "none" ? [] : parsed.trendRules;
  if (!Array.isArray(trendRuleIds) || trendRuleIds.length > 2) throw new Error("Probe trendRules must be an array with at most two rule ids");
  const trendRules = trendRuleIds.map((id) => {
    const rule = TREND_RULES_BY_ID.get(id);
    if (!rule) throw new Error(`Unknown probe trend rule: ${id}`);
    return rule;
  });
  const config = {
    trendRules,
    trendAlignment: parsed.trendAlignment == null ? "same" : String(parsed.trendAlignment),
    fundingSide: parsed.fundingSide == null ? "both" : String(parsed.fundingSide),
    dedupeActiveSymbol: Boolean(parsed.dedupeActiveSymbol),
    minFundingAtrRatio: parsed.minFundingAtrRatio == null ? 0 : Number(parsed.minFundingAtrRatio),
    fundingReversion: Boolean(parsed.fundingReversion),
    marketTrendRule: parsed.marketTrendRule == null ? null : String(parsed.marketTrendRule),
    marketTrendAlignment: parsed.marketTrendAlignment == null ? "same" : String(parsed.marketTrendAlignment),
    zWindow: Number(parsed.zWindow),
    entryZ: Number(parsed.entryZ),
    minAbsFunding: Number(parsed.minAbsFunding),
    exitZ: Number(parsed.exitZ),
    confirmation: Number(parsed.confirmation),
    atrMultiplier: Number(parsed.atrMultiplier),
    minStopPct: Number(parsed.minStopPct),
    maxHoldingHours: Number(parsed.maxHoldingHours)
  };
  if (!["same", "opposite"].includes(config.trendAlignment)
    || !["both", "positive", "negative"].includes(config.fundingSide)
    || !["same", "opposite"].includes(config.marketTrendAlignment)
    || (config.marketTrendRule != null && !TREND_RULES_BY_ID.has(config.marketTrendRule))
    || !Number.isFinite(config.minFundingAtrRatio)
    || config.minFundingAtrRatio < 0
    || !Z_WINDOWS.includes(config.zWindow)
    || !ENTRY_Z.includes(config.entryZ)
    || !MIN_ABS_FUNDING.includes(config.minAbsFunding)
    || !EXIT_Z.includes(config.exitZ)
    || !CONFIRMATION.includes(config.confirmation)
    || !ATR_MULTIPLIERS.includes(config.atrMultiplier)
    || !MIN_STOP_PCTS.includes(config.minStopPct)
    || !MAX_HOLDING_HOURS.includes(config.maxHoldingHours)) {
    throw new Error(`Probe config contains values outside the fixed search grid: ${JSON.stringify(configLabel(config))}`);
  }
  return config;
}

function collectEligibleEvents(config, preparedSymbols) {
  const benchmark = preparedSymbols.find((prepared) => prepared.symbol === "BTCUSDT") || null;
  const eligible = [];
  for (const prepared of preparedSymbols) {
    for (const event of prepared.events) {
      if (config.fundingSide === "positive" && event.fundingRate <= 0) continue;
      if (config.fundingSide === "negative" && event.fundingRate >= 0) continue;
      if (!signalFilterPasses(prepared, event, config, benchmark)) continue;
      eligible.push({ prepared, event });
    }
  }
  return eligible;
}

function runConfigFromEligible(config, eligibleEvents, costMultiplier = 1) {
  const raw = [];
  for (const { prepared, event } of eligibleEvents) {
    const trade = buildTrade(prepared, event, { ...config, tradingCost: BASE_COST * costMultiplier });
    if (trade) {
      trade.tradingCost = BASE_COST * costMultiplier;
      trade.netReturn = trade.priceReturn + trade.fundingReturn - trade.tradingCost;
      trade.accountReturn = trade.positionWeight * trade.netReturn;
      raw.push(trade);
    }
  }
  const selected = selectPortfolio(raw, { dedupeActiveSymbol: config.dedupeActiveSymbol });
  return { raw, selected, metrics: metrics(selected) };
}

function runConfig(config, preparedSymbols, costMultiplier = 1) {
  return runConfigFromEligible(config, collectEligibleEvents(config, preparedSymbols), costMultiplier);
}

function signalFilterPasses(prepared, event, signalConfig, benchmark = null) {
  const feature = prepared.fundingFeatures.get(signalConfig.zWindow)?.[event.fundingIndex];
  if (!feature || feature.signedZ < signalConfig.entryZ || event.absFundingRate < signalConfig.minAbsFunding) return false;
  const atrPct = event.entryPrice > 0 ? event.atr / event.entryPrice : null;
  if (signalConfig.minFundingAtrRatio > 0 && (!Number.isFinite(atrPct) || event.absFundingRate * 3 / atrPct < signalConfig.minFundingAtrRatio)) return false;
  if (signalConfig.fundingReversion) {
    const previous = prepared.funding[event.fundingIndex - 1];
    if (!previous || (event.direction > 0 ? event.fundingRate <= previous.fundingRate : event.fundingRate >= previous.fundingRate)) return false;
  }
  if (!prepared.volatilityStates[event.trendIndex]?.valid) return false;
  if (!trendValid(prepared.trendStates, signalConfig.trendRules, event.trendIndex, event.direction, signalConfig.trendAlignment)) return false;
  if (signalConfig.marketTrendRule) {
    if (!benchmark) return false;
    const benchmarkIndex = lowerBound(benchmark.fourHour, event.fundingTime + 1, (item) => item.closeTime) - 1;
    if (benchmarkIndex < 0 || !trendValid(benchmark.trendStates, [TREND_RULES_BY_ID.get(signalConfig.marketTrendRule)], benchmarkIndex, event.direction, signalConfig.marketTrendAlignment || "same")) return false;
  }
  for (let index = Math.max(0, event.fundingIndex - signalConfig.confirmation + 1); index <= event.fundingIndex; index++) {
    const prior = prepared.funding[index];
    const priorFeature = prepared.fundingFeatures.get(signalConfig.zWindow)?.[index];
    if (!priorFeature || Math.sign(prior.fundingRate) !== Math.sign(event.fundingRate) || priorFeature.signedZ < signalConfig.entryZ || Math.abs(prior.fundingRate) < signalConfig.minAbsFunding) return false;
  }
  return true;
}

function buildQuickSignalTrade(prepared, event, signalConfig, probeConfig) {
  const exitIndex = lowerBound(prepared.prices, event.entryTime + probeConfig.maxHoldingHours * HOUR_MS);
  const exitCandle = prepared.prices[exitIndex];
  if (!exitCandle) return null;
  const stopDistance = Math.max(event.atr * probeConfig.atrMultiplier, event.entryPrice * probeConfig.minStopPct);
  const stopPct = stopDistance / event.entryPrice;
  const positionWeight = Math.min(MAX_LEVERAGE, ACCOUNT_RISK / stopPct);
  const priceReturn = event.direction * (exitCandle.open / event.entryPrice - 1);
  const fundingReturn = -event.direction * fundingSumFast(prepared, event.entryTime, exitCandle.openTime);
  const tradingCost = BASE_COST;
  const netReturn = priceReturn + fundingReturn - tradingCost;
  return {
    symbol: event.symbol,
    direction: event.direction,
    side: event.direction > 0 ? "LONG" : "SHORT",
    entryTime: event.entryTime,
    exitTime: exitCandle.openTime,
    entryPrice: event.entryPrice,
    exitPrice: exitCandle.open,
    fundingRate: event.fundingRate,
    signedZ: prepared.fundingFeatures.get(signalConfig.zWindow)?.[event.fundingIndex]?.signedZ ?? null,
    priceReturn,
    fundingReturn,
    grossReturn: priceReturn + fundingReturn,
    tradingCost,
    netReturn,
    holdingHours: (exitCandle.openTime - event.entryTime) / HOUR_MS,
    exitReason: "proxy_horizon",
    stopPct,
    stopPrice: event.direction > 0 ? event.entryPrice - stopDistance : event.entryPrice + stopDistance,
    positionWeight,
    accountRisk: positionWeight * stopPct,
    accountReturn: positionWeight * netReturn,
    trendRules: signalConfig.trendRules.map((rule) => rule.id),
    trendAlignment: signalConfig.trendAlignment || "same",
    zWindow: signalConfig.zWindow,
    entryZ: signalConfig.entryZ,
    minAbsFunding: signalConfig.minAbsFunding,
    maxHoldingHours: probeConfig.maxHoldingHours
  };
}

function runSignalFilterGroups(signalConfigs, preparedSymbols, probeConfig) {
  const benchmark = preparedSymbols.find((prepared) => prepared.symbol === "BTCUSDT") || null;
  const groups = new Map();
  for (const signalConfig of signalConfigs) {
    const key = signalGroupKey(signalConfig);
    const group = groups.get(key) || { signalConfigs: [], trendRules: signalConfig.trendRules, zWindow: signalConfig.zWindow, trendAlignment: signalConfig.trendAlignment, marketTrendRule: signalConfig.marketTrendRule, marketTrendAlignment: signalConfig.marketTrendAlignment };
    group.signalConfigs.push(signalConfig);
    groups.set(key, group);
  }
  const results = [];
  for (const group of groups.values()) {
    const baseEvents = preparedSymbols.map((prepared) => [prepared, prepared.events.filter((event) => {
      const signalConfig = { trendRules: group.trendRules, trendAlignment: group.trendAlignment, marketTrendRule: group.marketTrendRule, marketTrendAlignment: group.marketTrendAlignment };
      if (!prepared.volatilityStates[event.trendIndex]?.valid) return false;
      if (!trendValid(prepared.trendStates, signalConfig.trendRules, event.trendIndex, event.direction, signalConfig.trendAlignment)) return false;
      if (signalConfig.marketTrendRule) {
        if (!benchmark) return false;
        const benchmarkIndex = lowerBound(benchmark.fourHour, event.fundingTime + 1, (item) => item.closeTime) - 1;
        if (benchmarkIndex < 0 || !trendValid(benchmark.trendStates, [TREND_RULES_BY_ID.get(signalConfig.marketTrendRule)], benchmarkIndex, event.direction, signalConfig.marketTrendAlignment || "same")) return false;
      }
      return true;
    })]);
    for (const signalConfig of group.signalConfigs) {
      const raw = [];
      for (const [prepared, events] of baseEvents) {
        for (const event of events) {
          if (!signalFilterPasses(prepared, event, signalConfig, benchmark)) continue;
          if (signalConfig.fundingSide === "positive" && event.fundingRate <= 0) continue;
          if (signalConfig.fundingSide === "negative" && event.fundingRate >= 0) continue;
          const trade = buildQuickSignalTrade(prepared, event, signalConfig, probeConfig);
          if (trade) raw.push(trade);
        }
      }
      const selected = selectPortfolio(raw);
      const config = { ...signalConfig, ...probeConfig, trendAlignment: group.trendAlignment };
      results.push({
        config: configLabel(config),
        internalConfig: signalConfig,
        metrics: metrics(selected),
        rawSignalCount: raw.length,
        selectedTradeCount: selected.length,
        trainRankScore: trainRankScore({ metrics: metrics(selected) })
      });
    }
  }
  return results;
}

function serializable(value) {
  if (value === Infinity) return null;
  if (Array.isArray(value)) return value.map(serializable);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, serializable(item)]));
  return value;
}

async function loadUniverse() {
  try {
    const manifest = JSON.parse(await readFile(UNIVERSE_FILE, "utf8"));
    if (Array.isArray(manifest.selectedSymbols) && manifest.selectedSymbols.length) return manifest;
  } catch {
    // Fall back to symbols with existing Funding cache for a diagnostic run.
  }
  const names = await readdir(FUNDING_ROOT);
  const selectedSymbols = [...new Set(names.filter((name) => name.endsWith(".json")).map((name) => name.split("-")[0]).filter((symbol) => symbol.endsWith("USDT")))];
  return { selectedSymbols, selectedSize: selectedSymbols.length, targetSize: TARGET_UNIVERSE_SIZE, fallback: true };
}

async function main() {
  const universe = await loadUniverse();
  const preparedSymbols = [];
  for (const symbol of universe.selectedSymbols) {
    const prepared = await prepareSymbol(symbol);
    if (prepared) preparedSymbols.push(prepared);
  }
  if (!preparedSymbols.length) throw new Error("No complete v2 price/funding datasets found");
  const dataComplete = preparedSymbols.every((item) => item.dataQuality.complete);
  const probeInput = process.env.FUNDING_CARRY_V2_PROBE_CONFIGS || process.env.FUNDING_CARRY_V2_PROBE_CONFIG;
  if (probeInput || process.env.FUNDING_CARRY_V2_PROBE_ALL_PAIRS === "1") {
    const parsed = probeInput ? JSON.parse(probeInput) : null;
    const rawConfigs = process.env.FUNDING_CARRY_V2_PROBE_ALL_PAIRS === "1"
      ? buildTrendCombos().map((trendRules) => ({ trendRules: trendRules.map((rule) => rule.id), zWindow: 180, entryZ: 1, minAbsFunding: 0.0002, exitZ: 0.25, confirmation: 1, atrMultiplier: 1.5, minStopPct: 0.008, maxHoldingHours: 24 }))
      : (Array.isArray(parsed) ? parsed : [parsed]);
    const probes = rawConfigs.map((value) => {
      const config = parseProbeConfig(value);
      const base = runConfig(config, preparedSymbols, 1);
      const stress15 = runConfig(config, preparedSymbols, COST_STRESS_MULTIPLIERS[0]);
      const stress2 = runConfig(config, preparedSymbols, COST_STRESS_MULTIPLIERS[1]);
      return {
        config: configLabel(config),
        metrics: base.metrics,
        components: componentMetrics(base.selected),
        stressMetrics: { "1.5x": stress15.metrics, "2x": stress2.metrics },
        gate: gate(base.metrics, stress15.metrics, dataComplete, preparedSymbols.length),
        rawSignalCount: base.raw.length,
        selectedTradeCount: base.selected.length
      };
    });
    const probeOutput = process.env.FUNDING_CARRY_V2_PROBE_OUTPUT || "funding_carry_v2_probe_2026-08-02.json";
    const output = serializable({
      generatedAt: new Date().toISOString(),
      purpose: "Fixed-grid diagnostic probes only; no parameter is selected from Validation/Test and no deployment is authorized.",
      assumptions: {
        universeFile: UNIVERSE_FILE,
        manifestUniverseSize: universe.selectedSymbols.length,
        preparedUniverseSize: preparedSymbols.length,
        dataComplete,
        baseRoundTripCost: BASE_COST,
        costStressMultipliers: COST_STRESS_MULTIPLIERS,
        gateVersion: GATE_VERSION
      },
      probes
    });
    await writeFile(probeOutput, `${JSON.stringify(output, null, 2)}\n`);
    console.log(JSON.stringify({ probeOutput, probes: probes.map((item) => ({ config: item.config, train: item.metrics.train, validation: item.metrics.validation, test: item.metrics.test, gate: item.gate })) }, null, 2));
    if (REQUIRE_PASS && !probes.some((item) => item.gate.passed)) process.exitCode = 1;
    return;
  }
  const combos = buildTrendCombos();
  const signalConfigs = buildSignalConfigs(combos);
  const probeConfig = { atrMultiplier: 2, minStopPct: 0.012, maxHoldingHours: 48, exitZ: 0.5 };
  const signalResults = runSignalFilterGroups(signalConfigs, preparedSymbols, probeConfig);
  signalResults.sort(compareSignalFilters);
  const expandedSignalResults = signalResults.slice(0, SIGNAL_FILTER_EXPANSION_LIMIT);
  const configs = expandedSignalResults.flatMap((item) => expandSignalConfig(item.internalConfig));
  const results = [];
  const eligibleEventsBySignal = new Map();
  for (const config of configs) {
    const key = signalConfigKey(config);
    const eligibleEvents = eligibleEventsBySignal.get(key) || collectEligibleEvents(config, preparedSymbols);
    eligibleEventsBySignal.set(key, eligibleEvents);
    const base = runConfigFromEligible(config, eligibleEvents, 1);
    results.push({ config: configLabel(config), internalConfig: config, metrics: base.metrics, rawSignalCount: base.raw.length, selectedTradeCount: base.selected.length, trainRankScore: trainRankScore({ metrics: base.metrics }) });
  }
  results.sort(compareCandidates);
  const topTrain = results.slice(0, 100);
  const evaluated = [];
  for (const item of topTrain) {
    const config = item.internalConfig;
    const eligibleEvents = eligibleEventsBySignal.get(signalConfigKey(config)) || collectEligibleEvents(config, preparedSymbols);
    const base = runConfigFromEligible(config, eligibleEvents, 1);
    const stress15 = runConfigFromEligible(config, eligibleEvents, COST_STRESS_MULTIPLIERS[0]);
    const stress2 = runConfigFromEligible(config, eligibleEvents, COST_STRESS_MULTIPLIERS[1]);
    const itemGate = gate(base.metrics, stress15.metrics, dataComplete, preparedSymbols.length);
    evaluated.push({
      config: configLabel(config),
      metrics: base.metrics,
      stressMetrics: { "1.5x": stress15.metrics, "2x": stress2.metrics },
      gate: itemGate,
      rawSignalCount: base.raw.length,
      selectedTradeCount: base.selected.length,
      trainRankScore: trainRankScore({ metrics: base.metrics })
    });
  }
  evaluated.sort((a, b) => trainRankScore({ metrics: b.metrics }) - trainRankScore({ metrics: a.metrics }) || Number(b.metrics.train.profitFactor || 0) - Number(a.metrics.train.profitFactor || 0));
  const selected = evaluated[0] || null;
  const deploymentGatePassed = Boolean(selected?.gate.passed);
  const output = serializable({
    generatedAt: new Date().toISOString(),
    purpose: "Funding Carry V2 with train-only liquid-universe selection, rolling funding z-score, 4h volatility cap, directional price PnL, Funding PnL, costs, 24/48/72-hour exits and strict out-of-sample gates.",
    assumptions: {
      priceCache: PRICE_ROOT,
      fundingCache: FUNDING_ROOT,
      backtestMode: BACKTEST_MODE,
      universeFile: UNIVERSE_FILE,
      targetUniverseSize: TARGET_UNIVERSE_SIZE,
      preparedUniverseSize: preparedSymbols.length,
      universeShortfall: Math.max(0, TARGET_UNIVERSE_SIZE - preparedSymbols.length),
      baseRoundTripCost: BASE_COST,
      costStressMultipliers: COST_STRESS_MULTIPLIERS,
      accountRiskPerTrade: ACCOUNT_RISK,
      maxLeverage: MAX_LEVERAGE,
      maxOpenPositions: MAX_OPEN_POSITIONS,
      maxAggregateRisk: MAX_AGGREGATE_RISK,
      volatilityFilter: `4h ATR14/close <= prior ${VOLATILITY_LOOKBACK}-bar ${VOLATILITY_PERCENTILE * 100}th percentile`,
      trendComboPolicy: TREND_COMBINATION_MODE === "single" ? "single trend rule only" : "all single rules plus every pair of distinct rules; at most two rules",
      fixedTrendRuleIds: FIXED_TREND_RULE_IDS,
      fundingReversionMode: FIXED_FUNDING_REVERSION,
      gateVersion: GATE_VERSION,
      sideMapping: "positive funding -> SHORT; negative funding -> LONG",
      entryTiming: "after a closed funding observation, next 1h candle open",
      split: { train: "2023-01-01 through 2024-12-31", validation: "2025-01-01 through 2025-12-31", test: "2026-01-01 through 2026-06-30" }
    },
    search: {
      evaluatedConfigs: configs.length,
      theoreticalConfigs: combos.length * Z_WINDOWS.length * ENTRY_Z.length * MIN_ABS_FUNDING.length * EXIT_Z.length * CONFIRMATION.length * ATR_MULTIPLIERS.length * MIN_STOP_PCTS.length * MAX_HOLDING_HOURS.length,
      signalFilterConfigs: signalConfigs.length,
      expandedSignalFilters: expandedSignalResults.length,
      exitGridPerSignalFilter: EXIT_Z.length * ATR_MULTIPLIERS.length * MIN_STOP_PCTS.length * MAX_HOLDING_HOURS.length,
      frequencyAndGapGateScope: "test_only",
      stagedSearch: true,
      trendCombinationMode: TREND_COMBINATION_MODE,
      fixedTrendRuleIds: FIXED_TREND_RULE_IDS,
      fixedFundingReversion: FIXED_FUNDING_REVERSION,
      signalRankingProxy: "Train-only 48h horizon return with funding and cost; exact stop/funding/trend exits are applied to expanded candidates",
      expansionPolicy: "rank all Train-only signal filters with a fixed 48h horizon proxy, then exact-search every fixed exit parameter combination for the top 50 filters; Validation/Test are never used for selection",
      fullyAuditedConfigs: evaluated.length,
      selectedOnTrainOnly: true,
      zWindows: Z_WINDOWS,
      entryZ: ENTRY_Z,
      minAbsFunding: MIN_ABS_FUNDING,
      exitZ: EXIT_Z,
      confirmation: CONFIRMATION,
      atrMultipliers: ATR_MULTIPLIERS,
      minStopPcts: MIN_STOP_PCTS,
      maxHoldingHours: MAX_HOLDING_HOURS,
      trainEligible: evaluated.filter((item) => gatePeriodPassed(item.gate.train, false)).length
    },
    historicalGatePassed: deploymentGatePassed,
    deploymentGatePassed,
    selectedCandidate: selected,
    topTrainCandidates: evaluated.slice(0, 20),
    passingCandidates: evaluated.filter((item) => item.gate.passed).slice(0, 20),
    dataQuality: Object.fromEntries(preparedSymbols.map((item) => [item.symbol, item.dataQuality]))
  });
  await writeFile(OUTPUT_FILE, `${JSON.stringify(output, null, 2)}\n`);
  console.log(JSON.stringify({
    evaluatedConfigs: configs.length,
    fullyAuditedConfigs: evaluated.length,
    manifestUniverseSize: universe.selectedSymbols.length,
    preparedUniverseSize: preparedSymbols.length,
    trainEligible: output.search.trainEligible,
    deploymentGatePassed,
    selectedOnTrain: selected?.config || null,
    selectedGate: selected?.gate || null
  }, null, 2));
  if (REQUIRE_PASS && !deploymentGatePassed) process.exitCode = 1;
}

await main();
