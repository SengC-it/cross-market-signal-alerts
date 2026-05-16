import { CONFIG, intervalHours } from "./config.js";
import { atr, highest, lowest, rsi, slope, sma, stdev } from "./indicators.js";

export const STRATEGIES = [
  {
    id: "trend_ma50_ma200",
    name: "趋势做多 close > SMA50 > SMA200",
    direction: "LONG",
    holdHours: 168,
    evaluate(candles, index) {
      const closes = candles.map((c) => c.close);
      const close = closes[index];
      const ma50 = sma(closes, 50, index);
      const ma200 = sma(closes, 200, index);
      return {
        passed: ma50 != null && ma200 != null && close > ma50 && ma50 > ma200,
        details: { close, sma50: ma50, sma200: ma200 }
      };
    }
  },
  {
    id: "donchian_20_breakout",
    name: "Donchian 20 突破做多",
    direction: "LONG",
    holdHours: 168,
    evaluate(candles, index) {
      const closes = candles.map((c) => c.close);
      const highs = candles.map((c) => c.high);
      const level = highest(highs, 20, index);
      return {
        passed: level != null && closes[index] > level,
        details: { close: closes[index], breakoutLevel: level }
      };
    }
  },
  {
    id: "donchian_55_breakout",
    name: "Donchian 55 突破做多",
    direction: "LONG",
    holdHours: 168,
    evaluate(candles, index) {
      const closes = candles.map((c) => c.close);
      const highs = candles.map((c) => c.high);
      const level = highest(highs, 55, index);
      return {
        passed: level != null && closes[index] > level,
        details: { close: closes[index], breakoutLevel: level }
      };
    }
  },
  {
    id: "ma20_cross_ma50",
    name: "SMA20 上穿 SMA50",
    direction: "LONG",
    holdHours: 168,
    evaluate(candles, index) {
      const closes = candles.map((c) => c.close);
      const ma20 = sma(closes, 20, index);
      const ma50 = sma(closes, 50, index);
      const prev20 = sma(closes, 20, index - 1);
      const prev50 = sma(closes, 50, index - 1);
      return {
        passed: ma20 != null && ma50 != null && prev20 != null && prev50 != null && ma20 > ma50 && prev20 <= prev50,
        details: { close: closes[index], sma20: ma20, sma50: ma50 }
      };
    }
  },
  {
    id: "rsi30_rebound",
    name: "RSI 超卖反弹",
    direction: "LONG",
    holdHours: 72,
    evaluate(candles, index) {
      const closes = candles.map((c) => c.close);
      const value = rsi(closes, 14, index);
      const prev = rsi(closes, 14, index - 1);
      return {
        passed: value != null && prev != null && prev < 30 && value >= 30,
        details: { close: closes[index], rsi14: value }
      };
    }
  },
  {
    id: "bollinger_lower_rebound",
    name: "布林下轨反弹",
    direction: "LONG",
    holdHours: 72,
    evaluate(candles, index) {
      const closes = candles.map((c) => c.close);
      const mid = sma(closes, 20, index);
      const sd = stdev(closes, 20, index);
      const close = closes[index];
      const prevClose = closes[index - 1];
      const prevMid = sma(closes, 20, index - 1);
      const prevSd = stdev(closes, 20, index - 1);
      const lower = mid == null || sd == null ? null : mid - 2 * sd;
      const prevLower = prevMid == null || prevSd == null ? null : prevMid - 2 * prevSd;
      return {
        passed: lower != null && prevLower != null && prevClose < prevLower && close > lower,
        details: { close, bollingerLower: lower, sma20: mid }
      };
    }
  }
];

