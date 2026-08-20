import { isTradeSpec } from "../trading/trade-spec.js";
import {
  normalizeExchangeFilters,
  roundExecutionPrice,
  validateExchangeFilters
} from "../trading/exchange-filters.js";

export const COMPLETE_DATA_QUALITY = "COMPLETE";
export const INCOMPLETE_FUNDING = "INCOMPLETE_FUNDING";
export const NO_FUNDING_EVENTS_CONFIRMED = "NO_FUNDING_EVENTS_CONFIRMED";
export const FUNDING_DATA_MISSING = "FUNDING_DATA_MISSING";
export const INCOMPLETE_EXCHANGE_FILTERS = "INCOMPLETE_EXCHANGE_FILTERS";

export function createExecutionModel(options = {}) {
  const marketType = options.marketType || "spot";
  const fee = options.fee || {};
  const defaultFeeMode = normalizeFeeMode(options.feeMode || "taker");
  const entryFeeMode = normalizeFeeMode(options.entryFeeMode || defaultFeeMode);
  const exitFeeMode = normalizeFeeMode(options.exitFeeMode || defaultFeeMode);
  const makerFeePct = nonNegativeNumber(fee.makerPct ?? options.makerFeePct) ?? 0;
  const takerFeePct = nonNegativeNumber(fee.takerPct ?? options.takerFeePct) ?? 0;
  const legacyRoundTripCostPct = nonNegativeNumber(options.legacyRoundTripCostPct);
  const entryFeePct = nonNegativeNumber(options.entryFeePct)
    ?? (legacyRoundTripCostPct != null ? legacyRoundTripCostPct / 2 : feeForMode(entryFeeMode, makerFeePct, takerFeePct));
  const exitFeePct = nonNegativeNumber(options.exitFeePct)
    ?? (legacyRoundTripCostPct != null ? legacyRoundTripCostPct / 2 : feeForMode(exitFeeMode, makerFeePct, takerFeePct));
  const fundingEvents = normalizeFundingEvents(options.fundingEvents);
  const fundingCoverage = normalizeFundingCoverage(options.fundingCoverage, fundingEvents.length);
  const exchangeRulesRequired = options.exchangeRulesRequired !== false;
  const fundingDataComplete = marketType !== "futures"
    ? true
    : fundingCoverage?.complete === true;
  const fundingStatus = marketType !== "futures"
    ? "NOT_APPLICABLE"
    : fundingDataComplete
      ? fundingCoverage?.eventCount === 0
        ? NO_FUNDING_EVENTS_CONFIRMED
        : COMPLETE_DATA_QUALITY
      : INCOMPLETE_FUNDING;

  return Object.freeze({
    marketType,
    fee: Object.freeze({
      makerPct: makerFeePct,
      takerPct: takerFeePct,
      defaultMode: defaultFeeMode
    }),
    entryFeeMode,
    exitFeeMode,
    entryFeePct,
    exitFeePct,
    spreadPct: nonNegativeNumber(options.spreadPct) ?? 0,
    entrySlippagePct: nonNegativeNumber(options.entrySlippagePct) ?? 0,
    exitSlippagePct: nonNegativeNumber(options.exitSlippagePct) ?? 0,
    exchangeRulesRequired,
    fundingEvents,
    fundingCoverage,
    fundingDataComplete,
    fundingStatus,
    legacyRoundTripCostPct: legacyRoundTripCostPct ?? null,
    dataQuality: marketType === "futures" && !fundingDataComplete
      ? INCOMPLETE_FUNDING
      : COMPLETE_DATA_QUALITY
  });
}

export function createLegacyExecutionModel(tradingCost, marketType = "spot") {
  return createExecutionModel({
    marketType,
    legacyRoundTripCostPct: tradingCost,
    fundingEvents: marketType === "futures" ? [] : undefined,
    fundingDataComplete: marketType !== "futures",
    exchangeRulesRequired: marketType === "futures"
  });
}

