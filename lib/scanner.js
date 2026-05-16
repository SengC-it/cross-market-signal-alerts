import { CONFIG } from "./config.js";
import { sendEmail } from "./email.js";
import {
  getCryptoCandles,
  getCryptoOrderBook,
  getFuturesCandles,
  getFuturesFundingRate,
  getFuturesOpenInterest,
  getYahooCandles
} from "./market-data.js";
import { renderSignalEmail } from "./report.js";
import {
  backtestStrategy,
  CRYPTO_STRATEGIES,
  evaluateFilters,
  evaluateFuturesFilters,
  FUTURES_STRATEGIES,
  getCurrentSignal,
  scoreCandidate,
  STRATEGIES
} from "./strategies.js";
import { hasSentSignal, recordRunLog, recordSentSignal } from "./storage.js";

export async function runSignalScan({ dryRun = false, group = "all" } = {}) {
  const startedAt = new Date().toISOString();
  const candidates = [];
  const errors = [];
  const selected = selectScanTargets(group);

  const btc4h = await safe(() => getCryptoCandles("BTCUSDT", "4h", 1000), errors, "BTCUSDT benchmark");

  for (const symbol of selected.cryptoAssets) {
    for (const interval of CONFIG.intervals) {
      const candles = await safe(() => getCryptoCandles(symbol, interval, 1000), errors, `${symbol} spot ${interval}`);
      if (!candles || candles.length < 260) continue;
      const orderBook = await safe(() => getCryptoOrderBook(symbol), errors, `${symbol} spot orderbook`);
      for (const strategy of CRYPTO_STRATEGIES) {
        addCandidate({
          candidates,
          candles,
          strategy,
          interval,
          tradingCost: CONFIG.cryptoTradingCost,
          filters: evaluateFilters({ candles, benchmarkCandles: btc4h, orderBook }),
          asset: symbol,
          market: "虚拟货币现货"
        });
      }
    }
  }

  for (const symbol of selected.futuresAssets) {
    for (const interval of [...CONFIG.intervals, ...CONFIG.shortTermIntervals]) {
      const candles = await safe(() => getFuturesCandles(symbol, interval, 1000), errors, `${symbol} futures ${interval}`);
      if (!candles || candles.length < 260) continue;
      const funding = await safe(() => getFuturesFundingRate(symbol), errors, `${symbol} futures funding`);
      const openInterest = await safe(() => getFuturesOpenInterest(symbol), errors, `${symbol} futures open interest`);
      for (const strategy of FUTURES_STRATEGIES) {
        const direction = strategy.direction === "LONG" ? "做多观察" : "做空观察";
        addCandidate({
          candidates,
          candles,
          strategy,
          interval,
          tradingCost: CONFIG.futuresTradingCost,
          filters: evaluateFuturesFilters({ candles, benchmarkCandles: btc4h, funding, openInterest, direction }),
          asset: symbol,
          market: "USDT 永续合约",
          triggerSuffix: "合约信号只用于观察，需额外考虑保证金、资金费率和强平风险。"
        });
      }
    }
  }

  for (const symbol of selected.tradfiAssets) {
    const candles = await safe(() => getYahooCandles(symbol, "5y", "1d"), errors, `${symbol} yahoo`);
    if (!candles || candles.length < 260) continue;
    const benchmark = symbol === "SPY" ? candles : await safe(() => getYahooCandles("SPY", "5y", "1d"), errors, "SPY benchmark");
    for (const strategy of STRATEGIES) {
      addCandidate({
        candidates,
        candles,
        strategy,
        interval: "1d",
        tradingCost: CONFIG.equityTradingCost,
        filters: evaluateFilters({ candles, benchmarkCandles: benchmark, orderBook: null }),
        asset: symbol,
        market: CONFIG.commodityAssets.includes(symbol) ? "商品/能源代理" : "美股/ETF"
      });
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
    scan_group: group,
    candidates_count: candidates.length,
    signals_count: signals.length,
    emailed,
    errors
  });

  return { group, candidates: candidates.length, signals: signals.length, emailed, errors };
}

function addCandidate({ candidates, candles, strategy, interval, tradingCost, filters, asset, market, triggerSuffix = "" }) {
  const metrics = backtestStrategy(candles, strategy, interval, tradingCost);
  if (!metrics || metrics.trades < CONFIG.minTrades) return;

  const currentSignal = getCurrentSignal(candles, strategy);
  if (!currentSignal) return;

  const recommendationScore = scoreCandidate({ metrics, filters });
  if (recommendationScore < CONFIG.minRecommendationScore) return;

  candidates.push(buildSignal({
    asset,
    market,
    interval,
    strategy,
    metrics,
    filters,
    recommendationScore,
    currentSignal,
    triggerSuffix
  }));
}

function buildSignal({ asset, market, interval, strategy, metrics, filters, recommendationScore, currentSignal, triggerSuffix = "" }) {
  const signalKey = `${asset}:${market}:${interval}:${strategy.id}:${currentSignal.candle.openTime}`;
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
    triggerReason: `最新已收盘 ${interval} K 线满足「${strategy.name}」，上一根 K 线不满足，因此属于新信号。${triggerSuffix ? ` ${triggerSuffix}` : ""}`,
    invalidCondition: strategy.id.includes("donchian")
      ? "收盘价跌回突破/跌破位内侧，或大盘/自身趋势过滤转弱。"
      : strategy.direction === "SHORT"
        ? "收盘价重新站回关键均线上方，或空头趋势条件失效。"
        : "收盘价跌回关键均线下方，或 SMA50 不再高于 SMA200。"
  };
}

function selectScanTargets(group) {
  if (group === "crypto-core") return { cryptoAssets: CONFIG.scanGroups["crypto-core"], futuresAssets: [], tradfiAssets: [] };
  if (group === "crypto-alt") return { cryptoAssets: CONFIG.scanGroups["crypto-alt"], futuresAssets: [], tradfiAssets: [] };
  if (group === "futures-core") return { cryptoAssets: [], futuresAssets: CONFIG.scanGroups["futures-core"], tradfiAssets: [] };
  if (group === "tradfi") return { cryptoAssets: [], futuresAssets: [], tradfiAssets: CONFIG.scanGroups.tradfi };
  return {
    cryptoAssets: CONFIG.cryptoAssets,
    futuresAssets: CONFIG.futuresAssets,
    tradfiAssets: [...CONFIG.equityAssets, ...CONFIG.commodityAssets]
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
