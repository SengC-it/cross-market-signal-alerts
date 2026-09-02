import { sendEmail } from "./email.js";
import {
  getFuturesCandles,
  getFuturesFundingHistory,
  getFuturesFundingRate,
  getFuturesPremiumIndex
} from "./market-data.js";
import {
  claimPaperModelEmail,
  fetchPaperModelRun,
  fetchPaperModelRunsForModel,
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
const FOUR_HOUR_MS = 4 * HOUR_MS;
const MAX_HOLDING_MS = 48 * HOUR_MS;
const ACCOUNT_RISK = 0.0025;
const MAX_LEVERAGE = 3;
const MAX_OPEN_POSITIONS = 3;
const MAX_AGGREGATE_RISK = 0.005;
const ROUND_TRIP_COST = 0.0012;
const HISTORICAL_GATE_VERSION = "funding_carry_perp_historical_gate_v1";

const UNIVERSE = Object.freeze([
  "BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT", "ADAUSDT",
  "AVAXUSDT", "LINKUSDT", "LTCUSDT", "BCHUSDT", "TRXUSDT", "SUIUSDT", "INJUSDT",
  "NEARUSDT", "APTUSDT", "DOTUSDT", "UNIUSDT", "AAVEUSDT", "FILUSDT"
]);

// This remains disabled until the corrected historical backtest produces a frozen,
// versioned candidate that passes every train/validation/test gate.
export const FUNDING_CARRY_MODEL = Object.freeze({
  id: "funding_carry_perp_trend_filter",
  version: "FUNDING CARRY PERP PAPER 2026-08-02",
  state: "PAPER",
  deploymentGatePassed: false,
  researchGatePassed: false,
  historicalGateVersion: HISTORICAL_GATE_VERSION,
  capitalWeight: 0,
  accountRiskPerTrade: ACCOUNT_RISK,
  maxLeverage: MAX_LEVERAGE,
  maxOpenPositions: MAX_OPEN_POSITIONS,
  maxAggregateRisk: MAX_AGGREGATE_RISK,
  maxHoldingHours: 48,
  roundTripCostRate: ROUND_TRIP_COST,
  entryThreshold: 0.0005,
  exitThreshold: 0.0002,
  confirmationEvents: 2,
  atrMultiplier: 2,
  minStopPct: 0.012,
  trendRules: Object.freeze(["sma50_slope3", "momentum12"]),
  universe: UNIVERSE
});

export const FUNDING_CARRY_MODEL_METADATA = buildModelMetadata({
  modelVersion: FUNDING_CARRY_MODEL.version,
  modelFamily: FUNDING_CARRY_MODEL.id,
  configSnapshot: FUNDING_CARRY_MODEL
});

export async function runFundingCarryPaperScan({ dryRun = false, now = Date.now() } = {}) {
  const startedAt = Date.now();
  const rebalanceTime = latestClosedHour(now);
  const rebalanceIso = new Date(rebalanceTime).toISOString();
  if (!FUNDING_CARRY_MODEL.researchGatePassed) {
    return blockedResult("historical_research_gate_not_passed", startedAt, rebalanceIso);
  }
  if (FUNDING_CARRY_MODEL.state !== "PAPER" || FUNDING_CARRY_MODEL.capitalWeight !== 0) {
    return blockedResult("paper_safety_state_invalid", startedAt, rebalanceIso);
  }
  if (!dryRun && !isSupabaseConfigured()) {
    throw new Error("Funding Carry PAPER requires Supabase persistence");
  }

  const existingRun = dryRun ? null : await fetchPaperModelRun({
    modelId: FUNDING_CARRY_MODEL.id,
    rebalanceTime
  });
  if (existingRun) {
    const review = await tryReviewFundingCarryPaperRun({ run: existingRun, now });
    const email = existingRun.targets?.length
      ? await sendFundingCarryPaperEmailIfNeeded({ modelId: FUNDING_CARRY_MODEL.id, rebalanceTime })
      : { emailStatus: existingRun.email_status || "suppressed" };
    return buildScanResult({ run: existingRun, review, email, status: "already_recorded", startedAt });
  }

  const previousRuns = dryRun ? [] : await fetchPaperModelRunsForModel({
    modelId: FUNDING_CARRY_MODEL.id,
    beforeTime: rebalanceTime,
    limit: 64
  });
  const openTargets = previousRuns
    .filter((run) => run?.review?.status === "pending")
    .flatMap((run) => Array.isArray(run.targets) ? run.targets : []);
  const openSymbols = new Set(openTargets.map((target) => target.symbol).filter(Boolean));
  const existingAggregateRisk = openTargets.reduce((sum, target) => sum + Number(target.accountRisk || 0), 0);
  const diagnostics = {
    generatedAt: new Date().toISOString(),
    dataCutoffTime: rebalanceIso,
    parameters: modelParameters(),
    historicalGatePassed: FUNDING_CARRY_MODEL.researchGatePassed,
    historicalGateVersion: FUNDING_CARRY_MODEL.historicalGateVersion,
    dataErrors: [],
    excludedOpenSymbols: [...openSymbols]
  };
  const candidates = [];
  await mapLimit(FUNDING_CARRY_MODEL.universe, 4, async (symbol) => {
    if (openSymbols.has(symbol)) return;
    try {
      const [hourly, fourHourly, latestFunding, premium, fundingHistory] = await Promise.all([
        getFuturesCandles(symbol, "1h", 160),
        getFuturesCandles(symbol, "4h", 160),
        getFuturesFundingRate(symbol),
        getFuturesPremiumIndex(symbol),
        getFuturesFundingHistory(symbol, rebalanceTime - 24 * HOUR_MS, rebalanceTime + HOUR_MS)
      ]);
      const rate = Number.isFinite(premium?.lastFundingRate)
        ? premium.lastFundingRate
        : Number(latestFunding?.fundingRate);
      const markPrice = Number(premium?.markPrice);
      if (!Number.isFinite(rate) || !Number.isFinite(markPrice) || markPrice <= 0) return;
      const closedFourHourly = closedCandles(fourHourly, now, FOUR_HOUR_MS);
      const trend = trendSnapshot(closedFourHourly, FUNDING_CARRY_MODEL.trendRules);
      const direction = rate > 0 ? -1 : 1;
      if (Math.abs(rate) < FUNDING_CARRY_MODEL.entryThreshold) return;
      if (!trend.ready || !trend[direction > 0 ? "long" : "short"]) return;
      if (!hasFundingConfirmation(fundingHistory, rate, FUNDING_CARRY_MODEL)) return;
      const atrValue = atr(closedFourHourly, 14);
      if (!Number.isFinite(atrValue) || atrValue <= 0) return;
      const stopDistance = Math.max(
        atrValue * FUNDING_CARRY_MODEL.atrMultiplier,
        markPrice * FUNDING_CARRY_MODEL.minStopPct
      );
      const stopPrice = direction > 0 ? markPrice - stopDistance : markPrice + stopDistance;
      const stopPct = stopDistance / markPrice;
      const targetWeight = direction * Math.min(
        FUNDING_CARRY_MODEL.maxLeverage,
        FUNDING_CARRY_MODEL.accountRiskPerTrade / stopPct
      );
      const nextFundingTime = Number(premium?.nextFundingTime || (rebalanceTime + 8 * HOUR_MS));
      candidates.push({
        symbol,
        side: direction > 0 ? "LONG" : "SHORT",
        direction,
        targetWeight,
        accountRisk: Math.abs(targetWeight) * stopPct,
        referencePrice: markPrice,
        stopLoss: stopPrice,
        stopPct,
        fundingRate: rate,
        absFundingRate: Math.abs(rate),
        fundingWindowKey: nextFundingTime,
        nextFundingTime,
        trendRules: FUNDING_CARRY_MODEL.trendRules,
        trend,
        entryTime: rebalanceIso,
        expectedExitTime: new Date(rebalanceTime + MAX_HOLDING_MS).toISOString(),
        maxHoldingHours: FUNDING_CARRY_MODEL.maxHoldingHours,
        modeledRoundTripCostPct: FUNDING_CARRY_MODEL.roundTripCostRate,
        signalKey: `${FUNDING_CARRY_MODEL.id}:${symbol}:${nextFundingTime}:${direction}`,
        score: Math.abs(rate) * 10_000 + (trend.strength || 0)
      });
    } catch (error) {
      diagnostics.dataErrors.push({ symbol, error: error instanceof Error ? error.message : String(error) });
    }
  });

  const targets = selectTargets(candidates, {
    existingOpenCount: openSymbols.size,
    existingAggregateRisk
  });
  const modelMetadata = FUNDING_CARRY_MODEL_METADATA;
  const row = {
    model_id: FUNDING_CARRY_MODEL.id,
    model_version: FUNDING_CARRY_MODEL.version,
    model_fingerprint: modelMetadata.fingerprint,
    code_commit: modelMetadata.codeCommit,
    rebalance_time: rebalanceIso,
    data_cutoff_time: rebalanceIso,
    state: FUNDING_CARRY_MODEL.state,
    deployment_gate_passed: false,
    capital_weight: 0,
    predicted_beta: null,
    gross_exposure: targets.reduce((sum, target) => sum + Math.abs(target.targetWeight), 0),
    eligible_symbols: targets.length,
    targets,
    risk_state: {
      status: "paper_only",
      accountRiskPerTrade: FUNDING_CARRY_MODEL.accountRiskPerTrade,
      maxLeverage: FUNDING_CARRY_MODEL.maxLeverage,
      maxOpenPositions: FUNDING_CARRY_MODEL.maxOpenPositions,
      maxAggregateRisk: FUNDING_CARRY_MODEL.maxAggregateRisk,
      openPositionCount: openSymbols.size + targets.length,
      aggregateRisk: existingAggregateRisk + targets.reduce((sum, target) => sum + target.accountRisk, 0),
      currentRisk: existingAggregateRisk + targets.reduce((sum, target) => sum + target.accountRisk, 0),
      maxHoldingHours: FUNDING_CARRY_MODEL.maxHoldingHours,
      roundTripCostRate: FUNDING_CARRY_MODEL.roundTripCostRate
    },
    diagnostics: {
      ...diagnostics,
      modelMetadata,
      candidateCount: candidates.length,
      generatedAt: new Date().toISOString()
    },
    review: targets.length ? pendingReview("等待小时收盘复盘；最长持仓 48 小时") : null
  };
  if (dryRun) return buildScanResult({ run: row, review: row.review, email: { emailStatus: "dry_run" }, status: "dry_run", startedAt });
  await recordPaperModelRun(row);
  const email = targets.length
    ? await sendFundingCarryPaperEmailIfNeeded({ modelId: row.model_id, rebalanceTime })
    : { emailStatus: "suppressed", reason: "no_eligible_targets" };
  return buildScanResult({ run: row, review: row.review, email, status: "recorded", startedAt });
}

export function reviewFundingCarryPaperRun({ run, hourlyCandlesBySymbol = new Map(), fourHourlyBySymbol = new Map(), fundingBySymbol = new Map(), now = Date.now(), reviewedAt = Date.now() }) {
  const targets = Array.isArray(run?.targets) ? run.targets : [];
  const entryTime = new Date(run?.rebalance_time).getTime();
  if (!Number.isFinite(entryTime) || !targets.length) {
    return pendingReview("暂无可复盘的 Funding Carry PAPER 持仓");
  }
  const positions = targets.map((target) => reviewPosition({
    target,
    entryTime,
    hourlyCandles: hourlyCandlesBySymbol.get(target.symbol) || [],
    fourHourlyCandles: fourHourlyBySymbol.get(target.symbol) || [],
    fundingRows: fundingBySymbol.get(target.symbol) || [],
    now
  }));
  const completed = positions.every((position) => position.status === "reviewed");
  const marked = positions.filter((position) => position.markTime).sort((a, b) => new Date(b.markTime).getTime() - new Date(a.markTime).getTime())[0] || null;
  const accountReturn = positions.reduce((sum, position) => sum + Number(position.netContribution || 0), 0);
  return {
    status: completed ? "reviewed" : "pending",
    modelVersion: run.model_version || FUNDING_CARRY_MODEL.version,
    method: "perpetual_price_funding_trend_stop_review",
    outcome: completed ? (accountReturn > 0 ? "盈利" : accountReturn < 0 ? "亏损" : "持平") : "持仓中",
    entryTime: new Date(entryTime).toISOString(),
    markTime: marked?.markTime || null,
    exitTime: completed ? positions.reduce((latest, position) => position.exitTime > latest ? position.exitTime : latest, positions[0].exitTime) : null,
    reviewedAt: new Date(reviewedAt).toISOString(),
    holdingHours: completed ? mean(positions.map((position) => position.holdingHours)) : mean(positions.filter((position) => position.holdingHours != null).map((position) => position.holdingHours)),
    returnPct: accountReturn,
    netOfCosts: true,
    positions
  };
}

export function evaluateFundingCarryPaperGate(runs = []) {
  const seenFundingWindows = new Set();
  let duplicateEntryCount = 0;
  let wrongDirectionCount = 0;
  let unprocessedExitCount = 0;
  let emailAnomalyCount = 0;
  for (const run of runs) {
    const expectedEmailStates = Array.isArray(run?.targets) && run.targets.length ? ["sent"] : ["suppressed", "sent"];
    if (run?.email_status && !expectedEmailStates.includes(run.email_status)) emailAnomalyCount++;
    for (const target of Array.isArray(run?.targets) ? run.targets : []) {
      const fundingWindow = target.fundingWindowKey || target.nextFundingTime || run.rebalance_time;
      const key = `${target.symbol}:${fundingWindow}`;
      if (seenFundingWindows.has(key)) duplicateEntryCount++;
      seenFundingWindows.add(key);
      const fundingRate = Number(target.fundingRate);
      const expectedSide = fundingRate > 0 ? "SHORT" : fundingRate < 0 ? "LONG" : null;
      if (!expectedSide || target.side !== expectedSide) wrongDirectionCount++;
    }
    if (run?.review?.status === "reviewed") {
      for (const position of Array.isArray(run.review.positions) ? run.review.positions : []) {
        if (position.status !== "reviewed" || !position.exitReason) unprocessedExitCount++;
      }
    }
  }
  const positions = runs
    .flatMap((run) => Array.isArray(run?.review?.positions) ? run.review.positions.map((position) => ({ ...position, run })) : [])
    .filter((position) => position.run?.review?.status === "reviewed" && Number.isFinite(Number(position.returnPct)));
  const ordered = positions.sort((a, b) => new Date(a.exitTime || a.markTime || a.run.rebalance_time).getTime() - new Date(b.exitTime || b.markTime || b.run.rebalance_time).getTime());
  const returns = ordered.map((position) => Number(position.netContribution ?? position.returnPct ?? 0));
  const grossProfit = returns.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const grossLoss = returns.filter((value) => value < 0).reduce((sum, value) => sum + value, 0);
  let equity = 1;
  let peak = 1;
  let maxDrawdown = 0;
  for (const value of returns) {
    equity *= 1 + value;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.min(maxDrawdown, equity / peak - 1);
  }
  const weeks = new Map();
  const symbolContribution = new Map();
  for (const position of ordered) {
    const time = new Date(position.exitTime || position.markTime || position.run.rebalance_time).getTime();
    const week = new Date(Math.floor(time / (7 * 24 * HOUR_MS)) * 7 * 24 * HOUR_MS).toISOString().slice(0, 10);
    weeks.set(week, (weeks.get(week) || 1) * (1 + Number(position.netContribution ?? position.returnPct ?? 0)));
    symbolContribution.set(position.symbol, (symbolContribution.get(position.symbol) || 0) + Math.abs(Number(position.netContribution ?? position.returnPct ?? 0)));
  }
  const weekReturns = [...weeks.values()].map((value) => value - 1);
  const entryTimes = ordered.map((position) => new Date(position.run.rebalance_time).getTime()).sort((a, b) => a - b);
  const gaps = entryTimes.slice(1).map((time, index) => (time - entryTimes[index]) / (24 * HOUR_MS));
  const totalSymbolContribution = [...symbolContribution.values()].reduce((sum, value) => sum + value, 0);
  const largestSymbolShare = totalSymbolContribution > 0 ? Math.max(...[...symbolContribution.values()].map((value) => value / totalSymbolContribution)) : 0;
  const dataRuns = runs.filter((run) => run?.diagnostics);
  const completeRuns = dataRuns.filter((run) => !run.diagnostics.dataErrors?.length).length;
  const costStressReturns = ordered.map((position) => {
    const gross = Number(position.grossContribution ?? position.netContribution ?? position.returnPct ?? 0) + Number(position.tradingCostContribution || 0);
    const cost = Math.abs(Number(position.tradingCostContribution || 0)) * 1.5;
    return gross - cost;
  });
  const stressProfit = costStressReturns.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const stressLoss = costStressReturns.filter((value) => value < 0).reduce((sum, value) => sum + value, 0);
  const metrics = {
    closedTrades: ordered.length,
    totalReturn: equity - 1,
    averageNetReturn: mean(returns),
    profitFactor: grossLoss < 0 ? grossProfit / Math.abs(grossLoss) : grossProfit > 0 ? Infinity : 0,
    maxDrawdown,
    positiveWeekRate: weekReturns.length ? weekReturns.filter((value) => value > 0).length / weekReturns.length : 0,
    weeks: weekReturns.length,
    maxSignalGapDays: gaps.length ? Math.max(...gaps) : null,
    largestSymbolShare,
    dataCompleteness: dataRuns.length ? completeRuns / dataRuns.length : 0,
    costStressAverageNetReturn: mean(costStressReturns),
    costStressProfitFactor: stressLoss < 0 ? stressProfit / Math.abs(stressLoss) : stressProfit > 0 ? Infinity : 0,
    duplicateEntryCount,
    wrongDirectionCount,
    unprocessedExitCount,
    emailAnomalyCount
  };
  const checks = {
    duration: durationWeeks(runs) >= 8,
    sample: metrics.closedTrades >= 24,
    weeklyProfitability: metrics.positiveWeekRate >= 0.5,
    averagePositive: metrics.averageNetReturn > 0,
    profitFactor: metrics.profitFactor >= 1.15,
    drawdown: Math.abs(metrics.maxDrawdown) <= 0.2,
    signalGap: metrics.maxSignalGapDays == null || metrics.maxSignalGapDays <= 14,
    concentration: metrics.largestSymbolShare <= 0.3,
    dataCompleteness: metrics.dataCompleteness >= 0.95,
    costStress: metrics.costStressAverageNetReturn > 0 && metrics.costStressProfitFactor >= 1.05,
    executionClean: metrics.duplicateEntryCount === 0
      && metrics.wrongDirectionCount === 0
      && metrics.unprocessedExitCount === 0
      && metrics.emailAnomalyCount === 0
  };
  return { passed: Object.values(checks).every(Boolean), checks, metrics, passedCount: Object.values(checks).filter(Boolean).length };
}

export function renderFundingCarryPaperEmail(run, { performanceSnapshot = null } = {}) {
  const targets = Array.isArray(run?.targets) ? run.targets : [];
  const rebalanceTime = new Date(run.rebalance_time).toISOString();
  const snapshot = performanceSnapshot || paperEmailPerformanceSnapshot(run, {
    modelId: FUNDING_CARRY_MODEL.id,
    modelLabel: "Funding Carry V1",
    basis: "Production PAPER 已完成周期"
  });
  const lines = [
    `[PAPER] Funding Carry 永续合约观察（不执行交易）`,
    ...performanceEmailLines(snapshot),
    `模型：${run.model_version || FUNDING_CARRY_MODEL.version}`,
    `时间：${rebalanceTime}`,
    `状态：PAPER；策略资金权重 0%；系统不会连接交易账户`,
    `规则：正 funding 做空，负 funding 做多；趋势反转、funding 失效、ATR 止损或 48 小时后退出`,
    `成本假设：往返 ${formatPercent(FUNDING_CARRY_MODEL.roundTripCostRate)}；单笔账户风险上限 ${formatPercent(FUNDING_CARRY_MODEL.accountRiskPerTrade)}`,
    "",
    ...targets.map((target) => [
      `${target.symbol} ${target.side} | funding ${formatPercent(target.fundingRate)} | 趋势 ${target.trendRules.join("+")}`,
      `模拟入场 ${formatNumber(target.referencePrice)} | 止损 ${formatNumber(target.stopLoss)} | 最迟退出 ${target.expectedExitTime}`,
      `模拟权重 ${formatPercent(target.targetWeight)} | 下一 funding ${new Date(target.nextFundingTime).toISOString()}`
    ].join("\n")),
    "",
    "这是 PAPER 复盘数据，不是交易指令；历史 Gate 或 8 周 PAPER Gate 未通过前，不会进入 LIVE。"
  ];
  return { subject: `[PAPER] Funding Carry ${targets.length} 个永续观察窗口`, text: lines.join("\n") };
}

export function isFundingCarryPaperEmailReady(run) {
  return Array.isArray(run?.targets) && run.targets.length > 0;
}

function reviewPosition({ target, entryTime, hourlyCandles, fourHourlyCandles, fundingRows, now }) {
  const candles = closedCandles(hourlyCandles, now, HOUR_MS).filter((candle) => candle.openTime >= entryTime);
  const first = candles[0];
  if (!first) return pendingPosition(target, entryTime, "等待首根已收盘 1h K 线");
  const direction = Number(target.direction || (target.side === "LONG" ? 1 : -1));
  const entryPrice = Number(target.referencePrice);
  const stopPrice = Number(target.stopLoss);
  const maxExitTime = entryTime + MAX_HOLDING_MS;
  let exit = null;
  for (const candle of candles) {
    if (candle.openTime > maxExitTime) break;
    const stopHit = direction > 0 ? candle.low <= stopPrice : candle.high >= stopPrice;
    if (stopHit) {
      const gapFill = direction > 0 ? candle.open <= stopPrice : candle.open >= stopPrice;
      exit = { time: candle.openTime, price: gapFill ? candle.open : stopPrice, reason: "atr_stop" };
      break;
    }
    const invalidFunding = fundingRows.some((row) =>
      Number(row.fundingTime) > entryTime
      && Number(row.fundingTime) <= candle.openTime
      && (Math.sign(Number(row.fundingRate)) !== Math.sign(Number(target.fundingRate)) || Math.abs(Number(row.fundingRate)) < FUNDING_CARRY_MODEL.exitThreshold)
    );
    if (invalidFunding) {
      exit = { time: candle.openTime, price: candle.open, reason: "funding_threshold" };
      break;
    }
    if (candle.openTime >= maxExitTime) {
      exit = { time: candle.openTime, price: candle.open, reason: "max_holding" };
      break;
    }
    if (candle.openTime > entryTime && candle.openTime % FOUR_HOUR_MS === 0) {
      const trendCandles = closedCandles(fourHourlyCandles, candle.openTime, FOUR_HOUR_MS);
      const trend = trendSnapshot(trendCandles, FUNDING_CARRY_MODEL.trendRules);
      if (trend.ready && !trend[direction > 0 ? "long" : "short"]) {
        exit = { time: candle.openTime, price: candle.open, reason: "trend_reversal" };
        break;
      }
    }
  }
  const pending = !exit;
  const markCandle = candles.at(-1);
  const exitTime = exit?.time || markCandle?.openTime;
  const exitPrice = exit?.price || markCandle?.close;
  if (!(entryPrice > 0) || !(exitPrice > 0) || !Number.isFinite(exitTime)) {
    return pendingPosition(target, entryTime, "等待有效价格数据");
  }
  const priceReturn = direction * (exitPrice / entryPrice - 1);
  const fundingReturn = -direction * fundingRows
    .filter((row) => Number(row.fundingTime) > entryTime && Number(row.fundingTime) <= exitTime)
    .reduce((sum, row) => sum + Number(row.fundingRate || 0), 0);
  const weight = Math.abs(Number(target.targetWeight || 0));
  const tradingCost = FUNDING_CARRY_MODEL.roundTripCostRate;
  const netReturn = priceReturn + fundingReturn - tradingCost;
  const netContribution = weight * netReturn;
  return {
    symbol: target.symbol,
    side: target.side,
    status: pending ? "pending" : "reviewed",
    outcome: pending ? (netReturn > 0 ? "持仓中盈利" : netReturn < 0 ? "持仓中亏损" : "持仓中持平") : (netReturn > 0 ? "盈利" : netReturn < 0 ? "亏损" : "持平"),
    entryTime: new Date(entryTime).toISOString(),
    markTime: new Date(exitTime).toISOString(),
    exitTime: pending ? null : new Date(exitTime).toISOString(),
    exitReason: pending ? null : exit.reason,
    holdingHours: (exitTime - entryTime) / HOUR_MS,
    entryPrice,
    markPrice: exitPrice,
    exitPrice: pending ? null : exitPrice,
    priceReturn,
    directionalPriceReturn: priceReturn,
    fundingReturn,
    tradingCost,
    returnPct: netReturn,
    grossReturn: priceReturn + fundingReturn,
    netContribution,
    grossContribution: weight * (priceReturn + fundingReturn),
    tradingCostContribution: weight * tradingCost,
    netOfCosts: true
  };
}

function pendingPosition(target, entryTime, reason) {
  return {
    symbol: target.symbol,
    side: target.side,
    status: "pending",
    outcome: "持仓中",
    entryTime: new Date(entryTime).toISOString(),
    markTime: null,
    exitTime: null,
    reason,
    returnPct: null,
    netContribution: null
  };
}

async function tryReviewFundingCarryPaperRun({ run, now }) {
  if (!run?.targets?.length || run.review?.status === "reviewed") return run?.review || null;
  const hourlyCandlesBySymbol = new Map();
  const fourHourlyBySymbol = new Map();
  const fundingBySymbol = new Map();
  const entryTime = new Date(run.rebalance_time).getTime();
  await mapLimit(run.targets, 4, async (target) => {
    const [candles, fourHourly, funding] = await Promise.all([
      getFuturesCandles(target.symbol, "1h", 160),
      getFuturesCandles(target.symbol, "4h", 160),
      getFuturesFundingHistory(target.symbol, entryTime, Math.min(Number(now), entryTime + MAX_HOLDING_MS))
    ]);
    hourlyCandlesBySymbol.set(target.symbol, candles);
    fourHourlyBySymbol.set(target.symbol, fourHourly);
    fundingBySymbol.set(target.symbol, funding);
  });
  const review = reviewFundingCarryPaperRun({ run, hourlyCandlesBySymbol, fourHourlyBySymbol, fundingBySymbol, now });
  await updatePaperModelReview({ modelId: run.model_id, rebalanceTime: run.rebalance_time, review });
  return review;
}

async function sendFundingCarryPaperEmailIfNeeded({ modelId, rebalanceTime }) {
  const current = await fetchPaperModelRun({ modelId, rebalanceTime });
  if (!current) return { emailStatus: "not_found" };
  if (!["pending", "failed"].includes(current.email_status)) {
    return { emailStatus: current.email_status || "not_claimed", emailSentAt: current.email_sent_at || null };
  }
  if (!isFundingCarryPaperEmailReady(current)) return { emailStatus: "suppressed", deferredReason: "no_targets" };
  const claimed = await claimPaperModelEmail({ modelId, rebalanceTime });
  if (!claimed) {
    const refreshed = await fetchPaperModelRun({ modelId, rebalanceTime });
    return { emailStatus: refreshed?.email_status || "not_claimed", emailSentAt: refreshed?.email_sent_at || null };
  }
  const idempotencyKey = `funding-carry-paper/${modelId}/${new Date(rebalanceTime).toISOString()}`;
  try {
    const performanceSnapshot = await loadPaperEmailPerformanceSnapshot({
      modelId,
      modelLabel: "Funding Carry V1",
      basis: "Production PAPER 已完成周期",
      fallbackRuns: [claimed]
    });
    const sent = await sendEmail({
      ...renderFundingCarryPaperEmail(claimed, { performanceSnapshot }),
      idempotencyKey
    });
    if (sent?.skipped) throw new Error(`Funding Carry PAPER email skipped: ${sent.reason}`);
    const sentAt = new Date().toISOString();
    await updatePaperModelEmail({ modelId, rebalanceTime, emailStatus: "sent", emailResult: summarizeEmail(sent), sentAt });
    return { emailStatus: "sent", emailSentAt: sentAt };
  } catch (error) {
    const errorText = error instanceof Error ? error.message : String(error);
    await updatePaperModelEmail({ modelId, rebalanceTime, emailStatus: "failed", emailResult: { error: errorText } });
    throw error;
  }
}

function selectTargets(candidates, { existingOpenCount = 0, existingAggregateRisk = 0 } = {}) {
  const selected = [];
  let aggregateRisk = existingAggregateRisk;
  const maxNewPositions = Math.max(0, MAX_OPEN_POSITIONS - existingOpenCount);
  for (const candidate of [...candidates].sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol))) {
    if (selected.length >= maxNewPositions) break;
    if (aggregateRisk + candidate.accountRisk > MAX_AGGREGATE_RISK + 1e-12) continue;
    if (selected.some((target) => target.symbol === candidate.symbol && target.fundingWindowKey === candidate.fundingWindowKey)) continue;
    selected.push(candidate);
    aggregateRisk += candidate.accountRisk;
  }
  return selected;
}

