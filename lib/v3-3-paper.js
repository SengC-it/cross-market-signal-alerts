import { sendEmail } from "./email.js";
import { getFuturesCandles, getFuturesFundingHistory } from "./market-data.js";
import {
  claimPaperModelEmail,
  fetchPaperModelRun,
  fetchPaperModelRunsForModel,
  fetchPreviousPaperModelRun,
  isSupabaseConfigured,
  recordPaperModelRun,
  updatePaperModelEmail,
  updatePaperModelReview
} from "./storage.js";
import {
  buildV31Portfolio,
  latestV31RebalanceTime,
  V31_MODEL
} from "./v3-paper.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const V33_MODEL = Object.freeze({
  id: "v3_3_vol_target_catastrophe_breaker",
  version: "V3.3 SHADOW PAPER",
  state: "PAPER",
  deploymentGatePassed: false,
  capitalWeight: 0,
  volatilityLookbackDays: 30,
  targetAnnualVolatility: 0.15,
  minimumGrossExposure: 0.25,
  maximumGrossExposure: 1.25,
  catastropheStop: 0.08,
  breakerDrawdown: 0.1,
  breakerCooldownWeeks: 4,
  hourlyCandleLimit: 800,
  monitorCandleLimit: 240,
  roundTripCostRate: V31_MODEL.roundTripCostRate
});

