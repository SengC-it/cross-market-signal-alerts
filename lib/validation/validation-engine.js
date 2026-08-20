import { runFinalHoldoutValidation } from "./holdout.js";
import {
  determineValidationVerdict,
  VALIDATION_FLAGS
} from "./validation-metrics.js";
import {
  runWalkForwardValidation,
  splitChronologicalData
} from "./walk-forward.js";

export function runM3Validation({
  candles,
  strategy,
  interval = "1h",
  holdoutPct = 0.2,
  folds = 5,
  asset = null,
  backtestOptions = {}
} = {}) {
  const split = splitChronologicalData(candles, { holdoutPct, interval });
  const walkForward = runWalkForwardValidation({
    split,
    strategy,
    interval,
    folds,
    asset,
    backtestOptions
  });
  const holdout = runFinalHoldoutValidation({
    split,
    strategy,
    interval,
    asset,
    backtestOptions
  });
  const verdict = determineValidationVerdict({
    aggregate: walkForward.aggregate,
    holdout: holdout.holdoutMetrics,
    folds: walkForward.folds,
    stability: walkForward.stability
  });
  return {
    development: {
      start: split.developmentStart,
      end: split.developmentEnd,
      candleCount: split.developmentCandles.length
    },
    holdout: {
      start: split.holdoutStart,
      end: split.holdoutEnd,
      pct: split.holdoutPct,
      candleCount: split.holdoutCandles.length,
      metrics: holdout.holdoutMetrics
    },
    folds: walkForward.folds,
    aggregate: walkForward.aggregate,
    stability: walkForward.stability,
    holdoutMetrics: holdout.holdoutMetrics,
    verdict,
    flags: { ...VALIDATION_FLAGS },
    tradeResults: walkForward.tradeResults,
    missedEntries: walkForward.missedEntries,
    holdoutTradeResults: holdout.tradeResults,
    holdoutMissedEntries: holdout.missedEntryRecords
  };
}
