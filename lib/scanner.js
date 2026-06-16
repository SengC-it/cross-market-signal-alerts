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
  getSpot24hTickers,
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
  scoreCandidateDetailed,
  STRATEGIES
} from "./strategies.js";
import { fetchSentAlertsForReview, hasSentSignal, recordRunLog, recordSentSignal } from "./storage.js";
import { atr } from "./indicators.js";

export async function runSignalScan({ dryRun = false, group = "all" } = {}) {
  const startedAt = new Date().toISOString();
  const candidates = [];
  const errors = [];
  const warnings = [];
  const selected = selectScanTargets(group);
  const dynamicSpotAssets = await loadDynamicSpotAssets({ group, selected, warnings });
  let emailStatus = dryRun ? "dry_run" : "not_sent";
  let emailResult = null;
  let sentAlertKeys = [];
  const sentAlerts = await safe(
    () => fetchSentAlertsForReview(CONFIG.livePerformanceLookback),
    errors,
    "sent alerts review lookup"
  ) ?? [];

  const needsCryptoBenchmark = selected.cryptoAssets.length || selected.futuresAssets.length || dynamicSpotAssets.length;
  const btc4h = needsCryptoBenchmark
    ? await safeMarket(() => getCryptoCandles("BTCUSDT", "4h", 1000), warnings, "BTCUSDT benchmark")
    : null;

  await mapLimit(selected.cryptoAssets, CONFIG.marketDataConcurrency, (symbol) => scanCryptoSymbol({ symbol, candidates, warnings, btc4h, sentAlerts, intervals: selected.cryptoIntervals }));
  await mapLimit(dynamicSpotAssets, CONFIG.marketDataConcurrency, (symbol) => scanDynamicSpotSymbol({ symbol, candidates, warnings, btc4h, sentAlerts }));
  await mapLimit(selected.futuresAssets, CONFIG.marketDataConcurrency, (symbol) => scanFuturesSymbol({ symbol, candidates, warnings, btc4h, sentAlerts, intervals: selected.futuresIntervals }));
  await mapLimit(selected.arbitrageAssets, CONFIG.marketDataConcurrency, (symbol) => scanFuturesArbitrageSymbol({ symbol, candidates, warnings }));

  const spyBenchmark = selected.tradfiAssets.length
    ? await safeMarket(() => getYahooCandles("SPY", "5y", "1d"), warnings, "SPY benchmark")
    : null;
  await mapLimit(selected.tradfiAssets, CONFIG.marketDataConcurrency, (symbol) => scanTradfiSymbol({ symbol, candidates, warnings, spyBenchmark, sentAlerts }));

  const signals = [];
  for (const signal of candidates.sort((a, b) => b.recommendationScore - a.recommendationScore).slice(0, CONFIG.maxSignalsPerEmail)) {
    const alreadySent = await safe(() => hasSentSignal(signal.signalKey), errors, `sent alert lookup ${signal.signalKey}`);
    if (alreadySent === null) {
      emailStatus = "blocked_by_dedupe_error";
      continue;
    }
    if (!alreadySent) signals.push(signal);
  }

  let emailed = false;
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
      errors.push({ label: "email or sent_alerts write", error: error instanceof Error ? error.message : String(error) });
    }
  } else if (!signals.length) {
    emailStatus = dryRun ? "dry_run_no_signals" : emailStatus === "blocked_by_dedupe_error" ? emailStatus : "no_signals";
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

  return { group, candidates: candidates.length, signals: signals.length, emailed, emailStatus, sentAlertKeys, errors, warnings };
}

async function scanCryptoSymbol({ symbol, candidates, warnings, btc4h, sentAlerts, intervals }) {
  const orderBook = await safeMarket(() => getCryptoOrderBook(symbol), warnings, `${symbol} spot orderbook`);
  for (const interval of intervals) {
    const candles = await safeMarket(() => getCryptoCandles(symbol, interval, 1000), warnings, `${symbol} spot ${interval}`);
    if (!candles || candles.length < 260) continue;
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
  }
}

async function scanDynamicSpotSymbol({ symbol, candidates, warnings, btc4h, sentAlerts }) {
  const [candles, orderBook] = await Promise.all([
    safeMarket(() => getCryptoCandles(symbol, "1h", 200), warnings, `${symbol} dynamic spot 1h`),
    safeMarket(() => getCryptoOrderBook(symbol), warnings, `${symbol} dynamic spot orderbook`)
  ]);
  if (!candles || candles.length < 50) return;

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
    recommendationScore: Math.min(score, 82),
    triggerReason: "该资产进入动态强势池，并在 1h 级别出现放量相对强势突破。",
    invalidCondition: "如果 4 小时内不能继续强于 BTC，或跌回突破前区间，应视为失效。"
  });
}

