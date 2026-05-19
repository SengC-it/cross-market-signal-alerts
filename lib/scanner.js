import { CONFIG } from "./config.js";
import { sendEmail } from "./email.js";
import {
  getCryptoCandles,
  getCryptoOrderBook,
  getFuturesCandles,
  getFuturesFundingRate,
  getFuturesOpenInterest,
  getFuturesPremiumIndex,
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
  let emailStatus = dryRun ? "dry_run" : "not_sent";

  const needsCryptoBenchmark = selected.cryptoAssets.length || selected.futuresAssets.length;
  const btc4h = needsCryptoBenchmark
    ? await safe(() => getCryptoCandles("BTCUSDT", "4h", 1000), errors, "BTCUSDT benchmark")
    : null;

  await Promise.all(selected.cryptoAssets.map((symbol) => scanCryptoSymbol({ symbol, candidates, errors, btc4h })));
  await Promise.all(selected.futuresAssets.map((symbol) => scanFuturesSymbol({ symbol, candidates, errors, btc4h })));
  await Promise.all(selected.arbitrageAssets.map((symbol) => scanFuturesArbitrageSymbol({ symbol, candidates, errors })));

  const spyBenchmark = selected.tradfiAssets.length
    ? await safe(() => getYahooCandles("SPY", "5y", "1d"), errors, "SPY benchmark")
    : null;
  await Promise.all(selected.tradfiAssets.map((symbol) => scanTradfiSymbol({ symbol, candidates, errors, spyBenchmark })));

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
    errors
  });

  return { group, candidates: candidates.length, signals: signals.length, emailed, emailStatus, errors };
}

async function scanCryptoSymbol({ symbol, candidates, errors, btc4h }) {
  const orderBook = await safe(() => getCryptoOrderBook(symbol), errors, `${symbol} spot orderbook`);
  await Promise.all([...CONFIG.intervals, ...CONFIG.shortTermIntervals].map(async (interval) => {
    const candles = await safe(() => getCryptoCandles(symbol, interval, 1000), errors, `${symbol} spot ${interval}`);
    if (!candles || candles.length < 260) return;
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
  }));
}

async function scanFuturesSymbol({ symbol, candidates, errors, btc4h }) {
  const [funding, openInterest] = await Promise.all([
    safe(() => getFuturesFundingRate(symbol), errors, `${symbol} futures funding`),
    safe(() => getFuturesOpenInterest(symbol), errors, `${symbol} futures open interest`)
  ]);
  await Promise.all([...CONFIG.intervals, ...CONFIG.shortTermIntervals].map(async (interval) => {
    const candles = await safe(() => getFuturesCandles(symbol, interval, 1000), errors, `${symbol} futures ${interval}`);
    if (!candles || candles.length < 260) return;
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
        triggerSuffix: "合约信号只用于观察，需要额外考虑保证金、资金费率、杠杆和强平风险。"
      });
    }
  }));
}

async function scanFuturesArbitrageSymbol({ symbol, candidates, errors }) {
  const [funding, premium] = await Promise.all([
    safe(() => getFuturesFundingRate(symbol), errors, `${symbol} arbitrage funding`),
    safe(() => getFuturesPremiumIndex(symbol), errors, `${symbol} premium index`)
  ]);
  const rate = Number.isFinite(premium?.lastFundingRate) ? premium.lastFundingRate : funding?.fundingRate;
  if (!Number.isFinite(rate)) return;

  const absRate = Math.abs(rate);
  const annualizedFunding = rate * 3 * 365;
  const annualizedMagnitude = Math.abs(annualizedFunding);
  if (annualizedMagnitude < CONFIG.arbitrageAnnualizedThreshold) return;

  const dailyFunding = absRate * 3;
  const breakEvenDays = dailyFunding > 0 ? CONFIG.arbitrageTradingCost / dailyFunding : Infinity;

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

async function scanTradfiSymbol({ symbol, candidates, errors, spyBenchmark }) {
  const candles = symbol === "SPY" && spyBenchmark
    ? spyBenchmark
    : await safe(() => getYahooCandles(symbol, "5y", "1d"), errors, `${symbol} yahoo`);
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
      market: CONFIG.commodityAssets.includes(symbol) ? "商品/能源代理" : "美股/ETF"
    });
  }
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
    triggerReason: `最新已收盘 ${interval} K 线满足“${strategy.name}”，上一根 K 线不满足，因此属于新信号。${triggerSuffix ? ` ${triggerSuffix}` : ""}`,
    invalidCondition: strategy.id.includes("donchian")
      ? "收盘价跌回突破/跌破位内侧，或大盘/自身趋势过滤转弱。"
      : strategy.direction === "SHORT"
        ? "收盘价重新站回关键均线上方，或空头趋势条件失效。"
        : "收盘价跌回关键均线下方，或 SMA50 不再高于 SMA200。"
  };
}

function selectScanTargets(group) {
  if (group.startsWith("crypto-core")) return { cryptoAssets: CONFIG.scanGroups[group] ?? CONFIG.scanGroups["crypto-core"], futuresAssets: [], arbitrageAssets: [], tradfiAssets: [] };
  if (group.startsWith("crypto-alt")) return { cryptoAssets: CONFIG.scanGroups[group] ?? CONFIG.scanGroups["crypto-alt"], futuresAssets: [], arbitrageAssets: [], tradfiAssets: [] };
  if (group === "futures-core") return { cryptoAssets: [], futuresAssets: CONFIG.scanGroups["futures-core"], arbitrageAssets: CONFIG.scanGroups["futures-core"], tradfiAssets: [] };
  if (group === "futures-arbitrage") return { cryptoAssets: [], futuresAssets: [], arbitrageAssets: CONFIG.scanGroups["futures-arbitrage"], tradfiAssets: [] };
  if (group === "tradfi") return { cryptoAssets: [], futuresAssets: [], arbitrageAssets: [], tradfiAssets: CONFIG.scanGroups.tradfi };
  return {
    cryptoAssets: CONFIG.cryptoAssets,
    futuresAssets: CONFIG.futuresAssets,
    arbitrageAssets: CONFIG.futuresArbitrageAssets,
    tradfiAssets: [...CONFIG.equityAssets, ...CONFIG.commodityAssets]
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
