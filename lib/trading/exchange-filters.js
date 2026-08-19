const EPSILON = 1e-12;

export const INVALID_FILTER_VALUES = "INVALID_FILTER_VALUES";
export const MIN_QTY = "MIN_QTY";
export const MAX_QTY = "MAX_QTY";
export const MIN_NOTIONAL = "MIN_NOTIONAL";
export const MAX_NOTIONAL = "MAX_NOTIONAL";
export const INVALID_STEP_SIZE = "INVALID_STEP_SIZE";

export function normalizeExchangeFilters(input) {
  if (input == null) return null;
  const source = input.exchangeFilters
    || (Array.isArray(input.filters) ? parseBinanceSymbolFilters(input) : input);
  const filters = {
    tickSize: positiveNumber(source.tickSize),
    stepSize: positiveNumber(source.stepSize),
    minQty: nonNegativeNumber(source.minQty),
    maxQty: positiveNumber(source.maxQty),
    minNotional: nonNegativeNumber(source.minNotional),
    maxNotional: positiveNumber(source.maxNotional),
    marketStepSize: positiveNumber(source.marketStepSize),
    marketMinQty: nonNegativeNumber(source.marketMinQty),
    marketMaxQty: positiveNumber(source.marketMaxQty),
    source: source.source || "injected"
  };
  if (!filters.tickSize || !filters.stepSize) return null;
  if (isPresent(source.tickSize) && !filters.tickSize) return null;
  if (isPresent(source.stepSize) && !filters.stepSize) return null;
  if (isPresent(source.minQty) && filters.minQty == null) return null;
  if (isPresent(source.maxQty) && !filters.maxQty) return null;
  if (isPresent(source.minNotional) && filters.minNotional == null) return null;
  if (isPresent(source.maxNotional) && !filters.maxNotional) return null;
  if (isPresent(source.marketStepSize) && !filters.marketStepSize) return null;
  if (isPresent(source.marketMinQty) && filters.marketMinQty == null) return null;
  if (isPresent(source.marketMaxQty) && !filters.marketMaxQty) return null;
  return Object.freeze(filters);
}

export function validateExchangeFilters(input) {
  const filters = normalizeExchangeFilters(input);
  return filters
    ? { valid: true, filters, reason: null }
    : { valid: false, filters: null, reason: INVALID_FILTER_VALUES };
}

export function parseBinanceSymbolFilters(symbolInfo = {}) {
  const rows = Array.isArray(symbolInfo.filters) ? symbolInfo.filters : [];
  const price = findFilter(rows, "PRICE_FILTER");
  const lot = findFilter(rows, "LOT_SIZE");
  const marketLot = findFilter(rows, "MARKET_LOT_SIZE") || lot;
  const notional = findFilter(rows, "MIN_NOTIONAL") || findFilter(rows, "NOTIONAL");
  return normalizeExchangeFilters({
    tickSize: price?.tickSize,
    stepSize: lot?.stepSize,
    minQty: lot?.minQty,
    maxQty: lot?.maxQty,
    minNotional: notional?.minNotional ?? notional?.notional,
    maxNotional: notional?.maxNotional,
    marketStepSize: marketLot?.stepSize,
    marketMinQty: marketLot?.minQty,
    marketMaxQty: marketLot?.maxQty,
    source: "BINANCE_EXCHANGE_INFO"
  });
}

export function extractBinanceExchangeFilters(exchangeInfo, symbol) {
  const symbolInfo = (exchangeInfo?.symbols || []).find((item) => item.symbol === symbol);
  return symbolInfo ? parseBinanceSymbolFilters(symbolInfo) : null;
}

export function roundPriceToTick(price, tickSize, mode = "nearest") {
  return roundToStep(price, tickSize, mode);
}

export function roundQtyToStep(quantity, stepSize, mode = "floor") {
  return roundToStep(quantity, stepSize, mode);
}

export function roundTradeLevels({ side, stopLoss, takeProfit, exchangeFilters } = {}) {
  const filters = normalizeExchangeFilters(exchangeFilters);
  if (!filters) {
    return {
      valid: exchangeFilters == null,
      reason: exchangeFilters == null ? null : INVALID_FILTER_VALUES,
      rawStopLoss: Number(stopLoss),
      roundedStopLoss: Number(stopLoss),
      rawTakeProfit: Number(takeProfit),
      roundedTakeProfit: Number(takeProfit),
      filters: null
    };
  }
  const isShort = String(side || "").toUpperCase() === "SHORT";
  const roundedStopLoss = roundPriceToTick(stopLoss, filters.tickSize, isShort ? "floor" : "ceil");
  const roundedTakeProfit = roundPriceToTick(takeProfit, filters.tickSize, isShort ? "ceil" : "floor");
  const valid = Number.isFinite(roundedStopLoss) && Number.isFinite(roundedTakeProfit);
  return {
    valid,
    reason: valid ? null : INVALID_FILTER_VALUES,
    rawStopLoss: Number(stopLoss),
    roundedStopLoss,
    rawTakeProfit: Number(takeProfit),
    roundedTakeProfit,
    filters,
    roundingMode: {
      stopLoss: isShort ? "floor_toward_entry" : "ceil_toward_entry",
      takeProfit: isShort ? "ceil_conservative" : "floor_conservative"
    }
  };
}

