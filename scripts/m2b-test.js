import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  FUNDING_DATA_MISSING,
  NO_FUNDING_EVENTS_CONFIRMED,
  buildFundingCoverage,
  fetchHistoricalFunding
} from "../lib/market-data/funding-history.js";
import { fetchBinanceExchangeFilters } from "../lib/market-data/exchange-info.js";
import {
  MIN_NOTIONAL,
  parseBinanceSymbolFilters,
  prepareTradeSpecForExecution,
  roundTradeLevels,
  validateExecutionQuantity
} from "../lib/trading/exchange-filters.js";
import { createExecutionModel } from "../lib/backtest/execution-model.js";
import { MISSED_ENTRY, NO_ENTRY, simulateTrade } from "../lib/backtest/trade-simulator.js";
import { runBacktest } from "../lib/backtest/backtest-engine.js";
import { aggregateMetrics } from "../lib/backtest/metrics.js";
import { reviewAlertWithCandles } from "../lib/alert-review.js";
import {
  createTradeSpec,
  intervalMilliseconds,
  isTradeSpec
} from "../lib/trading/trade-spec.js";
import { buildTradePlan } from "../lib/trading/trade-plan.js";
import { enhanceInverseWatchSignal } from "../lib/scanner.js";
import { backtestStrategy } from "../lib/strategies.js";

const HOUR = intervalMilliseconds("1h");
const MINUTE = 60 * 1000;
const BASE = Date.UTC(2026, 0, 1, 0, 0);

function candle(openTime, open = 100, high = 101, low = 99, close = open) {
  return { openTime, open, high, low, close, markPrice: 999999 };
}

function spec({
  side = "LONG",
  referencePrice = 100,
  stopLoss = side === "SHORT" ? 105 : 95,
  takeProfit = side === "SHORT" ? 95 : 105,
  maxHoldingHours = 4,
  interval = "1h",
  entryEligibleAt = BASE + HOUR
} = {}) {
  return createTradeSpec({
    side,
    interval,
    signalCandleOpenTime: entryEligibleAt - intervalMilliseconds(interval),
    signalCandleCloseTime: entryEligibleAt,
    signalAvailableAt: entryEligibleAt,
    entryEligibleAt,
    referencePrice,
    stopLoss,
    takeProfit,
    maxHoldingHours
  });
}

function model(options = {}) {
  return createExecutionModel({
    marketType: "spot",
    fundingDataComplete: true,
    ...options
  });
}

function lowerBars(start, { triggerIndex = null, high = 101, low = 99 } = {}) {
  return Array.from({ length: 60 }, (_, index) => {
    const isTrigger = index === triggerIndex;
    return {
      openTime: start + index * MINUTE,
      open: 100,
      high: isTrigger ? high : 101,
      low: isTrigger ? low : 99,
      close: 100
    };
  });
}

function trade(tradeSpec, candles, options = {}) {
  return simulateTrade({
    tradeSpec,
    candles,
    entryIndex: 1,
    executionModel: model(),
    ...options
  });
}

const longReferenceOnly = trade(
  spec(),
  [
    candle(BASE, 100, 101, 99, 100),
    candle(BASE + HOUR, 101, 102, 100, 101),
    candle(BASE + 2 * HOUR, 101, 106, 100, 105)
  ]
);
assert.equal(longReferenceOnly.entryTime, BASE + HOUR);
assert.equal(longReferenceOnly.entryMarketPrice, 101);
assert.notEqual(longReferenceOnly.referencePrice, longReferenceOnly.entryFillPrice);
assert.equal(longReferenceOnly.exitReason, "take_profit");

const adverseLong = trade(
  spec(),
  [
    candle(BASE, 100),
    candle(BASE + HOUR, 100, 102, 99, 100)
  ],
  {
    executionModel: model({ spreadPct: 0.02, entrySlippagePct: 0.01, exitSlippagePct: 0.01 })
  }
);
assert.ok(adverseLong.entryFillPrice > adverseLong.entryMarketPrice);

const adverseShort = trade(
  spec({ side: "SHORT" }),
  [
    candle(BASE, 100),
    candle(BASE + HOUR, 100, 101, 98, 100)
  ],
  {
    executionModel: model({ spreadPct: 0.02, entrySlippagePct: 0.01, exitSlippagePct: 0.01 })
  }
);
assert.ok(adverseShort.entryFillPrice < adverseShort.entryMarketPrice);

