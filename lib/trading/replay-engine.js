export const INCOMPLETE_INTRABAR_DATA = "INCOMPLETE_INTRABAR_DATA";
export const BASE_BAR_REPLAY = "BASE_BAR_REPLAY";
export const PESSIMISTIC_STOP_FIRST = "PESSIMISTIC_STOP_FIRST";

export function resolveIntrabarExit({
  tradeSpec,
  baseCandle,
  lowerTimeframeCandles,
  side = tradeSpec?.side,
  replayStart = null,
  lowerTimeframe = null
} = {}) {
  const baseOpenTime = Number(baseCandle?.openTime);
  const baseCloseTime = baseOpenTime + intervalMilliseconds(tradeSpec?.interval);
  if (!Number.isFinite(baseOpenTime) || !Number.isFinite(baseCloseTime)) {
    return unresolvedResult({ reason: "INVALID_BASE_CANDLE" });
  }
  const startTime = Math.max(
    baseOpenTime,
    Number.isFinite(Number(replayStart)) ? Number(replayStart) : baseOpenTime
  );
  const frozenMaxHoldingTime = tradeSpec?.maxHoldingTime == null
    ? null
    : Number(tradeSpec.maxHoldingTime);
  const timeStopInsideBaseCandle = Number.isFinite(frozenMaxHoldingTime)
    && frozenMaxHoldingTime > baseOpenTime
    && frozenMaxHoldingTime < baseCloseTime;
  const replayEndTime = Number.isFinite(frozenMaxHoldingTime)
    && frozenMaxHoldingTime > startTime
    && frozenMaxHoldingTime < baseCloseTime
    ? frozenMaxHoldingTime
    : baseCloseTime;
  const timeStopAtOrBeforeBaseOpen = Number.isFinite(frozenMaxHoldingTime)
    && frozenMaxHoldingTime <= baseOpenTime;
  const baseState = detectCandleExit({ tradeSpec, candle: baseCandle, side });
  const hasLowerInput = Array.isArray(lowerTimeframeCandles);
  const lower = hasLowerInput
    ? inspectLowerTimeframe({
      candles: lowerTimeframeCandles,
      startTime,
      endTime: replayEndTime,
      lowerTimeframe
    })
    : null;
  if (timeStopAtOrBeforeBaseOpen) {
    return {
      ...unresolvedResult({ reason: "TIME_STOP_REACHED_BEFORE_BASE_CANDLE" }),
      dataQuality: INCOMPLETE_INTRABAR_DATA,
      coverage: lower?.coverage || null
    };
  }
  if (lower?.complete) {
    for (let index = 0; index < lower.safeCandles.length; index++) {
      const candle = lower.safeCandles[index];
      const state = detectCandleExit({ tradeSpec, candle, side });
      if (state.hitStop || state.hitTarget) {
        return buildExitResult({
          tradeSpec,
          candle,
          state,
          side,
          replayCandles: lower.safeCandles,
          replayCandleIndex: index,
          resolution: state.hitStop && state.hitTarget
            ? PESSIMISTIC_STOP_FIRST
            : state.hitStop
              ? isGapThroughStop(candle, side, Number(tradeSpec.stopLoss))
                ? "gap_stop_worse_fill"
                : lower.resolution
              : isGapThroughTarget(candle, side, Number(tradeSpec.takeProfit))
                ? "take_profit_conservative"
                : lower.resolution,
          dataQuality: lower.resolution,
          lowerTimeframeReplayed: true,
          coverage: lower.coverage
        });
      }
    }
    if (baseState.hitStop || baseState.hitTarget || startTime > baseOpenTime) {
      return {
        ...unresolvedResult({
          reason: baseState.hitStop || baseState.hitTarget
            ? "BASE_EXIT_NOT_CONFIRMED_BY_LOWER_TF"
            : "NO_LOWER_TF_EXIT"
        }),
        replayCandles: lower.safeCandles,
        lowerTimeframeReplayed: true,
        dataQuality: lower.resolution,
        coverage: lower.coverage
      };
    }
    return {
      ...unresolvedResult({ reason: "NO_EXIT" }),
      replayCandles: lower.safeCandles,
      lowerTimeframeReplayed: true,
      dataQuality: lower.resolution,
      coverage: lower.coverage
    };
  }

  const partialReplay = startTime > baseOpenTime && startTime < baseCloseTime;
  if (partialReplay) {
    return {
      ...unresolvedResult({ reason: "INCOMPLETE_PARTIAL_CANDLE" }),
      requiresLowerTimeframe: true,
      dataQuality: INCOMPLETE_INTRABAR_DATA,
      coverage: lower?.coverage || null
    };
  }
  if (hasLowerInput && lower && !lower.complete) {
    for (let index = 0; index < lower.safeCandles.length; index++) {
      const candle = lower.safeCandles[index];
      const state = detectCandleExit({ tradeSpec, candle, side });
      if (state.hitStop || state.hitTarget) {
        return buildExitResult({
          tradeSpec,
          candle,
          state,
          side,
          replayCandles: lower.safeCandles,
          replayCandleIndex: index,
          resolution: state.hitStop && state.hitTarget
            ? PESSIMISTIC_STOP_FIRST
            : state.hitStop
              ? isGapThroughStop(candle, side, Number(tradeSpec.stopLoss))
                ? "gap_stop_worse_fill"
                : lower.resolution
              : isGapThroughTarget(candle, side, Number(tradeSpec.takeProfit))
                ? "take_profit_conservative"
                : lower.resolution,
          dataQuality: INCOMPLETE_INTRABAR_DATA,
          lowerTimeframeReplayed: true,
          coverage: lower.coverage
        });
      }
    }
    return {
      ...unresolvedResult({ reason: "INCOMPLETE_LOWER_TF_COVERAGE" }),
      replayCandles: lower.safeCandles,
      lowerTimeframeReplayed: lower.safeCandles.length > 0,
      requiresLowerTimeframe: true,
      dataQuality: INCOMPLETE_INTRABAR_DATA,
      coverage: lower.coverage
    };
  }
  if (timeStopInsideBaseCandle) {
    return {
      ...unresolvedResult({ reason: "TIME_STOP_INSIDE_BASE_CANDLE" }),
      requiresLowerTimeframe: true,
      dataQuality: INCOMPLETE_INTRABAR_DATA,
      coverage: lower?.coverage || null
    };
  }
  if (baseState.hitStop || baseState.hitTarget) {
    return buildExitResult({
      tradeSpec,
      candle: baseCandle,
      state: baseState,
      side,
      replayCandles: [],
      replayCandleIndex: 0,
      resolution: baseState.hitStop && baseState.hitTarget
        ? PESSIMISTIC_STOP_FIRST
        : baseState.hitStop
          ? isGapThroughStop(baseCandle, side, Number(tradeSpec.stopLoss))
            ? "gap_stop_worse_fill"
            : "stop_loss"
          : isGapThroughTarget(baseCandle, side, Number(tradeSpec.takeProfit))
            ? "take_profit_conservative"
            : "take_profit",
      dataQuality: baseState.hitStop && baseState.hitTarget
        ? INCOMPLETE_INTRABAR_DATA
        : BASE_BAR_REPLAY,
      lowerTimeframeReplayed: false,
      requiresLowerTimeframe: baseState.hitStop && baseState.hitTarget,
      coverage: lower?.coverage || null
    });
  }
  return {
    ...unresolvedResult({ reason: "NO_EXIT" }),
    replayCandles: [],
    lowerTimeframeReplayed: false,
    dataQuality: hasLowerInput ? INCOMPLETE_INTRABAR_DATA : BASE_BAR_REPLAY,
    coverage: lower?.coverage || null
  };
}

