import { CONFIG, intervalHours } from "./config.js";
import { sendEmail } from "./email.js";
import {
  getCryptoCandles,
  getCryptoOrderBook,
  getFuturesCandles,
  getFuturesFundingRate,
  getFuturesLongShortContext,
  getFuturesOpenInterest,
  getFuturesPremiumIndex,
  getSpot24hTickers
} from "./market-data.js";
import { renderSignalEmail } from "./report.js";
import { reviewAlertWithCandles, reviewArbitrageAlert } from "./alert-review.js";
import {
  backtestStrategy,
  CRYPTO_STRATEGIES,
  evaluateFilters,
  evaluateFuturesFilters,
  FUTURES_STRATEGIES,
  getCurrentSignal,
  scoreCandidateDetailed
} from "./strategies.js";
import {
  fetchSentAlertsForReview,
  hasProcessedScanCandle,
  hasSentSignal,
  recordProcessedScanCandle,
  recordRunLog,
  recordSentSignal,
  updateSentAlertPayload
} from "./storage.js";
import { atr } from "./indicators.js";

export async function runSignalScan({ dryRun = false, group = "all", sendEmailNow = true, includeSignals = false } = {}) {
  const startedAt = new Date().toISOString();
  const candidates = [];
  const errors = [];
  const warnings = [];
  const processedCandles = [];
  const selected = selectScanTargets(group);
  const dynamicSpotAssets = await loadDynamicSpotAssets({ group, selected, warnings });
  const dynamicWeakSpotAssets = await loadDynamicWeakSpotAssets({ group, selected, dynamicSpotAssets, warnings });
  let emailStatus = dryRun ? "dry_run" : "not_sent";
  let emailResult = null;
  let sentAlertKeys = [];
  const sentAlerts = await safe(
    () => fetchSentAlertsForReview(CONFIG.livePerformanceLookback),
    errors,
    "sent alerts review lookup"
  ) ?? [];
  if (!dryRun && shouldReviewRecentAlerts(group)) await reviewRecentSentAlerts({ sentAlerts, warnings });

  const needsCryptoBenchmark = selected.cryptoAssets.length || selected.futuresAssets.length || dynamicSpotAssets.length || dynamicWeakSpotAssets.length;
  const btc4h = needsCryptoBenchmark
    ? await safeMarket(() => getCryptoCandles("BTCUSDT", "4h", 1000), warnings, "BTCUSDT benchmark")
    : null;

  await mapLimit(selected.cryptoAssets, CONFIG.marketDataConcurrency, (symbol) => scanCryptoSymbol({ group, symbol, candidates, warnings, processedCandles, btc4h, sentAlerts, intervals: selected.cryptoIntervals }));
  await mapLimit(dynamicSpotAssets, CONFIG.marketDataConcurrency, (symbol) => scanDynamicSpotSymbol({ group, symbol, candidates, warnings, processedCandles, btc4h, sentAlerts }));
  await mapLimit(dynamicWeakSpotAssets, CONFIG.marketDataConcurrency, (symbol) => scanDynamicWeakSpotSymbol({ group, symbol, candidates, warnings, processedCandles, btc4h, sentAlerts }));
  await mapLimit(selected.futuresAssets, CONFIG.marketDataConcurrency, (symbol) => scanFuturesSymbol({ group, symbol, candidates, warnings, processedCandles, btc4h, sentAlerts, intervals: selected.futuresIntervals }));
  await mapLimit(selected.arbitrageAssets, CONFIG.marketDataConcurrency, (symbol) => scanFuturesArbitrageSymbol({ symbol, candidates, warnings }));

  let signals = [];
  for (const signal of candidates.sort((a, b) => b.recommendationScore - a.recommendationScore).slice(0, CONFIG.maxSignalsPerEmail)) {
    const alreadySent = await safe(() => hasSentSignal(signal.signalKey), errors, `sent alert lookup ${signal.signalKey}`);
    if (alreadySent === null) {
      emailStatus = "blocked_by_dedupe_error";
      continue;
    }
    if (!alreadySent) signals.push(signal);
  }

  if (signals.length && !dryRun && sendEmailNow) {
    signals = await guardSignalsByCurrentPrice({ signals, warnings });
  }

  let emailed = false;
  if (signals.length && !dryRun && sendEmailNow) {
    try {
      const email = renderSignalEmail(signals);
      const sent = await sendEmail(email);
      if (sent?.skipped) {
        emailStatus = `skipped:${sent.reason}`;
        emailResult = summarizeEmailResult(sent);
      } else {
        await Promise.all(signals.map((signal) => recordSentSignal({
          signal_key: signal.signalKey,
          asset: signal.asset,
          strategy_id: signal.strategyId,
          interval: signal.interval,
          trigger_time: new Date(signal.triggerTime).toISOString(),
          recommendation_score: signal.recommendationScore,
          payload: signal
        })));
        sentAlertKeys = signals.map((signal) => signal.signalKey);
        emailResult = summarizeEmailResult(sent);
        emailed = true;
        emailStatus = "sent";
      }
    } catch (error) {
      emailStatus = "failed";
      errors.push({ label: "email or sent_alerts write", error: error instanceof Error ? error.message : String(error) });
    }
  } else if (signals.length && !dryRun && !sendEmailNow) {
    emailStatus = "batched_pending";
  } else if (!signals.length) {
    emailStatus = dryRun ? "dry_run_no_signals" : emailStatus === "blocked_by_dedupe_error" ? emailStatus : "no_signals";
  }

  if (shouldCommitProcessedCandles({ dryRun, sendEmailNow, signals, emailed })) {
    await recordProcessedScanCandles({ processedCandles, warnings });
  }

  await recordRunLog({
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    scan_group: group,
    candidates_count: candidates.length,
    signals_count: signals.length,
    emailed,
    email_status: emailStatus,
    email_result: emailResult,
    sent_alert_keys: sentAlertKeys,
    errors,
    warnings
  });

  const result = { group, candidates: candidates.length, signals: signals.length, emailed, emailStatus, sentAlertKeys, errors, warnings };
  if (includeSignals) result.signalPayloads = signals;
  if (includeSignals) result.processedCandles = processedCandles;
  return result;
}

export async function runSignalBatch({ dryRun = false, groups = [] } = {}) {
  const startedAt = new Date().toISOString();
  const normalizedGroups = [...new Set(groups.filter(Boolean))];
  if (!normalizedGroups.length) return runSignalScan({ dryRun, group: "all" });

  const runs = [];
  const errors = [];
  const warnings = [];
  const processedCandles = [];
  const signalsByKey = new Map();
  await mapLimit(normalizedGroups, CONFIG.batchGroupConcurrency, async (group) => {
    const result = await runSignalScan({ dryRun, group, sendEmailNow: false, includeSignals: true });
    runs.push(stripSignalPayloads(result));
    errors.push(...(result.errors || []));
    warnings.push(...(result.warnings || []));
    processedCandles.push(...(result.processedCandles || []));
    for (const signal of result.signalPayloads || []) {
      if (!signalsByKey.has(signal.signalKey)) signalsByKey.set(signal.signalKey, signal);
    }
  });

  let signals = [...signalsByKey.values()]
    .sort((a, b) => b.recommendationScore - a.recommendationScore)
    .slice(0, CONFIG.maxSignalsPerEmail);
  let emailed = false;
  let emailStatus = dryRun ? "dry_run" : "not_sent";
  let emailResult = null;
  let sentAlertKeys = [];

  if (signals.length && !dryRun) {
    signals = await guardSignalsByCurrentPrice({ signals, warnings });
  }

  if (signals.length && !dryRun) {
    try {
      const email = renderSignalEmail(signals);
      const sent = await sendEmail(email);
      if (sent?.skipped) {
        emailStatus = `skipped:${sent.reason}`;
        emailResult = summarizeEmailResult(sent);
      } else {
        await Promise.all(signals.map((signal) => recordSentSignal({
          signal_key: signal.signalKey,
          asset: signal.asset,
          strategy_id: signal.strategyId,
          interval: signal.interval,
          trigger_time: new Date(signal.triggerTime).toISOString(),
          recommendation_score: signal.recommendationScore,
          payload: signal
        })));
        sentAlertKeys = signals.map((signal) => signal.signalKey);
        emailResult = summarizeEmailResult(sent);
        emailed = true;
        emailStatus = "sent";
      }
    } catch (error) {
      emailStatus = "failed";
      errors.push({ label: "batch email or sent_alerts write", error: error instanceof Error ? error.message : String(error) });
    }
  } else if (!signals.length) {
    emailStatus = dryRun ? "dry_run_no_signals" : "no_signals";
  }

  if (shouldCommitProcessedCandles({ dryRun, sendEmailNow: true, signals, emailed })) {
    await recordProcessedScanCandles({ processedCandles, warnings });
  }

  await recordRunLog({
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    scan_group: `batch:${normalizedGroups.join(",")}`,
    candidates_count: runs.reduce((sum, run) => sum + run.candidates, 0),
    signals_count: signals.length,
    emailed,
    email_status: emailStatus,
    email_result: emailResult,
    sent_alert_keys: sentAlertKeys,
    errors,
    warnings
  });

  return {
    group: "batch",
    groups: normalizedGroups,
    candidates: runs.reduce((sum, run) => sum + run.candidates, 0),
    signals: signals.length,
    emailed,
    emailStatus,
    sentAlertKeys,
    runs,
    errors,
    warnings
  };
}