const normalLongStop = trade(spec(), [
  candle(BASE, 100),
  candle(BASE + HOUR, 100, 102, 99, 100),
  candle(BASE + 2 * HOUR, 100, 102, 95, 96)
]);
assert.equal(normalLongStop.exitReason, "stop_loss");
assert.equal(normalLongStop.exitMarketPrice, 95);
assert.equal(normalLongStop.exitResolution, "stop_loss");

const normalShortStop = trade(spec({ side: "SHORT" }), [
  candle(BASE, 100),
  candle(BASE + HOUR, 100, 101, 98, 100),
  candle(BASE + 2 * HOUR, 100, 105, 99, 104)
]);
assert.equal(normalShortStop.exitReason, "stop_loss");
assert.equal(normalShortStop.exitMarketPrice, 105);
assert.equal(normalShortStop.exitResolution, "stop_loss");

const longGapStop = trade(spec(), [
  candle(BASE, 100),
  candle(BASE + HOUR, 100, 102, 99, 100),
  candle(BASE + 2 * HOUR, 90, 95, 80, 85)
]);
assert.equal(longGapStop.exitResolution, "gap_stop_worse_fill");
assert.equal(longGapStop.exitMarketPrice, 90);
assert.ok(Math.abs(longGapStop.maePct + 0.1) < 1e-12);
assert.ok(Math.abs(longGapStop.mfePct - 0.02) < 1e-12);

const shortGapStop = trade(spec({ side: "SHORT" }), [
  candle(BASE, 100),
  candle(BASE + HOUR, 100, 101, 98, 100),
  candle(BASE + 2 * HOUR, 110, 115, 109, 111)
]);
assert.equal(shortGapStop.exitReason, "stop_loss");
assert.equal(shortGapStop.exitResolution, "gap_stop_worse_fill");
assert.equal(shortGapStop.exitMarketPrice, 110);
assert.ok(Math.abs(shortGapStop.maePct + 0.1) < 1e-12);

const longGapTarget = trade(spec(), [
  candle(BASE, 100),
  candle(BASE + HOUR, 100, 102, 99, 100),
  candle(BASE + 2 * HOUR, 110, 115, 109, 112)
]);
assert.equal(longGapTarget.exitReason, "take_profit");
assert.equal(longGapTarget.exitMarketPrice, 105);
assert.equal(longGapTarget.exitResolution, "take_profit_conservative");

for (const [side, open] of [
  ["LONG", 110],
  ["LONG", 90],
  ["SHORT", 90],
  ["SHORT", 110]
]) {
  const result = trade(
    spec({ side }),
    [candle(BASE, 100), candle(BASE + HOUR, open, open + 2, open - 2, open)],
    { executionModel: model() }
  );
  assert.equal(result, null, side + " invalid entry should not open");
}
assert.ok(NO_ENTRY && MISSED_ENTRY);

const expiredEntry = trade(spec({ maxHoldingHours: 1 }), [
  candle(BASE, 100),
  candle(BASE + 2 * HOUR, 100, 102, 99, 100)
]);
assert.equal(expiredEntry, null);

const baseAmbiguous = trade(spec(), [
  candle(BASE, 100),
  candle(BASE + HOUR, 100, 106, 94, 100)
]);
assert.equal(baseAmbiguous.exitReason, "stop_loss");
assert.equal(baseAmbiguous.exitResolution, "pessimistic_stop_first");
assert.equal(baseAmbiguous.ambiguousIntrabar, true);
assert.equal(baseAmbiguous.mfePct, 0);

const lowerTp = trade(spec(), [
  candle(BASE, 100),
  candle(BASE + HOUR, 100, 106, 94, 100)
], {
  lowerTimeframe: "1m",
  lowerTimeframeCandles: lowerBars(BASE + HOUR, { triggerIndex: 2, high: 106, low: 99 })
});
assert.equal(lowerTp.exitReason, "take_profit");
assert.equal(lowerTp.exitResolution, "take_profit");
assert.equal(lowerTp.exitTime, BASE + HOUR + 2 * MINUTE);
assert.equal(lowerTp.excursionQuality, "LOWER_TF_REPLAY_1M");