export function resolveTimeStop({
  tradeSpec,
  baseCandle,
  lowerTimeframeCandles,
  replayStart = null,
  lowerTimeframe = null
} = {}) {
  const maxHoldingTime = tradeSpec?.maxHoldingTime == null
    ? null
    : Number(tradeSpec.maxHoldingTime);
  const baseOpenTime = Number(baseCandle?.openTime);
  const baseCloseTime = baseOpenTime + intervalMilliseconds(tradeSpec?.interval);
  if (!Number.isFinite(maxHoldingTime) || !Number.isFinite(baseOpenTime) || maxHoldingTime > baseCloseTime) {
    return { resolved: false, reason: "TIME_STOP_NOT_REACHED" };
  }
  if (maxHoldingTime <= baseOpenTime) {
    const exactOpen = maxHoldingTime === baseOpenTime;
    return {
      resolved: true,
      exitReason: "time_stop",
      exitTime: baseOpenTime,
      exitMarketPrice: Number(baseCandle.open),
      resolution: "time_stop",
      dataQuality: exactOpen ? BASE_BAR_REPLAY : INCOMPLETE_INTRABAR_DATA,
      replayCandles: [],
      replayCandleIndex: 0,
      lowerTimeframeReplayed: false,
      approximate: !exactOpen,
      coverage: null
    };
  }
  const startTime = Math.max(
    baseOpenTime,
    Number.isFinite(Number(replayStart)) ? Number(replayStart) : baseOpenTime
  );
  const insideBaseCandle = maxHoldingTime > baseOpenTime && maxHoldingTime < baseCloseTime;
  const hasLowerInput = Array.isArray(lowerTimeframeCandles);
  const lower = hasLowerInput
    ? inspectLowerTimeframe({
      candles: lowerTimeframeCandles,
      startTime,
      endTime: insideBaseCandle ? maxHoldingTime : baseCloseTime,
      lowerTimeframe
    })
    : null;
  if (insideBaseCandle && lower?.coverageToBoundary && lower.boundaryCandle) {
    const stopOpen = Number(lower.boundaryCandle.openTime);
    const exactOpen = stopOpen === maxHoldingTime;
    return {
      resolved: true,
      exitReason: "time_stop",
      exitTime: stopOpen,
      exitMarketPrice: Number(lower.boundaryCandle.open),
      resolution: "time_stop",
      dataQuality: exactOpen ? lower.resolution : INCOMPLETE_INTRABAR_DATA,
      replayCandles: lower.safeCandles,
      replayCandleIndex: lower.safeCandles.length,
      lowerTimeframeReplayed: true,
      approximate: !exactOpen,
      coverage: lower.coverage
    };
  }
  if (insideBaseCandle && (!lower || !lower.complete)) {
    const knownCandles = lower?.safeCandles || [];
    return {
      resolved: true,
      exitReason: "time_stop",
      exitTime: maxHoldingTime,
      exitMarketPrice: Number(baseCandle.open),
      resolution: "time_stop",
      dataQuality: INCOMPLETE_INTRABAR_DATA,
      replayCandles: knownCandles,
      replayCandleIndex: knownCandles.length,
      lowerTimeframeReplayed: knownCandles.length > 0,
      requiresLowerTimeframe: true,
      approximate: true,
      coverage: lower?.coverage || null
    };
  }
  return {
    resolved: true,
    exitReason: "time_stop",
    exitTime: Math.min(maxHoldingTime, baseCloseTime),
    exitMarketPrice: Number(baseCandle.close),
    resolution: "time_stop",
    dataQuality: BASE_BAR_REPLAY,
    replayCandles: [],
    replayCandleIndex: 0,
    lowerTimeframeReplayed: false,
    approximate: false,
    coverage: lower?.coverage || null
  };
}

