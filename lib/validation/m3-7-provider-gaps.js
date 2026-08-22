export const PROVIDER_DATA_MISSING = "PROVIDER_DATA_MISSING";
export const PURGED_PROVIDER_DATA_GAP = "PURGED_PROVIDER_DATA_GAP";
export const M37_PROVIDER_GAP_POLICY_VERSION = "M3_7_PROVIDER_GAP_POLICY_V1";

// This registry records provider-confirmed gaps. The matching and dependency
// logic below is generic so future confirmed gaps do not require asset-specific
// branches in the strategy families.
export const M37_PROVIDER_GAP_REGISTRY = Object.freeze([
  Object.freeze({
    asset: "LITUSDT",
    start: "2025-12-23T00:00:00.000Z",
    endExclusive: "2025-12-23T17:00:00.000Z",
    missingBars: 17,
    primarySource: "BINANCE_VISION_MONTHLY_1H",
    fallbackSource: "BINANCE_FUTURES_REST_1H",
    status: PROVIDER_DATA_MISSING
  }),
  Object.freeze({
    asset: "AIAUSDT",
    start: "2026-01-20T00:00:00.000Z",
    endExclusive: "2026-01-20T11:00:00.000Z",
    missingBars: 11,
    primarySource: "BINANCE_VISION_MONTHLY_1H",
    fallbackSource: "BINANCE_FUTURES_REST_1H",
    status: PROVIDER_DATA_MISSING
  })
]);

export function normalizeProviderGapRegistry(registry = M37_PROVIDER_GAP_REGISTRY) {
  return (Array.isArray(registry) ? registry : [])
    .map((gap) => {
      const asset = String(gap?.asset || "").trim().toUpperCase();
      const start = toTimestamp(gap?.start ?? gap?.gapStart);
      const endExclusive = toTimestamp(gap?.endExclusive ?? gap?.gapEndExclusive);
      const missingBars = Number(gap?.missingBars);
      return {
        asset,
        start: Number.isFinite(start) ? new Date(start).toISOString() : null,
        endExclusive: Number.isFinite(endExclusive) ? new Date(endExclusive).toISOString() : null,
        startTime: start,
        endTime: endExclusive,
        missingBars: Number.isFinite(missingBars) ? missingBars : null,
        primarySource: String(gap?.primarySource || "UNKNOWN").trim(),
        fallbackSource: String(gap?.fallbackSource || "UNKNOWN").trim(),
        status: String(gap?.status || PROVIDER_DATA_MISSING).trim()
      };
    })
    .filter((gap) => gap.asset
      && Number.isFinite(gap.startTime)
      && Number.isFinite(gap.endTime)
      && gap.startTime < gap.endTime
      && gap.status === PROVIDER_DATA_MISSING)
    .sort((left, right) => left.startTime - right.startTime || left.asset.localeCompare(right.asset));
}

export function providerGapIntersects(registry, {
  asset,
  start,
  endExclusive
} = {}) {
  const normalizedAsset = String(asset || "").trim().toUpperCase();
  const startTime = toTimestamp(start);
  const endTime = toTimestamp(endExclusive);
  if (!normalizedAsset || !Number.isFinite(startTime) || !Number.isFinite(endTime) || startTime >= endTime) {
    return [];
  }
  return normalizeProviderGapRegistry(registry)
    .filter((gap) => gap.asset === normalizedAsset
      && gap.startTime < endTime
      && gap.endTime > startTime);
}

export function providerGapDependency(registry, {
  asset,
  requiredTimes = [],
  start,
  endExclusive,
  reason = "provider_gap_dependency"
} = {}) {
  const finiteTimes = (Array.isArray(requiredTimes) ? requiredTimes : [])
    .map(toTimestamp)
    .filter(Number.isFinite);
  const startTime = Number.isFinite(toTimestamp(start))
    ? toTimestamp(start)
    : finiteTimes.length ? Math.min(...finiteTimes) : null;
  const endTime = Number.isFinite(toTimestamp(endExclusive))
    ? toTimestamp(endExclusive)
    : finiteTimes.length ? Math.max(...finiteTimes) + 1 : null;
  const gaps = providerGapIntersects(registry, {
    asset,
    start: startTime,
    endExclusive: endTime
  });
  return {
    affected: gaps.length > 0,
    gaps,
    reason: gaps.length > 0 ? reason : null,
    requiredStart: startTime,
    requiredEndExclusive: endTime
  };
}

export function providerGapRegistryMissingBars(registry = M37_PROVIDER_GAP_REGISTRY) {
  return normalizeProviderGapRegistry(registry)
    .reduce((sum, gap) => sum + (Number(gap.missingBars) || 0), 0);
}

export function providerGapKey(gap) {
  return `${gap?.asset || ""}:${gap?.startTime || gap?.start || ""}:${gap?.endTime || gap?.endExclusive || ""}`;
}

function toTimestamp(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : Number(value);
  }
  return Number(value);
}