async function scanFuturesSymbol({ symbol, candidates, warnings, btc4h, sentAlerts, intervals }) {
  const [funding, openInterest, sentiment] = await Promise.all([
    safeMarket(() => getFuturesFundingRate(symbol), warnings, `${symbol} futures funding`),
    safeMarket(() => getFuturesOpenInterest(symbol), warnings, `${symbol} futures open interest`),
    safeMarket(() => getFuturesLongShortContext(symbol, "1h"), warnings, `${symbol} futures long-short context`)
  ]);
  for (const interval of intervals) {
    const candleLimit = CONFIG.futuresScalpIntervals.includes(interval) ? 1500 : 1000;
    const candles = await safeMarket(() => getFuturesCandles(symbol, interval, candleLimit), warnings, `${symbol} futures ${interval}`);
    if (!candles || candles.length < 260) continue;
    for (const strategy of FUTURES_STRATEGIES) {
      const direction = strategy.direction === "LONG" ? "做多观察" : "做空观察";
      addCandidate({
        candidates,
        candles,
        strategy,
        interval,
        tradingCost: CONFIG.futuresTradingCost,
        filters: evaluateFuturesFilters({ candles, benchmarkCandles: btc4h, funding, openInterest, sentiment, direction }),
        asset: symbol,
        market: "USDT 永续合约",
        triggerSuffix: "合约信号只用于观察，需要额外考虑保证金、资金费率、杠杆和强平风险。",
        sentAlerts
      });
    }
  }
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
    triggerReason: `当前资金费率达到 ${formatPct(rate)} / 8h，折合年化约 ${formatPct(annualizedFunding)}。该信号只提示资金费率套利窗口，不代表价格方向判断。`,
    invalidCondition: "下一次资金费结算后费率明显回落、价差快速反向扩大、现货/合约任一侧流动性不足，或预估回本天数超过阈值时失效。"
  });
}

async function scanTradfiSymbol({ symbol, candidates, warnings, spyBenchmark, sentAlerts }) {
  const candles = symbol === "SPY" && spyBenchmark
    ? spyBenchmark
    : await safeMarket(() => getYahooCandles(symbol, "5y", "1d"), warnings, `${symbol} yahoo`);
  if (!candles || candles.length < 260) return;
  const benchmark = symbol === "SPY" ? candles : spyBenchmark;
  for (const strategy of STRATEGIES) {
    addCandidate({
      candidates,
      candles,
      strategy,
      interval: "1d",
      tradingCost: CONFIG.equityTradingCost,
      filters: evaluateFilters({ candles, benchmarkCandles: benchmark, orderBook: null }),
      asset: symbol,
      market: CONFIG.commodityAssets.includes(symbol) ? "商品/能源代理" : "美股/ETF",
      sentAlerts
    });
  }
}

function addCandidate({ candidates, candles, strategy, interval, tradingCost, filters, asset, market, triggerSuffix = "", sentAlerts = [], signalEnhancer = null }) {
  const metrics = backtestStrategy(candles, strategy, interval, tradingCost);
  const minTrades = isFuturesScalpSignal({ market, interval, strategy })
    ? CONFIG.futuresScalpMinTrades
    : CONFIG.minTrades;
  if (!metrics || metrics.trades < minTrades) return;

  const currentSignal = getCurrentSignal(candles, strategy, interval);
  if (!currentSignal) return;

  const livePerformance = summarizeLiveAlertPerformance({ sentAlerts, candles, asset, strategy, interval, tradingCost });
  const cooldown = summarizeCooldown({ sentAlerts, asset, strategy, interval, currentSignal });
  const gate = evaluateCandidateGate({ strategy, metrics, filters, livePerformance, cooldown, market, currentSignal });
  if (!gate.passed) return;

  const scoring = scoreCandidateDetailed({ metrics, filters, livePerformance, strategy, interval, tradingCost });
  if (scoring.hardVetoes.length && !isRelativeStrengthOverride(currentSignal)) return;

  const recommendationScore = clampScore(scoring.score + gate.scoreAdjustment);
  if (!passesScoreFloor({ recommendationScore, metrics, market, interval, strategy, tradingCost })) return;

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
    scoringBreakdown: scoring.breakdown
  });
  candidates.push(typeof signalEnhancer === "function"
    ? signalEnhancer(signal, { candles, currentSignal, strategy, interval, metrics, filters })
    : signal);
}

