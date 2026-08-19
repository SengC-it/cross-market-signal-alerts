const BINANCE_FUTURES_FUNDING_URL = "https://fapi.binance.com/fapi/v1/fundingRate";
const DEFAULT_PAGE_LIMIT = 1000;
const DEFAULT_MAX_PAGES = 1000;

export const FUNDING_DATA_MISSING = "FUNDING_DATA_MISSING";
export const NO_FUNDING_EVENTS_CONFIRMED = "NO_FUNDING_EVENTS_CONFIRMED";
export const FUNDING_DATA_COMPLETE = "COMPLETE";
export const INCOMPLETE_FUNDING = "INCOMPLETE_FUNDING";

/**
 * Fetches Binance USDT-M funding rows without manufacturing a schedule.
 * The provider returns coverage metadata instead of treating a successful
 * empty response as complete by accident.
 */
export async function fetchHistoricalFunding({
  asset,
  symbol = asset,
  startTime,
  endTime,
  fetchImpl = globalThis.fetch,
  baseUrl = BINANCE_FUTURES_FUNDING_URL,
  pageLimit = DEFAULT_PAGE_LIMIT,
  maxPages = DEFAULT_MAX_PAGES,
  source = "BINANCE_FAPI_FUNDING_RATE"
} = {}) {
  const requestedStart = toTimestamp(startTime);
  const requestedEnd = toTimestamp(endTime);
  const normalizedSymbol = String(symbol || "").trim();
  if (!normalizedSymbol || !Number.isFinite(requestedStart) || !Number.isFinite(requestedEnd) || requestedEnd < requestedStart) {
    return incompleteFundingResult({
      requestedStart,
      requestedEnd,
      source,
      reason: "INVALID_FUNDING_REQUEST"
    });
  }
  if (typeof fetchImpl !== "function") {
    return incompleteFundingResult({
      requestedStart,
      requestedEnd,
      source,
      reason: "FUNDING_FETCH_UNAVAILABLE"
    });
  }

  const events = [];
  let cursor = requestedStart;
  let complete = false;
  let pageCount = 0;
  let error = null;

  try {
    while (cursor <= requestedEnd && pageCount < Math.max(1, Number(maxPages) || DEFAULT_MAX_PAGES)) {
      const params = new URLSearchParams({
        symbol: normalizedSymbol,
        startTime: String(cursor),
        endTime: String(requestedEnd),
        limit: String(Math.max(1, Math.min(1000, Number(pageLimit) || DEFAULT_PAGE_LIMIT)))
      });
      const response = await fetchImpl(`${baseUrl}?${params.toString()}`);
      if (!response?.ok) {
        throw new Error(`Binance funding history failed: ${normalizedSymbol} ${response?.status ?? "NO_RESPONSE"}`);
      }
      const body = await response.json();
      if (!Array.isArray(body)) throw new Error("Binance funding history returned a non-array payload");
      const pageEvents = normalizeFundingEvents(body, normalizedSymbol);
      if (body.length > 0 && pageEvents.length === 0) {
        throw new Error("Binance funding history returned no valid timestamped funding rows");
      }
      events.push(...pageEvents.filter((event) => event.time >= requestedStart && event.time <= requestedEnd));
      pageCount++;

      const lastTime = pageEvents.at(-1)?.time;
      if (body.length < Math.max(1, Math.min(1000, Number(pageLimit) || DEFAULT_PAGE_LIMIT))
        || !Number.isFinite(lastTime)
        || lastTime >= requestedEnd) {
        complete = true;
        break;
      }
      const nextCursor = lastTime + 1;
      if (!Number.isFinite(nextCursor) || nextCursor <= cursor) {
        throw new Error("Funding pagination did not advance");
      }
      cursor = nextCursor;
    }
  } catch (fetchError) {
    error = fetchError instanceof Error ? fetchError.message : String(fetchError);
  }

  const dedupedEvents = normalizeFundingEvents(events, normalizedSymbol);
  if (!complete && !error && pageCount >= Math.max(1, Number(maxPages) || DEFAULT_MAX_PAGES)) {
    error = "Funding pagination reached maxPages before covering the requested range";
  }
  const status = error
    ? FUNDING_DATA_MISSING
    : complete && dedupedEvents.length === 0
      ? NO_FUNDING_EVENTS_CONFIRMED
      : complete
        ? FUNDING_DATA_COMPLETE
        : FUNDING_DATA_MISSING;
  const fundingCoverage = buildFundingCoverage({
    requestedStart,
    requestedEnd,
    events: dedupedEvents,
    complete: complete && !error,
    gaps: complete && !error
      ? []
      : [{
        start: Number.isFinite(cursor) ? cursor : requestedStart,
        end: requestedEnd,
        reason: error || "FUNDING_COVERAGE_INCOMPLETE"
      }],
    source,
    status
  });
  return {
    events: dedupedEvents,
    fundingEvents: dedupedEvents,
    fundingCoverage,
    fundingDataComplete: fundingCoverage.complete,
    dataQuality: fundingCoverage.complete ? FUNDING_DATA_COMPLETE : INCOMPLETE_FUNDING,
    status,
    error
  };
}

export function buildFundingCoverage({
  requestedStart,
  requestedEnd,
  events = [],
  complete = false,
  gaps = [],
  source = "injected",
  status = complete
    ? events.length ? FUNDING_DATA_COMPLETE : NO_FUNDING_EVENTS_CONFIRMED
    : FUNDING_DATA_MISSING
} = {}) {
  const normalizedEvents = normalizeFundingEvents(events);
  const start = toTimestamp(requestedStart);
  const end = toTimestamp(requestedEnd);
  const coverageComplete = Boolean(complete)
    && Number.isFinite(start)
    && Number.isFinite(end)
    && end >= start;
  return Object.freeze({
    requestedStart: start,
    requestedEnd: end,
    coverageStart: coverageComplete ? start : normalizedEvents[0]?.time ?? null,
    coverageEnd: coverageComplete ? end : normalizedEvents.at(-1)?.time ?? null,
    eventCount: normalizedEvents.length,
    complete: coverageComplete,
    gaps: Object.freeze((Array.isArray(gaps) ? gaps : []).map((gap) => Object.freeze({ ...gap }))),
    source,
    status: coverageComplete
      ? normalizedEvents.length ? FUNDING_DATA_COMPLETE : NO_FUNDING_EVENTS_CONFIRMED
      : status || FUNDING_DATA_MISSING
  });
}

export function normalizeFundingEvents(rows, symbol = null) {
  if (!Array.isArray(rows)) return [];
  const byTime = new Map();
  for (const row of rows) {
    const time = toTimestamp(row?.time ?? row?.fundingTime ?? row?.fundingTimeMs);
    const rate = Number(row?.rate ?? row?.fundingRate);
    if (!Number.isFinite(time) || !Number.isFinite(rate)) continue;
    byTime.set(time, {
      time,
      rate,
      ...(symbol ? { symbol } : {})
    });
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

function incompleteFundingResult({ requestedStart, requestedEnd, source, reason }) {
  const fundingCoverage = buildFundingCoverage({
    requestedStart,
    requestedEnd,
    complete: false,
    gaps: [{
      start: requestedStart,
      end: requestedEnd,
      reason
    }],
    source,
    status: FUNDING_DATA_MISSING
  });
  return {
    events: [],
    fundingEvents: [],
    fundingCoverage,
    fundingDataComplete: false,
    dataQuality: INCOMPLETE_FUNDING,
    status: FUNDING_DATA_MISSING,
    error: reason
  };
}

function toTimestamp(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value instanceof Date) return value.getTime();
  if (value == null || value === "") return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}
