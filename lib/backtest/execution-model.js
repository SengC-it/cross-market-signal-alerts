export const COMPLETE_DATA_QUALITY = "COMPLETE";
export const INCOMPLETE_FUNDING = "INCOMPLETE_FUNDING";
export const NO_FUNDING_EVENTS_CONFIRMED = "NO_FUNDING_EVENTS_CONFIRMED";
export const FUNDING_DATA_MISSING = "FUNDING_DATA_MISSING";

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
  const fundingDataComplete = marketType !== "futures"
    ? true
    : options.fundingDataComplete === true || fundingCoverage?.complete === true;
  const fundingStatus = marketType !== "futures"
    ? "NOT_APPLICABLE"
    : fundingDataComplete
      ? fundingCoverage?.eventCount === 0
        ? NO_FUNDING_EVENTS_CONFIRMED
        : COMPLETE_DATA_QUALITY
      : FUNDING_DATA_MISSING;

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
    fundingDataComplete: marketType !== "futures"
  });
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
      eventCount: normalizedEventCount,
      complete: false
    });
  }
  return Object.freeze({
    ...value,
    requestedStart,
    requestedEnd,
    eventCount: normalizedEventCount,
    complete: true
  });
}

function toTimestamp(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value instanceof Date) return value.getTime();
  if (value == null || value === "") return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}