export function detectCandleExit({ tradeSpec, candle, side = tradeSpec?.side } = {}) {
  const high = Number(candle?.high);
  const low = Number(candle?.low);
  const stopLoss = Number(tradeSpec?.stopLoss);
  const takeProfit = Number(tradeSpec?.takeProfit);
  const hitStop = side === "SHORT" ? high >= stopLoss : low <= stopLoss;
  const hitTarget = side === "SHORT" ? low <= takeProfit : high >= takeProfit;
  return {
    hitStop: Boolean(hitStop),
    hitTarget: Boolean(hitTarget),
    ambiguousIntrabar: Boolean(hitStop && hitTarget)
  };
}

export function buildExitResult({
  tradeSpec,
  candle,
  state,
  side = tradeSpec?.side,
  replayCandles = [],
  replayCandleIndex = 0,
  resolution,
  dataQuality,
  lowerTimeframeReplayed = false,
  requiresLowerTimeframe = false,
  coverage = null
} = {}) {
  const exitReason = state.hitStop ? "stop_loss" : "take_profit";
  const exitMarketPrice = state.hitStop
    ? gapAdjustedStopPrice(candle, side, Number(tradeSpec.stopLoss))
    : Number(tradeSpec.takeProfit);
  return {
    resolved: true,
    exitReason,
    exitTime: Number(candle.openTime),
    exitMarketPrice,
    resolution,
    dataQuality,
    replayCandles,
    replayCandleIndex,
    exitCandle: candle,
    ambiguousIntrabar: Boolean(state.ambiguousIntrabar),
    lowerTimeframeReplayed,
    requiresLowerTimeframe,
    gapThroughStop: Boolean(state.hitStop && isGapThroughStop(candle, side, Number(tradeSpec.stopLoss))),
    gapThroughTarget: Boolean(state.hitTarget && isGapThroughTarget(candle, side, Number(tradeSpec.takeProfit))),
    coverage
  };
}