function modelParameters() {
  return {
    entryThreshold: FUNDING_CARRY_MODEL.entryThreshold,
    exitThreshold: FUNDING_CARRY_MODEL.exitThreshold,
    confirmationEvents: FUNDING_CARRY_MODEL.confirmationEvents,
    atrMultiplier: FUNDING_CARRY_MODEL.atrMultiplier,
    minStopPct: FUNDING_CARRY_MODEL.minStopPct,
    trendRules: FUNDING_CARRY_MODEL.trendRules,
    maxHoldingHours: FUNDING_CARRY_MODEL.maxHoldingHours,
    roundTripCostRate: FUNDING_CARRY_MODEL.roundTripCostRate
  };
}

function hasFundingConfirmation(rows, rate, model) {
  const relevant = (rows || []).filter((row) => Number.isFinite(Number(row.fundingRate))).sort((a, b) => Number(a.fundingTime) - Number(b.fundingTime));
  if (relevant.length < model.confirmationEvents) return false;
  const sign = Math.sign(rate);
  return relevant.slice(-model.confirmationEvents).every((row) =>
    Math.sign(Number(row.fundingRate)) === sign
    && Math.abs(Number(row.fundingRate)) >= model.entryThreshold
  );
}

function trendSnapshot(candles, ruleIds) {
  const rows = candles || [];
  const closes = rows.map((row) => Number(row.close)).filter((value) => value > 0);
  const requiredBars = Math.max(60, ...(ruleIds || []).map((ruleId) => {
    const match = /^(?:sma|ema)(20|50|100)_slope(3|6|12)$/.exec(ruleId);
    if (match) return Number(match[1]) + Number(match[2]) + 1;
    const momentum = /^momentum(6|12|24)$/.exec(ruleId);
    return momentum ? Number(momentum[1]) + 1 : 60;
  }));
  if (closes.length < requiredBars) return { long: false, short: false, ready: false, strength: 0, details: {} };
  const details = {};
  let long = true;
  let short = true;
  for (const ruleId of ruleIds || []) {
    let ruleLong = false;
    let ruleShort = false;
    let value = null;
    const maMatch = /^(sma|ema)(20|50|100)_slope(3|6|12)$/.exec(ruleId);
    const momentumMatch = /^momentum(6|12|24)$/.exec(ruleId);
    if (maMatch) {
      const kind = maMatch[1];
      const period = Number(maMatch[2]);
      const slopeBars = Number(maMatch[3]);
      const ma = kind === "ema" ? ema(closes, period) : sma(closes, period);
      const priorValues = closes.slice(0, -slopeBars);
      const prior = kind === "ema" ? ema(priorValues, period) : sma(priorValues, period);
      value = ma;
      ruleLong = Number.isFinite(ma) && Number.isFinite(prior) && closes.at(-1) > ma && ma > prior;
      ruleShort = Number.isFinite(ma) && Number.isFinite(prior) && closes.at(-1) < ma && ma < prior;
    } else if (momentumMatch) {
      const lookback = Number(momentumMatch[1]);
      value = closes.at(-1) / closes.at(-(lookback + 1)) - 1;
      ruleLong = value > 0;
      ruleShort = value < 0;
    }
    details[ruleId] = { long: ruleLong, short: ruleShort, value };
    long &&= ruleLong;
    short &&= ruleShort;
  }
  const strength = Object.values(details).reduce((sum, item) => sum + Math.abs(Number(item.value) || 0), 0) * 100;
  return { long, short, ready: true, strength, details };
}