const lowerCollision = trade(spec(), [
  candle(BASE, 100),
  candle(BASE + HOUR, 100, 106, 94, 100)
], {
  lowerTimeframe: "1m",
  lowerTimeframeCandles: lowerBars(BASE + HOUR, { triggerIndex: 2, high: 106, low: 94 })
});
assert.equal(lowerCollision.exitReason, "stop_loss");
assert.equal(lowerCollision.exitResolution, "pessimistic_stop_first");
assert.equal(lowerCollision.ambiguousIntrabar, true);

const noBaseLookahead = trade(spec(), [
  candle(BASE, 100),
  candle(BASE + HOUR, 100, 106, 94, 100)
], {
  lowerTimeframe: "1m",
  lowerTimeframeCandles: lowerBars(BASE + HOUR)
});
assert.equal(noBaseLookahead.exitReason, "end_of_data");

const longMfeBounded = trade(spec(), [
  candle(BASE, 100),
  candle(BASE + HOUR, 100, 101, 99, 100),
  candle(BASE + 2 * HOUR, 100, 106, 99, 105)
]);
assert.equal(longMfeBounded.exitReason, "take_profit");
assert.ok(Math.abs(longMfeBounded.mfePct - 0.05) < 1e-12);
assert.notEqual(longMfeBounded.mfePct, 0.06);

const shortExcursion = trade(spec({ side: "SHORT", stopLoss: 120, takeProfit: 80 }), [
  candle(BASE, 100),
  candle(BASE + HOUR, 100, 110, 90, 100),
  candle(BASE + 2 * HOUR, 100, 101, 99, 100)
]);
assert.ok(Math.abs(shortExcursion.mfePct - 0.1) < 1e-12);
assert.ok(Math.abs(shortExcursion.maePct + 0.1) < 1e-12);

const lowerTimeStop = trade(spec({ maxHoldingHours: 0.5 }), [
  candle(BASE, 100),
  candle(BASE + HOUR, 100, 101, 99, 100)
], {
  lowerTimeframe: "1m",
  lowerTimeframeCandles: lowerBars(BASE + HOUR)
    .map((row, index) => index > 30 ? { ...row, high: 200, low: 50 } : row)
});
assert.equal(lowerTimeStop.exitReason, "time_stop");
assert.equal(lowerTimeStop.exitTime, BASE + HOUR + 30 * MINUTE);
assert.equal(lowerTimeStop.exitResolution, "time_stop");
assert.equal(lowerTimeStop.excursionQuality, "LOWER_TF_REPLAY_1M");
assert.ok(Math.abs(lowerTimeStop.mfePct - 0.01) < 1e-12);

const feeTrade = trade(spec(), [
  candle(BASE, 100),
  candle(BASE + HOUR, 100, 102, 99, 100),
  candle(BASE + 2 * HOUR, 100, 106, 99, 105)
], {
  executionModel: model({ entryFeePct: 0.001, exitFeePct: 0.001 })
});
assert.equal(feeTrade.entryFeePct, 0.001);
assert.ok(Math.abs(feeTrade.exitFeePct - 0.00105) < 1e-12);
assert.ok(Math.abs(feeTrade.totalFeePct - 0.00205) < 1e-12);

const fundingCandles = [
  candle(BASE, 100),
  candle(BASE + HOUR, 100, 102, 98, 100),
  candle(BASE + 2 * HOUR, 100, 102, 98, 100),
  candle(BASE + 3 * HOUR, 100, 102, 98, 100)
];
const fundingModel = createExecutionModel({
  marketType: "futures",
  fundingDataComplete: true,
  fundingEvents: [
    { time: BASE + HOUR, rate: 0.2 },
    { time: BASE + 2 * HOUR, rate: 0.01 },
    { time: BASE + 3 * HOUR, rate: -0.004 },
    { time: BASE + 4 * HOUR, rate: 0.2 }
  ]
});
const fundingLong = simulateTrade({
  tradeSpec: spec({ maxHoldingHours: 2 }),
  candles: fundingCandles,
  entryIndex: 1,
  executionModel: fundingModel
});
assert.ok(Math.abs(fundingLong.fundingPct + 0.006) < 1e-12);
const fundingShort = simulateTrade({
  tradeSpec: spec({ side: "SHORT", stopLoss: 200, takeProfit: 1, maxHoldingHours: 2 }),
  candles: fundingCandles,
  entryIndex: 1,
  executionModel: fundingModel
});
assert.ok(Math.abs(fundingShort.fundingPct - 0.006) < 1e-12);
assert.equal(createExecutionModel({ marketType: "futures", fundingEvents: [] }).fundingDataComplete, false);
assert.equal(createExecutionModel({
  marketType: "futures",
  fundingEvents: [],
  fundingCoverage: buildFundingCoverage({
    requestedStart: BASE,
    requestedEnd: BASE + HOUR,
    complete: true,
    events: []
  })
}).fundingStatus, NO_FUNDING_EVENTS_CONFIRMED);