function stripSignalPayloads(result) {
  const { signalPayloads, processedCandles, ...rest } = result;
  return rest;
}

async function guardSignalsByCurrentPrice({ signals, warnings }) {
  if (!CONFIG.maxSignalCurrentPriceDriftPct || CONFIG.maxSignalCurrentPriceDriftPct <= 0) return signals;
  const currentPrices = await loadCurrentPricesForSignals({ signals, warnings });
  return filterSignalsByCurrentPrice({
    signals,
    currentPrices,
    maxDriftPct: CONFIG.maxSignalCurrentPriceDriftPct,
    warnings
  });
}

async function loadCurrentPricesForSignals({ signals, warnings }) {
  const currentPrices = new Map();
  const spotSignals = signals.filter((signal) => shouldCheckCurrentPrice(signal) && !isFuturesPriceSignal(signal));
  const futuresSignals = signals.filter((signal) => shouldCheckCurrentPrice(signal) && isFuturesPriceSignal(signal));

  if (spotSignals.length) {
    const tickers = await safeMarket(() => getSpot24hTickers(), warnings, "spot current prices");
    const needed = new Set(spotSignals.map((signal) => signal.asset));
    for (const ticker of tickers || []) {
      if (needed.has(ticker.symbol) && Number.isFinite(ticker.lastPrice)) {
        currentPrices.set(ticker.symbol, ticker.lastPrice);
      }
    }
  }

  await mapLimit([...new Set(futuresSignals.map((signal) => signal.asset))], CONFIG.marketDataConcurrency, async (symbol) => {
    const premium = await safeMarket(() => getFuturesPremiumIndex(symbol), warnings, `${symbol} futures current price`);
    const price = Number(premium?.markPrice);
    if (Number.isFinite(price) && price > 0) currentPrices.set(symbol, price);
  });

  return currentPrices;
}

export function filterSignalsByCurrentPrice({ signals, currentPrices, maxDriftPct, warnings = [] }) {
  if (!maxDriftPct || maxDriftPct <= 0) return signals;
  return signals.filter((signal) => {
    if (!shouldCheckCurrentPrice(signal)) return true;
    const reference = signalReferencePrice(signal);
    if (!Number.isFinite(reference) || reference <= 0) return true;

    const current = Number(currentPrices.get(signal.asset));
    if (!Number.isFinite(current) || current <= 0) {
      warnings.push({
        label: `${signal.asset} current price guard`,
        warning: "current price unavailable; kept signal"
      });
      return true;
    }

    const drift = Math.abs(current / reference - 1);
    if (drift <= maxDriftPct) return true;

    warnings.push({
      label: `${signal.asset} current price guard`,
      warning: `dropped signal: current ${formatNumber(current)} differs from reference ${formatNumber(reference)} by ${formatPct(drift)}`
    });
    return false;
  });
}

function shouldCheckCurrentPrice(signal) {
  return signal?.kind !== "futures_arbitrage";
}

function isFuturesPriceSignal(signal) {
  return String(signal?.strategyId || "").startsWith("futures_") || String(signal?.market || "").toLowerCase().includes("futures");
}

function signalReferencePrice(signal) {
  return Number(signal?.executionPlan?.entryReference ?? signal?.close);
}

async function scanCryptoSymbol({ group, symbol, candidates, warnings, processedCandles, btc4h, sentAlerts, intervals }) {
  let orderBook;
  for (const interval of intervals) {
    const candles = await safeMarket(() => getCryptoCandles(symbol, interval, 1000), warnings, `${symbol} spot ${interval}`);
    if (!candles || candles.length < 260) continue;
    const processed = await processedScanCandleState({ group, asset: symbol, interval, candles, warnings });
    if (processed.skip) continue;
    orderBook ??= await safeMarket(() => getCryptoOrderBook(symbol), warnings, `${symbol} spot orderbook`);
    for (const strategy of CRYPTO_STRATEGIES) {
      addCandidate({
        candidates,
        candles,
        strategy,
        interval,
        tradingCost: CONFIG.cryptoTradingCost,
        filters: evaluateFilters({ candles, benchmarkCandles: btc4h, orderBook }),
        asset: symbol,
        market: "虚拟货币现货",
        sentAlerts
      });
    }
    processedCandles.push({ scanGroup: group, asset: symbol, interval, candleOpenTime: processed.candleOpenTime });
  }
}

async function scanDynamicSpotSymbol({ group, symbol, candidates, warnings, processedCandles, btc4h, sentAlerts }) {
  const candles = await safeMarket(() => getCryptoCandles(symbol, "1h", 200), warnings, `${symbol} dynamic spot 1h`);
  if (!candles || candles.length < 50) return;
  const processed = await processedScanCandleState({ group, asset: symbol, interval: "1h", candles, warnings });
  if (processed.skip) return;
  const orderBook = await safeMarket(() => getCryptoOrderBook(symbol), warnings, `${symbol} dynamic spot orderbook`);

  const latestIndex = candles.length - 2;
  const latest = candles[latestIndex];
  const prev24Index = Math.max(0, latestIndex - 24);
  const highs = candles.map((candle) => candle.high);
  const volumes = candles.map((candle) => candle.volume);
  const recentHigh = Math.max(...highs.slice(Math.max(0, latestIndex - 20), latestIndex));
  const volume20 = average(volumes.slice(Math.max(0, latestIndex - 20), latestIndex));
  const momentum24h = latest.close / candles[prev24Index].close - 1;
  const volumeMultiple = volume20 > 0 ? latest.volume / volume20 : null;
  const breakout = latest.close >= recentHigh * 0.995;
  const benchmarkChange24h = benchmarkMomentum24h(btc4h);
  const relativeStrength = Number.isFinite(benchmarkChange24h) ? momentum24h - benchmarkChange24h : momentum24h;

  if (
    momentum24h < CONFIG.relativeStrengthMinMomentum24h ||
    !breakout ||
    !Number.isFinite(volumeMultiple) ||
    volumeMultiple < CONFIG.relativeStrengthMinVolumeMultiple
  ) {
    return;
  }

  const livePerformance = summarizeLiveAlertPerformance({
    sentAlerts,
    candles,
    asset: symbol,
    strategy: { id: "dynamic_relative_strength_breakout", direction: "LONG", holdHours: 8 },
    interval: "1h",
    tradingCost: CONFIG.cryptoTradingCost
  });
  const cooldown = isDynamicSpotCoolingDown({ sentAlerts, asset: symbol, triggerTime: latest.openTime });
  if (cooldown.active) return;
  if (livePerformance.trades >= CONFIG.minLiveTradesForPenalty && livePerformance.totalReturn < CONFIG.livePerformanceMinReturn) return;

  const score = clampScore(
    62 +
      Math.min(12, momentum24h * 100) +
      Math.min(8, relativeStrength * 100) +
      Math.min(8, (volumeMultiple - 1) * 4) +
      (orderBook ? 4 : 0)
  );
  if (score < CONFIG.minRecommendationScore) return;

  const signalKey = `${symbol}:DYNAMIC_SPOT:1h:dynamic_relative_strength_breakout:${latest.openTime}`;
  candidates.push({
    signalKey,
    asset: symbol,
    market: "虚拟货币现货（动态强势池）",
    interval: "1h",
    strategyId: "dynamic_relative_strength_breakout",
    strategyName: "动态强势币放量突破",
    direction: "做多观察",
    triggerTime: latest.openTime,
    validUntil: latest.openTime + 4 * 3600 * 1000,
    close: latest.close,
    details: {
      close: latest.close,
      momentum24h,
      benchmarkMomentum24h: benchmarkChange24h,
      relativeStrength,
      volumeMultiple,
      recentHigh
    },
    metrics: {
      trades: 0,
      winRate: null,
      totalReturn: momentum24h,
      cagr: 0,
      profitFactor: null,
      maxDrawdown: null,
      years: 0,
      sampleStart: candles[0].openTime,
      sampleEnd: latest.openTime,
      recent: null
    },
    livePerformance,
    gateNotes: ["动态强势池：历史样本可能不足，只作为短线观察，不作为高置信交易信号"],
    scoringBreakdown: {
      outOfSample: 6,
      environment: 16,
      livePerformance: livePerformance.trades ? 12 : 10,
      risk: 8,
      costLiquidity: orderBook ? 8 : 5,
      capitalEfficiency: 4
    },
    filters: {
      score: 18,
      liquidityScore: orderBook ? 10 : 7,
      checks: [
        ["24小时涨幅", "通过", `约 ${formatPct(momentum24h)}`],
        ["相对 BTC", relativeStrength > 0 ? "通过" : "一般", `相对强弱约 ${formatPct(relativeStrength)}`],
        ["放量", "通过", `约为 20 小时均量的 ${volumeMultiple.toFixed(2)} 倍`],
        ["突破", "通过", "价格接近或突破最近 20 小时高点"],
        ["流动性", orderBook ? "通过" : "一般", orderBook ? "订单簿可获取" : "未获取订单簿"]
      ]
    },
    rawScore: score,
    recommendationScore: score,
    alertTier: "watch",
    alertTierLabel: "观察级",
    opportunityScore: score,
    riskScore: 55,
    tierReason: "动态强势池只提示短线观察，不作为直接交易指令。",
    triggerReason: "该资产进入动态强势池，并在 1h 级别出现放量相对强势突破。",
    invalidCondition: "如果 4 小时内不能继续强于 BTC，或跌回突破前区间，应视为失效。"
  });
  processedCandles.push({ scanGroup: group, asset: symbol, interval: "1h", candleOpenTime: processed.candleOpenTime });
}

