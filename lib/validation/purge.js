export const PURGED_BOUNDARY = "PURGED_BOUNDARY";
export const ELIGIBLE_OOS = "ELIGIBLE_OOS";
export const OUTSIDE_TEST_WINDOW = "OUTSIDE_TEST_WINDOW";

/**
 * Apply the frozen TradeSpec boundary rules for one formal OOS trade.
 *
 * The validator deliberately reads maxHoldingTime from the record/TradeSpec;
 * it never derives a new holding period from strategy settings.
 */
export function classifyOosBoundary(record, { testStart, testEnd } = {}) {
  const start = toTimestamp(testStart);
  const end = toTimestamp(testEnd);
  const source = record?.tradeSpec || record || {};
  const signalAvailableAt = toTimestamp(source.signalAvailableAt);
  const entryEligibleAt = toTimestamp(source.entryEligibleAt);
  const maxHoldingTime = toTimestamp(source.maxHoldingTime);
  const reasons = [];

  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    reasons.push("invalid_test_boundary");
  }
  if (!Number.isFinite(signalAvailableAt)) reasons.push("missing_signal_available_at");
  if (!Number.isFinite(entryEligibleAt)) reasons.push("missing_entry_eligible_at");
  if (!Number.isFinite(maxHoldingTime)) reasons.push("missing_max_holding_time");
  if (Number.isFinite(start) && Number.isFinite(signalAvailableAt) && signalAvailableAt < start) {
    reasons.push("signal_before_test_start");
  }
  if (Number.isFinite(start) && Number.isFinite(entryEligibleAt) && entryEligibleAt < start) {
    reasons.push("entry_before_test_start");
  }
  if (Number.isFinite(end) && Number.isFinite(maxHoldingTime) && maxHoldingTime > end) {
    reasons.push("holding_period_crosses_test_end");
  }
  if (Number.isFinite(end) && Number.isFinite(signalAvailableAt) && signalAvailableAt >= end) {
    reasons.push("signal_after_test_end");
  }

  const boundaryReasons = reasons.filter((reason) => reason !== "signal_after_test_end");
  if (boundaryReasons.length) {
    return {
      status: PURGED_BOUNDARY,
      eligible: false,
      reasons,
      signalAvailableAt,
      entryEligibleAt,
      maxHoldingTime
    };
  }
  if (reasons.length) {
    return {
      status: OUTSIDE_TEST_WINDOW,
      eligible: false,
      reasons,
      signalAvailableAt,
      entryEligibleAt,
      maxHoldingTime
    };
  }
  return {
    status: ELIGIBLE_OOS,
    eligible: true,
    reasons: [],
    signalAvailableAt,
    entryEligibleAt,
    maxHoldingTime
  };
}

export function partitionByOosBoundary(records = [], bounds = {}) {
  const eligible = [];
  const purged = [];
  const outsideWindow = [];
  for (const record of Array.isArray(records) ? records : []) {
    const classification = classifyOosBoundary(record, bounds);
    const classified = { record, ...classification };
    if (classification.status === ELIGIBLE_OOS) eligible.push(classified);
    else if (classification.status === PURGED_BOUNDARY) purged.push(classified);
    else outsideWindow.push(classified);
  }
  return { eligible, purged, outsideWindow };
}

export function boundaryRecordKey(record) {
  const source = record?.tradeSpec || record || {};
  return [
    source.strategyId ?? record?.strategyId ?? "",
    source.asset ?? record?.asset ?? "",
    source.signalCandleOpenTime ?? record?.signalCandleOpenTime ?? "",
    source.signalAvailableAt ?? record?.signalAvailableAt ?? ""
  ].join("|");
}

function toTimestamp(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value instanceof Date) return value.getTime();
  if (value == null || value === "") return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}