export function resolveEntryExecution({
  tradeSpec,
  entryCandle = null,
  entryTime = null,
  marketPrice = null,
  executionModel = createExecutionModel(),
  exchangeFilters = null
} = {}) {
  if (!isTradeSpec(tradeSpec)) {
    return { valid: false, status: "NO_ENTRY", reason: "invalid_trade_spec_or_entry_price" };
  }
  const filterValidation = exchangeFilters == null
    ? { valid: true, filters: null, reason: null }
    : validateExchangeFilters(exchangeFilters);
  if (!filterValidation.valid) {
    return {
      valid: false,
      status: "NO_ENTRY",
      reason: filterValidation.reason || "invalid_exchange_filters"
    };
  }
  const normalizedFilters = filterValidation.filters;
  const explicitEntryTime = toTimestamp(entryTime);
  const resolvedEntryTime = Number.isFinite(explicitEntryTime)
    ? explicitEntryTime
    : Number(entryCandle?.openTime);
  const candleOpen = Number(entryCandle?.open);
  const candleClose = Number(entryCandle?.close);
  const resolvedMarketPrice = marketPrice != null && Number.isFinite(Number(marketPrice))
    ? Number(marketPrice)
    : Number.isFinite(candleOpen)
      ? candleOpen
      : candleClose;
  const entryEligibleAt = Number(tradeSpec.entryEligibleAt);
  if (!Number.isFinite(resolvedEntryTime) || !Number.isFinite(resolvedMarketPrice)) {
    return { valid: false, status: "MISSED_ENTRY", reason: "missing_entry_observation" };
  }
  if (!Number.isFinite(entryEligibleAt) || resolvedEntryTime < entryEligibleAt) {
    return { valid: false, status: "MISSED_ENTRY", reason: "entry_before_eligibility" };
  }
  const frozenMaxHoldingTime = tradeSpec.maxHoldingTime == null
    ? null
    : Number(tradeSpec.maxHoldingTime);
  if (Number.isFinite(frozenMaxHoldingTime) && resolvedEntryTime >= frozenMaxHoldingTime) {
    return { valid: false, status: "MISSED_ENTRY", reason: "trade_spec_expired_before_entry" };
  }
  const rawExecution = applyEntryExecution({
    marketPrice: resolvedMarketPrice,
    side: tradeSpec.side,
    executionModel
  });
  const fillPrice = roundExecutionPrice({
    price: rawExecution.fillPrice,
    side: tradeSpec.side,
    role: "entry",
    exchangeFilters: normalizedFilters
  });
  const stopLoss = Number(tradeSpec.stopLoss);
  const takeProfit = Number(tradeSpec.takeProfit);
  const validGeometry = tradeSpec.side === "SHORT"
    ? takeProfit < fillPrice && fillPrice < stopLoss
    : stopLoss < fillPrice && fillPrice < takeProfit;
  if (!validGeometry) {
    return {
      valid: false,
      status: "NO_ENTRY",
      reason: "entry_fill_outside_trade_spec_geometry",
      entryTime: resolvedEntryTime,
      marketPrice: resolvedMarketPrice,
      entryMarketPrice: resolvedMarketPrice,
      entryFillPrice: fillPrice,
      fillPrice
    };
  }
  return {
    valid: true,
    status: "ENTRY",
    reason: null,
    entryTime: resolvedEntryTime,
    marketPrice: resolvedMarketPrice,
    entryMarketPrice: resolvedMarketPrice,
    entryFillPrice: fillPrice,
    execution: {
      ...rawExecution,
      rawFillPrice: rawExecution.fillPrice,
      fillPrice
    },
    filters: normalizedFilters
  };
}

export function validateFundingCoverageForTrade({ fundingCoverage, entryTime, exitTime } = {}) {
  const entry = toTimestamp(entryTime);
  const exit = toTimestamp(exitTime);
  if (!fundingCoverage || typeof fundingCoverage !== "object") {
    return { valid: false, status: INCOMPLETE_FUNDING, reason: "funding_coverage_missing" };
  }
  const requestedStart = toTimestamp(fundingCoverage.requestedStart);
  const requestedEnd = toTimestamp(fundingCoverage.requestedEnd);
  const coverageStart = toTimestamp(fundingCoverage.coverageStart);
  const coverageEnd = toTimestamp(fundingCoverage.coverageEnd);
  if (fundingCoverage.complete !== true
    || !Number.isFinite(entry)
    || !Number.isFinite(exit)
    || exit < entry
    || !Number.isFinite(requestedStart)
    || !Number.isFinite(requestedEnd)
    || requestedStart > entry
    || requestedEnd < exit
    || (Number.isFinite(coverageStart) && coverageStart > entry)
    || (Number.isFinite(coverageEnd) && coverageEnd < exit)
    || hasOverlappingFundingGap(fundingCoverage.gaps, entry, exit)) {
    return { valid: false, status: INCOMPLETE_FUNDING, reason: "funding_coverage_does_not_cover_trade" };
  }
  const eventCount = Number(fundingCoverage.eventCount);
  return {
    valid: true,
    status: eventCount === 0 ? NO_FUNDING_EVENTS_CONFIRMED : COMPLETE_DATA_QUALITY,
    reason: null
  };
}