async function scanDynamicWeakSpotSymbol({ group, symbol, candidates, warnings, processedCandles, btc4h, sentAlerts }) {
  const candles = await safeMarket(() => getCryptoCandles(symbol, "1h", 200), warnings, `${symbol} dynamic weak spot 1h`);
  if (!candles || candles.length < 50) return;
  const processed = await processedScanCandleState({ group, asset: symbol, interval: "1h", candles, warnings });
  if (processed.skip) return;
  const orderBook = await safeMarket(() => getCryptoOrderBook(symbol), warnings, `${symbol} dynamic weak spot orderbook`);

  const latestIndex = candles.length - 2;
  const latest = candles[latestIndex];
  const prev24Index = Math.max(0, latestIndex - 24);
  const lows = candles.map((candle) => candle.low);
  const volumes = candles.map((candle) => candle.volume);
  const recentLow = Math.min(...lows.slice(Math.max(0, latestIndex - 20), latestIndex));
  const volume20 = average(volumes.slice(Math.max(0, latestIndex - 20), latestIndex));
  const momentum24h = latest.close / candles[prev24Index].close - 1;
  const volumeMultiple = volume20 > 0 ? latest.volume / volume20 : null;
  const breakdown = latest.close <= recentLow * 1.005;
  const benchmarkChange24h = benchmarkMomentum24h(btc4h);
  const relativeWeakness = Number.isFinite(benchmarkChange24h) ? momentum24h - benchmarkChange24h : momentum24h;

  if (
    momentum24h > CONFIG.relativeWeaknessMaxMomentum24h ||
    relativeWeakness > CONFIG.relativeWeaknessMaxRelativeStrength24h ||
    !breakdown ||
    !Number.isFinite(volumeMultiple) ||
    volumeMultiple < CONFIG.relativeWeaknessMinVolumeMultiple
  ) {
    return;
  }

  const strategy = { id: "dynamic_relative_weakness_breakdown", direction: "SHORT", holdHours: 8 };
  const livePerformance = summarizeLiveAlertPerformance({
    sentAlerts,
    candles,
    asset: symbol,
    strategy,
    interval: "1h",
    tradingCost: CONFIG.cryptoTradingCost
  });
  const cooldown = isDynamicStrategyCoolingDown({
    sentAlerts,
    asset: symbol,
    strategyId: strategy.id,
    interval: "1h",
    triggerTime: latest.openTime
  });
  if (cooldown.active) return;
  if (livePerformance.trades >= CONFIG.minLiveTradesForPenalty && livePerformance.totalReturn < CONFIG.livePerformanceMinReturn) return;

  const score = clampScore(
    62 +
      Math.min(12, Math.abs(momentum24h) * 100) +
      Math.min(8, Math.abs(relativeWeakness) * 100) +
      Math.min(8, (volumeMultiple - 1) * 4) +
      (orderBook ? 4 : 0)
  );
  if (score < CONFIG.minRecommendationScore) return;

  const signalKey = `${symbol}:DYNAMIC_WEAK_SPOT:1h:${strategy.id}:${latest.openTime}`;
  candidates.push({
    signalKey,
    asset: symbol,
    market: "虚拟货币现货（动态弱势池）",
    interval: "1h",
    strategyId: strategy.id,
    strategyName: "动态弱势币放量跌破",
    direction: "做空观察",
    triggerTime: latest.openTime,
    validUntil: latest.openTime + 4 * 3600 * 1000,
    close: latest.close,
    details: {
      close: latest.close,
      momentum24h,
      benchmarkMomentum24h: benchmarkChange24h,
      relativeWeakness,
      volumeMultiple,
      recentLow
    },
    metrics: {
      trades: 0,
      winRate: null,
      totalReturn: -momentum24h,
      cagr: 0,
      profitFactor: null,
      maxDrawdown: null,
      years: 0,
      sampleStart: candles[0].openTime,
      sampleEnd: latest.openTime,
      recent: null
    },
    livePerformance,
    gateNotes: ["动态弱势池：用现货弱势发现可做空观察标的，只作为短线观察，不作为高置信交易信号"],
    scoringBreakdown: {
      outOfSample: 6,
      environment: 16,
      livePerformance: livePerformance.trades ? 12 : 10,
      risk: 8,
      costLiquidity: orderBook ? 8 : 5,
      capitalEfficiency: 4
    },
    filters: {
      score: 18,
      liquidityScore: orderBook ? 10 : 7,
      checks: [
        ["24小时跌幅", "通过", `约 ${formatPct(momentum24h)}`],
        ["相对 BTC", relativeWeakness < 0 ? "通过" : "一般", `相对弱势约 ${formatPct(relativeWeakness)}`],
        ["放量", "通过", `约为 20 小时均量的 ${volumeMultiple.toFixed(2)} 倍`],
        ["跌破", "通过", "价格接近或跌破最近 20 小时低点"],
        ["流动性", orderBook ? "通过" : "一般", orderBook ? "订单簿可获取" : "未获取订单簿"]
      ]
    },
    rawScore: score,
    recommendationScore: score,
    alertTier: "watch",
    alertTierLabel: "观察级",
    opportunityScore: score,
    riskScore: 60,
    tierReason: "动态弱势池只提示短线做空观察，不作为直接交易指令。",
    triggerReason: "该资产进入动态弱势池，并在 1h 级别出现放量相对弱势跌破。",
    invalidCondition: "如果 4 小时内不能继续弱于 BTC，或重新站回跌破前区间，应视为失效。"
  });
  processedCandles.push({ scanGroup: group, asset: symbol, interval: "1h", candleOpenTime: processed.candleOpenTime });
}