const providerStart = BASE;
const providerEnd = BASE + 3 * HOUR;
const providerRows = [
  { fundingTime: providerStart + 30 * MINUTE, fundingRate: "0.001" },
  { fundingTime: providerStart + 90 * MINUTE, fundingRate: "-0.002" },
  { fundingTime: providerStart + 150 * MINUTE, fundingRate: "0.003" }
];
const providerCalls = [];
const providerResult = await fetchHistoricalFunding({
  symbol: "BTCUSDT",
  startTime: providerStart,
  endTime: providerEnd,
  pageLimit: 2,
  fetchImpl: async (url) => {
    const parsed = new URL(url);
    const cursor = Number(parsed.searchParams.get("startTime"));
    providerCalls.push(cursor);
    const rows = cursor <= providerRows[0].fundingTime
      ? providerRows.slice(0, 2)
      : providerRows.slice(2);
    return { ok: true, json: async () => rows };
  }
});
assert.equal(providerCalls.length, 2);
assert.deepEqual(providerResult.events.map((event) => event.time), providerRows.map((event) => event.fundingTime));
assert.equal(providerResult.fundingCoverage.complete, true);
assert.equal(providerResult.status, "COMPLETE");
const emptyProvider = await fetchHistoricalFunding({
  symbol: "BTCUSDT",
  startTime: providerStart,
  endTime: providerEnd,
  fetchImpl: async () => ({ ok: true, json: async () => [] })
});
assert.equal(emptyProvider.status, NO_FUNDING_EVENTS_CONFIRMED);
assert.equal(emptyProvider.fundingDataComplete, true);
const missingProvider = await fetchHistoricalFunding({
  symbol: "BTCUSDT",
  startTime: providerStart,
  endTime: providerEnd,
  fetchImpl: async () => ({ ok: false, status: 500 })
});
assert.equal(missingProvider.status, FUNDING_DATA_MISSING);
assert.equal(missingProvider.fundingDataComplete, false);

const exchangeInfo = {
  symbols: [{
    symbol: "BTCUSDT",
    filters: [
      { filterType: "PRICE_FILTER", tickSize: "0.1" },
      { filterType: "LOT_SIZE", minQty: "0.01", maxQty: "100", stepSize: "0.01" },
      { filterType: "MARKET_LOT_SIZE", minQty: "0.1", maxQty: "100", stepSize: "0.1" },
      { filterType: "MIN_NOTIONAL", notional: "5" }
    ]
  }]
};
const exchangeFilters = parseBinanceSymbolFilters(exchangeInfo.symbols[0]);
assert.ok(exchangeFilters);
const exchangeProvider = await fetchBinanceExchangeFilters({
  symbol: "BTCUSDT",
  fetchImpl: async () => ({ ok: true, json: async () => exchangeInfo })
});
assert.equal(exchangeProvider.dataQuality, "COMPLETE");
assert.equal(exchangeProvider.exchangeFilters.tickSize, 0.1);
const roundedLong = roundTradeLevels({
  side: "LONG",
  stopLoss: 95.03,
  takeProfit: 105.07,
  exchangeFilters
});
assert.equal(roundedLong.roundedStopLoss, 95.1);
assert.equal(roundedLong.roundedTakeProfit, 105);
const roundedShort = roundTradeLevels({
  side: "SHORT",
  stopLoss: 105.03,
  takeProfit: 94.97,
  exchangeFilters
});
assert.equal(roundedShort.roundedStopLoss, 105);
assert.equal(roundedShort.roundedTakeProfit, 95);
const rejectedNotional = validateExecutionQuantity({
  quantity: 0.1,
  price: 10,
  exchangeFilters
});
assert.equal(rejectedNotional.valid, false);
assert.equal(rejectedNotional.reason, MIN_NOTIONAL);
const acceptedQuantity = validateExecutionQuantity({
  quantity: 0.25,
  price: 100,
  exchangeFilters
});
assert.equal(acceptedQuantity.valid, true);
assert.equal(acceptedQuantity.roundedQty, 0.2);
const filterTradeSpec = spec({ stopLoss: 95.03, takeProfit: 105.07 });
const preparedFilterSpec = prepareTradeSpecForExecution(filterTradeSpec, exchangeFilters);
assert.equal(preparedFilterSpec.tradeSpec.stopLoss, 95.1);
const filteredTrade = trade(filterTradeSpec, [
  candle(BASE, 100),
  candle(BASE + HOUR, 100, 102, 99, 100),
  candle(BASE + 2 * HOUR, 100, 106, 99, 105)
], {
  exchangeFilters,
  requestedQty: 0.25
});
assert.equal(filteredTrade.roundedStopLoss, 95.1);
assert.equal(filteredTrade.roundedTakeProfit, 105);
assert.equal(filteredTrade.quantity, 0.2);
assert.equal(filteredTrade.entryMarketPrice, 100);