function atr(candles, period) {
  if (!Array.isArray(candles) || candles.length <= period) return null;
  let total = 0;
  for (let index = candles.length - period; index < candles.length; index++) {
    const previous = candles[index - 1]?.close ?? candles[index].close;
    total += Math.max(
      candles[index].high - candles[index].low,
      Math.abs(candles[index].high - previous),
      Math.abs(candles[index].low - previous)
    );
  }
  return total / period;
}

function sma(values, period) {
  if (values.length < period) return null;
  return values.slice(-period).reduce((sum, value) => sum + value, 0) / period;
}

function ema(values, period) {
  if (values.length < period) return null;
  const alpha = 2 / (period + 1);
  let result = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  for (const value of values.slice(period)) result = alpha * value + (1 - alpha) * result;
  return result;
}

function closedCandles(candles, now, intervalMs) {
  return (candles || []).filter((candle) => Number(candle.openTime) + intervalMs <= Number(now));
}

function latestClosedHour(now) {
  return Math.floor(Number(now) / HOUR_MS) * HOUR_MS - HOUR_MS;
}

function pendingReview(reason) {
  return { status: "pending", reason, modelVersion: FUNDING_CARRY_MODEL.version };
}

function blockedResult(reason, startedAt, rebalanceTime) {
  return {
    group: "funding-carry-paper",
    modelId: FUNDING_CARRY_MODEL.id,
    modelVersion: FUNDING_CARRY_MODEL.version,
    state: "PAPER",
    deploymentGatePassed: false,
    historicalGateVersion: FUNDING_CARRY_MODEL.historicalGateVersion,
    capitalWeight: 0,
    rebalanceTime,
    status: "blocked_by_research_gate",
    reason,
    targets: [],
    emailStatus: "suppressed",
    durationMs: Date.now() - startedAt
  };
}