async function scanFuturesSymbol({ group, symbol, candidates, warnings, processedCandles, btc4h, sentAlerts, intervals }) {
  let futuresContext;
  for (const interval of intervals) {
    const candleLimit = CONFIG.futuresScalpIntervals.includes(interval) ? 1500 : 1000;
    const candles = await safeMarket(() => getFuturesCandles(symbol, interval, candleLimit), warnings, `${symbol} futures ${interval}`);
    if (!candles || candles.length < 260) continue;
    const processed = await processedScanCandleState({ group, asset: symbol, interval, candles, warnings });
    if (processed.skip) continue;
    futuresContext ??= await loadFuturesContext(symbol, warnings);
    for (const strategy of FUTURES_STRATEGIES) {
      const direction = strategy.direction === "LONG" ? "做多观察" : "做空观察";
      addCandidate({
        candidates,
        candles,
        strategy,
        interval,
        tradingCost: CONFIG.futuresTradingCost,
        filters: evaluateFuturesFilters({ candles, benchmarkCandles: btc4h, ...futuresContext, direction }),
        asset: symbol,
        market: "USDT 永续合约",
        triggerSuffix: "合约信号只用于观察，需要额外考虑保证金、资金费率、杠杆和强平风险。",
        sentAlerts
      });
    }
    processedCandles.push({ scanGroup: group, asset: symbol, interval, candleOpenTime: processed.candleOpenTime });
  }
}

async function loadFuturesContext(symbol, warnings) {
  const [funding, openInterest, sentiment] = await Promise.all([
    safeMarket(() => getFuturesFundingRate(symbol), warnings, `${symbol} futures funding`),
    safeMarket(() => getFuturesOpenInterest(symbol), warnings, `${symbol} futures open interest`),
    safeMarket(() => getFuturesLongShortContext(symbol, "1h"), warnings, `${symbol} futures long-short context`)
  ]);
  return { funding, openInterest, sentiment };
}

async function scanFuturesArbitrageSymbol({ symbol, candidates, warnings }) {
  const [funding, premium] = await Promise.all([
    safeMarket(() => getFuturesFundingRate(symbol), warnings, `${symbol} arbitrage funding`),
    safeMarket(() => getFuturesPremiumIndex(symbol), warnings, `${symbol} premium index`)
  ]);
  const rate = Number.isFinite(premium?.lastFundingRate) ? premium.lastFundingRate : funding?.fundingRate;
  if (!Number.isFinite(rate)) {
    warnings.push({
      label: `${symbol} arbitrage rate`,
      warning: "未获取到 fundingRate/premiumIndex，无法评估合约套利窗口"
    });
    return;
  }

  const absRate = Math.abs(rate);
  const annualizedFunding = rate * 3 * 365;
  const annualizedMagnitude = Math.abs(annualizedFunding);
  if (annualizedMagnitude < CONFIG.arbitrageAnnualizedThreshold) return;

  const dailyFunding = absRate * 3;
  const breakEvenDays = dailyFunding > 0 ? CONFIG.arbitrageTradingCost / dailyFunding : Infinity;
  const estimatedNetDaily = dailyFunding - (CONFIG.arbitrageTradingCost / Math.max(1, CONFIG.arbitrageStrongMaxBreakEvenDays));
  if (breakEvenDays > CONFIG.arbitrageStrongMaxBreakEvenDays && estimatedNetDaily < CONFIG.arbitrageMinNetDailyAfterCost) return;

  const markPrice = premium?.markPrice;
  const indexPrice = premium?.indexPrice;
  const basis = Number.isFinite(markPrice) && Number.isFinite(indexPrice) && indexPrice
    ? markPrice / indexPrice - 1
    : null;
  const nextFundingTime = premium?.nextFundingTime || funding?.fundingTime || Date.now();
  const score = scoreArbitrage({ absRate, breakEvenDays, basis });

  candidates.push({
    kind: "futures_arbitrage",
    signalKey: `${symbol}:USDT_PERP_ARBITRAGE:${Math.sign(rate)}:${nextFundingTime}`,
    asset: symbol,
    market: "USDT 永续合约套利观察",
    interval: "8h funding",
    strategyId: rate > 0 ? "perp_positive_funding_cash_carry" : "perp_negative_funding_reverse_cash_carry",
    strategyName: rate > 0 ? "正资金费率套利：买现货 / 卖永续" : "负资金费率套利：卖出现货或持有稳定币 / 买永续",
    direction: rate > 0 ? "收资金费：现货多 + 永续空" : "收资金费：永续多 + 现货侧对冲",
    triggerTime: Date.now(),
    validUntil: nextFundingTime,
    close: Number.isFinite(markPrice) ? markPrice : indexPrice,
    details: {
      fundingRate: rate,
      absFundingRate: absRate,
      annualizedFunding,
      annualizedMagnitude,
      estimatedDailyFunding: dailyFunding,
      estimatedNetDailyAfterCost: estimatedNetDaily,
      breakEvenDays,
      basis,
      markPrice,
      indexPrice,
      nextFundingTime
    },
    metrics: {
      trades: 1,
      winRate: null,
      totalReturn: dailyFunding,
      cagr: Math.abs(annualizedFunding),
      profitFactor: null,
      maxDrawdown: null,
      years: 0,
      sampleStart: Date.now(),
      sampleEnd: Date.now()
    },
    filters: {
      score: Math.min(25, Math.round(annualizedMagnitude / CONFIG.arbitrageAnnualizedThreshold * 12)),
      liquidityScore: CONFIG.futuresAssets.includes(symbol) ? 12 : 9,
      checks: buildArbitrageChecks({ rate, annualizedFunding, dailyFunding, breakEvenDays, basis, nextFundingTime })
    },
    recommendationScore: score,
    alertTier: score >= 80 ? "trade" : "watch",
    alertTierLabel: score >= 80 ? "交易级" : "观察级",
    opportunityScore: score,
    riskScore: breakEvenDays > CONFIG.arbitrageStrongMaxBreakEvenDays ? 65 : 48,
    tierReason: score >= 80 ? "资金费率套利窗口较强，但仍需核对两边成交和保证金风险。" : "套利窗口达到观察阈值，适合人工复核。",
    triggerReason: `当前资金费率达到 ${formatPct(rate)} / 8h，折合年化约 ${formatPct(annualizedFunding)}。该信号只提示资金费率套利窗口，不代表价格方向判断。`,
    invalidCondition: "下一次资金费结算后费率明显回落、价差快速反向扩大、现货/合约任一侧流动性不足，或预估回本天数超过阈值时失效。"
  });
}

function addCandidate({ candidates, candles, strategy, interval, tradingCost, filters, asset, market, triggerSuffix = "", sentAlerts = [], signalEnhancer = null }) {
  const currentSignal = getCurrentSignal(candles, strategy, interval);
  if (!currentSignal) return;

  const metrics = backtestStrategy(candles, strategy, interval, tradingCost);
  const minTrades = isFuturesScalpSignal({ market, interval, strategy })
    ? CONFIG.futuresScalpMinTrades
    : CONFIG.minTrades;
  if (!metrics || metrics.trades < minTrades) return;

  const livePerformance = summarizeLiveAlertPerformance({ sentAlerts, candles, asset, strategy, interval, tradingCost });
  const cooldown = summarizeCooldown({ sentAlerts, asset, strategy, interval, currentSignal });
  const gate = evaluateCandidateGate({ strategy, metrics, filters, livePerformance, cooldown, market, currentSignal });
  if (!gate.passed) return;

  const scoring = scoreCandidateDetailed({ metrics, filters, livePerformance, strategy, interval, tradingCost });
  const recommendationScore = clampScore(scoring.score + gate.scoreAdjustment);
  const tier = classifyAlertTier({
    recommendationScore,
    metrics,
    market,
    interval,
    strategy,
    tradingCost,
    scoring,
    filters,
    currentSignal
  });
  if (!tier) return;

  const signal = buildSignal({
    asset,
    market,
    interval,
    strategy,
    metrics,
    filters,
    recommendationScore,
    currentSignal,
    triggerSuffix,
    livePerformance,
    gateNotes: [...gate.notes, ...scoring.hardVetoes.map((veto) => `硬性风控提示：${veto}`)],
    scoringBreakdown: scoring.breakdown,
    alertTier: tier.id,
    alertTierLabel: tier.label,
    opportunityScore: tier.opportunityScore,
    riskScore: tier.riskScore,
    tierReason: tier.reason
  });
  signal.gateNotes = [...(signal.gateNotes || []), ...tier.notes];
  const futuresContext = filters?.futuresContext || {};
  const enrichedSignal = typeof signalEnhancer === "function"
    ? signalEnhancer(signal, { candles, currentSignal, strategy, interval, metrics, filters })
    : isFuturesSignal({ market })
      ? enhanceFuturesSignal(signal, { candles, currentSignal, strategy, interval, metrics, filters, ...futuresContext })
      : signal;
  candidates.push(enrichedSignal);
}