const sentAt = BASE + HOUR + 30 * MINUTE;
const sentSpec = spec();
const sentAlert = {
  sent_at: new Date(sentAt).toISOString(),
  interval: "1h",
  payload: { tradeSpec: sentSpec }
};
const postSendOnly = lowerBars(sentAt);
const safePartialReview = reviewAlertWithCandles(
  sentAlert,
  [candle(BASE + HOUR, 100, 120, 80, 100)],
  BASE + 2 * HOUR,
  { lowerTimeframe: "1m", lowerTimeframeCandles: postSendOnly }
);
assert.equal(safePartialReview.status, "pending");
assert.notEqual(safePartialReview.outcome, "止损");
assert.notEqual(safePartialReview.outcome, "止盈");
const partialWithoutLower = reviewAlertWithCandles(
  sentAlert,
  [candle(BASE + HOUR, 100, 120, 80, 100)],
  BASE + 2 * HOUR
);
assert.equal(partialWithoutLower.status, "pending");
assert.equal(partialWithoutLower.state, "ambiguous");
assert.equal(partialWithoutLower.reason, "pending_partial_candle");

const reviewLowerStop = reviewAlertWithCandles(
  sentAlert,
  [candle(BASE + HOUR, 100, 120, 80, 100)],
  BASE + 2 * HOUR,
  {
    lowerTimeframe: "1m",
    lowerTimeframeCandles: lowerBars(sentAt, { triggerIndex: 1, high: 101, low: 94 })
  }
);
assert.equal(reviewLowerStop.status, "reviewed");
assert.equal(reviewLowerStop.outcome, "止损");

const reviewLowerTarget = reviewAlertWithCandles(
  { sent_at: new Date(BASE + HOUR).toISOString(), interval: "1h", payload: { tradeSpec: sentSpec } },
  [candle(BASE + HOUR, 100, 120, 80, 100)],
  BASE + 2 * HOUR,
  {
    lowerTimeframe: "1m",
    lowerTimeframeCandles: lowerBars(BASE + HOUR, { triggerIndex: 1, high: 106, low: 99 })
  }
);
assert.equal(reviewLowerTarget.status, "reviewed");
assert.equal(reviewLowerTarget.outcome, "止盈");

const metricResult = aggregateMetrics([longReferenceOnly, baseAmbiguous], {
  missedEntries: [{ status: NO_ENTRY }],
  entryStats: { signals: 3 }
});
assert.equal(metricResult.trades, 2);
assert.equal(metricResult.expectancyR, (longReferenceOnly.realizedR + baseAmbiguous.realizedR) / 2);
assert.equal(metricResult.ambiguousTrades, 1);
assert.equal(metricResult.missedEntries, 1);
assert.equal(metricResult.noEntryRate, 1 / 3);
assert.equal(metricResult.degradedTrades, 1);