export function applyEntryExecution({ marketPrice, side, executionModel }) {
  const spreadComponent = executionModel.spreadPct / 2;
  const adversePct = spreadComponent + executionModel.entrySlippagePct;
  const fillPrice = side === "SHORT"
    ? marketPrice * (1 - adversePct)
    : marketPrice * (1 + adversePct);
  return {
    marketPrice,
    fillPrice,
    spreadComponentPct: spreadComponent,
    slippageComponentPct: executionModel.entrySlippagePct
  };
}

export function applyExitExecution({ marketPrice, side, executionModel }) {
  const spreadComponent = executionModel.spreadPct / 2;
  const adversePct = spreadComponent + executionModel.exitSlippagePct;
  const fillPrice = side === "SHORT"
    ? marketPrice * (1 + adversePct)
    : marketPrice * (1 - adversePct);
  return {
    marketPrice,
    fillPrice,
    spreadComponentPct: spreadComponent,
    slippageComponentPct: executionModel.exitSlippagePct
  };
}

export function resolveExitExecution({
  decision,
  side,
  executionModel = createExecutionModel(),
  exchangeFilters = null
} = {}) {
  const rawMarketPrice = Number(decision?.exitMarketPrice ?? decision?.marketPrice);
  const role = exitExecutionRole(decision);
  const marketPrice = roundExecutionPrice({
    price: rawMarketPrice,
    side,
    role,
    exchangeFilters
  });
  const rawExecution = applyExitExecution({
    marketPrice,
    side,
    executionModel
  });
  const fillPrice = roundExecutionPrice({
    price: rawExecution.fillPrice,
    side,
    role,
    exchangeFilters
  });
  return {
    rawMarketPrice,
    marketPrice,
    rawFillPrice: rawExecution.fillPrice,
    fillPrice,
    spreadComponentPct: rawExecution.spreadComponentPct,
    slippageComponentPct: rawExecution.slippageComponentPct,
    execution: {
      ...rawExecution,
      rawMarketPrice,
      marketPrice,
      rawFillPrice: rawExecution.fillPrice,
      fillPrice
    }
  };
}

export function feePctForLeg(executionModel, leg) {
  return leg === "entry" ? executionModel.entryFeePct : executionModel.exitFeePct;
}

export function normalizeFundingEvents(events) {
  if (!Array.isArray(events)) return Object.freeze([]);
  const normalized = events
    .map((event) => ({
      time: toTimestamp(event?.time ?? event?.fundingTime),
      rate: Number(event?.rate ?? event?.fundingRate)
    }))
    .filter((event) => Number.isFinite(event.time) && Number.isFinite(event.rate))
    .sort((a, b) => a.time - b.time);
  return Object.freeze(normalized.map((event) => Object.freeze(event)));
}

function feeForMode(mode, makerFeePct, takerFeePct) {
  return mode === "maker" ? makerFeePct : takerFeePct;
}

function exitExecutionRole(decision = {}) {
  if (decision.exitReason === "take_profit") return "take_profit";
  if (decision.exitReason === "stop_loss") return "stop_loss";
  if (decision.exitResolution === "end_of_data") return "end_of_data";
  return "exit";
}

function normalizeFeeMode(value) {
  return String(value).toLowerCase() === "maker" ? "maker" : "taker";
}

function nonNegativeNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function normalizeFundingCoverage(value, fallbackEventCount = 0) {
  if (!value || typeof value !== "object") return null;
  const requestedStart = toTimestamp(value.requestedStart);
  const requestedEnd = toTimestamp(value.requestedEnd);
  const eventCount = Number(value.eventCount);
  const normalizedEventCount = Number.isFinite(eventCount) ? eventCount : fallbackEventCount;
  if (value.complete !== true || !Number.isFinite(requestedStart) || !Number.isFinite(requestedEnd) || requestedEnd < requestedStart) {
    return Object.freeze({
      ...value,
      requestedStart,
      requestedEnd,
      coverageStart: toTimestamp(value.coverageStart),
      coverageEnd: toTimestamp(value.coverageEnd),
      eventCount: normalizedEventCount,
      complete: false
    });
  }
  return Object.freeze({
    ...value,
    requestedStart,
    requestedEnd,
    coverageStart: toTimestamp(value.coverageStart),
    coverageEnd: toTimestamp(value.coverageEnd),
    eventCount: normalizedEventCount,
    complete: true
  });
}

function hasOverlappingFundingGap(gaps, entryTime, exitTime) {
  return (Array.isArray(gaps) ? gaps : []).some((gap) => {
    const start = toTimestamp(gap?.start ?? gap?.requestedStart);
    const end = toTimestamp(gap?.end ?? gap?.requestedEnd);
    return Number.isFinite(start) && Number.isFinite(end)
      && end > entryTime
      && start <= exitTime;
  });
}

function toTimestamp(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value instanceof Date) return value.getTime();
  if (value == null || value === "") return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}