function buildSignal({ asset, market, interval, strategy, metrics, filters, recommendationScore, currentSignal, triggerSuffix = "", livePerformance = null, gateNotes = [], scoringBreakdown = null }) {
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

function isDynamicSpotCandidate(ticker, existing) {
  const symbol = ticker.symbol || "";
  if (!symbol.endsWith("USDT")) return false;
  if (existing.has(symbol)) return false;
  if (CONFIG.dynamicSpotPoolExcludedPatterns.some((pattern) => symbol.includes(pattern))) return false;
  if (!Number.isFinite(ticker.priceChangePercent) || ticker.priceChangePercent < CONFIG.dynamicSpotPoolMinPriceChangePercent) return false;
  if (!Number.isFinite(ticker.quoteVolume) || ticker.quoteVolume < CONFIG.dynamicSpotPoolMinQuoteVolume) return false;
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

function selectScanTargets(group) {
  const shortIntervals = ["1h"];
  const scalpIntervals = CONFIG.futuresScalpIntervals;
  const midIntervals = ["2h", "4h"];
  const dailyIntervals = ["1d"];
  const allIntervals = [...CONFIG.shortTermIntervals, ...CONFIG.intervals];
  const empty = withIntervals({ cryptoAssets: [], futuresAssets: [], arbitrageAssets: [], tradfiAssets: [] }, []);

  if (group === "dynamic-spot") return empty;

  const cryptoCoreMatch = group.match(/^crypto-core-(a|b)(?:-(1h|mid|daily))?$/);
  if (cryptoCoreMatch) {
    return withIntervals(
      { cryptoAssets: CONFIG.scanGroups[`crypto-core-${cryptoCoreMatch[1]}`], futuresAssets: [], arbitrageAssets: [], tradfiAssets: [] },
      intervalProfile(cryptoCoreMatch[2], allIntervals, shortIntervals, midIntervals)
    );
  }

  const cryptoAltMatch = group.match(/^crypto-alt-(a|b|c)(?:-(1h|mid|daily))?$/);
  if (cryptoAltMatch) {
    return withIntervals(
      { cryptoAssets: CONFIG.scanGroups[`crypto-alt-${cryptoAltMatch[1]}`], futuresAssets: [], arbitrageAssets: [], tradfiAssets: [] },
      intervalProfile(cryptoAltMatch[2], allIntervals, shortIntervals, midIntervals)
    );
  }

  if (group === "crypto-core") {
    return withIntervals({ cryptoAssets: CONFIG.scanGroups["crypto-core"], futuresAssets: [], arbitrageAssets: [], tradfiAssets: [] }, allIntervals);
  }
  if (group === "crypto-alt") {
    return withIntervals({ cryptoAssets: CONFIG.scanGroups["crypto-alt"], futuresAssets: [], arbitrageAssets: [], tradfiAssets: [] }, allIntervals);
  }
  if (group === "crypto-daily") {
    return withIntervals({ cryptoAssets: CONFIG.cryptoAssets, futuresAssets: [], arbitrageAssets: [], tradfiAssets: [] }, dailyIntervals);
  }
  if (group === "futures-core-1h") {
    return withIntervals({ cryptoAssets: [], futuresAssets: CONFIG.scanGroups["futures-core"], arbitrageAssets: [], tradfiAssets: [] }, shortIntervals);
  }
  if (group === "futures-scalp-a" || group === "futures-scalp-b") {
    return withIntervals({ cryptoAssets: [], futuresAssets: CONFIG.scanGroups[group], arbitrageAssets: [], tradfiAssets: [] }, scalpIntervals);
  }
  if (group === "futures-core-mid") {
    return withIntervals({ cryptoAssets: [], futuresAssets: CONFIG.scanGroups["futures-core"], arbitrageAssets: [], tradfiAssets: [] }, midIntervals);
  }
  if (group === "futures-core") {
    return withIntervals({ cryptoAssets: [], futuresAssets: CONFIG.scanGroups["futures-core"], arbitrageAssets: CONFIG.scanGroups["futures-core"], tradfiAssets: [] }, allIntervals);
  }
  if (group === "futures-daily") {
    return withIntervals({ cryptoAssets: [], futuresAssets: CONFIG.futuresAssets, arbitrageAssets: [], tradfiAssets: [] }, dailyIntervals);
  }
  if (group === "futures-arbitrage") {
    return withIntervals({ cryptoAssets: [], futuresAssets: [], arbitrageAssets: CONFIG.scanGroups["futures-arbitrage"], tradfiAssets: [] }, []);
  }
  if (group === "tradfi" || group === "tradfi-daily") {
    return withIntervals({ cryptoAssets: [], futuresAssets: [], arbitrageAssets: [], tradfiAssets: CONFIG.scanGroups.tradfi }, dailyIntervals);
  }
  return withIntervals({
    cryptoAssets: CONFIG.cryptoAssets,
    futuresAssets: CONFIG.futuresAssets,
    arbitrageAssets: CONFIG.futuresArbitrageAssets,
    tradfiAssets: [...CONFIG.equityAssets, ...CONFIG.commodityAssets]
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