const engineCandles = Array.from({ length: 224 }, (_, index) =>
  candle(BASE + index * HOUR, 100, 102, 98, 101)
);
engineCandles[220] = candle(BASE + 220 * HOUR, 100, 102, 98, 100);
engineCandles[221] = candle(BASE + 221 * HOUR, 101, 102, 98, 101);
engineCandles[222] = candle(BASE + 222 * HOUR, 101, 999, 1, 101);
const engineResult = runBacktest({
  candles: engineCandles,
  strategy: {
    id: "m2b_engine_test",
    direction: "LONG",
    holdHours: 1,
    evaluate(_candles, index) {
      return { passed: index === 220 };
    }
  },
  interval: "1h",
  marketType: "spot",
  startIndex: 220
});
assert.ok(engineResult.tradeResults.length);
assert.equal(engineResult.tradeResults[0].entryTime, engineCandles[221].openTime);
assert.equal(engineResult.tradeResults[0].entryTime, engineResult.tradeResults[0].entryEligibleAt);
assert.notEqual(engineResult.tradeResults[0].entryFillPrice, engineResult.tradeResults[0].referencePrice);

const invalidEngineCandles = engineCandles.map((row) => ({ ...row }));
invalidEngineCandles[221] = candle(BASE + 221 * HOUR, 110, 112, 109, 111);
const invalidEngineResult = runBacktest({
  candles: invalidEngineCandles,
  strategy: {
    id: "m2b_invalid_entry_test",
    direction: "LONG",
    holdHours: 1,
    evaluate(_candles, index) {
      return { passed: index === 220 };
    }
  },
  interval: "1h",
  marketType: "spot",
  startIndex: 220
});
assert.equal(invalidEngineResult.tradeResults.length, 0);
assert.equal(invalidEngineResult.missedEntries[0].status, NO_ENTRY);
assert.equal(invalidEngineResult.metrics.missedEntries, 1);

const legacyResult = backtestStrategy(
  engineCandles,
  {
    id: "m2b_legacy_wrapper_test",
    direction: "LONG",
    holdHours: 1,
    evaluate(_candles, index) {
      return { passed: index === 220 };
    }
  },
  "1h",
  0,
  { marketType: "spot", startIndex: 220 }
);
assert.ok(legacyResult?.tradeResults?.length);
assert.equal(legacyResult.tradeResults[0].entryTime, engineCandles[221].openTime);

const inverseSignal = enhanceInverseWatchSignal({
  signalKey: "inverse-regression",
  asset: "BTCUSDT",
  market: "USDT inverse watch",
  interval: "1h",
  strategyId: "inverse_regression",
  strategyName: "inverse regression",
  direction: "做多观察",
  signalCandleOpenTime: BASE,
  signalCandleCloseTime: BASE + HOUR,
  signalAvailableAt: BASE + HOUR,
  entryEligibleAt: BASE + HOUR,
  triggerTime: BASE + HOUR,
  close: 100
}, { strategy: { direction: "LONG", holdHours: 8 }, interval: "1h" });
const inverseBacktestPlan = buildTradePlan({
  marketType: "futures",
  tradePlanType: "spot",
  signal: inverseSignal,
  strategy: { direction: "LONG", holdHours: 8 },
  interval: "1h"
});
assert.equal(inverseSignal.marketType, "futures");
assert.equal(inverseSignal.tradePlanType, "spot");
assert.equal(inverseSignal.tradeSpec.stopLoss, inverseBacktestPlan.tradeSpec.stopLoss);
assert.equal(inverseSignal.tradeSpec.takeProfit, inverseBacktestPlan.tradeSpec.takeProfit);
assert.equal(inverseSignal.tradeSpec.maxHoldingTime, inverseBacktestPlan.tradeSpec.maxHoldingTime);
assert.equal(inverseSignal.tradeSpec.stopLoss, 97);
assert.equal(inverseSignal.tradeSpec.takeProfit, 104.5);
assert.match(readFileSync("scripts/inverse-signal-report.js", "utf8"), /marketType:\s*market/);

const invalidChronology = {
  ...sentSpec,
  signalAvailableAt: sentSpec.signalCandleOpenTime - 1
};
assert.equal(isTradeSpec(invalidChronology), false);

const incompleteFilterTrade = trade(spec(), [
  candle(BASE, 100),
  candle(BASE + HOUR, 100, 102, 99, 100)
], {
  exchangeFilters: { tickSize: 0, stepSize: 0 }
});
assert.equal(incompleteFilterTrade, null);
assert.equal(prepareTradeSpecForExecution(spec(), {
  tickSize: 0.1,
  stepSize: 0.1,
  minQty: -1
}).valid, false);

console.log("M2B test passed");