function buildSignal({ asset, market, interval, strategy, metrics, filters, recommendationScore, currentSignal, triggerSuffix = "", livePerformance = null, gateNotes = [], scoringBreakdown = null, alertTier = "trade", alertTierLabel = "交易级", opportunityScore = null, riskScore = null, tierReason = "" }) {
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
    alertTier,
    alertTierLabel,
    opportunityScore: opportunityScore ?? recommendationScore,
    riskScore,
    tierReason,
    metrics,
    livePerformance,
    gateNotes,
    scoringBreakdown,
    filters,
    recommendationScore,
    triggerReason: `最新已收盘 ${interval} K 线满足“${strategy.name}”，上一根 K 线不满足，因此属于新信号。${triggerSuffix ? ` ${triggerSuffix}` : ""}`,
    invalidCondition: strategy.id.includes("donchian")
      ? "收盘价跌回突破/跌破位内侧，或大盘/自身趋势过滤转弱。"
      : strategy.direction === "SHORT"
        ? "收盘价重新站回关键均线上方，或空头趋势条件失效。"
        : "收盘价跌回关键均线下方，或 SMA50 不再高于 SMA200。"
  };
}

function classifyAlertTier({ recommendationScore, metrics, market, interval, strategy, tradingCost, scoring, filters, currentSignal }) {
  const riskScore = estimateRiskScore({ metrics, filters, market, interval, strategy });
  const hasOverride = isRelativeStrengthOverride(currentSignal);
  const hardVetoes = scoring?.hardVetoes || [];
  const severeVeto = hasSevereVeto(hardVetoes);

  const tradeEligible =
    (!hardVetoes.length || hasOverride) &&
    passesScoreFloor({ recommendationScore, metrics, market, interval, strategy, tradingCost });

  if (tradeEligible) {
    return {
      id: "trade",
      label: "交易级",
      opportunityScore: recommendationScore,
      riskScore,
      reason: "通过交易级过滤，仍需人工复核仓位和止损。",
      notes: []
    };
  }

  if (severeVeto) return null;

  const observationFloor = isFuturesScalpSignal({ market, interval, strategy })
    ? CONFIG.futuresScalpObservationMinRecommendationScore
    : CONFIG.observationMinRecommendationScore;

  if (recommendationScore >= observationFloor && passesObservationQuality({ metrics, market, interval, strategy, tradingCost })) {
    return {
      id: "watch",
      label: "观察级",
      opportunityScore: recommendationScore,
      riskScore,
      reason: "机会未达到交易级，只提醒你观察，不建议直接追单。",
      notes: ["分层提醒：观察级，先看行情和风险，不要当成下单指令。"]
    };
  }

  if (isFuturesSignal({ market }) && recommendationScore >= CONFIG.riskAlertMinRecommendationScore && hasRiskWarning(filters)) {
    return {
      id: "risk",
      label: "风险级",
      opportunityScore: recommendationScore,
      riskScore: Math.max(riskScore, 70),
      reason: "当前环境存在拥挤、资金费率或波动风险，只作为避险提醒。",
      notes: ["分层提醒：风险级，优先减少仓位或观望，不建议开新仓。"]
    };
  }

  return null;
}

function passesObservationQuality({ metrics, market, interval, strategy, tradingCost }) {
  const scalp = isFuturesScalpSignal({ market, interval, strategy });
  const maxDrawdownLimit = scalp ? 0.3 : 0.38;
  if (Math.abs(metrics.maxDrawdown ?? 0) > maxDrawdownLimit) return false;
  if (Number.isFinite(metrics.averageReturn) && Number.isFinite(tradingCost) && metrics.averageReturn < tradingCost * 0.5) return false;
  if (metrics?.recent?.trades >= CONFIG.minRecentTradesForPenalty && metrics.recent.totalReturn < CONFIG.minRecentReturnForStrongSignal * 1.5) return false;
  return true;
}

function hasSevereVeto(vetoes) {
  return vetoes.some((veto) => {
    const text = String(veto);
    return text.includes("样本不足") ||
      text.includes("真实表现偏弱") ||
      text.includes("期望收益不足") ||
      text.includes("鏍锋湰涓嶈冻") ||
      text.includes("鐪熷疄琛ㄧ幇鍋忓急") ||
      text.includes("鏈熸湜鏀剁泭");
  });
}

function hasRiskWarning(filters) {
  return Array.isArray(filters?.checks) && filters.checks.some((check) => {
    const status = String(check?.[1] || "");
    const text = check.map((part) => String(part || "")).join(" ");
    return status.includes("风险") ||
      status.includes("椋庨櫓") ||
      text.includes("拥挤") ||
      text.includes("拥挤") ||
      text.includes("嫢") ||
      text.includes("funding") ||
      text.includes("资金费率");
  });
}