export function prepareTradeSpecForExecution(tradeSpec, exchangeFilters = null) {
  if (exchangeFilters == null) {
    return {
      valid: true,
      tradeSpec,
      filters: null,
      rounding: {
        rawStopLoss: tradeSpec?.stopLoss ?? null,
        roundedStopLoss: tradeSpec?.stopLoss ?? null,
        rawTakeProfit: tradeSpec?.takeProfit ?? null,
        roundedTakeProfit: tradeSpec?.takeProfit ?? null
      },
      reason: null
    };
  }
  const filtersResult = validateExchangeFilters(exchangeFilters);
  if (!filtersResult.valid) return { valid: false, tradeSpec: null, filters: null, rounding: null, reason: filtersResult.reason };
  const rounding = roundTradeLevels({
    side: tradeSpec?.side,
    stopLoss: tradeSpec?.stopLoss,
    takeProfit: tradeSpec?.takeProfit,
    exchangeFilters: filtersResult.filters
  });
  if (!rounding.valid) return { valid: false, tradeSpec: null, filters: filtersResult.filters, rounding, reason: rounding.reason };
  return {
    valid: true,
    tradeSpec: {
      ...tradeSpec,
      stopLoss: rounding.roundedStopLoss,
      takeProfit: rounding.roundedTakeProfit,
      entry: tradeSpec?.entry ? { ...tradeSpec.entry } : tradeSpec?.entry
    },
    filters: filtersResult.filters,
    rounding,
    reason: null
  };
}

export function roundExecutionPrice({ price, side, role, exchangeFilters } = {}) {
  const filters = normalizeExchangeFilters(exchangeFilters);
  if (!filters) return Number(price);
  const normalizedRole = String(role || "").toLowerCase();
  const isShort = String(side || "").toUpperCase() === "SHORT";
  if (normalizedRole === "entry") {
    return roundPriceToTick(price, filters.tickSize, isShort ? "floor" : "ceil");
  }
  if (normalizedRole === "take_profit") {
    return roundPriceToTick(price, filters.tickSize, isShort ? "ceil" : "floor");
  }
  if (normalizedRole === "stop_loss") {
    return roundPriceToTick(price, filters.tickSize, isShort ? "ceil" : "floor");
  }
  return roundPriceToTick(price, filters.tickSize, "nearest");
}

export function validateExecutionQuantity({ quantity, price, exchangeFilters, orderType = "MARKET" } = {}) {
  const filtersResult = validateExchangeFilters(exchangeFilters);
  if (!filtersResult.valid) return { valid: false, reason: INVALID_FILTER_VALUES, filters: null };
  const filters = filtersResult.filters;
  const useMarket = String(orderType).toUpperCase() === "MARKET";
  const stepSize = useMarket ? filters.marketStepSize || filters.stepSize : filters.stepSize;
  const minQty = useMarket ? filters.marketMinQty ?? filters.minQty : filters.minQty;
  const maxQty = useMarket ? filters.marketMaxQty ?? filters.maxQty : filters.maxQty;
  if (!stepSize || !Number.isFinite(Number(quantity)) || Number(quantity) <= 0) {
    return { valid: false, reason: INVALID_STEP_SIZE, filters };
  }
  const roundedQty = roundQtyToStep(Number(quantity), stepSize, "floor");
  if (!Number.isFinite(roundedQty) || roundedQty <= 0) return { valid: false, reason: INVALID_STEP_SIZE, filters };
  if (Number.isFinite(minQty) && roundedQty + EPSILON < minQty) return { valid: false, reason: MIN_QTY, roundedQty, filters };
  if (Number.isFinite(maxQty) && roundedQty - EPSILON > maxQty) return { valid: false, reason: MAX_QTY, roundedQty, filters };
  const notional = Number(price) * roundedQty;
  if (!Number.isFinite(notional)) return { valid: false, reason: MIN_NOTIONAL, roundedQty, filters };
  if (Number.isFinite(filters.minNotional) && notional + EPSILON < filters.minNotional) {
    return { valid: false, reason: MIN_NOTIONAL, roundedQty, notional, filters };
  }
  if (Number.isFinite(filters.maxNotional) && notional - EPSILON > filters.maxNotional) {
    return { valid: false, reason: MAX_NOTIONAL, roundedQty, notional, filters };
  }
  return { valid: true, reason: null, roundedQty, notional, filters };
}

function findFilter(filters, filterType) {
  return filters.find((filter) => filter.filterType === filterType) || null;
}

function roundToStep(value, step, mode) {
  const number = Number(value);
  const increment = Number(step);
  if (!Number.isFinite(number) || !Number.isFinite(increment) || increment <= 0) return null;
  const units = number / increment;
  const roundedUnits = mode === "floor"
    ? Math.floor(units + EPSILON)
    : mode === "ceil"
      ? Math.ceil(units - EPSILON)
      : Math.round(units);
  return cleanFloat(roundedUnits * increment);
}

function cleanFloat(value) {
  return Number(Number(value).toPrecision(15));
}

function positiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function nonNegativeNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function isPresent(value) {
  return value !== undefined && value !== null && value !== "";
}