export const BREAKDOWN_STRATEGIES = [
  {
    id: "break_ma50_defense",
    name: "跌破 SMA50 防守/做空观察",
    direction: "SHORT",
    holdHours: 72,
    evaluate(candles, index) {
      const closes = candles.map((c) => c.close);
      const ma50 = sma(closes, 50, index);
      const prevMa50 = sma(closes, 50, index - 1);
      return {
        passed: ma50 != null && prevMa50 != null && closes[index] < ma50 && closes[index - 1] >= prevMa50,
        details: { close: closes[index], sma50: ma50 }
      };
    }
  },
  {
    id: "break_ma200_regime_risk",
    name: "跌破 SMA200 趋势转弱提醒",
    direction: "SHORT",
    holdHours: 168,
    evaluate(candles, index) {
      const closes = candles.map((c) => c.close);
      const ma200 = sma(closes, 200, index);
      const prevMa200 = sma(closes, 200, index - 1);
      return {
        passed: ma200 != null && prevMa200 != null && closes[index] < ma200 && closes[index - 1] >= prevMa200,
        details: { close: closes[index], sma200: ma200 }
      };
    }
  },
  {
    id: "donchian_20_breakdown",
    name: "Donchian 20 跌破防守/做空观察",
    direction: "SHORT",
    holdHours: 72,
    evaluate(candles, index) {
      const closes = candles.map((c) => c.close);
      const lows = candles.map((c) => c.low);
      const level = lowest(lows, 20, index);
      return {
        passed: level != null && closes[index] < level,
        details: { close: closes[index], breakdownLevel: level }
      };
    }
  }
];

export const SHORT_TERM_STRATEGIES = [
  {
    id: "short_term_momentum_24h",
    name: "短线 24 小时动量延续",
    direction: "LONG",
    holdHours: 12,
    evaluate(candles, index) {
      if (index < 24) return { passed: false, details: {} };
      const closes = candles.map((c) => c.close);
      const volumes = candles.map((c) => c.volume);
      const momentum = closes[index] / closes[index - 24] - 1;
      const volume20 = sma(volumes, 20, index);
      return {
        passed: momentum > 0.04 && volume20 != null && volumes[index] > volume20,
        details: { close: closes[index], momentum24h: momentum, volumeMultiple: volumes[index] / volume20 }
      };
    }
  },
  {
    id: "short_term_pullback_rsi40",
    name: "短线强趋势 RSI40 回踩",
    direction: "LONG",
    holdHours: 12,
    evaluate(candles, index) {
      const closes = candles.map((c) => c.close);
      const ma50 = sma(closes, 50, index);
      const ma200 = sma(closes, 200, index);
      const value = rsi(closes, 14, index);
      const prev = rsi(closes, 14, index - 1);
      return {
        passed: ma50 != null && ma200 != null && value != null && prev != null && closes[index] > ma50 && ma50 > ma200 && prev < 40 && value >= 40,
        details: { close: closes[index], sma50: ma50, sma200: ma200, rsi14: value }
      };
    }
  },
  {
    id: "short_term_breakdown_24h",
    name: "短线 24 小时弱势跌破",
    direction: "SHORT",
    holdHours: 12,
    evaluate(candles, index) {
      const closes = candles.map((c) => c.close);
      const lows = candles.map((c) => c.low);
      const level = lowest(lows, 24, index);
      const ma50 = sma(closes, 50, index);
      return {
        passed: level != null && ma50 != null && closes[index] < level && closes[index] < ma50,
        details: { close: closes[index], breakdownLevel: level, sma50: ma50 }
      };
    }
  }
];

export const CRYPTO_STRATEGIES = [...STRATEGIES, ...BREAKDOWN_STRATEGIES];

export const FUTURES_STRATEGIES = [
  ...STRATEGIES,
  ...BREAKDOWN_STRATEGIES,
  ...SHORT_TERM_STRATEGIES,
  {
    id: "futures_trend_short_ma50_ma200",
    name: "合约趋势做空 close < SMA50 < SMA200",
    direction: "SHORT",
    holdHours: 72,
    evaluate(candles, index) {
      const closes = candles.map((c) => c.close);
      const close = closes[index];
      const ma50 = sma(closes, 50, index);
      const ma200 = sma(closes, 200, index);
      return {
        passed: ma50 != null && ma200 != null && close < ma50 && ma50 < ma200,
        details: { close, sma50: ma50, sma200: ma200 }
      };
    }
  },
  {
    id: "futures_donchian_20_breakdown",
    name: "合约 Donchian 20 跌破做空",
    direction: "SHORT",
    holdHours: 72,
    evaluate(candles, index) {
      const closes = candles.map((c) => c.close);
      const lows = candles.map((c) => c.low);
      const level = lowest(lows, 20, index);
      return {
        passed: level != null && closes[index] < level,
        details: { close: closes[index], breakdownLevel: level }
      };
    }
  },
  {
    id: "futures_rsi70_short_revert",
    name: "合约 RSI 过热回落做空",
    direction: "SHORT",
    holdHours: 24,
    evaluate(candles, index) {
      const closes = candles.map((c) => c.close);
      const value = rsi(closes, 14, index);
      const prev = rsi(closes, 14, index - 1);
      return {
        passed: value != null && prev != null && prev > 70 && value <= 70,
        details: { close: closes[index], rsi14: value }
      };
    }
  }
];

