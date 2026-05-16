import { CONFIG } from "./config.js";
import { sendEmail } from "./email.js";
import { getCryptoCandles, getCryptoOrderBook, getYahooCandles } from "./market-data.js";
import { renderSignalEmail } from "./report.js";
import { backtestStrategy, evaluateFilters, getCurrentSignal, scoreCandidate, STRATEGIES } from "./strategies.js";
import { hasSentSignal, recordRunLog, recordSentSignal } from "./storage.js";

export async function runSignalScan({ dryRun = false } = {}) {
  const startedAt = new Date().toISOString();
  const candidates = [];
  const errors = [];

  const btc4h = await safe(() => getCryptoCandles("BTCUSDT", "4h", 1000), errors, "BTCUSDT benchmark");

  for (const symbol of CONFIG.cryptoAssets) {
    for (const interval of CONFIG.intervals) {
      const candles = await safe(() => getCryptoCandles(symbol, interval, 1000), errors, `${symbol} ${interval}`);
      if (!candles || candles.length < 260) continue;
      const orderBook = await safe(() => getCryptoOrderBook(symbol), errors, `${symbol} orderbook`);
      for (const strategy of STRATEGIES) {
        const metrics = backtestStrategy(candles, strategy, interval, CONFIG.cryptoTradingCost);
        if (!metrics || metrics.trades < CONFIG.minTrades) continue;
        const currentSignal = getCurrentSignal(candles, strategy);
        if (!currentSignal) continue;
        const filters = evaluateFilters({ candles, benchmarkCandles: btc4h, orderBook });
        const recommendationScore = scoreCandidate({ metrics, filters });
        if (recommendationScore < CONFIG.minRecommendationScore) continue;
        candidates.push(buildSignal({
          asset: symbol,
          market: "虚拟货币",
          interval,
          strategy,
          metrics,
          filters,
          recommendationScore,
          currentSignal
        }));
      }
    }
  }

  for (const symbol of [...CONFIG.equityAssets, ...CONFIG.commodityAssets]) {
    const candles = await safe(() => getYahooCandles(symbol, "5y", "1d"), errors, `${symbol} yahoo`);
    if (!candles || candles.length < 260) continue;
    const benchmark = symbol === "SPY" ? candles : await safe(() => getYahooCandles("SPY", "5y", "1d"), errors, "SPY benchmark");
    for (const strategy of STRATEGIES) {
      const metrics = backtestStrategy(candles, strategy, "1d", CONFIG.equityTradingCost);
      if (!metrics || metrics.trades < CONFIG.minTrades) continue;
      const currentSignal = getCurrentSignal(candles, strategy);
      if (!currentSignal) continue;
      const filters = evaluateFilters({ candles, benchmarkCandles: benchmark, orderBook: null });
      const recommendationScore = scoreCandidate({ metrics, filters });
      if (recommendationScore < CONFIG.minRecommendationScore) continue;
      candidates.push(buildSignal({
        asset: symbol,
        market: CONFIG.commodityAssets.includes(symbol) ? "商品/能源代理" : "美股/ETF",
        interval: "1d",
        strategy,
        metrics,
        filters,
        recommendationScore,
        currentSignal
      }));
    }
  }

  const signals = [];
  for (const signal of candidates.sort((a, b) => b.recommendationScore - a.recommendationScore).slice(0, CONFIG.maxSignalsPerEmail)) {
    if (!(await hasSentSignal(signal.signalKey))) signals.push(signal);
  }

  let emailed = false;
  if (signals.length && !dryRun) {
    const email = renderSignalEmail(signals);
    await sendEmail(email);
    await Promise.all(signals.map((signal) => recordSentSignal({
      signal_key: signal.signalKey,
      asset: signal.asset,
      strategy_id: signal.strategyId,
      interval: signal.interval,
      trigger_time: new Date(signal.triggerTime).toISOString(),
      recommendation_score: signal.recommendationScore,
      payload: signal
    })));
    emailed = true;
  }

  await recordRunLog({
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    candidates_count: candidates.length,
    signals_count: signals.length,
    emailed,
    errors
  });

  return { candidates: candidates.length, signals: signals.length, emailed, errors };
}

function buildSignal({ asset, market, interval, strategy, metrics, filters, recommendationScore, currentSignal }) {
  const signalKey = `${asset}:${interval}:${strategy.id}:${currentSignal.candle.openTime}`;
  return {
    signalKey,
    asset,
    market,
    interval,
    strategyId: strategy.id,
    strategyName: strategy.name,
    direction: strategy.direction === "LONG" ? "做多观察" : "做空观察",
    triggerTime: currentSignal.candle.openTime,
    validUntil: currentSignal.validUntil,
    close: currentSignal.candle.close,
    details: currentSignal.details,
    metrics,
    filters,
    recommendationScore,
    triggerReason: `最新已收盘 ${interval} K 线满足「${strategy.name}」，上一根 K 线不满足，因此属于新信号。`,
    invalidCondition: strategy.id.includes("donchian")
      ? "收盘价跌回突破位下方，或大盘/自身趋势过滤转弱。"
      : "收盘价跌回关键均线下方，或 SMA50 不再高于 SMA200。"
  };
}

async function safe(fn, errors, label) {
  try {
    return await fn();
  } catch (error) {
    errors.push({ label, error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}
