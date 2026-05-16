import { CONFIG, intervalHours } from "./config.js";
import { atr, highest, rsi, slope, sma, stdev } from "./indicators.js";

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

export function backtestStrategy(candles, strategy, interval, tradingCost) {
  const holdBars = Math.max(1, Math.round(strategy.holdHours / intervalHours(interval)));
  const returns = [];
  for (let index = 220; index < candles.length - holdBars; ) {
    const signal = strategy.evaluate(candles, index);
    const prev = strategy.evaluate(candles, index - 1);
    if (signal.passed && !prev.passed) {
      const entry = candles[index].close;
      const exit = candles[index + holdBars].close;
      returns.push(exit / entry - 1 - tradingCost);
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

function validMs(strategy) {
  return strategy.holdHours >= 168 ? 3 * 24 * 3600 * 1000 : 8 * 3600 * 1000;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
}