export function gapAdjustedStopPrice(candle, side, stopLoss) {
  const open = Number(candle?.open);
  if (!Number.isFinite(open)) return stopLoss;
  if (side === "SHORT") return open >= stopLoss ? open : stopLoss;
  return open <= stopLoss ? open : stopLoss;
}

export function isGapThroughStop(candle, side, stopLoss) {
  const open = Number(candle?.open);
  if (!Number.isFinite(open)) return false;
  return side === "SHORT" ? open >= stopLoss : open <= stopLoss;
}

export function isGapThroughTarget(candle, side, takeProfit) {
  const open = Number(candle?.open);
  if (!Number.isFinite(open)) return false;
  return side === "SHORT" ? open <= takeProfit : open >= takeProfit;
}

export function candleExcursion(candle, entryPrice, side) {
  const high = Number(candle?.high);
  const low = Number(candle?.low);
  if (!Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(entryPrice) || entryPrice === 0) {
    return { mfePct: 0, maePct: 0 };
  }
  if (side === "SHORT") {
    return {
      mfePct: 1 - low / entryPrice,
      maePct: 1 - high / entryPrice
    };
  }
  return {
    mfePct: high / entryPrice - 1,
    maePct: low / entryPrice - 1
  };
}

export function boundedExitExcursion(candle, entryPrice, side, exitPrice, exitReason, ambiguousIntrabar = false) {
  const open = Number(candle?.open);
  if (!Number.isFinite(open) || !Number.isFinite(exitPrice) || !Number.isFinite(entryPrice) || entryPrice === 0) {
    return { mfePct: 0, maePct: 0 };
  }
  if (ambiguousIntrabar) {
    return side === "SHORT"
      ? { mfePct: 0, maePct: Math.min(0, 1 - exitPrice / entryPrice) }
      : { mfePct: 0, maePct: Math.min(0, exitPrice / entryPrice - 1) };
  }
  const isTakeProfit = String(exitReason || "").startsWith("take_profit");
  if (side === "SHORT") {
    const favorableBoundary = isTakeProfit ? exitPrice : Math.min(open, exitPrice);
    const adverseBoundary = isTakeProfit ? Math.max(open, exitPrice) : exitPrice;
    return {
      mfePct: Math.max(0, 1 - favorableBoundary / entryPrice),
      maePct: Math.min(0, 1 - adverseBoundary / entryPrice)
    };
  }
  const favorableBoundary = isTakeProfit ? exitPrice : Math.max(open, exitPrice);
  const adverseBoundary = isTakeProfit ? Math.min(open, exitPrice) : exitPrice;
  return {
    mfePct: Math.max(0, favorableBoundary / entryPrice - 1),
    maePct: Math.min(0, adverseBoundary / entryPrice - 1)
  };
}

