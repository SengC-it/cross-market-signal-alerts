import { intervalMilliseconds } from "../lib/trading/trade-spec.js";
import { runM3Validation } from "../lib/validation/validation-engine.js";

const HOUR = intervalMilliseconds("1h");

export function buildM3SampleCandles(count = 120, base = Date.UTC(2026, 0, 1)) {
  return Array.from({ length: count }, (_, index) => {
    const signalCycle = index % 6;
    const isTargetCandle = signalCycle === 4;
    return {
      openTime: base + index * HOUR,
      open: 100,
      high: isTargetCandle ? 106 : 101,
      low: 99,
      close: 100,
      markPrice: 100
    };
  });
}

export function buildM3SampleStrategy() {
  return {
    id: "m3_validation_sample",
    direction: "LONG",
    holdHours: 4,
    evaluate(_candles, index) {
      return { passed: index >= 2 && index % 6 === 2 };
    }
  };
}

const result = runM3Validation({
  candles: buildM3SampleCandles(),
  strategy: buildM3SampleStrategy(),
  interval: "1h",
  folds: 5,
  holdoutPct: 0.2,
  backtestOptions: {
    marketType: "spot",
    tradePlanType: "spot",
    executionModel: {
      exchangeRulesRequired: false
    }
  }
});

console.log(JSON.stringify({
  development: result.development,
  folds: result.folds.map((fold) => ({
    foldId: fold.foldId,
    testStart: fold.testStart,
    testEnd: fold.testEnd,
    completeTrades: fold.completeTrades,
    degradedTrades: fold.degradedTrades,
    purgedBoundarySignals: fold.purgedBoundarySignals,
    expectancyR: fold.expectancyR,
    profitFactor: fold.profitFactor
  })),
  aggregate: result.aggregate,
  holdoutMetrics: result.holdoutMetrics,
  verdict: result.verdict,
  flags: result.flags
}, null, 2));
