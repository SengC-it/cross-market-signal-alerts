import { sendEmail } from "./email.js";
import { getFuturesCandles, getFuturesFundingHistory } from "./market-data.js";
import {
  claimPaperModelEmail,
  fetchPaperModelRun,
  fetchPreviousPaperModelRun,
  isSupabaseConfigured,
  recordPaperModelRun,
  updatePaperModelEmail,
  updatePaperModelReview
} from "./storage.js";
import { buildModelMetadata } from "./model-metadata.js";
import {
  loadPaperEmailPerformanceSnapshot,
  paperEmailPerformanceSnapshot
} from "./email-performance-context.js";
import { performanceEmailLines } from "./performance-summary.js";

const HOUR_MS = 60 * 60 * 1000;
const BAR_HOURS = 4;
const BAR_MS = BAR_HOURS * HOUR_MS;

export const V31_MODEL = Object.freeze({
  id: "v3_1_residual_momentum_beta_neutral",
  version: "V3.1 BENCHMARK PAPER",
  state: "PAPER",
  deploymentGatePassed: false,
  capitalWeight: 0,
  benchmarkOnly: true,
  emailEnabled: false,
  interval: "4h",
  lookbackHours: 720,
  skipHours: 12,
  rebalanceHours: 168,
  positionsPerSide: 3,
  minQuoteVolume24h: 50_000_000,
  candleLimit: 240,
  roundTripCostRate: 0.0012,
  universe: Object.freeze([
    "BTCUSDT",
    "ETHUSDT",
    "SOLUSDT",
    "BNBUSDT",
    "XRPUSDT",
    "DOGEUSDT",
    "ADAUSDT",
    "AVAXUSDT",
    "LINKUSDT",
    "LTCUSDT",
    "BCHUSDT",
    "TRXUSDT",
    "SUIUSDT",
    "INJUSDT",
    "NEARUSDT",
    "APTUSDT",
    "DOTUSDT",
    "UNIUSDT",
    "AAVEUSDT",
    "FILUSDT"
  ])
});

export const V31_MODEL_METADATA = buildModelMetadata({
  modelVersion: V31_MODEL.version,
  modelFamily: V31_MODEL.id,
  configSnapshot: V31_MODEL
});