export function backtestStrategy(candles, strategy, interval, tradingCost) {
  const holdBars = Math.max(1, Math.round(strategy.holdHours / intervalHours(interval)));
  const returns = [];
  for (let index = 220; index < candles.length - holdBars; ) {
    const signal = strategy.evaluate(candles, index);
    const prev = strategy.evaluate(candles, index - 1);
    if (signal.passed && !prev.passed) {
      const entry = candles[index].close;
      const exit = candles[index + holdBars].close;
      const directionMultiplier = strategy.direction === "SHORT" ? -1 : 1;
      returns.push((exit / entry - 1) * directionMultiplier - tradingCost);
      index += holdBars;
    } else {
      index++;
    }
  }

  if (!returns.length) return null;
  let equity = 1;
  let peak = 1;
  let maxDrawdown = 0;
  let wins = 0;
  let winSum = 0;
  let lossSum = 0;
  for (const value of returns) {
    if (value > 0) {
      wins++;
      winSum += value;
    } else {
      lossSum += value;
    }
    equity *= 1 + value;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.min(maxDrawdown, equity / peak - 1);
  }

  const years = (candles.at(-1).openTime - candles[0].openTime) / (365.25 * 24 * 3600 * 1000);
  const totalReturn = equity - 1;
  return {
    trades: returns.length,
    winRate: wins / returns.length,
    totalReturn,
    cagr: years > 0 ? Math.pow(equity, 1 / years) - 1 : totalReturn,
    profitFactor: lossSum < 0 ? winSum / Math.abs(lossSum) : Infinity,
    maxDrawdown,
    years,
    sampleStart: candles[0].openTime,
    sampleEnd: candles.at(-1).openTime
  };
}

export function getCurrentSignal(candles, strategy) {
  const latestIndex = candles.length - 2;
  if (latestIndex < 220) return null;
  const current = strategy.evaluate(candles, latestIndex);
  const previous = strategy.evaluate(candles, latestIndex - 1);
  if (!current.passed || previous.passed) return null;
  return {
    candle: candles[latestIndex],
    details: current.details,
    validUntil: candles[latestIndex].openTime + validMs(strategy)
  };
}

export function scoreCandidate({ metrics, filters }) {
  const historical = clamp(
    (metrics.cagr * 100) * 0.45 +
      (metrics.totalReturn * 10) * 0.25 +
      (metrics.profitFactor * 12) * 0.2 +
      (metrics.winRate * 40) * 0.1,
    0,
    35
  );
  const risk = clamp(25 - Math.abs(metrics.maxDrawdown) * 35, 0, 25);
  const environment = filters.score;
  const liquidity = filters.liquidityScore;
  return Math.round(clamp(historical + risk + environment + liquidity, 0, 100));
}

