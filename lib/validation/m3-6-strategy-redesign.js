import { DYNAMIC_PRODUCTION_HOLD_HOURS } from "../strategies/dynamic-production.js";

export const M36_OLD_WINDOW_ROLE = "RESEARCH_AFTER_FAILURE_ANALYSIS";
export const M36_RESEARCH_STATUS = "RESEARCH_ONLY_NOT_UNTOUCHED_OOS";
export const M36_MAX_CANDIDATES = 3;

export const M36_CANDIDATE_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: "weak_breakdown_confirmed_continuation_v1",
    label: "Continuation confirmation",
    hypothesis: "H1",
    side: "SHORT",
    coreEdge: ["price_action", "relative_move", "volume_structure"],
    formula: [
      "return1 <= -0.5%",
      "return3 <= -1.5%",
      "close < previousLow",
      "closeLocationValue <= -0.25",
      "volumeAcceleration >= 1",
      "volumeClimax < 2.5"
    ],
    causalTiming: "All features use the closed signal candle and candles with openTime <= signalCandleOpenTime; entry is the next eligible candle open."
  }),
  Object.freeze({
    id: "weak_breakdown_exhaustion_filtered_v1",
    label: "Exhaustion rejection filter",
    hypothesis: "H2",
    side: "SHORT",
    coreEdge: ["price_action", "relative_move", "volume_structure"],
    formula: [
      "return1 <= -0.5%",
      "close < previousLow",
      "NOT(volumeClimax >= 2.5 AND lowerWickRatio >= 0.35 AND reboundFromLow >= 0.3%)"
    ],
    causalTiming: "The exhaustion pattern is evaluated at signal candle close; no post-entry candle is read."
  }),
  Object.freeze({
    id: "weak_breakdown_confirmed_market_v1",
    label: "Continuation plus market confirmation",
    hypothesis: "H1/H3",
    side: "SHORT",
    coreEdge: ["price_action", "relative_move", "volume_structure", "market_context"],
    formula: [
      "all weak_breakdown_confirmed_continuation_v1 rules",
      "BTC 24h momentum <= 0"
    ],
    causalTiming: "BTC context is the latest completed benchmark value available at signalAvailableAt; entry remains next-bar eligible."
  })
]);

export function candidateDefinitions() {
  return M36_CANDIDATE_DEFINITIONS.map((definition) => ({
    ...definition,
    formula: [...definition.formula],
    coreEdge: [...definition.coreEdge]
  }));
}

export function computeM36Features({ candles = [], signalIndex, benchmarkMomentum24h = null } = {}) {
  const index = Number(signalIndex);
  const current = candles[index];
  const previous = candles[index - 1];
  const previous2 = candles[index - 2];
  const previous3 = candles[index - 3];
  const previous24 = candles[index - 24];
  if (!current || !previous || !previous2 || !previous3 || !previous24) {
    return { complete: false, causalInputMaxOpenTime: null };
  }

  const close = number(current.close);
  const open = number(current.open);
  const high = number(current.high);
  const low = number(current.low);
  const previousClose = number(previous.close);
  const previous3Close = number(previous3.close);
  const previous24Close = number(previous24.close);
  const range = high - low;
  const volume = number(current.volume);
  const prior3Volumes = candles.slice(index - 3, index).map((row) => number(row?.volume));
  const prior20Volumes = candles.slice(index - 20, index).map((row) => number(row?.volume));
  const volumeAcceleration = ratio(volume, average(prior3Volumes));
  const volumeClimax = ratio(volume, average(prior20Volumes));
  const closeLocationValue = range > 0
    ? ((close - low) - (high - close)) / range
    : 0;
  const lowerWick = Math.max(0, Math.min(open, close) - low);
  const lowerWickRatio = range > 0 ? lowerWick / range : 0;
  const reboundFromLow = ratio(close - low, low);
  const momentumRatio = ratio(close, previous24Close);
  const momentum24h = Number.isFinite(momentumRatio) ? momentumRatio - 1 : null;
  const relativeWeakness = Number.isFinite(Number(benchmarkMomentum24h))
    ? momentum24h - Number(benchmarkMomentum24h)
    : null;
  const features = {
    complete: [close, open, high, low, previousClose, previous3Close, previous24Close, volume,
      volumeAcceleration, volumeClimax, momentum24h].every(Number.isFinite),
    signalCandleOpenTime: number(current.openTime),
    causalInputMaxOpenTime: number(current.openTime),
    causalInputMinOpenTime: number(previous24.openTime),
    return1: ratio(close, previousClose) - 1,
    return3: ratio(close, previous3Close) - 1,
    momentum24h,
    benchmarkMomentum24h: Number.isFinite(Number(benchmarkMomentum24h))
      ? Number(benchmarkMomentum24h)
      : null,
    relativeWeakness,
    previousLow: number(previous.low),
    previousHigh: number(previous.high),
    lowerLow: low < number(previous.low),
    lowerHigh: high < number(previous.high) && number(previous.high) <= number(previous2.high),
    breakPreviousLow: close < number(previous.low),
    bearishBody: close < open,
    range,
    closeLocationValue,
    volumeAcceleration,
    volumeClimax,
    lowerWickRatio,
    reboundFromLow,
    exhaustionPattern: volumeClimax >= 2.5
      && lowerWickRatio >= 0.35
      && reboundFromLow >= 0.003
  };
  return features;
}