function estimateRiskScore({ metrics, filters, market, interval, strategy }) {
  let score = isFuturesSignal({ market }) ? 45 : 30;
  if (Math.abs(metrics?.maxDrawdown ?? 0) > 0.2) score += 15;
  if ((metrics?.recent?.trades ?? 0) >= CONFIG.minRecentTradesForPenalty && (metrics.recent?.totalReturn ?? 0) < 0) score += 12;
  if (isFuturesScalpSignal({ market, interval, strategy })) score += 8;
  if (hasRiskWarning(filters)) score += 15;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function isFuturesSignal({ market }) {
  return String(market || "").includes("USDT") || String(market || "").includes("合约") || String(market || "").includes("鍚堢害");
}

function enhanceFuturesSignal(signal, { candles, strategy, interval, funding, openInterest, sentiment }) {
  const latestIndex = candles.length - 2;
  const latest = candles[latestIndex];
  const latestAtr = atr(candles, 14, latestIndex);
  const fallbackStopDistance = latest.close * 0.018;
  const stopDistance = Number.isFinite(latestAtr)
    ? Math.max(latestAtr * CONFIG.futuresStopAtrMultiplier, latest.close * 0.006)
    : fallbackStopDistance;
  const isShort = strategy.direction === "SHORT";
  const stopLoss = isShort ? latest.close + stopDistance : latest.close - stopDistance;
  const takeProfit = isShort
    ? latest.close - stopDistance * CONFIG.futuresRewardRiskRatio
    : latest.close + stopDistance * CONFIG.futuresRewardRiskRatio;
  const stopPct = Math.abs(stopDistance / latest.close);
  const leverageCapByStop = stopPct > 0
    ? Math.max(1, Math.floor(CONFIG.futuresMaxLeveragedStopPct / stopPct))
    : 1;
  const suggestedLeverage = Math.max(1, Math.min(CONFIG.futuresMaxSuggestedLeverage, leverageCapByStop));
  const maxPositionPct = stopPct > 0
    ? Math.min(1, CONFIG.futuresMaxPositionRiskPct / stopPct)
    : 0;
  const fundingRate = Number.isFinite(funding?.fundingRate) ? funding.fundingRate : null;
  const accountRatio = sentiment?.accounts?.ratio ?? null;
  const topRatio = sentiment?.topPositions?.ratio ?? null;

  const simpleThesis = buildFuturesPlainThesis({ signal, isShort, fundingRate, accountRatio, topRatio });
  const executionPlan = {
    style: interval === "1h" ? "短线观察" : interval === "2h" || interval === "4h" ? "波段观察" : "慢周期观察",
    scanCadence: interval === "1h" ? "建议每 1 小时复核一次" : interval === "2h" || interval === "4h" ? "建议每 4 小时复核一次" : "建议每天复核一次",
    validFor: interval === "1h" ? "约 2-4 小时" : interval === "2h" ? "约 4-8 小时" : interval === "4h" ? "约 8-16 小时" : "约 1-3 天",
    entryReference: latest.close,
    stopLoss,
    takeProfit,
    stopPct,
    rewardRiskRatio: CONFIG.futuresRewardRiskRatio,
    suggestedLeverage,
    maxPositionPct,
    fundingRate,
    openInterest: Number.isFinite(openInterest?.openInterest) ? openInterest.openInterest : null,
    accountLongShortRatio: Number.isFinite(accountRatio) ? accountRatio : null,
    topTraderLongShortRatio: Number.isFinite(topRatio) ? topRatio : null,
    simpleThesis,
    plainInvalidCondition: isShort
      ? "如果价格重新站回提醒价上方并继续走强，或亏损接近止损位，就不要硬扛。"
      : "如果价格跌破止损参考位，或上涨很快失败回落，就不要继续追。"
  };

  return {
    ...signal,
    executionPlan,
    triggerReason: simpleThesis,
    invalidCondition: executionPlan.plainInvalidCondition
  };
}

function buildFuturesPlainThesis({ signal, isShort, fundingRate, accountRatio, topRatio }) {
  const side = isShort ? "偏空" : "偏多";
  const fundingText = Number.isFinite(fundingRate)
    ? fundingRate > 0.0008
      ? "资金费率偏热"
      : fundingRate < -0.0008
        ? "资金费率偏冷"
        : "资金费率不算极端"
    : "资金费率缺失";
  const crowdText = Number.isFinite(accountRatio)
    ? accountRatio > 2.2 || accountRatio < 0.45
      ? "市场有拥挤风险"
      : "市场拥挤度可接受"
    : "多空拥挤度缺失";
  const topText = Number.isFinite(topRatio)
    ? `大户多空比 ${topRatio.toFixed(2)}`
    : "大户倾向缺失";
  return `${signal.asset} 出现${side}合约观察信号，${fundingText}，${crowdText}，${topText}。`;
}

async function reviewRecentSentAlerts({ sentAlerts, warnings }) {
  const reviewable = sentAlerts
    .filter((alert) => shouldReviewAlert(alert))
    .slice(0, CONFIG.maxAlertReviewsPerRun);

  await mapLimit(reviewable, 2, async (alert) => {
    try {
      const payload = alert.payload || {};
      const review = payload.kind === "futures_arbitrage"
        ? reviewArbitrageAlert(alert)
        : reviewAlertWithCandles(alert, await fetchReviewCandles(alert));
      if (!shouldPersistReview(payload.review, review)) return;
      await updateSentAlertPayload(alert.signal_key, { ...payload, review });
    } catch (error) {
      warnings.push({
        label: `${alert.asset} alert review`,
        warning: error instanceof Error ? error.message : String(error)
      });
    }
  });
}

function shouldReviewAlert(alert) {
  const review = alert?.payload?.review;
  if (!review) return true;
  if (review.status !== "pending") return false;
  const reviewAfter = Number(review.reviewAfter);
  return !Number.isFinite(reviewAfter) || Date.now() >= reviewAfter;
}

async function fetchReviewCandles(alert) {
  const payload = alert.payload || {};
  const interval = alert.interval || payload.interval || "1h";
  const market = String(payload.market || "");
  if (market.includes("USDT") || market.includes("合约") || market.includes("鍚堢害")) {
    return getFuturesCandles(alert.asset, interval, 1000);
  }
  return getCryptoCandles(alert.asset, interval, 1000);
}

function shouldPersistReview(previous, next) {
  if (!next) return false;
  if (!previous) return true;
  if (previous.status !== next.status) return true;
  if (previous.outcome !== next.outcome) return true;
  if (previous.returnPct !== next.returnPct) return true;
  if (previous.reason !== next.reason) return true;
  return previous.reviewAfter !== next.reviewAfter;
}

function summarizeLiveAlertPerformance({ sentAlerts, candles, asset, strategy, interval, tradingCost }) {
  const relevant = sentAlerts
    .filter((alert) => alert.asset === asset && alert.strategy_id === strategy.id && alert.interval === interval)
    .sort((a, b) => new Date(a.trigger_time).getTime() - new Date(b.trigger_time).getTime());
  const holdMs = Math.max(1, Math.round(strategy.holdHours / intervalHours(interval))) * intervalHours(interval) * 3600 * 1000;
  const returns = [];
  for (const alert of relevant) {
    const entryTime = new Date(alert.trigger_time).getTime();
    if (!Number.isFinite(entryTime)) continue;
    const entry = Number(alert.payload?.close);
    const exit = candles.find((candle) => candle.openTime >= entryTime + holdMs);
    if (!Number.isFinite(entry) || !exit) continue;
    const directionMultiplier = strategy.direction === "SHORT" ? -1 : 1;
    returns.push((exit.close / entry - 1) * directionMultiplier - tradingCost);
  }
  if (!returns.length) return { trades: 0, winRate: null, totalReturn: 0, averageReturn: null };
  let equity = 1;
  let wins = 0;
  for (const value of returns) {
    if (value > 0) wins++;
    equity *= 1 + value;
  }
  return {
    trades: returns.length,
    winRate: wins / returns.length,
    totalReturn: equity - 1,
    averageReturn: returns.reduce((sum, value) => sum + value, 0) / returns.length
  };
}

function summarizeCooldown({ sentAlerts, asset, strategy, interval, currentSignal }) {
  const latest = sentAlerts
    .filter((alert) => alert.asset === asset && alert.strategy_id === strategy.id && alert.interval === interval)
    .map((alert) => new Date(alert.trigger_time).getTime())
    .filter((time) => Number.isFinite(time) && time < currentSignal.candle.openTime)
    .sort((a, b) => b - a)[0];
  const hoursSince = latest ? (currentSignal.candle.openTime - latest) / 3600000 : null;
  return {
    active: Number.isFinite(hoursSince) && hoursSince < CONFIG.assetSignalCooldownHours,
    hoursSince,
    cooldownHours: CONFIG.assetSignalCooldownHours
  };
}

export function isDynamicSpotCoolingDown({ sentAlerts, asset, triggerTime }) {
  return isDynamicStrategyCoolingDown({
    sentAlerts,
    asset,
    strategyId: "dynamic_relative_strength_breakout",
    interval: "1h",
    triggerTime
  });
}

function isDynamicStrategyCoolingDown({ sentAlerts, asset, strategyId, interval, triggerTime }) {
  const latest = sentAlerts
    .filter((alert) =>
      alert.asset === asset &&
      alert.strategy_id === strategyId &&
      alert.interval === interval
    )
    .map((alert) => new Date(alert.trigger_time).getTime())
    .filter((time) => Number.isFinite(time) && time < triggerTime)
    .sort((a, b) => b - a)[0];
  const hoursSince = latest ? (triggerTime - latest) / 3600000 : null;
  return {
    active: Number.isFinite(hoursSince) && hoursSince < CONFIG.assetSignalCooldownHours,
    hoursSince,
    cooldownHours: CONFIG.assetSignalCooldownHours
  };
}

export function shouldReviewRecentAlerts(group) {
  return group === "all" || group === "review" || String(group || "").includes("daily");
}

async function processedScanCandleState({ group, asset, interval, candles, warnings }) {
  const candle = latestClosedCandle(candles);
  const candleOpenTime = Number(candle?.openTime);
  if (!Number.isFinite(candleOpenTime)) return { skip: false, candleOpenTime: null };

  try {
    const skip = await hasProcessedScanCandle({ scanGroup: group, asset, interval, candleOpenTime });
    return { skip, candleOpenTime };
  } catch (error) {
    warnings.push({
      label: `${asset} ${interval} processed candle lookup`,
      warning: error instanceof Error ? error.message : String(error)
    });
    return { skip: false, candleOpenTime };
  }
}

function shouldCommitProcessedCandles({ dryRun, sendEmailNow, signals, emailed }) {
  if (dryRun || !sendEmailNow) return false;
  return signals.length === 0 || emailed;
}

async function recordProcessedScanCandles({ processedCandles, warnings }) {
  const seen = new Set();
  for (const candle of processedCandles) {
    if (!Number.isFinite(candle.candleOpenTime)) continue;
    const key = `${candle.scanGroup}|${candle.asset}|${candle.interval}|${candle.candleOpenTime}`;
    if (seen.has(key)) continue;
    seen.add(key);

    try {
      await recordProcessedScanCandle(candle);
    } catch (error) {
      warnings.push({
        label: `${candle.asset} ${candle.interval} processed candle record`,
        warning: error instanceof Error ? error.message : String(error)
      });
    }
  }
}

function latestClosedCandle(candles) {
  if (!Array.isArray(candles) || candles.length < 2) return null;
  return candles[candles.length - 2];
}

function evaluateCandidateGate({ strategy, metrics, filters, livePerformance, cooldown, market, currentSignal }) {
  const notes = [];
  let scoreAdjustment = 0;
  if (cooldown.active) {
    return {
      passed: false,
      scoreAdjustment,
      notes: [`同一资产/策略 ${cooldown.hoursSince.toFixed(1)} 小时前刚提醒，等待冷却`]
    };
  }

  if (livePerformance.trades >= CONFIG.minLiveTradesForPenalty) {
    if ((livePerformance.winRate ?? 0) < CONFIG.livePerformanceMinWinRate || livePerformance.totalReturn < CONFIG.livePerformanceMinReturn) {
      return {
        passed: false,
        scoreAdjustment,
        notes: [`最近真实提醒表现偏弱，胜率 ${formatPct(livePerformance.winRate)}，收益 ${formatPct(livePerformance.totalReturn)}`]
      };
    }
    if (livePerformance.winRate >= 0.6 && livePerformance.totalReturn > 0) {
      scoreAdjustment += 6;
      notes.push("最近真实提醒表现较好，适度加分");
    }
  }

  const recent = metrics.recent;
  if (recent?.trades >= CONFIG.minRecentTradesForPenalty) {
    const weakRecent = (recent.winRate ?? 0) < CONFIG.minRecentWinRateForStrongSignal || recent.totalReturn < CONFIG.minRecentReturnForStrongSignal;
    if (weakRecent && strategy.direction === "LONG" && !isRelativeStrengthOverride(currentSignal)) {
      return {
        passed: false,
        scoreAdjustment,
        notes: [`近期同类回测偏弱，胜率 ${formatPct(recent.winRate)}，收益 ${formatPct(recent.totalReturn)}`]
      };
    }
  }

  const benchmarkRisk = hasFilterStatus(filters, "大盘趋势", "风险");
  const canOverrideBenchmarkRisk = isRelativeStrengthOverride(currentSignal);
  if (
    CONFIG.cryptoLongRequiresBenchmarkTrend &&
    benchmarkRisk &&
    strategy.direction === "LONG" &&
    market.includes("虚拟货币") &&
    strategy.id.includes("short_term_momentum") &&
    !canOverrideBenchmarkRisk
  ) {
    return {
      passed: false,
      scoreAdjustment,
      notes: ["BTC 大盘趋势偏弱，暂停短线追涨信号"]
    };
  }

  if (benchmarkRisk && strategy.direction === "LONG") {
    scoreAdjustment += canOverrideBenchmarkRisk ? CONFIG.relativeStrengthScorePenalty : -8;
    notes.push(canOverrideBenchmarkRisk ? "大盘偏弱但自身放量强势，仅作为观察级通过" : "大盘趋势偏弱，降低推荐指数");
  }

  return { passed: true, scoreAdjustment, notes };
}

function isRelativeStrengthOverride(currentSignal) {
  if (!CONFIG.relativeStrengthOverride) return false;
  const details = currentSignal?.details || {};
  return (
    Number.isFinite(details.momentum24h) &&
    details.momentum24h >= CONFIG.relativeStrengthMinMomentum24h &&
    Number.isFinite(details.volumeMultiple) &&
    details.volumeMultiple >= CONFIG.relativeStrengthMinVolumeMultiple
  );
}

function isFuturesScalpSignal({ market, interval, strategy }) {
  return market.includes("USDT") && CONFIG.futuresScalpIntervals.includes(interval) && strategy.id.startsWith("futures_scalp_");
}

function passesScoreFloor({ recommendationScore, metrics, market, interval, strategy, tradingCost }) {
  if (!isFuturesScalpSignal({ market, interval, strategy })) {
    return recommendationScore >= CONFIG.minRecommendationScore;
  }

  if (recommendationScore < CONFIG.futuresScalpMinRecommendationScore) return false;
  if ((metrics.recent?.winRate ?? 0) < CONFIG.futuresScalpMinRecentWinRate && metrics.recent?.trades >= CONFIG.minRecentTradesForPenalty) return false;
  if (Number.isFinite(metrics.averageReturn) && metrics.averageReturn < Math.max(CONFIG.futuresScalpMinAverageReturn, tradingCost * 1.2)) return false;
  if (Math.abs(metrics.maxDrawdown ?? 0) > 0.22) return false;
  return true;
}

function hasFilterStatus(filters, labelPart, statusPart) {
  return Array.isArray(filters?.checks) && filters.checks.some((check) =>
    String(check?.[0] || "").includes(labelPart) && String(check?.[1] || "").includes(statusPart)
  );
}

function clampScore(value) {
  return Math.max(0, Math.min(100, Math.round(Number.isFinite(value) ? value : 0)));
}

async function loadDynamicSpotAssets({ group, selected, warnings }) {
  if (!CONFIG.dynamicSpotPoolEnabled || !["all", "dynamic-spot"].includes(group)) return [];
  const tickers = await safeMarket(() => getSpot24hTickers(), warnings, "dynamic spot ticker");
  if (!Array.isArray(tickers)) return [];
  const existing = new Set([
    ...selected.cryptoAssets,
    ...selected.futuresAssets,
    ...selected.arbitrageAssets
  ]);
  return tickers
    .filter((ticker) => isDynamicSpotCandidate(ticker, existing))
    .sort((a, b) => {
      const aScore = a.priceChangePercent * Math.log10(Math.max(10, a.quoteVolume));
      const bScore = b.priceChangePercent * Math.log10(Math.max(10, b.quoteVolume));
      return bScore - aScore;
    })
    .slice(0, CONFIG.dynamicSpotPoolMaxAssets)
    .map((ticker) => ticker.symbol);
}

async function loadDynamicWeakSpotAssets({ group, selected, dynamicSpotAssets, warnings }) {
  if (!CONFIG.dynamicWeakSpotPoolEnabled || !["all", "dynamic-weak-spot"].includes(group)) return [];
  const tickers = await safeMarket(() => getSpot24hTickers(), warnings, "dynamic weak spot ticker");
  if (!Array.isArray(tickers)) return [];
  const existing = new Set([
    ...selected.cryptoAssets,
    ...selected.futuresAssets,
    ...selected.arbitrageAssets,
    ...dynamicSpotAssets
  ]);
  return tickers
    .filter((ticker) => isDynamicWeakSpotCandidate(ticker, existing))
    .sort((a, b) => {
      const aScore = Math.abs(a.priceChangePercent) * Math.log10(Math.max(10, a.quoteVolume));
      const bScore = Math.abs(b.priceChangePercent) * Math.log10(Math.max(10, b.quoteVolume));
      return bScore - aScore;
    })
    .slice(0, CONFIG.dynamicWeakSpotPoolMaxAssets)
    .map((ticker) => ticker.symbol);
}

function isDynamicSpotCandidate(ticker, existing) {
  const symbol = ticker.symbol || "";
  if (!symbol.endsWith("USDT")) return false;
  if (existing.has(symbol)) return false;
  if (CONFIG.dynamicSpotPoolExcludedPatterns.some((pattern) => symbol.includes(pattern))) return false;
  if (!Number.isFinite(ticker.priceChangePercent) || ticker.priceChangePercent < CONFIG.dynamicSpotPoolMinPriceChangePercent) return false;
  if (!Number.isFinite(ticker.quoteVolume) || ticker.quoteVolume < CONFIG.dynamicSpotPoolMinQuoteVolume) return false;
  return true;
}

export function isDynamicWeakSpotCandidate(ticker, existing = new Set()) {
  const symbol = ticker.symbol || "";
  if (!symbol.endsWith("USDT")) return false;
  if (existing.has(symbol)) return false;
  if (CONFIG.dynamicSpotPoolExcludedPatterns.some((pattern) => symbol.includes(pattern))) return false;
  if (!Number.isFinite(ticker.priceChangePercent) || ticker.priceChangePercent > CONFIG.dynamicWeakSpotPoolMaxPriceChangePercent) return false;
  if (!Number.isFinite(ticker.quoteVolume) || ticker.quoteVolume < CONFIG.dynamicWeakSpotPoolMinQuoteVolume) return false;
  return true;
}

function average(values) {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return 0;
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function benchmarkMomentum24h(candles) {
  if (!candles || candles.length < 8) return null;
  const latestIndex = candles.length - 2;
  const lookback = Math.max(1, Math.round(24 / 4));
  const prevIndex = Math.max(0, latestIndex - lookback);
  return candles[latestIndex].close / candles[prevIndex].close - 1;
}

async function mapLimit(items, limit, fn) {
  const queue = [...items];
  const workers = Array.from({ length: Math.max(1, Math.min(limit, queue.length || 1)) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      await fn(item);
    }
  });
  await Promise.all(workers);
}

export function selectScanTargets(group) {
  const shortIntervals = ["1h"];
  const scalpIntervals = CONFIG.futuresScalpIntervals;
  const midIntervals = ["2h", "4h"];
  const dailyIntervals = ["1d"];
  const allIntervals = [...CONFIG.shortTermIntervals, ...CONFIG.intervals];
  const empty = withIntervals({ cryptoAssets: [], futuresAssets: [], arbitrageAssets: [] }, []);

  if (group === "review") return empty;
  if (group === "dynamic-spot") return empty;
  if (group === "dynamic-weak-spot") return empty;

  const cryptoCoreMatch = group.match(/^crypto-core-(a|b)(?:-(1h|mid|daily))?$/);
  if (cryptoCoreMatch) {
    return withIntervals(
      { cryptoAssets: CONFIG.scanGroups[`crypto-core-${cryptoCoreMatch[1]}`], futuresAssets: [], arbitrageAssets: [] },
      intervalProfile(cryptoCoreMatch[2], allIntervals, shortIntervals, midIntervals)
    );
  }

  const cryptoAltMatch = group.match(/^crypto-alt-(a|b|c)(?:-(1h|mid|daily))?$/);
  if (cryptoAltMatch) {
    return withIntervals(
      { cryptoAssets: CONFIG.scanGroups[`crypto-alt-${cryptoAltMatch[1]}`], futuresAssets: [], arbitrageAssets: [] },
      intervalProfile(cryptoAltMatch[2], allIntervals, shortIntervals, midIntervals)
    );
  }

  if (group === "crypto-core") {
    return withIntervals({ cryptoAssets: CONFIG.scanGroups["crypto-core"], futuresAssets: [], arbitrageAssets: [] }, allIntervals);
  }
  if (group === "crypto-alt") {
    return withIntervals({ cryptoAssets: CONFIG.scanGroups["crypto-alt"], futuresAssets: [], arbitrageAssets: [] }, allIntervals);
  }
  if (group === "crypto-daily") {
    return withIntervals({ cryptoAssets: CONFIG.cryptoAssets, futuresAssets: [], arbitrageAssets: [] }, dailyIntervals);
  }
  if (group === "futures-core-1h") {
    return withIntervals({ cryptoAssets: [], futuresAssets: CONFIG.scanGroups["futures-core"], arbitrageAssets: [] }, shortIntervals);
  }
  if (group === "futures-scalp-a" || group === "futures-scalp-b") {
    return withIntervals({ cryptoAssets: [], futuresAssets: CONFIG.scanGroups[group], arbitrageAssets: [] }, scalpIntervals);
  }
  if (group === "futures-core-mid") {
    return withIntervals({ cryptoAssets: [], futuresAssets: CONFIG.scanGroups["futures-core"], arbitrageAssets: [] }, midIntervals);
  }
  if (group === "futures-core") {
    return withIntervals({ cryptoAssets: [], futuresAssets: CONFIG.scanGroups["futures-core"], arbitrageAssets: CONFIG.scanGroups["futures-core"] }, allIntervals);
  }
  if (group === "futures-daily") {
    return withIntervals({ cryptoAssets: [], futuresAssets: CONFIG.futuresAssets, arbitrageAssets: [] }, dailyIntervals);
  }
  if (group === "futures-arbitrage") {
    return withIntervals({ cryptoAssets: [], futuresAssets: [], arbitrageAssets: CONFIG.scanGroups["futures-arbitrage"] }, []);
  }
  return withIntervals({
    cryptoAssets: CONFIG.cryptoAssets,
    futuresAssets: CONFIG.futuresAssets,
    arbitrageAssets: CONFIG.futuresArbitrageAssets
  }, allIntervals);
}

function intervalProfile(profile, allIntervals, shortIntervals, midIntervals) {
  if (profile === "1h") return shortIntervals;
  if (profile === "mid") return midIntervals;
  if (profile === "daily") return ["1d"];
  return allIntervals;
}

function withIntervals(targets, intervals) {
  return {
    ...targets,
    cryptoIntervals: intervals,
    futuresIntervals: intervals
  };
}

function scoreArbitrage({ absRate, breakEvenDays, basis }) {
  const annualizedMagnitude = absRate * 3 * 365;
  const rateScore = Math.min(50, Math.round(annualizedMagnitude / CONFIG.arbitrageAnnualizedThreshold * 30));
  const paybackScore = Number.isFinite(breakEvenDays)
    ? Math.max(0, Math.round(25 - breakEvenDays * 3))
    : 0;
  const basisScore = basis == null ? 8 : Math.max(0, Math.round(15 - Math.abs(basis) * 300));
  return Math.max(0, Math.min(100, rateScore + paybackScore + basisScore + 10));
}

function buildArbitrageChecks({ rate, annualizedFunding, dailyFunding, breakEvenDays, basis, nextFundingTime }) {
  const checks = [];
  checks.push(["资金费年化", Math.abs(annualizedFunding) >= CONFIG.arbitrageAnnualizedThreshold ? "通过" : "观察", `${formatPct(rate)} / 8h，年化约 ${formatPct(annualizedFunding)}`]);
  checks.push(["预估日收益", "参考", `按 3 次结算估算约 ${formatPct(dailyFunding)} / 天，未扣滑点和实际成交差`]);
  checks.push(["手续费回本", breakEvenDays <= CONFIG.arbitrageMaxBreakEvenDays ? "通过" : "观察", `按 ${formatPct(CONFIG.arbitrageTradingCost)} 总摩擦成本估算约 ${breakEvenDays.toFixed(1)} 天回本`]);
  checks.push(["基差", basis == null ? "缺失" : Math.abs(basis) <= 0.003 ? "通过" : "风险", basis == null ? "未获取 mark/index 价差" : `mark 相对 index 约 ${formatPct(basis)}`]);
  checks.push(["下次结算", "参考", new Date(nextFundingTime).toISOString()]);
  return checks;
}

function formatPct(value) {
  if (!Number.isFinite(value)) return "N/A";
  return `${(value * 100).toFixed(4)}%`;
}

function formatNumber(value) {
  if (!Number.isFinite(value)) return "N/A";
  if (Math.abs(value) >= 1) return value.toFixed(6).replace(/\.?0+$/, "");
  return value.toPrecision(6);
}

async function safe(fn, errors, label) {
  try {
    return await fn();
  } catch (error) {
    errors.push({ label, error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

async function safeMarket(fn, warnings, label) {
  try {
    return await fn();
  } catch (error) {
    warnings.push({
      label,
      warning: error instanceof Error ? error.message : String(error)
    });
    return null;
  }
}

function summarizeEmailResult(result) {
  if (!result || typeof result !== "object") return null;
  return {
    messageId: result.messageId || result.id || null,
    accepted: Array.isArray(result.accepted) ? result.accepted : undefined,
    rejected: Array.isArray(result.rejected) ? result.rejected : undefined,
    response: typeof result.response === "string" ? result.response.slice(0, 500) : undefined,
    skipped: Boolean(result.skipped),
    reason: result.reason || undefined
  };
}