function buildScanResult({ run, review, email, status, startedAt }) {
  return {
    group: "funding-carry-paper",
    modelId: run.model_id,
    modelVersion: run.model_version,
    state: run.state,
    deploymentGatePassed: run.deployment_gate_passed === true,
    historicalGateVersion: run.diagnostics?.historicalGateVersion || FUNDING_CARRY_MODEL.historicalGateVersion,
    capitalWeight: Number(run.capital_weight || 0),
    rebalanceTime: run.rebalance_time,
    status,
    targets: run.targets || [],
    review,
    ...email,
    durationMs: Date.now() - startedAt
  };
}

function summarizeEmail(sent) {
  return {
    messageId: sent?.messageId || null,
    accepted: sent?.accepted || null,
    response: sent?.response || null
  };
}

function formatPercent(value) {
  return `${(Number(value || 0) * 100).toFixed(3)}%`;
}

function formatNumber(value) {
  return Number.isFinite(Number(value)) ? Number(value).toLocaleString("en-US", { maximumFractionDigits: 8 }) : "n/a";
}

function mean(values) {
  const filtered = values.filter((value) => Number.isFinite(Number(value)));
  return filtered.length ? filtered.reduce((sum, value) => sum + Number(value), 0) / filtered.length : null;
}

function durationWeeks(runs) {
  const times = runs
    .map((run) => new Date(run?.rebalance_time).getTime())
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (times.length < 2) return 0;
  return (times.at(-1) - times[0]) / (7 * 24 * HOUR_MS);
}

async function mapLimit(items, limit, worker) {
  const results = [];
  let cursor = 0;
  async function consume() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => consume()));
  return results;
}