export function passesM36Candidate(candidateId, features = {}) {
  if (!features.complete) return false;
  const continuation = features.return1 <= -0.005
    && features.return3 <= -0.015
    && features.breakPreviousLow
    && features.closeLocationValue <= -0.25
    && features.volumeAcceleration >= 1
    && features.volumeClimax < 2.5;
  if (candidateId === "weak_breakdown_confirmed_continuation_v1") return continuation;
  if (candidateId === "weak_breakdown_exhaustion_filtered_v1") {
    return features.return1 <= -0.005
      && features.breakPreviousLow
      && !features.exhaustionPattern;
  }
  if (candidateId === "weak_breakdown_confirmed_market_v1") {
    return continuation
      && Number.isFinite(Number(features.benchmarkMomentum24h))
      && Number(features.benchmarkMomentum24h) <= 0;
  }
  return false;
}

export function buildM36CandidateSignals({
  baseSignals = [],
  datasets = [],
  candidateId
} = {}) {
  const datasetsByAsset = new Map((Array.isArray(datasets) ? datasets : [])
    .map((dataset) => [String(dataset?.asset), {
      dataset,
      indexByOpenTime: new Map((Array.isArray(dataset?.candles) ? dataset.candles : [])
        .map((candle, index) => [Number(candle?.openTime), index]))
    }]));
  return (Array.isArray(baseSignals) ? baseSignals : [])
    .filter((signal) => signal?.primaryEligible === true && signal?.opportunityPassed === true)
    .map((signal) => {
      const datasetEntry = datasetsByAsset.get(String(signal.asset));
      const dataset = datasetEntry?.dataset;
      const signalIndex = datasetEntry?.indexByOpenTime.get(Number(signal.signalCandleOpenTime)) ?? -1;
      const features = computeM36Features({
        candles: dataset?.candles,
        signalIndex,
        benchmarkMomentum24h: signal.details?.benchmarkMomentum24h
      });
      return { signal, features };
    })
    .filter(({ features }) => passesM36Candidate(candidateId, features))
    .map(({ signal, features }) => ({
      ...signal,
      strategyId: candidateId,
      signalSelectionMode: "M3_6_CANDIDATE_RULES",
      details: {
        ...signal.details,
        m36: features
      },
      m36: {
        candidateId,
        causalInputMinOpenTime: features.causalInputMinOpenTime,
        causalInputMaxOpenTime: features.causalInputMaxOpenTime,
        features
      }
    }));
}

export function buildM36SignalStrategy({ strategyId, signalTimeline = [] } = {}) {
  const eventsByOpenTime = new Map((Array.isArray(signalTimeline) ? signalTimeline : [])
    .filter((signal) => Number.isFinite(Number(signal?.signalCandleOpenTime)))
    .map((signal) => [Number(signal.signalCandleOpenTime), signal]));
  return {
    id: strategyId,
    direction: "SHORT",
    holdHours: DYNAMIC_PRODUCTION_HOLD_HOURS,
    evaluate(candles, index) {
      const signal = eventsByOpenTime.get(Number(candles?.[index]?.openTime));
      return signal
        ? { passed: true, details: signal.details, m36Signal: signal }
        : { passed: false, details: {} };
    }
  };
}

export function causalTimingForCandidate(candidateId) {
  return M36_CANDIDATE_DEFINITIONS.find((definition) => definition.id === candidateId)?.causalTiming || null;
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function ratio(numerator, denominator) {
  const left = Number(numerator);
  const right = Number(denominator);
  return Number.isFinite(left) && Number.isFinite(right) && right !== 0 ? left / right : null;
}

function average(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : null;
}