function inspectLowerTimeframe({ candles, startTime, endTime, lowerTimeframe }) {
  const intervalMs = inferIntervalMilliseconds(lowerTimeframe, candles);
  const validInterval = Number.isFinite(intervalMs) && intervalMs > 0;
  const sorted = (Array.isArray(candles) ? candles : [])
    .filter((candle) => Number.isFinite(Number(candle?.openTime)))
    .sort((a, b) => Number(a.openTime) - Number(b.openTime));
  const selected = sorted.filter((candle) => Number(candle.openTime) >= startTime && Number(candle.openTime) < endTime);
  const allSafeCandles = validInterval
    ? selected.filter((candle) => Number(candle.openTime) + intervalMs <= endTime)
    : [];
  const { contiguousCandles, firstGap } = findContiguousLowerPrefix({
    candles: allSafeCandles,
    availableCandles: selected,
    startTime,
    intervalMs,
    endTime
  });
  const safeCandles = contiguousCandles;
  const firstOpen = Number(safeCandles[0]?.openTime);
  const lastOpen = Number(safeCandles.at(-1)?.openTime);
  const boundaryCandle = sorted.find((candle) => Number(candle.openTime) >= endTime) || null;
  const crossingCandle = selected.find((candle) => Number(candle.openTime) + intervalMs > endTime) || null;
  const hasRows = safeCandles.length > 0;
  const safeCoverageEnd = hasRows ? lastOpen + intervalMs : null;
  const contiguous = validInterval && hasRows && firstOpen === startTime && firstGap == null;
  const complete = contiguous && safeCoverageEnd === endTime;
  const boundaryOpen = Number(boundaryCandle?.openTime);
  const coverageToBoundary = contiguous
    && Boolean(boundaryCandle)
    && (hasRows
      ? boundaryOpen - lastOpen === intervalMs
        || (crossingCandle
          && boundaryOpen - Number(crossingCandle.openTime) === intervalMs
          && Number(crossingCandle.openTime) - lastOpen === intervalMs)
      : boundaryOpen === startTime);
  const resolution = validInterval
    ? `LOWER_TF_REPLAY_${formatLowerTimeframe(lowerTimeframe, intervalMs)}`
    : INCOMPLETE_INTRABAR_DATA;
  return {
    complete,
    candles: safeCandles,
    safeCandles,
    boundaryCandle,
    crossingCandle,
    intervalMs,
    coverageToBoundary,
    resolution,
    coverage: {
      requestedStart: startTime,
      requestedEnd: endTime,
      coverageStart: hasRows ? firstOpen : null,
      coverageEnd: safeCoverageEnd,
      eventCount: safeCandles.length,
      complete,
      firstGap,
      contiguousCoverageEnd: safeCoverageEnd,
      gaps: complete || coverageToBoundary
        ? []
        : [{ start: firstGap ?? firstOpen ?? startTime, end: endTime, reason: "LOWER_TF_COVERAGE_INCOMPLETE" }],
      source: "injected_lower_timeframe"
    },
    firstGap,
    contiguousCoverageEnd: safeCoverageEnd
  };
}

function findContiguousLowerPrefix({ candles, availableCandles, startTime, intervalMs, endTime }) {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    return { contiguousCandles: [], firstGap: startTime };
  }
  const contiguousCandles = [];
  let expectedOpen = startTime;
  let firstGap = null;
  for (const candle of candles) {
    const openTime = Number(candle.openTime);
    if (openTime !== expectedOpen) {
      firstGap = expectedOpen;
      break;
    }
    contiguousCandles.push(candle);
    expectedOpen = openTime + intervalMs;
  }
  if (!firstGap && contiguousCandles.length === 0 && startTime < endTime) {
    firstGap = startTime;
  }
  if (!firstGap && contiguousCandles.length > 0 && expectedOpen < endTime) {
    const nextCandle = availableCandles.find((candle) => Number(candle.openTime) >= expectedOpen);
    const nextOpen = Number(nextCandle?.openTime);
    const nextCandleCrossesBoundary = nextOpen === expectedOpen
      && nextOpen + intervalMs > endTime;
    if (!nextCandleCrossesBoundary) firstGap = expectedOpen;
  }
  return { contiguousCandles, firstGap };
}

function unresolvedResult({ reason }) {
  return {
    resolved: false,
    exitReason: null,
    exitTime: null,
    exitMarketPrice: null,
    resolution: null,
    dataQuality: INCOMPLETE_INTRABAR_DATA,
    replayCandles: [],
    replayCandleIndex: null,
    requiresLowerTimeframe: false,
    reason
  };
}

function inferIntervalMilliseconds(lowerTimeframe, candles) {
  const explicit = intervalMilliseconds(lowerTimeframe);
  if (explicit) return explicit;
  const sorted = (Array.isArray(candles) ? candles : [])
    .map((candle) => Number(candle?.openTime))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  for (let index = 1; index < sorted.length; index++) {
    const difference = sorted[index] - sorted[index - 1];
    if (difference > 0) return difference;
  }
  return null;
}

function intervalMilliseconds(interval) {
  const map = {
    "1m": 60 * 1000,
    "3m": 3 * 60 * 1000,
    "5m": 5 * 60 * 1000,
    "15m": 15 * 60 * 1000,
    "30m": 30 * 60 * 1000,
    "1h": 3600 * 1000,
    "2h": 2 * 3600 * 1000,
    "4h": 4 * 3600 * 1000,
    "1d": 24 * 3600 * 1000
  };
  return map[String(interval)] || null;
}

function formatLowerTimeframe(lowerTimeframe, intervalMs) {
  if (lowerTimeframe) return String(lowerTimeframe).toUpperCase();
  if (intervalMs === 60 * 1000) return "1M";
  if (intervalMs === 5 * 60 * 1000) return "5M";
  return `${intervalMs / 60000}M`;
}