export async function runV33PaperScan({ dryRun = false, now = Date.now() } = {}) {
  const startedAt = Date.now();
  const rebalanceTime = latestV31RebalanceTime(now);
  const rebalanceIso = new Date(rebalanceTime).toISOString();

  if (!dryRun && !isSupabaseConfigured()) {
    throw new Error("V3.3 SHADOW PAPER requires Supabase persistence");
  }

  const existingRun = dryRun ? null : await fetchPaperModelRun({
    modelId: V33_MODEL.id,
    rebalanceTime
  });
  if (existingRun) {
    const review = await tryMonitorV33PaperRun({ run: existingRun, now });
    const email = existingRun.targets?.length
      ? await sendV33PaperEmailIfNeeded({ modelId: V33_MODEL.id, rebalanceTime })
      : { emailStatus: existingRun.email_status || "suppressed" };
    return buildScanResult({
      run: existingRun,
      status: "already_recorded",
      review,
      email,
      startedAt
    });
  }

  let previousReview = null;
  let breakerState = emptyBreakerState();
  if (!dryRun) {
    const previous = await fetchPreviousPaperModelRun({
      modelId: V33_MODEL.id,
      beforeTime: rebalanceTime
    });
    if (previous && previous.review?.status !== "reviewed") {
      previousReview = await tryMonitorV33PaperRun({ run: previous, now });
    } else {
      previousReview = previous?.review || null;
    }
    const history = await fetchPaperModelRunsForModel({
      modelId: V33_MODEL.id,
      beforeTime: rebalanceTime,
      limit: 104
    });
    breakerState = deriveV33BreakerState(history);
  }

  if (breakerState.cooldownRemaining > 0) {
    const remainingAfterRun = breakerState.cooldownRemaining - 1;
    const row = buildBreakerCashRun({
      rebalanceTime,
      now,
      breakerState,
      remainingAfterRun
    });
    await recordPaperModelRun(row);
    return buildScanResult({
      run: row,
      status: "breaker_cash",
      review: row.review,
      email: { emailStatus: "suppressed" },
      previousReview,
      startedAt
    });
  }

  const baseSeriesBySymbol = new Map();
  const dataErrors = [];
  await mapLimit(V31_MODEL.universe, 5, async (symbol) => {
    try {
      const candles = await getFuturesCandles(symbol, V31_MODEL.interval, V31_MODEL.candleLimit);
      baseSeriesBySymbol.set(symbol, candles);
    } catch (error) {
      dataErrors.push({
        symbol,
        interval: V31_MODEL.interval,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  const basePortfolio = buildV31Portfolio({
    seriesBySymbol: baseSeriesBySymbol,
    rebalanceTime
  });
  const hourlySeriesBySymbol = new Map();
  await mapLimit(basePortfolio.targets, 5, async (target) => {
    try {
      const candles = await getFuturesCandles(
        target.symbol,
        "1h",
        V33_MODEL.hourlyCandleLimit
      );
      hourlySeriesBySymbol.set(target.symbol, candles);
    } catch (error) {
      dataErrors.push({
        symbol: target.symbol,
        interval: "1h",
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  const forecastAnnualVolatility = forecastV33PortfolioVolatility({
    targets: basePortfolio.targets,
    hourlySeriesBySymbol,
    rebalanceTime
  });
  const portfolio = applyV33VolatilityTarget({
    portfolio: basePortfolio,
    forecastAnnualVolatility
  });
  const row = {
    model_id: V33_MODEL.id,
    model_version: V33_MODEL.version,
    rebalance_time: rebalanceIso,
    data_cutoff_time: new Date(basePortfolio.dataCutoffTime).toISOString(),
    state: V33_MODEL.state,
    deployment_gate_passed: false,
    capital_weight: 0,
    predicted_beta: portfolio.predictedBeta,
    gross_exposure: portfolio.grossExposure,
    eligible_symbols: portfolio.eligibleSymbols,
    targets: portfolio.targets,
    risk_state: {
      status: "active",
      forecastAnnualVolatility: round(forecastAnnualVolatility, 12),
      targetAnnualVolatility: V33_MODEL.targetAnnualVolatility,
      minimumGrossExposure: V33_MODEL.minimumGrossExposure,
      maximumGrossExposure: V33_MODEL.maximumGrossExposure,
      catastropheStop: V33_MODEL.catastropheStop,
      breakerDrawdown: V33_MODEL.breakerDrawdown,
      breakerCooldownWeeks: V33_MODEL.breakerCooldownWeeks,
      breakerCooldownRemaining: 0,
      breakerEquity: round(breakerState.equity, 12),
      breakerHighWatermark: round(breakerState.highWatermark, 12),
      breakerCurrentDrawdown: round(breakerState.currentDrawdown, 12)
    },
    review: pendingReview("等待小时收盘监控；最长持仓 168 小时"),
    diagnostics: {
      baseModelId: V31_MODEL.id,
      researchGatePassed: false,
      deploymentGatePassed: false,
      parameters: {
        volatilityLookbackDays: V33_MODEL.volatilityLookbackDays,
        targetAnnualVolatility: V33_MODEL.targetAnnualVolatility,
        minimumGrossExposure: V33_MODEL.minimumGrossExposure,
        maximumGrossExposure: V33_MODEL.maximumGrossExposure,
        catastropheStop: V33_MODEL.catastropheStop,
        breakerDrawdown: V33_MODEL.breakerDrawdown,
        breakerCooldownWeeks: V33_MODEL.breakerCooldownWeeks,
        maxHoldingHours: V31_MODEL.rebalanceHours,
        takeProfit: null
      },
      excluded: portfolio.excluded,
      dataErrors,
      generatedAt: new Date().toISOString(),
      generationLagHours: round((Number(now) - rebalanceTime) / HOUR_MS, 4)
    }
  };

  let email = { emailStatus: "dry_run" };
  if (!dryRun) {
    await recordPaperModelRun(row);
    email = await sendV33PaperEmailIfNeeded({
      modelId: V33_MODEL.id,
      rebalanceTime
    });
  }

  return buildScanResult({
    run: row,
    status: dryRun ? "dry_run" : "recorded",
    review: row.review,
    email,
    previousReview,
    startedAt,
    dataErrors
  });
}

export function forecastV33PortfolioVolatility({
  targets,
  hourlySeriesBySymbol,
  rebalanceTime,
  lookbackDays = V33_MODEL.volatilityLookbackDays
}) {
  const closeTimes = Array.from(
    { length: lookbackDays + 1 },
    (_, index) => rebalanceTime - HOUR_MS - (lookbackDays - index) * DAY_MS
  );
  const closesBySymbol = new Map();
  for (const target of targets) {
    const candles = hourlySeriesBySymbol.get(target.symbol);
    const closeByTime = new Map(
      (Array.isArray(candles) ? candles : [])
        .map((candle) => [Number(candle.openTime), Number(candle.close)])
    );
    const closes = closeTimes.map((time) => closeByTime.get(time));
    if (closes.some((close) => !(close > 0))) {
      throw new Error(`V3.3 volatility forecast is missing hourly history: ${target.symbol}`);
    }
    closesBySymbol.set(target.symbol, closes);
  }

  const dailyReturns = [];
  for (let day = 1; day < closeTimes.length; day++) {
    let portfolioReturn = 0;
    for (const target of targets) {
      const closes = closesBySymbol.get(target.symbol);
      portfolioReturn += Number(target.targetWeight)
        * (closes[day] / closes[day - 1] - 1);
    }
    dailyReturns.push(portfolioReturn);
  }
  const forecast = sampleStandardDeviation(dailyReturns) * Math.sqrt(365);
  if (!(forecast > 0)) throw new Error("V3.3 volatility forecast is invalid");
  return forecast;
}

export function applyV33VolatilityTarget({ portfolio, forecastAnnualVolatility }) {
  const grossScale = clamp(
    V33_MODEL.targetAnnualVolatility / forecastAnnualVolatility,
    V33_MODEL.minimumGrossExposure,
    V33_MODEL.maximumGrossExposure
  );
  const targets = portfolio.targets.map((target) => ({
    ...target,
    baseTargetWeight: target.targetWeight,
    targetWeight: round(Number(target.targetWeight) * grossScale, 12)
  }));
  return {
    ...portfolio,
    targets,
    forecastAnnualVolatility: round(forecastAnnualVolatility, 12),
    grossExposure: round(
      targets.reduce((sum, target) => sum + Math.abs(Number(target.targetWeight)), 0),
      12
    ),
    predictedBeta: round(
      targets.reduce(
        (sum, target) => sum + Number(target.targetWeight) * Number(target.beta),
        0
      ),
      12
    )
  };
}

export function reviewV33PaperRun({
  run,
  hourlyCandlesBySymbol,
  fundingBySymbol,
  now = Date.now(),
  reviewedAt = Date.now()
}) {
  const entryTime = new Date(run?.rebalance_time).getTime();
  const targets = Array.isArray(run?.targets) ? run.targets : [];
  if (!Number.isFinite(entryTime) || !targets.length) {
    throw new Error("V3.3 SHADOW PAPER review has no active portfolio");
  }
  const expectedExitTime = entryTime + V31_MODEL.rebalanceHours * HOUR_MS;
  const firstCandles = hourlyCandlesBySymbol.get(targets[0].symbol) || [];
  const completedTimes = firstCandles
    .map((candle) => Number(candle.openTime))
    .filter((openTime) =>
      openTime >= entryTime
      && openTime < expectedExitTime
      && openTime + HOUR_MS <= Number(now)
    )
    .sort((a, b) => a - b);

  let latestMarkedReturn = null;
  let lowestMarkedReturn = null;
  let latestMarkTime = null;
  let triggerMarkedReturn = null;
  let actualExitTime = null;
  let exitReason = null;
  for (const candleTime of completedTimes) {
    const markedReturn = markedV33PortfolioReturn({
      run,
      hourlyCandlesBySymbol,
      fundingBySymbol,
      candleTime
    });
    if (markedReturn == null) continue;
    latestMarkedReturn = markedReturn;
    lowestMarkedReturn = lowestMarkedReturn == null
      ? markedReturn
      : Math.min(lowestMarkedReturn, markedReturn);
    latestMarkTime = candleTime + HOUR_MS;
    if (markedReturn <= -V33_MODEL.catastropheStop) {
      triggerMarkedReturn = markedReturn;
      actualExitTime = candleTime + HOUR_MS;
      exitReason = "catastrophe_stop";
      break;
    }
  }

  if (!actualExitTime && Number(now) >= expectedExitTime) {
    actualExitTime = expectedExitTime;
    exitReason = "time_exit";
  }
  if (!actualExitTime) {
    return {
      ...pendingReview("组合灾难止损尚未触发，继续按小时监控"),
      modelVersion: V33_MODEL.version,
      method: "hourly_close_catastrophe_monitor",
      latestMarkTime: latestMarkTime ? new Date(latestMarkTime).toISOString() : null,
      latestMarkedReturn: round(latestMarkedReturn, 12),
      lowestMarkedReturn: round(lowestMarkedReturn, 12),
      catastropheStop: V33_MODEL.catastropheStop,
      expectedExitTime: new Date(expectedExitTime).toISOString()
    };
  }

  const positions = targets.map((target) => {
    const candles = hourlyCandlesBySymbol.get(target.symbol) || [];
    const exitCandle = candles.find(
      (candle) => Number(candle.openTime) === actualExitTime
    );
    const entryPrice = Number(target.referencePrice);
    const exitPrice = Number(exitCandle?.open);
    const weight = Number(target.targetWeight);
    if (!(entryPrice > 0) || !(exitPrice > 0) || !Number.isFinite(weight)) {
      return null;
    }
    const fundingRows = fundingBySymbol.get(target.symbol);
    if (!Array.isArray(fundingRows)) return null;
    const fundingRate = fundingRows
      .filter((item) =>
        Number(item.fundingTime) > entryTime
        && Number(item.fundingTime) <= actualExitTime
      )
      .reduce((sum, item) => sum + Number(item.fundingRate || 0), 0);
    const priceReturn = exitPrice / entryPrice - 1;
    const direction = Math.sign(weight);
    const directionalPriceReturn = direction * priceReturn;
    const fundingReturn = -direction * fundingRate;
    const positionReturn = directionalPriceReturn
      + fundingReturn
      - V33_MODEL.roundTripCostRate;
    return {
      symbol: target.symbol,
      side: target.side,
      targetWeight: round(weight, 12),
      entryPrice: round(entryPrice, 12),
      exitPrice: round(exitPrice, 12),
      priceReturn: round(priceReturn, 12),
      priceContribution: round(weight * priceReturn, 12),
      fundingRate: round(fundingRate, 12),
      fundingContribution: round(-weight * fundingRate, 12),
      directionalPriceReturn: round(directionalPriceReturn, 12),
      fundingReturn: round(fundingReturn, 12),
      tradingCost: V33_MODEL.roundTripCostRate,
      returnPct: round(positionReturn, 12),
      netContribution: round(Math.abs(weight) * positionReturn, 12),
      outcome: positionReturn > 0 ? "盈利" : positionReturn < 0 ? "亏损" : "持平"
    };
  });
  if (positions.some((position) => !position)) {
    return {
      ...pendingReview("退出小时开盘价或资金费率尚未齐全，下次扫描重试"),
      modelVersion: V33_MODEL.version,
      exitReason,
      actualExitTime: new Date(actualExitTime).toISOString(),
      triggerMarkedReturn: round(triggerMarkedReturn, 12)
    };
  }

  const priceReturn = positions.reduce(
    (sum, position) => sum + position.priceContribution,
    0
  );
  const fundingReturn = positions.reduce(
    (sum, position) => sum + position.fundingContribution,
    0
  );
  const grossExposure = targets.reduce(
    (sum, target) => sum + Math.abs(Number(target.targetWeight || 0)),
    0
  );
  const tradingCost = V33_MODEL.roundTripCostRate * grossExposure;
  const returnPct = priceReturn + fundingReturn - tradingCost;
  const breakerReturnPct = returnPct - tradingCost;
  return {
    status: "reviewed",
    outcome: returnPct > 0 ? "盈利" : returnPct < 0 ? "亏损" : "持平",
    exitReason,
    modelVersion: V33_MODEL.version,
    method: "vol_target_hourly_catastrophe_net_return",
    holdingHours: round((actualExitTime - entryTime) / HOUR_MS, 4),
    entryTime: new Date(entryTime).toISOString(),
    exitTime: new Date(actualExitTime).toISOString(),
    expectedExitTime: new Date(expectedExitTime).toISOString(),
    reviewedAt: new Date(reviewedAt).toISOString(),
    triggerMarkedReturn: round(triggerMarkedReturn, 12),
    latestMarkedReturn: round(latestMarkedReturn, 12),
    lowestMarkedReturn: round(lowestMarkedReturn, 12),
    priceReturn: round(priceReturn, 12),
    fundingReturn: round(fundingReturn, 12),
    tradingCost: round(tradingCost, 12),
    returnPct: round(returnPct, 12),
    breakerReturnPct: round(breakerReturnPct, 12),
    netOfCosts: true,
    positions
  };
}

export function deriveV33BreakerState(runs = []) {
  let equity = 1;
  let highWatermark = 1;
  let cooldownRemaining = 0;
  const chronological = [...runs].sort(
    (a, b) => new Date(a.rebalance_time).getTime() - new Date(b.rebalance_time).getTime()
  );
  for (const run of chronological) {
    const breakerCash = run?.risk_state?.breakerCash === true
      || run?.review?.outcome === "breaker_cash";
    if (breakerCash) {
      if (cooldownRemaining > 0) cooldownRemaining -= 1;
      if (cooldownRemaining === 0) highWatermark = equity;
      continue;
    }
    if (cooldownRemaining > 0) {
      cooldownRemaining -= 1;
      if (cooldownRemaining === 0) highWatermark = equity;
      continue;
    }
    if (run?.review?.status !== "reviewed") continue;
    const periodReturn = Number(
      run.review.breakerReturnPct ?? run.review.returnPct
    );
    if (!Number.isFinite(periodReturn)) continue;
    equity *= Math.max(0, 1 + periodReturn);
    highWatermark = Math.max(highWatermark, equity);
    const drawdown = highWatermark > 0 ? equity / highWatermark - 1 : -1;
    if (drawdown <= -V33_MODEL.breakerDrawdown) {
      cooldownRemaining = V33_MODEL.breakerCooldownWeeks;
    }
  }
  return {
    equity,
    highWatermark,
    currentDrawdown: highWatermark > 0 ? equity / highWatermark - 1 : -1,
    cooldownRemaining
  };
}

export function renderV33PaperEmail(run) {
  const targets = Array.isArray(run?.targets) ? run.targets : [];
  const longs = targets.filter((target) => target.side === "LONG");
  const shorts = targets.filter((target) => target.side === "SHORT");
  const rebalanceTime = new Date(run.rebalance_time).toISOString();
  const risk = run.risk_state || {};
  const date = rebalanceTime.slice(0, 10);
  const subject = `【模拟提醒】本周关注：${longs.length}个看涨 + ${shorts.length}个看跌 | ${date}`;
  const lines = [
    "这是一封模拟交易提醒，不会自动下单。",
    "",
    "系统版本：V3.3（模拟版）",
    `本次记录时间：${rebalanceTime}`,
    `本次总模拟仓位：${formatPercent(run.gross_exposure)}`,
    "",
    "看涨（价格上涨时受益）：",
    ...longs.map(formatPaperTarget),
    "",
    "看跌（价格下跌时受益）：",
    ...shorts.map(formatPaperTarget),
    "",
    "系统会怎样控制风险：",
    `- 如果整个组合的模拟亏损达到 ${formatPercent(risk.catastropheStop)}，会在下一小时开盘时模拟退出。`,
    "- 不设置固定盈利目标，最多观察 7 天。",
    `- 如果模拟账户比之前最高点少了 ${formatPercent(risk.breakerDrawdown)}，暂停建立新仓位 ${risk.breakerCooldownWeeks} 周。`,
    "",
    "说明：模拟占比只是系统用于复盘的仓位比例；参考价是计算时使用的价格，不代表实际成交价。",
    "风险提示：合约价格波动较大。这封邮件只用于模拟验证，不是投资建议。"
  ];
  return { subject, text: lines.join("\n") };
}

async function monitorAndPersistV33PaperRun({ run, now }) {
  if (!run?.targets?.length || run.review?.status === "reviewed") {
    return run?.review || null;
  }
  const hourlyCandlesBySymbol = new Map();
  const fundingBySymbol = new Map();
  const entryTime = new Date(run.rebalance_time).getTime();
  const fundingEnd = Math.min(
    Number(now),
    entryTime + V31_MODEL.rebalanceHours * HOUR_MS
  );
  await mapLimit(run.targets, 5, async (target) => {
    const [candles, funding] = await Promise.all([
      getFuturesCandles(target.symbol, "1h", V33_MODEL.monitorCandleLimit),
      getFuturesFundingHistory(target.symbol, entryTime, fundingEnd)
    ]);
    hourlyCandlesBySymbol.set(target.symbol, candles);
    fundingBySymbol.set(target.symbol, funding);
  });
  const review = reviewV33PaperRun({
    run,
    hourlyCandlesBySymbol,
    fundingBySymbol,
    now
  });
  await updatePaperModelReview({
    modelId: run.model_id,
    rebalanceTime: run.rebalance_time,
    review
  });
  return review;
}

async function tryMonitorV33PaperRun(options) {
  try {
    return await monitorAndPersistV33PaperRun(options);
  } catch (error) {
    return {
      ...pendingReview("监控数据暂不可用，系统将在下次小时扫描重试"),
      modelVersion: V33_MODEL.version,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function sendV33PaperEmailIfNeeded({ modelId, rebalanceTime }) {
  const claimedRun = await claimPaperModelEmail({ modelId, rebalanceTime });
  if (!claimedRun) {
    const current = await fetchPaperModelRun({ modelId, rebalanceTime });
    return {
      emailStatus: current?.email_status || "not_claimed",
      emailSentAt: current?.email_sent_at || null
    };
  }
  const message = renderV33PaperEmail(claimedRun);
  const idempotencyKey = `v33-shadow/${modelId}/${new Date(rebalanceTime).toISOString()}`;
  let sent;
  try {
    sent = await sendEmail({ ...message, idempotencyKey });
  } catch (error) {
    const errorText = error instanceof Error ? error.message : String(error);
    await updatePaperModelEmail({
      modelId,
      rebalanceTime,
      emailStatus: "failed",
      emailResult: { error: errorText }
    });
    throw error;
  }
  if (sent?.skipped) {
    await updatePaperModelEmail({
      modelId,
      rebalanceTime,
      emailStatus: "failed",
      emailResult: summarizePaperEmailResult(sent)
    });
    throw new Error(`V3.3 SHADOW PAPER email skipped: ${sent.reason}`);
  }
  const sentAt = new Date().toISOString();
  await updatePaperModelEmail({
    modelId,
    rebalanceTime,
    emailStatus: "sent",
    emailResult: summarizePaperEmailResult(sent),
    sentAt
  });
  return { emailStatus: "sent", emailSentAt: sentAt };
}

function markedV33PortfolioReturn({
  run,
  hourlyCandlesBySymbol,
  fundingBySymbol,
  candleTime
}) {
  const entryTime = new Date(run.rebalance_time).getTime();
  let markedReturn = -V33_MODEL.roundTripCostRate
    * Number(run.gross_exposure)
    / 2;
  for (const target of run.targets) {
    const candle = (hourlyCandlesBySymbol.get(target.symbol) || [])
      .find((item) => Number(item.openTime) === candleTime);
    const fundingRows = fundingBySymbol.get(target.symbol);
    if (!candle || !Array.isArray(fundingRows)) return null;
    const entryPrice = Number(target.referencePrice);
    const weight = Number(target.targetWeight);
    if (!(entryPrice > 0) || !Number.isFinite(weight)) return null;
    const fundingRate = fundingRows
      .filter((item) =>
        Number(item.fundingTime) > entryTime
        && Number(item.fundingTime) <= candleTime
      )
      .reduce((sum, item) => sum + Number(item.fundingRate || 0), 0);
    markedReturn += weight * (Number(candle.close) / entryPrice - 1);
    markedReturn -= weight * fundingRate;
  }
  return markedReturn;
}

function buildBreakerCashRun({
  rebalanceTime,
  now,
  breakerState,
  remainingAfterRun
}) {
  const rebalanceIso = new Date(rebalanceTime).toISOString();
  return {
    model_id: V33_MODEL.id,
    model_version: V33_MODEL.version,
    rebalance_time: rebalanceIso,
    data_cutoff_time: rebalanceIso,
    state: V33_MODEL.state,
    deployment_gate_passed: false,
    capital_weight: 0,
    predicted_beta: 0,
    gross_exposure: 0,
    eligible_symbols: 0,
    targets: [],
    email_status: "suppressed",
    risk_state: {
      status: "breaker_cash",
      breakerCash: true,
      breakerDrawdown: V33_MODEL.breakerDrawdown,
      breakerCooldownWeeks: V33_MODEL.breakerCooldownWeeks,
      breakerCooldownRemaining: remainingAfterRun,
      breakerEquity: round(breakerState.equity, 12),
      breakerHighWatermark: round(breakerState.highWatermark, 12),
      breakerCurrentDrawdown: round(breakerState.currentDrawdown, 12)
    },
    review: {
      status: "reviewed",
      outcome: "breaker_cash",
      modelVersion: V33_MODEL.version,
      method: "drawdown_breaker_cash",
      holdingHours: 0,
      entryTime: rebalanceIso,
      exitTime: rebalanceIso,
      reviewedAt: new Date(now).toISOString(),
      returnPct: 0,
      breakerReturnPct: 0,
      netOfCosts: true,
      positions: []
    },
    diagnostics: {
      researchGatePassed: false,
      deploymentGatePassed: false,
      reason: "account_drawdown_breaker",
      generatedAt: new Date().toISOString()
    }
  };
}

function buildScanResult({
  run,
  status,
  review,
  email,
  previousReview = null,
  startedAt,
  dataErrors = []
}) {
  return {
    group: "v3-3-paper",
    modelId: V33_MODEL.id,
    modelVersion: V33_MODEL.version,
    state: V33_MODEL.state,
    deploymentGatePassed: false,
    capitalWeight: 0,
    rebalanceTime: run.rebalance_time,
    dataCutoffTime: run.data_cutoff_time,
    status,
    eligibleSymbols: Number(run.eligible_symbols || 0),
    predictedBeta: Number(run.predicted_beta || 0),
    grossExposure: Number(run.gross_exposure || 0),
    riskState: run.risk_state || {},
    targets: run.targets || [],
    review,
    previousReview,
    dataErrors,
    ...email,
    durationMs: Date.now() - startedAt
  };
}

function emptyBreakerState() {
  return {
    equity: 1,
    highWatermark: 1,
    currentDrawdown: 0,
    cooldownRemaining: 0
  };
}

function pendingReview(reason) {
  return { status: "pending", reason };
}

function sampleStandardDeviation(values) {
  if (values.length < 2) return NaN;
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce(
    (sum, value) => sum + (value - average) ** 2,
    0
  ) / (values.length - 1);
  return Math.sqrt(variance);
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function round(value, digits = 8) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function formatPaperTarget(target) {
  const weight = formatPercent(Math.abs(Number(target.targetWeight || 0)));
  const reference = formatNumber(target.referencePrice, 8);
  return `- ${target.symbol} | 模拟占比 ${weight} | 参考价 ${reference}`;
}

function formatPercent(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${(number * 100).toFixed(2)}%` : "N/A";
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
  const workers = Array.from(
    { length: Math.min(limit, queue.length) },
    async () => {
      while (queue.length) await fn(queue.shift());
    }
  );
  await Promise.all(workers);
}