export function evaluateFilters({ candles, benchmarkCandles, orderBook }) {
  const latestIndex = candles.length - 2;
  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);
  const close = closes[latestIndex];
  const ma50 = sma(closes, 50, latestIndex);
  const ma200 = sma(closes, 200, latestIndex);
  const ma50Slope = slope(closes.map((_, i) => sma(closes, 50, i) ?? closes[i]), 10, latestIndex);
  const volume20 = sma(volumes, 20, latestIndex);
  const latestAtr = atr(candles, 14, latestIndex);
  const atrRatio = latestAtr && close ? latestAtr / close : null;

  let score = 0;
  const checks = [];
  if (ma200 != null && close > ma200) {
    score += 7;
    checks.push(["自身趋势", "通过", "价格位于 SMA200 上方"]);
  } else {
    checks.push(["自身趋势", "风险", "价格未站上 SMA200"]);
  }

  if (ma50Slope != null && ma50Slope > 0) {
    score += 5;
    checks.push(["均线斜率", "通过", "SMA50 斜率为正"]);
  } else {
    checks.push(["均线斜率", "一般", "SMA50 斜率未明显向上"]);
  }

  const volumeMultiple = volume20 ? volumes[latestIndex] / volume20 : null;
  if (volumeMultiple != null && volumeMultiple >= 1.2) {
    score += 5;
    checks.push(["成交量", "通过", `最新成交量约为 20 均量的 ${volumeMultiple.toFixed(2)} 倍`]);
  } else {
    checks.push(["成交量", "一般", volumeMultiple == null ? "成交量数据不足" : `成交量约为 20 均量的 ${volumeMultiple.toFixed(2)} 倍`]);
  }

  if (atrRatio != null && atrRatio < 0.08) {
    score += 4;
    checks.push(["波动率", "通过", `ATR14/close 约 ${(atrRatio * 100).toFixed(2)}%`]);
  } else {
    checks.push(["波动率", "风险", atrRatio == null ? "ATR 数据不足" : `ATR14/close 约 ${(atrRatio * 100).toFixed(2)}%`]);
  }

  if (benchmarkCandles?.length > 220) {
    const bIndex = benchmarkCandles.length - 2;
    const bCloses = benchmarkCandles.map((c) => c.close);
    const bClose = bCloses[bIndex];
    const bMa200 = sma(bCloses, 200, bIndex);
    if (bMa200 != null && bClose > bMa200) {
      score += 4;
      checks.push(["大盘趋势", "通过", "基准资产位于 SMA200 上方"]);
    } else {
      checks.push(["大盘趋势", "风险", "基准资产未站上 SMA200"]);
    }
  } else {
    checks.push(["大盘趋势", "缺失", "基准数据不足"]);
  }

  const liquidityScore = orderBook ? 12 : 9;
  checks.push(["流动性", orderBook ? "通过" : "一般", orderBook ? "订单簿可获取" : "未获取订单簿，按主流标的处理"]);

  return { score: clamp(score, 0, 25), liquidityScore, checks };
}

export function evaluateFuturesFilters({ candles, benchmarkCandles, funding, openInterest, direction }) {
  const base = evaluateFilters({ candles, benchmarkCandles, orderBook: null });
  const checks = [...base.checks];
  let score = Math.max(0, base.score - 2);
  let liquidityScore = 10;

  if (funding && Number.isFinite(funding.fundingRate)) {
    const rate = funding.fundingRate;
    if (direction === "做多观察" && rate > 0.0008) {
      checks.push(["资金费率", "风险", `资金费率偏高 ${(rate * 100).toFixed(4)}%，多头可能拥挤`]);
    } else if (direction === "做空观察" && rate < -0.0008) {
      checks.push(["资金费率", "风险", `资金费率偏低 ${(rate * 100).toFixed(4)}%，空头可能拥挤`]);
    } else {
      score += 3;
      checks.push(["资金费率", "通过", `资金费率 ${(rate * 100).toFixed(4)}%，未见极端拥挤`]);
    }
  } else {
    checks.push(["资金费率", "缺失", "未获取到最新资金费率"]);
  }

  if (openInterest && Number.isFinite(openInterest.openInterest)) {
    score += 2;
    checks.push(["持仓量", "一般", `当前持仓量 ${openInterest.openInterest.toFixed(2)}，用于辅助判断拥挤度`]);
  } else {
    checks.push(["持仓量", "缺失", "未获取到当前持仓量"]);
  }

  checks.push(["杠杆风险", "风险", "合约存在强平风险，推荐指数不代表可使用高杠杆"]);
  return { score: clamp(score, 0, 25), liquidityScore, checks };
}

function validMs(strategy) {
  return strategy.holdHours >= 168 ? 3 * 24 * 3600 * 1000 : 8 * 3600 * 1000;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
}