export async function runV31PaperScan({ dryRun = false, now = Date.now() } = {}) {
  const startedAt = Date.now();
  const rebalanceTime = latestV31RebalanceTime(now);
  const rebalanceIso = new Date(rebalanceTime).toISOString();

  if (!dryRun && !isSupabaseConfigured()) {
    throw new Error("V3.1 PAPER requires Supabase persistence");
  }
  const existingRun = dryRun ? null : await fetchPaperModelRun({
    modelId: V31_MODEL.id,
    rebalanceTime
  });
  if (existingRun) {
    const review = await tryMonitorV31PaperRun({ run: existingRun, now });
    const previousReview = await tryReviewPreviousV31PaperRun({ rebalanceTime });
    const email = V31_MODEL.emailEnabled
      ? await sendV31PaperEmailIfNeeded({
          modelId: V31_MODEL.id,
          rebalanceTime
        })
      : suppressedV31Email();
    return {
      group: "v3-paper",
      modelId: V31_MODEL.id,
      state: V31_MODEL.state,
      deploymentGatePassed: false,
      capitalWeight: 0,
      rebalanceTime: rebalanceIso,
      status: "already_recorded",
      review,
      previousReview,
      ...email,
      durationMs: Date.now() - startedAt
    };
  }

  const seriesBySymbol = new Map();
  const dataErrors = [];
  await mapLimit(V31_MODEL.universe, 5, async (symbol) => {
    try {
      const candles = await getFuturesCandles(symbol, V31_MODEL.interval, V31_MODEL.candleLimit);
      seriesBySymbol.set(symbol, candles);
    } catch (error) {
      dataErrors.push({
        symbol,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  const portfolio = buildV31Portfolio({ seriesBySymbol, rebalanceTime });
  const previousReview = dryRun
    ? null
    : await tryReviewPreviousV31PaperRun({ rebalanceTime, seriesBySymbol });
  const row = {
    model_id: V31_MODEL.id,
    model_version: V31_MODEL.version,
    model_fingerprint: V31_MODEL_METADATA.fingerprint,
    code_commit: V31_MODEL_METADATA.codeCommit,
    rebalance_time: rebalanceIso,
    data_cutoff_time: new Date(portfolio.dataCutoffTime).toISOString(),
    state: V31_MODEL.state,
    deployment_gate_passed: false,
    capital_weight: 0,
    predicted_beta: portfolio.predictedBeta,
    gross_exposure: portfolio.grossExposure,
    eligible_symbols: portfolio.eligibleSymbols,
    targets: portfolio.targets,
    email_status: V31_MODEL.emailEnabled ? "pending" : "suppressed",
    review: {
      status: "pending",
      reason: "持仓周期未结束"
    },
    diagnostics: {
      parameters: {
        interval: V31_MODEL.interval,
        lookbackHours: V31_MODEL.lookbackHours,
        skipHours: V31_MODEL.skipHours,
        rebalanceHours: V31_MODEL.rebalanceHours,
        positionsPerSide: V31_MODEL.positionsPerSide,
        minQuoteVolume24h: V31_MODEL.minQuoteVolume24h
      },
      modelMetadata: V31_MODEL_METADATA,
      excluded: portfolio.excluded,
      dataErrors,
      generatedAt: new Date().toISOString(),
      generationLagHours: round((Number(now) - rebalanceTime) / HOUR_MS, 4)
    }
  };

  let email = { emailStatus: "dry_run" };
  if (!dryRun) {
    await recordPaperModelRun(row);
    email = V31_MODEL.emailEnabled
      ? await sendV31PaperEmailIfNeeded({
          modelId: V31_MODEL.id,
          rebalanceTime
        })
      : suppressedV31Email();
  }

  return {
    group: "v3-paper",
    modelId: V31_MODEL.id,
    state: V31_MODEL.state,
    deploymentGatePassed: false,
    capitalWeight: 0,
    rebalanceTime: rebalanceIso,
    dataCutoffTime: row.data_cutoff_time,
    status: dryRun ? "dry_run" : "recorded",
    eligibleSymbols: portfolio.eligibleSymbols,
    predictedBeta: portfolio.predictedBeta,
    grossExposure: portfolio.grossExposure,
    targets: portfolio.targets,
    dataErrors,
    previousReview,
    ...email,
    durationMs: Date.now() - startedAt
  };
}

function suppressedV31Email() {
  return {
    emailStatus: "suppressed",
    emailSuppressedReason: "v3_4_unified_primary"
  };
}

export function reviewV31PaperRun({
  run,
  exitCandlesBySymbol,
  fundingBySymbol,
  exitTime,
  reviewedAt = Date.now()
}) {
  const entryTime = new Date(run?.rebalance_time).getTime();
  const expectedExitTime = entryTime + V31_MODEL.rebalanceHours * HOUR_MS;
  if (!Number.isFinite(entryTime)) {
    throw new Error("V3.1 PAPER review has an invalid entry time");
  }

  const targets = Array.isArray(run?.targets) ? run.targets : [];
  if (!targets.length) throw new Error("V3.1 PAPER review has no portfolio targets");

  const isFinal = Number(exitTime) >= expectedExitTime;
  let candleOpenTime = expectedExitTime;
  let valuationTime = expectedExitTime;
  let priceField = "open";
  let positionTradingCost = V31_MODEL.roundTripCostRate;
  if (!isFinal) {
    const firstCandles = exitCandlesBySymbol.get(targets[0].symbol) || [];
    const completedTimes = firstCandles
      .map((candle) => Number(candle.openTime))
      .filter((openTime) =>
        openTime >= entryTime
        && openTime < expectedExitTime
        && openTime + BAR_MS <= Number(exitTime)
      )
      .sort((a, b) => b - a);
    candleOpenTime = completedTimes.find((openTime) =>
      targets.every((target) =>
        (exitCandlesBySymbol.get(target.symbol) || []).some(
          (candle) => Number(candle.openTime) === openTime
        )
      )
    );
    if (!Number.isFinite(candleOpenTime)) {
      return {
        status: "pending",
        reason: "等待首个完整 4 小时K线后计算浮动收益",
        modelVersion: "V3.1 PAPER",
        expectedExitTime: new Date(expectedExitTime).toISOString()
      };
    }
    valuationTime = candleOpenTime + BAR_MS;
    priceField = "close";
    positionTradingCost = V31_MODEL.roundTripCostRate / 2;
  }

  const positions = targets.map((target) => {
    const symbol = target.symbol;
    const entryPrice = Number(target.referencePrice);
    const weight = Number(target.targetWeight);
    const candles = exitCandlesBySymbol.get(symbol);
    const valuationCandle = Array.isArray(candles)
      ? candles.find((candle) => Number(candle.openTime) === candleOpenTime)
      : null;
    const valuationPrice = Number(valuationCandle?.[priceField]);
    if (!(entryPrice > 0) || !(valuationPrice > 0) || !Number.isFinite(weight)) {
      throw new Error(`V3.1 PAPER review is missing a valuation price: ${symbol}`);
    }

    const fundingRows = fundingBySymbol.get(symbol);
    if (!Array.isArray(fundingRows)) {
      throw new Error(`V3.1 PAPER review is missing funding history: ${symbol}`);
    }
    const fundingRate = fundingRows
      .filter((item) => Number(item.fundingTime) > entryTime && Number(item.fundingTime) <= valuationTime)
      .reduce((sum, item) => sum + Number(item.fundingRate || 0), 0);
    const priceReturn = valuationPrice / entryPrice - 1;
    const direction = Math.sign(weight);
    const directionalPriceReturn = direction * priceReturn;
    const positionFundingReturn = -direction * fundingRate;
    const positionReturn = directionalPriceReturn + positionFundingReturn - positionTradingCost;
    const outcome = positionReturn > 0
      ? isFinal ? "盈利" : "持仓中盈利"
      : positionReturn < 0
        ? isFinal ? "亏损" : "持仓中亏损"
        : isFinal ? "持平" : "持仓中持平";

    return {
      symbol,
      side: target.side,
      targetWeight: round(weight, 12),
      entryPrice: round(entryPrice, 12),
      ...(isFinal
        ? { exitPrice: round(valuationPrice, 12) }
        : { markPrice: round(valuationPrice, 12) }),
      priceReturn: round(priceReturn, 12),
      priceContribution: round(weight * priceReturn, 12),
      fundingRate: round(fundingRate, 12),
      fundingContribution: round(-weight * fundingRate, 12),
      directionalPriceReturn: round(directionalPriceReturn, 12),
      fundingReturn: round(positionFundingReturn, 12),
      tradingCost: round(positionTradingCost, 12),
      returnPct: round(positionReturn, 12),
      netContribution: round(Math.abs(weight) * positionReturn, 12),
      outcome
    };
  });

  const priceReturn = positions.reduce((sum, position) => sum + position.priceContribution, 0);
  const fundingReturn = positions.reduce((sum, position) => sum + position.fundingContribution, 0);
  const grossExposure = targets.reduce((sum, target) => sum + Math.abs(Number(target.targetWeight || 0)), 0);
  const tradingCost = positionTradingCost * grossExposure;
  const returnPct = priceReturn + fundingReturn - tradingCost;

  if (!isFinal) {
    return {
      status: "pending",
      reason: "持仓周期未结束；当前为最新完整 4 小时K线浮动收益",
      outcome: returnPct > 0 ? "持仓中盈利" : returnPct < 0 ? "持仓中亏损" : "持仓中持平",
      modelVersion: "V3.1 PAPER",
      method: "weekly_portfolio_mark_to_market",
      holdingHours: round((valuationTime - entryTime) / HOUR_MS, 4),
      entryTime: new Date(entryTime).toISOString(),
      markTime: new Date(valuationTime).toISOString(),
      expectedExitTime: new Date(expectedExitTime).toISOString(),
      markedAt: new Date(reviewedAt).toISOString(),
      priceReturn: round(priceReturn, 12),
      fundingReturn: round(fundingReturn, 12),
      tradingCost: round(tradingCost, 12),
      returnPct: round(returnPct, 12),
      netOfCosts: true,
      positions
    };
  }

  return {
    status: "reviewed",
    outcome: returnPct > 0 ? "盈利" : returnPct < 0 ? "亏损" : "持平",
    modelVersion: "V3.1 PAPER",
    method: "weekly_portfolio_net_return",
    holdingHours: V31_MODEL.rebalanceHours,
    entryTime: new Date(entryTime).toISOString(),
    exitTime: new Date(expectedExitTime).toISOString(),
    reviewedAt: new Date(reviewedAt).toISOString(),
    priceReturn: round(priceReturn, 12),
    fundingReturn: round(fundingReturn, 12),
    tradingCost: round(tradingCost, 12),
    returnPct: round(returnPct, 12),
    netOfCosts: true,
    positions
  };
}

export function latestV31RebalanceTime(now = Date.now()) {
  const interval = V31_MODEL.rebalanceHours * HOUR_MS;
  return Math.floor(Number(now) / interval) * interval;
}

export function buildV31Portfolio({ seriesBySymbol, rebalanceTime }) {
  const btcCandles = seriesBySymbol.get("BTCUSDT");
  if (!Array.isArray(btcCandles) || !btcCandles.length) {
    throw new Error("V3.1 PAPER cannot calculate without BTCUSDT futures candles");
  }

  const rows = [];
  const excluded = [];
  for (const symbol of V31_MODEL.universe) {
    const result = calculateCandidate({
      symbol,
      candles: seriesBySymbol.get(symbol),
      btcCandles,
      rebalanceTime
    });
    if (result.eligible) rows.push(result.row);
    else excluded.push({ symbol, reason: result.reason });
  }

  const needed = V31_MODEL.positionsPerSide * 2;
  if (rows.length < needed) {
    throw new Error(`V3.1 PAPER has only ${rows.length} eligible symbols; ${needed} required`);
  }

  rows.sort((a, b) => a.score - b.score || a.symbol.localeCompare(b.symbol));
  const shorts = rows.slice(0, V31_MODEL.positionsPerSide);
  const longs = rows.slice(-V31_MODEL.positionsPerSide).reverse();
  const averageLongBeta = mean(longs.map((row) => row.beta));
  const averageShortBeta = mean(shorts.map((row) => row.beta));
  const betaSum = averageLongBeta + averageShortBeta;
  if (!(betaSum > 0)) throw new Error("V3.1 PAPER cannot calculate beta-neutral weights");

  const longGross = averageShortBeta / betaSum;
  const shortGross = averageLongBeta / betaSum;
  const targets = [
    ...longs.map((row) => toTarget(row, "LONG", longGross / longs.length)),
    ...shorts.map((row) => toTarget(row, "SHORT", -shortGross / shorts.length))
  ];
  const predictedBeta = targets.reduce((sum, target) => sum + target.targetWeight * target.beta, 0);
  const grossExposure = targets.reduce((sum, target) => sum + Math.abs(target.targetWeight), 0);

  return {
    dataCutoffTime: rebalanceTime - V31_MODEL.skipHours * HOUR_MS,
    eligibleSymbols: rows.length,
    predictedBeta: round(predictedBeta, 12),
    grossExposure: round(grossExposure, 12),
    targets,
    excluded
  };
}

export function renderV31PaperEmail(run, { performanceSnapshot = null } = {}) {
  const targets = Array.isArray(run?.targets) ? run.targets : [];
  const longs = targets.filter((target) => target.side === "LONG");
  const shorts = targets.filter((target) => target.side === "SHORT");
  const rebalanceTime = new Date(run.rebalance_time).toISOString();
  const date = rebalanceTime.slice(0, 10);
  const subject = `【PAPER】V3.1 新信号：${longs.length}多/${shorts.length}空 | ${date}`;
  const snapshot = performanceSnapshot || paperEmailPerformanceSnapshot(run, {
    modelId: V31_MODEL.id,
    modelLabel: "V3.1 Benchmark",
    basis: "Production PAPER 已完成周期"
  });
  const lines = [
    "V3.1 残差动量模型出现新的周调仓信号。",
    "",
    ...performanceEmailLines(snapshot),
    "",
    "重要：这是 PAPER 前向验证提醒，不是实盘下单指令。",
    `模型状态：${run.state || "PAPER"}`,
    `实盘部署门槛：${run.deployment_gate_passed ? "已通过" : "未通过"}`,
    `实盘资金权重：${formatPercent(Number(run.capital_weight || 0))}`,
    `调仓时间：${rebalanceTime}`,
    `合格币种：${Number(run.eligible_symbols || 0)}`,
    `组合总敞口：${formatNumber(run.gross_exposure, 4)}x`,
    `预测 BTC beta：${formatNumber(run.predicted_beta, 8)}`,
    "",
    "做多目标：",
    ...longs.map(formatPaperTarget),
    "",
    "做空目标：",
    ...shorts.map(formatPaperTarget),
    "",
    "入选门槛：180 个完整 4h 收益观测、过去 24h 合约成交额至少 5,000 万 USDT、beta 为正，并能形成 3 多/3 空 beta 中性组合。",
    "系统不会连接交易账户，也不会自动下单。"
  ];
  return { subject, text: lines.join("\n") };
}

async function sendV31PaperEmailIfNeeded({ modelId, rebalanceTime }) {
  const claimedRun = await claimPaperModelEmail({ modelId, rebalanceTime });
  if (!claimedRun) {
    const current = await fetchPaperModelRun({ modelId, rebalanceTime });
    return {
      emailStatus: current?.email_status || "not_claimed",
      emailSentAt: current?.email_sent_at || null
    };
  }

  const performanceSnapshot = await loadPaperEmailPerformanceSnapshot({
    modelId,
    modelLabel: "V3.1 Benchmark",
    basis: "Production PAPER 已完成周期",
    fallbackRuns: [claimedRun]
  });
  const message = renderV31PaperEmail(claimedRun, { performanceSnapshot });
  const idempotencyKey = `v31-paper/${modelId}/${new Date(rebalanceTime).toISOString()}`;
  let sent;
  try {
    sent = await sendEmail({ ...message, idempotencyKey });
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    await updatePaperModelEmail({
      modelId,
      rebalanceTime,
      emailStatus: "failed",
      emailResult: { error: messageText }
    });
    throw error;
  }

  if (sent?.skipped) {
    const emailResult = summarizePaperEmailResult(sent);
    await updatePaperModelEmail({
      modelId,
      rebalanceTime,
      emailStatus: "failed",
      emailResult
    });
    throw new Error(`V3.1 PAPER email skipped: ${sent.reason}`);
  }

  const sentAt = new Date().toISOString();
  const emailResult = summarizePaperEmailResult(sent);
  await updatePaperModelEmail({
    modelId,
    rebalanceTime,
    emailStatus: "sent",
    emailResult,
    sentAt
  });
  return {
    emailStatus: "sent",
    emailSentAt: sentAt
  };
}

async function monitorAndPersistV31PaperRun({ run, now }) {
  if (!run?.targets?.length || run.review?.status === "reviewed") {
    return run?.review || null;
  }
  const exitCandlesBySymbol = new Map();
  const fundingBySymbol = new Map();
  const entryTime = new Date(run.rebalance_time).getTime();
  const fundingEnd = Math.min(
    Number(now),
    entryTime + V31_MODEL.rebalanceHours * HOUR_MS
  );
  await mapLimit(run.targets, 5, async (target) => {
    const [candles, funding] = await Promise.all([
      getFuturesCandles(target.symbol, V31_MODEL.interval, V31_MODEL.candleLimit),
      getFuturesFundingHistory(target.symbol, entryTime, fundingEnd)
    ]);
    exitCandlesBySymbol.set(target.symbol, candles);
    fundingBySymbol.set(target.symbol, funding);
  });
  const review = reviewV31PaperRun({
    run,
    exitCandlesBySymbol,
    fundingBySymbol,
    exitTime: now,
    reviewedAt: now
  });
  await updatePaperModelReview({
    modelId: run.model_id,
    rebalanceTime: run.rebalance_time,
    review
  });
  return review;
}

async function tryMonitorV31PaperRun(options) {
  try {
    return await monitorAndPersistV31PaperRun(options);
  } catch (error) {
    return {
      status: "pending",
      reason: "持仓浮动收益数据暂不可用，系统将在下次小时扫描重试",
      modelVersion: "V3.1 PAPER",
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function reviewPreviousV31PaperRun({ rebalanceTime, seriesBySymbol }) {
  const previous = await fetchPreviousPaperModelRun({
    modelId: V31_MODEL.id,
    beforeTime: rebalanceTime
  });
  if (!previous || previous.review?.status === "reviewed") {
    return previous?.review || null;
  }

  const reviewSeries = seriesBySymbol || new Map();
  if (!seriesBySymbol) {
    await mapLimit(previous.targets || [], 5, async (target) => {
      const candles = await getFuturesCandles(target.symbol, V31_MODEL.interval, V31_MODEL.candleLimit);
      reviewSeries.set(target.symbol, candles);
    });
  }

  const fundingBySymbol = new Map();
  await mapLimit(previous.targets || [], 5, async (target) => {
    const funding = await getFuturesFundingHistory(
      target.symbol,
      new Date(previous.rebalance_time).getTime(),
      new Date(previous.rebalance_time).getTime() + V31_MODEL.rebalanceHours * HOUR_MS
    );
    fundingBySymbol.set(target.symbol, funding);
  });

  const review = reviewV31PaperRun({
    run: previous,
    exitCandlesBySymbol: reviewSeries,
    fundingBySymbol,
    exitTime: rebalanceTime
  });
  if (review.status === "reviewed") {
    await updatePaperModelReview({
      modelId: previous.model_id,
      rebalanceTime: previous.rebalance_time,
      review
    });
  }
  return review;
}

async function tryReviewPreviousV31PaperRun(options) {
  try {
    return await reviewPreviousV31PaperRun(options);
  } catch (error) {
    return {
      status: "pending",
      reason: "复盘数据暂不可用，系统将在下次扫描重试",
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function calculateCandidate({ symbol, candles, btcCandles, rebalanceTime }) {
  if (!Array.isArray(candles) || !candles.length) {
    return { eligible: false, reason: "missing_candles" };
  }

  const cutoff = rebalanceTime - V31_MODEL.skipHours * HOUR_MS;
  const windowStart = cutoff - V31_MODEL.lookbackHours * HOUR_MS;
  const aligned = alignedLogReturns(candles, btcCandles, windowStart, cutoff);
  const requiredObservations = V31_MODEL.lookbackHours / BAR_HOURS;
  if (aligned.length !== requiredObservations) {
    return { eligible: false, reason: `insufficient_history:${aligned.length}/${requiredObservations}` };
  }

  const assetReturns = aligned.map((row) => row.asset);
  const btcReturns = aligned.map((row) => row.btc);
  const beta = olsBeta(assetReturns, btcReturns);
  if (!(beta > 0)) return { eligible: false, reason: "non_positive_beta" };

  const residualReturns = assetReturns.map((value, index) => value - beta * btcReturns[index]);
  const residualVolatility = sampleStandardDeviation(residualReturns);
  if (!(residualVolatility > 0)) {
    return { eligible: false, reason: "invalid_residual_volatility" };
  }

  const liquidityCandles = candles.filter((candle) => {
    const closeTime = Number(candle.openTime) + BAR_MS;
    return closeTime > rebalanceTime - 24 * HOUR_MS && closeTime <= rebalanceTime;
  });
  if (liquidityCandles.length !== 24 / BAR_HOURS) {
    return { eligible: false, reason: `insufficient_liquidity_history:${liquidityCandles.length}` };
  }
  const quoteVolume24h = liquidityCandles.reduce((sum, candle) => sum + Number(candle.quoteVolume || 0), 0);
  if (quoteVolume24h < V31_MODEL.minQuoteVolume24h) {
    return { eligible: false, reason: `low_quote_volume:${round(quoteVolume24h, 2)}` };
  }

  const entryCandle = candles.find((candle) => Number(candle.openTime) === rebalanceTime);
  if (!entryCandle || !(Number(entryCandle.open) > 0)) {
    return { eligible: false, reason: "missing_rebalance_open" };
  }

  const residualMomentum = assetReturns.reduce((sum, value) => sum + value, 0)
    - beta * btcReturns.reduce((sum, value) => sum + value, 0);
  const score = residualMomentum / (residualVolatility * Math.sqrt(aligned.length));

  return {
    eligible: true,
    row: {
      symbol,
      beta,
      residualMomentum,
      residualVolatility,
      score,
      observations: aligned.length,
      quoteVolume24h,
      referencePrice: Number(entryCandle.open)
    }
  };
}

function alignedLogReturns(assetCandles, btcCandles, windowStart, cutoff) {
  const assetCloseByTime = closeMap(assetCandles, windowStart, cutoff);
  const btcCloseByTime = closeMap(btcCandles, windowStart, cutoff);
  const returns = [];
  for (let closeTime = windowStart + BAR_MS; closeTime <= cutoff; closeTime += BAR_MS) {
    const previousTime = closeTime - BAR_MS;
    const assetClose = assetCloseByTime.get(closeTime);
    const assetPrevious = assetCloseByTime.get(previousTime);
    const btcClose = btcCloseByTime.get(closeTime);
    const btcPrevious = btcCloseByTime.get(previousTime);
    if (![assetClose, assetPrevious, btcClose, btcPrevious].every((value) => value > 0)) continue;
    returns.push({
      asset: Math.log(assetClose / assetPrevious),
      btc: Math.log(btcClose / btcPrevious)
    });
  }
  return returns;
}

function closeMap(candles, windowStart, cutoff) {
  const map = new Map();
  for (const candle of candles) {
    const closeTime = Number(candle.openTime) + BAR_MS;
    if (closeTime < windowStart || closeTime > cutoff) continue;
    map.set(closeTime, Number(candle.close));
  }
  return map;
}

function olsBeta(assetReturns, btcReturns) {
  const assetMean = mean(assetReturns);
  const btcMean = mean(btcReturns);
  let covariance = 0;
  let variance = 0;
  for (let index = 0; index < assetReturns.length; index++) {
    const btcDeviation = btcReturns[index] - btcMean;
    covariance += (assetReturns[index] - assetMean) * btcDeviation;
    variance += btcDeviation * btcDeviation;
  }
  return variance > 0 ? covariance / variance : NaN;
}

function sampleStandardDeviation(values) {
  if (values.length < 2) return NaN;
  const average = mean(values);
  const variance = values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function toTarget(row, side, targetWeight) {
  return {
    symbol: row.symbol,
    side,
    targetWeight: round(targetWeight, 12),
    beta: round(row.beta, 8),
    score: round(row.score, 8),
    residualMomentum: round(row.residualMomentum, 8),
    residualVolatility: round(row.residualVolatility, 8),
    observations: row.observations,
    quoteVolume24h: round(row.quoteVolume24h, 2),
    referencePrice: round(row.referencePrice, 12)
  };
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round(value, digits = 8) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function formatPaperTarget(target) {
  const weight = formatPercent(Math.abs(Number(target.targetWeight || 0)));
  const reference = formatNumber(target.referencePrice, 8);
  const score = formatNumber(target.score, 4);
  const beta = formatNumber(target.beta, 4);
  return `- ${target.symbol} | 权重 ${weight} | 参考价 ${reference} | 分数 ${score} | beta ${beta}`;
}

function formatPercent(value) {
  return `${(Number(value || 0) * 100).toFixed(2)}%`;
}

function formatNumber(value, digits) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "N/A";
  return number.toFixed(digits).replace(/\.?0+$/, "");
}

function summarizePaperEmailResult(result) {
  if (!result || typeof result !== "object") return null;
  return {
    id: result.id || result.messageId || null,
    accepted: Array.isArray(result.accepted) ? result.accepted : undefined,
    rejected: Array.isArray(result.rejected) ? result.rejected : undefined,
    skipped: Boolean(result.skipped),
    reason: result.reason || undefined
  };
}

async function mapLimit(items, limit, fn) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift());
  });
  await Promise.all(workers);
}
