import { sendEmail } from "./email.js";
import {
  getFuturesCandles,
  getFuturesFundingHistory,
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

const HOUR_MS = 60 * 60 * 1000;
const FOUR_HOUR_MS = 4 * HOUR_MS;
const FUNDING_INTERVAL_MS = 8 * HOUR_MS;
const ACCOUNT_RISK = 0.0025;
const MAX_LEVERAGE = 3;
const MAX_OPEN_POSITIONS = 3;
const MAX_AGGREGATE_RISK = 0.005;
const ROUND_TRIP_COST = 0.0012;
const VOLATILITY_LOOKBACK = 90;
const VOLATILITY_PERCENTILE = 0.9;
const HISTORICAL_GATE_VERSION = "funding_carry_perp_v2_historical_gate_v1";
const PAPER_SCAN_CONCURRENCY = Math.max(4, Number(process.env.FUNDING_CARRY_V2_SCAN_CONCURRENCY || 32));

// This is the frozen acquisition result from Train-only selection on 2023-2024.
// It is intentionally independent of the current ticker ranking.
export const FUNDING_CARRY_V2_UNIVERSE = Object.freeze([
  "BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT", "BNBUSDT", "LTCUSDT", "LINKUSDT",
  "AVAXUSDT", "ADAUSDT", "OPUSDT", "1000SHIBUSDT", "APTUSDT", "FILUSDT", "BCHUSDT", "NEARUSDT",
  "ETCUSDT", "DOTUSDT", "INJUSDT", "GALAUSDT", "APEUSDT", "FETUSDT", "DYDXUSDT", "CRVUSDT",
  "LDOUSDT", "ATOMUSDT", "TRBUSDT", "UNIUSDT", "SANDUSDT", "GMTUSDT", "AAVEUSDT", "TRXUSDT",
  "RUNEUSDT", "MKRUSDT", "AXSUSDT", "PEOPLEUSDT", "GRTUSDT", "WAVESUSDT", "CHZUSDT", "1000LUNCUSDT",
  "MANAUSDT", "ICPUSDT", "JASMYUSDT", "OCEANUSDT", "XLMUSDT", "CELOUSDT", "ALGOUSDT", "IMXUSDT",
  "SUSHIUSDT", "ENSUSDT", "SNXUSDT", "ARUSDT", "THETAUSDT", "UNFIUSDT", "HBARUSDT", "NEOUSDT",
  "STORJUSDT", "FLOWUSDT", "COMPUSDT", "MAGICUSDT", "XMRUSDT", "ZECUSDT", "LUNA2USDT", "KAVAUSDT",
  "VETUSDT", "ROSEUSDT", "STMXUSDT", "EGLDUSDT", "1INCHUSDT", "LPTUSDT", "WOOUSDT", "ZRXUSDT",
  "ZILUSDT", "YFIUSDT", "ENJUSDT", "RSRUSDT", "C98USDT", "STGUSDT", "BELUSDT", "KNCUSDT",
  "ARPAUSDT", "COTIUSDT", "API3USDT", "OMGUSDT", "OGNUSDT", "IOTAUSDT", "GTCUSDT", "BANDUSDT",
  "KSMUSDT", "ALICEUSDT", "FLMUSDT", "RLCUSDT", "REEFUSDT", "ZENUSDT", "DASHUSDT", "LRCUSDT",
  "KLAYUSDT", "ICXUSDT", "SKLUSDT", "BATUSDT"
]);

// The historical search is deliberately not considered passed until its JSON
// result is reviewed and this object is changed in a separate release.
export const FUNDING_CARRY_V2_MODEL = Object.freeze({
  id: "funding_carry_perp_reversion_ema100_v2",
  version: "FUNDING CARRY PERP Z-SCORE V2 REVERSION EMA100 PAPER 2026-08-02",
  state: "PAPER",
  deploymentGatePassed: false,
  researchGatePassed: true,
  historicalGateVersion: HISTORICAL_GATE_VERSION,
  capitalWeight: 0,
  accountRiskPerTrade: ACCOUNT_RISK,
  maxLeverage: MAX_LEVERAGE,
  maxOpenPositions: MAX_OPEN_POSITIONS,
  maxAggregateRisk: MAX_AGGREGATE_RISK,
  maxHoldingHours: 48,
  allowedMaxHoldingHours: Object.freeze([24, 48, 72]),
  roundTripCostRate: ROUND_TRIP_COST,
  zWindow: 90,
  entrySignedZ: 1,
  minAbsFunding: 0.0002,
  exitSignedZ: 0.5,
  confirmationEvents: 2,
  atrMultiplier: 2,
  minStopPct: 0.012,
  volatilityLookback: VOLATILITY_LOOKBACK,
  volatilityPercentile: VOLATILITY_PERCENTILE,
  trendRules: Object.freeze(["ema100_slope12"]),
  fundingReversion: true,
  universe: FUNDING_CARRY_V2_UNIVERSE
});

export const FUNDING_CARRY_V2_MODEL_METADATA = buildModelMetadata({
  modelVersion: FUNDING_CARRY_V2_MODEL.version,
  modelFamily: FUNDING_CARRY_V2_MODEL.id,
  configSnapshot: FUNDING_CARRY_V2_MODEL
});

export function calculateFundingZScore(rows, window, currentIndex = rows.length - 1) {
  const ordered = (rows || [])
    .map((row) => ({ fundingTime: Number(row.fundingTime), fundingRate: Number(row.fundingRate) }))
    .filter((row) => Number.isFinite(row.fundingTime) && Number.isFinite(row.fundingRate))
    .sort((a, b) => a.fundingTime - b.fundingTime);
  const current = ordered[currentIndex];
  if (!current || currentIndex < window) return null;
  const prior = ordered.slice(currentIndex - window, currentIndex).map((row) => row.fundingRate);
  const average = prior.reduce((sum, value) => sum + value, 0) / prior.length;
  const variance = prior.reduce((sum, value) => sum + (value - average) ** 2, 0) / prior.length;
  const standardDeviation = Math.sqrt(variance);
  if (!(standardDeviation > 0)) return null;
  const z = (current.fundingRate - average) / standardDeviation;
  return {
    fundingTime: current.fundingTime,
    fundingRate: current.fundingRate,
    mean: average,
    standardDeviation,
    z,
    signedZ: Math.sign(current.fundingRate) * z
  };
}

export function fundingDirection(fundingRate) {
  const value = Number(fundingRate);
  return value > 0 ? -1 : value < 0 ? 1 : 0;
}

export function fundingReversionPasses(previousFundingRate, currentFundingRate, direction) {
  const previous = Number(previousFundingRate);
  const current = Number(currentFundingRate);
  if (!Number.isFinite(previous) || !Number.isFinite(current) || !direction) return false;
  return direction > 0 ? current > previous : current < previous;
}

export function volatilitySnapshot(candles, index = (candles || []).length - 1, lookback = VOLATILITY_LOOKBACK, percentileRatio = VOLATILITY_PERCENTILE) {
  const atrValue = atrAt(candles, index, 14);
  const close = Number(candles?.[index]?.close);
  if (!(atrValue > 0) || !(close > 0)) return { valid: false, atr: null, atrPct: null, cap: null };
  const atrPct = atrValue / close;
  const prior = (candles || []).slice(Math.max(0, index - lookback), index)
    .map((_, cursor, source) => {
      const actualIndex = Math.max(0, index - lookback) + cursor;
      const value = atrAt(candles, actualIndex, 14);
      const candleClose = Number(candles?.[actualIndex]?.close);
      return value > 0 && candleClose > 0 ? value / candleClose : null;
    })
    .filter(Number.isFinite);
  const cap = percentile(prior, percentileRatio);
  return { valid: Number.isFinite(cap) && atrPct <= cap, atr: atrValue, atrPct, cap };
}

export async function runFundingCarryV2PaperScan({ dryRun = false, now = Date.now() } = {}) {
  const startedAt = Date.now();
  const rebalanceTime = latestClosedHour(now);
  const rebalanceIso = new Date(rebalanceTime).toISOString();
  if (!FUNDING_CARRY_V2_MODEL.researchGatePassed) {
    return blockedResult("historical_research_gate_not_passed", startedAt, rebalanceIso);
  }
  if (FUNDING_CARRY_V2_MODEL.state !== "PAPER" || FUNDING_CARRY_V2_MODEL.capitalWeight !== 0) {
    return blockedResult("paper_safety_state_invalid", startedAt, rebalanceIso);
  }
  if (!dryRun && !isSupabaseConfigured()) throw new Error("Funding Carry V2 PAPER requires Supabase persistence");

  const existingRun = dryRun ? null : await fetchPaperModelRun({ modelId: FUNDING_CARRY_V2_MODEL.id, rebalanceTime });
  if (existingRun) {
    const review = await tryReviewFundingCarryV2PaperRun({ run: existingRun, now });
    const email = existingRun.targets?.length
      ? await sendFundingCarryV2PaperEmailIfNeeded({ modelId: existingRun.model_id, rebalanceTime })
      : { emailStatus: existingRun.email_status || "suppressed" };
    return buildScanResult({ run: existingRun, review, email, status: "already_recorded", startedAt });
  }

  const previousRuns = dryRun ? [] : await fetchPaperModelRunsForModel({
    modelId: FUNDING_CARRY_V2_MODEL.id,
    beforeTime: rebalanceTime,
    limit: 64
  });
  const openTargets = previousRuns
    .filter((run) => run?.review?.status === "pending")
    .flatMap((run) => Array.isArray(run.targets) ? run.targets : []);
  const openFundingWindows = new Set(openTargets.map((target) => `${target.symbol}:${target.fundingWindowKey}`));
  const existingAggregateRisk = openTargets.reduce((sum, target) => sum + Number(target.accountRisk || 0), 0);
  const diagnostics = {
    generatedAt: new Date().toISOString(),
    dataCutoffTime: rebalanceIso,
    parameters: modelParameters(),
    historicalGatePassed: FUNDING_CARRY_V2_MODEL.researchGatePassed,
    historicalGateVersion: HISTORICAL_GATE_VERSION,
    universeSize: FUNDING_CARRY_V2_MODEL.universe.length,
    dataErrors: [],
    excludedFundingWindows: [...openFundingWindows]
  };
  const candidates = [];
  await mapLimit(FUNDING_CARRY_V2_MODEL.universe, PAPER_SCAN_CONCURRENCY, async (symbol) => {
    try {
      const [hourly, fourHourly, premium, history] = await Promise.all([
        getFuturesCandles(symbol, "1h", 240),
        getFuturesCandles(symbol, "4h", 220),
        getFuturesPremiumIndex(symbol),
        getFuturesFundingHistory(symbol, rebalanceTime - 280 * FUNDING_INTERVAL_MS, rebalanceTime + HOUR_MS)
      ]);
      const closedHourly = closedCandles(hourly, now, HOUR_MS);
      const closedFourHourly = closedCandles(fourHourly, now, FOUR_HOUR_MS);
      const latest = [...(history || [])]
        .filter((row) => Number(row.fundingTime) <= rebalanceTime && Number.isFinite(Number(row.fundingRate)))
        .sort((a, b) => Number(a.fundingTime) - Number(b.fundingTime))
        .at(-1);
      const rate = Number(latest?.fundingRate);
      const markPrice = Number(premium?.markPrice);
      const nextFundingTime = Number(premium?.nextFundingTime);
      if (!latest || !(rate !== 0) || !(markPrice > 0) || !(nextFundingTime > rebalanceTime)) return;
      const observedHistory = (history || []).filter((row) => Number(row.fundingTime) <= rebalanceTime);
      const z = calculateFundingZScore(observedHistory, FUNDING_CARRY_V2_MODEL.zWindow, observedHistory.length - 1);
      if (!z || z.fundingTime !== Number(latest.fundingTime)) return;
      if (z.signedZ < FUNDING_CARRY_V2_MODEL.entrySignedZ || Math.abs(rate) < FUNDING_CARRY_V2_MODEL.minAbsFunding) return;
      if (!hasFundingConfirmation(history, latest, FUNDING_CARRY_V2_MODEL)) return;
      const direction = fundingDirection(rate);
      if (FUNDING_CARRY_V2_MODEL.fundingReversion) {
        const previous = observedHistory.at(-2);
        if (!previous || !fundingReversionPasses(previous.fundingRate, rate, direction)) return;
      }
      const trend = trendSnapshot(closedFourHourly, FUNDING_CARRY_V2_MODEL.trendRules);
      if (!trend.ready || !trend[direction > 0 ? "long" : "short"]) return;
      const volatility = volatilitySnapshot(closedFourHourly);
      if (!volatility.valid) return;
      const stopDistance = Math.max(volatility.atr * FUNDING_CARRY_V2_MODEL.atrMultiplier, markPrice * FUNDING_CARRY_V2_MODEL.minStopPct);
      const stopLoss = direction > 0 ? markPrice - stopDistance : markPrice + stopDistance;
      const stopPct = stopDistance / markPrice;
      const targetWeight = direction * Math.min(MAX_LEVERAGE, ACCOUNT_RISK / stopPct);
      const fundingWindowKey = `${symbol}:${nextFundingTime}`;
      if (openFundingWindows.has(fundingWindowKey)) return;
      candidates.push({
        symbol,
        side: direction > 0 ? "LONG" : "SHORT",
        direction,
        targetWeight,
        accountRisk: Math.abs(targetWeight) * stopPct,
        referencePrice: markPrice,
        stopLoss,
        stopPct,
        fundingRate: rate,
        absFundingRate: Math.abs(rate),
        signedZ: z.signedZ,
        zScore: z.z,
        fundingMean: z.mean,
        fundingStdDev: z.standardDeviation,
        zWindow: FUNDING_CARRY_V2_MODEL.zWindow,
        entrySignedZ: FUNDING_CARRY_V2_MODEL.entrySignedZ,
        minAbsFunding: FUNDING_CARRY_V2_MODEL.minAbsFunding,
        exitSignedZ: FUNDING_CARRY_V2_MODEL.exitSignedZ,
        fundingReversion: FUNDING_CARRY_V2_MODEL.fundingReversion,
        fundingWindowKey,
        nextFundingTime,
        trendRules: FUNDING_CARRY_V2_MODEL.trendRules,
        trend,
        volatility,
        entryTime: rebalanceIso,
        expectedExitTime: new Date(rebalanceTime + FUNDING_CARRY_V2_MODEL.maxHoldingHours * HOUR_MS).toISOString(),
        maxHoldingHours: FUNDING_CARRY_V2_MODEL.maxHoldingHours,
        modeledRoundTripCostPct: ROUND_TRIP_COST,
        signalKey: `${FUNDING_CARRY_V2_MODEL.id}:${symbol}:${nextFundingTime}:${direction}`,
        score: Math.abs(z.signedZ) + Math.abs(rate) * 10_000 + (trend.strength || 0)
      });
    } catch (error) {
      diagnostics.dataErrors.push({ symbol, error: error instanceof Error ? error.message : String(error) });
    }
  });

  const targets = selectTargets(candidates, { existingOpenCount: openTargets.length, existingAggregateRisk, openFundingWindows });
  const metadata = FUNDING_CARRY_V2_MODEL_METADATA;
  const row = {
    model_id: FUNDING_CARRY_V2_MODEL.id,
    model_version: FUNDING_CARRY_V2_MODEL.version,
    model_fingerprint: metadata.fingerprint,
    code_commit: metadata.codeCommit,
    rebalance_time: rebalanceIso,
    data_cutoff_time: rebalanceIso,
    state: FUNDING_CARRY_V2_MODEL.state,
    deployment_gate_passed: false,
    capital_weight: 0,
    predicted_beta: null,
    gross_exposure: targets.reduce((sum, target) => sum + Math.abs(target.targetWeight), 0),
    eligible_symbols: targets.length,
    targets,
    risk_state: {
      status: "paper_only",
      accountRiskPerTrade: ACCOUNT_RISK,
      maxLeverage: MAX_LEVERAGE,
      maxOpenPositions: MAX_OPEN_POSITIONS,
      maxAggregateRisk: MAX_AGGREGATE_RISK,
      openPositionCount: openTargets.length + targets.length,
      aggregateRisk: existingAggregateRisk + targets.reduce((sum, target) => sum + target.accountRisk, 0),
      currentRisk: existingAggregateRisk + targets.reduce((sum, target) => sum + target.accountRisk, 0),
      maxHoldingHours: FUNDING_CARRY_V2_MODEL.maxHoldingHours,
      roundTripCostRate: ROUND_TRIP_COST
    },
    diagnostics: {
      ...diagnostics,
      modelMetadata: metadata,
      rawSignalCount: candidates.length,
      riskFilteredTargetCount: targets.length,
      riskRejectedCount: Math.max(0, candidates.length - targets.length)
    },
    email_status: targets.length ? "pending" : "suppressed",
    review: pendingReview(
      targets.length
        ? "Waiting for closed candles and funding observations"
        : "No eligible Funding Carry V2 PAPER positions"
    )
  };
  if (dryRun) return buildScanResult({ run: row, review: row.review, email: { emailStatus: "dry_run" }, status: "dry_run", startedAt });
  await recordPaperModelRun(row);
  const email = targets.length
    ? await sendFundingCarryV2PaperEmailIfNeeded({ modelId: row.model_id, rebalanceTime })
    : { emailStatus: "suppressed", reason: "no_eligible_targets" };
  return buildScanResult({ run: row, review: row.review, email, status: "recorded", startedAt });
}

export function reviewFundingCarryV2PaperRun({ run, hourlyCandlesBySymbol = new Map(), fourHourlyBySymbol = new Map(), fundingBySymbol = new Map(), now = Date.now(), reviewedAt = Date.now() }) {
  const targets = Array.isArray(run?.targets) ? run.targets : [];
  const entryTime = new Date(run?.rebalance_time).getTime();
  if (!Number.isFinite(entryTime) || !targets.length) return pendingReview("No Funding Carry V2 PAPER positions to review");
  const positions = targets.map((target) => reviewPosition({
    target,
    entryTime,
    hourlyCandles: hourlyCandlesBySymbol.get(target.symbol) || [],
    fourHourlyCandles: fourHourlyBySymbol.get(target.symbol) || [],
    fundingRows: fundingBySymbol.get(target.symbol) || [],
    now
  }));
  const completed = positions.every((position) => position.status === "reviewed");
  const accountReturn = positions.reduce((sum, position) => sum + Number(position.netContribution || 0), 0);
  return {
    status: completed ? "reviewed" : "pending",
    modelVersion: run.model_version || FUNDING_CARRY_V2_MODEL.version,
    method: "perpetual_price_funding_zscore_trend_volatility_stop_review",
    outcome: completed ? (accountReturn > 0 ? "profit" : accountReturn < 0 ? "loss" : "flat") : "open",
    entryTime: new Date(entryTime).toISOString(),
    exitTime: completed ? positions.reduce((latest, position) => position.exitTime > latest ? position.exitTime : latest, positions[0].exitTime) : null,
    reviewedAt: new Date(reviewedAt).toISOString(),
    holdingHours: mean(positions.map((position) => position.holdingHours)),
    returnPct: accountReturn,
    netOfCosts: true,
    positions
  };
}

export function evaluateFundingCarryV2PaperGate(runs = []) {
  const seenWindows = new Set();
  let duplicateEntryCount = 0;
  let wrongDirectionCount = 0;
  let unprocessedExitCount = 0;
  let emailAnomalyCount = 0;
  for (const run of runs) {
    const expectedEmailStates = Array.isArray(run?.targets) && run.targets.length ? ["sent"] : ["suppressed", "sent"];
    if (run?.email_status && !expectedEmailStates.includes(run.email_status)) emailAnomalyCount++;
    for (const target of Array.isArray(run?.targets) ? run.targets : []) {
      const key = `${target.symbol}:${target.fundingWindowKey || target.nextFundingTime || run.rebalance_time}`;
      if (seenWindows.has(key)) duplicateEntryCount++;
      seenWindows.add(key);
      const expectedSide = fundingDirection(target.fundingRate) > 0 ? "LONG" : fundingDirection(target.fundingRate) < 0 ? "SHORT" : null;
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
    .filter((position) => position.run?.review?.status === "reviewed" && Number.isFinite(Number(position.netContribution ?? position.returnPct)));
  const ordered = positions.sort((a, b) => new Date(a.exitTime || a.run.rebalance_time).getTime() - new Date(b.exitTime || b.run.rebalance_time).getTime());
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
    const time = new Date(position.exitTime || position.run.rebalance_time).getTime();
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
  const stressReturns = ordered.map((position) => {
    const gross = Number(position.grossContribution ?? position.netContribution ?? position.returnPct ?? 0);
    const cost = Math.abs(Number(position.tradingCostContribution || 0)) * 1.5;
    return gross - cost;
  });
  const stressProfit = stressReturns.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const stressLoss = stressReturns.filter((value) => value < 0).reduce((sum, value) => sum + value, 0);
  const metrics = {
    closedTrades: ordered.length,
    totalReturn: equity - 1,
    averageNetReturn: mean(returns),
    profitFactor: grossLoss < 0 ? grossProfit / Math.abs(grossLoss) : grossProfit > 0 ? Infinity : 0,
    maxDrawdown,
    positiveWeekRate: weekReturns.length ? weekReturns.filter((value) => value > 0).length / weekReturns.length : 0,
    maxSignalGapDays: gaps.length ? Math.max(...gaps) : null,
    largestSymbolShare,
    dataCompleteness: dataRuns.length ? completeRuns / dataRuns.length : 0,
    costStressAverageNetReturn: mean(stressReturns),
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
    executionClean: duplicateEntryCount === 0 && wrongDirectionCount === 0 && unprocessedExitCount === 0 && emailAnomalyCount === 0
  };
  return { passed: Object.values(checks).every(Boolean), checks, metrics, passedCount: Object.values(checks).filter(Boolean).length };
}

export function renderFundingCarryV2PaperEmail(run) {
  const targets = Array.isArray(run?.targets) ? run.targets : [];
  const lines = [
    "PAPER / 不执行交易 — Funding Carry V2 永续合约观察",
    `模型：${run.model_version || FUNDING_CARRY_V2_MODEL.version}`,
    `时间：${new Date(run.rebalance_time).toISOString()}`,
    "状态：PAPER，策略资金权重 0%，不会连接交易账户或下单。",
    "方向：正 funding 做空，负 funding 做多；需 signed z-score、趋势和波动率同时确认。",
    `成本假设：往返 ${(ROUND_TRIP_COST * 100).toFixed(3)}%，单笔风险上限 ${(ACCOUNT_RISK * 100).toFixed(2)}%，最长持仓 ${FUNDING_CARRY_V2_MODEL.maxHoldingHours} 小时。`,
    "",
    ...targets.map((target) => [
      `${target.symbol} ${target.side} | funding ${(Number(target.fundingRate) * 100).toFixed(4)}% | signedZ ${Number(target.signedZ).toFixed(3)}`,
      `模拟入场 ${formatNumber(target.referencePrice)} | 止损 ${formatNumber(target.stopLoss)} | 最迟退出 ${target.expectedExitTime}`,
      `趋势 ${target.trendRules.join("+")} | 4h ATR/价格 ${(Number(target.volatility?.atrPct) * 100).toFixed(3)}% <= 历史 P90 | funding 窗口 ${new Date(target.nextFundingTime).toISOString()}`
    ].join("\n")),
    "",
    "这是 PAPER / 不执行交易 的模拟观察邮件；历史 Gate 和 8 周 PAPER Gate 均通过前不会升级 LIVE。"
  ];
  return {
    subject: `[PAPER / 不执行交易] Funding Carry V2 ${targets.length} 个观察目标`,
    text: lines.join("\n")
  };
}

export function isFundingCarryV2PaperEmailReady(run) {
  return Array.isArray(run?.targets) && run.targets.length > 0;
}

function reviewPosition({ target, entryTime, hourlyCandles, fourHourlyCandles, fundingRows, now }) {
  const candles = closedCandles(hourlyCandles, now, HOUR_MS).filter((candle) => Number(candle.openTime) >= entryTime);
  const first = candles[0];
  if (!first) return pendingPosition(target, entryTime, "missing closed price data");
  const direction = Number(target.direction || (target.side === "LONG" ? 1 : -1));
  const entryPrice = Number(target.referencePrice);
  const stopPrice = Number(target.stopLoss);
  const maxHoldingHours = Number(target.maxHoldingHours || FUNDING_CARRY_V2_MODEL.maxHoldingHours);
  const maxExitTime = entryTime + maxHoldingHours * HOUR_MS;
  const sortedFunding = (fundingRows || []).filter((row) => Number.isFinite(Number(row.fundingTime)) && Number.isFinite(Number(row.fundingRate))).sort((a, b) => Number(a.fundingTime) - Number(b.fundingTime));
  let exit = null;
  for (const candle of candles) {
    if (Number(candle.openTime) > maxExitTime) break;
    const stopHit = direction > 0 ? candle.low <= stopPrice : candle.high >= stopPrice;
    if (stopHit) {
      const gapFill = direction > 0 ? candle.open <= stopPrice : candle.open >= stopPrice;
      exit = { time: Number(candle.openTime), price: gapFill ? Number(candle.open) : stopPrice, reason: "atr_stop" };
      break;
    }
    const currentFunding = sortedFunding.filter((row) => Number(row.fundingTime) > entryTime && Number(row.fundingTime) <= Number(candle.openTime));
    const latestFunding = currentFunding.at(-1);
    const latestIndex = latestFunding ? sortedFunding.indexOf(latestFunding) : -1;
    const latestZ = latestIndex >= 0 ? calculateFundingZScore(sortedFunding, Number(target.zWindow || FUNDING_CARRY_V2_MODEL.zWindow), latestIndex) : null;
    if (latestFunding && (!latestZ || Math.sign(Number(latestFunding.fundingRate)) !== Math.sign(Number(target.fundingRate)) || latestZ.signedZ < Number(target.exitSignedZ || FUNDING_CARRY_V2_MODEL.exitSignedZ))) {
      exit = { time: Number(candle.openTime), price: Number(candle.open), reason: "funding_threshold" };
      break;
    }
    if (Number(candle.openTime) >= maxExitTime) {
      exit = { time: Number(candle.openTime), price: Number(candle.open), reason: "max_holding" };
      break;
    }
    if (Number(candle.openTime) > entryTime && Number(candle.openTime) % FOUR_HOUR_MS === 0) {
      const trend = trendSnapshot(closedCandles(fourHourlyCandles, Number(candle.openTime), FOUR_HOUR_MS), target.trendRules || FUNDING_CARRY_V2_MODEL.trendRules);
      if (trend.ready && !trend[direction > 0 ? "long" : "short"]) {
        exit = { time: Number(candle.openTime), price: Number(candle.open), reason: "trend_reversal" };
        break;
      }
    }
  }
  const pending = !exit;
  const markCandle = candles.at(-1);
  const exitTime = exit?.time || Number(markCandle?.openTime);
  const exitPrice = exit?.price || Number(markCandle?.close);
  if (!(entryPrice > 0) || !(exitPrice > 0) || !Number.isFinite(exitTime)) return pendingPosition(target, entryTime, "missing valid price data");
  const priceReturn = direction * (exitPrice / entryPrice - 1);
  const fundingReturn = -direction * sortedFunding
    .filter((row) => Number(row.fundingTime) > entryTime && Number(row.fundingTime) <= exitTime)
    .reduce((sum, row) => sum + Number(row.fundingRate), 0);
  const weight = Math.abs(Number(target.targetWeight || 0));
  const tradingCost = ROUND_TRIP_COST;
  const netReturn = priceReturn + fundingReturn - tradingCost;
  const netContribution = weight * netReturn;
  return {
    symbol: target.symbol,
    side: target.side,
    status: pending ? "pending" : "reviewed",
    outcome: pending ? "open" : (netReturn > 0 ? "profit" : netReturn < 0 ? "loss" : "flat"),
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

async function tryReviewFundingCarryV2PaperRun({ run, now }) {
  if (!run?.targets?.length || run.review?.status === "reviewed") return run?.review || null;
  const hourly = new Map();
  const fourHourly = new Map();
  const funding = new Map();
  const entryTime = new Date(run.rebalance_time).getTime();
  await mapLimit(run.targets, 4, async (target) => {
    const [oneHour, fourHour, rates] = await Promise.all([
      getFuturesCandles(target.symbol, "1h", 240),
      getFuturesCandles(target.symbol, "4h", 220),
      getFuturesFundingHistory(target.symbol, entryTime - 280 * FUNDING_INTERVAL_MS, Math.min(Number(now), entryTime + Number(target.maxHoldingHours || 48) * HOUR_MS))
    ]);
    hourly.set(target.symbol, oneHour);
    fourHourly.set(target.symbol, fourHour);
    funding.set(target.symbol, rates);
  });
  const review = reviewFundingCarryV2PaperRun({ run, hourlyCandlesBySymbol: hourly, fourHourlyBySymbol: fourHourly, fundingBySymbol: funding, now });
  await updatePaperModelReview({ modelId: run.model_id, rebalanceTime: run.rebalance_time, review });
  return review;
}

async function sendFundingCarryV2PaperEmailIfNeeded({ modelId, rebalanceTime }) {
  const current = await fetchPaperModelRun({ modelId, rebalanceTime });
  if (!current) return { emailStatus: "not_found" };
  if (!["pending", "failed"].includes(current.email_status)) return { emailStatus: current.email_status || "not_claimed", emailSentAt: current.email_sent_at || null };
  if (!isFundingCarryV2PaperEmailReady(current)) return { emailStatus: "suppressed", deferredReason: "no_targets" };
  const claimed = await claimPaperModelEmail({ modelId, rebalanceTime });
  if (!claimed) return { emailStatus: "not_claimed" };
  const idempotencyKey = `funding-carry-v2-paper/${modelId}/${new Date(rebalanceTime).toISOString()}`;
  try {
    const sent = await sendEmail({ ...renderFundingCarryV2PaperEmail(claimed), idempotencyKey });
    if (sent?.skipped) throw new Error(`Funding Carry V2 PAPER email skipped: ${sent.reason}`);
    const sentAt = new Date().toISOString();
    await updatePaperModelEmail({ modelId, rebalanceTime, emailStatus: "sent", emailResult: { messageId: sent?.messageId || null, accepted: sent?.accepted || null }, sentAt });
    return { emailStatus: "sent", emailSentAt: sentAt };
  } catch (error) {
    const errorText = error instanceof Error ? error.message : String(error);
    await updatePaperModelEmail({ modelId, rebalanceTime, emailStatus: "failed", emailResult: { error: errorText } });
    throw error;
  }
}

function selectTargets(candidates, { existingOpenCount = 0, existingAggregateRisk = 0, openFundingWindows = new Set() } = {}) {
  const selected = [];
  let aggregateRisk = existingAggregateRisk;
  const maxNewPositions = Math.max(0, MAX_OPEN_POSITIONS - existingOpenCount);
  for (const candidate of [...candidates].sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol))) {
    if (selected.length >= maxNewPositions) break;
    if (openFundingWindows.has(candidate.fundingWindowKey)) continue;
    if (aggregateRisk + candidate.accountRisk > MAX_AGGREGATE_RISK + 1e-12) continue;
    if (selected.some((target) => target.symbol === candidate.symbol && target.fundingWindowKey === candidate.fundingWindowKey)) continue;
    selected.push(candidate);
    aggregateRisk += candidate.accountRisk;
  }
  return selected;
}

function modelParameters() {
  return {
    zWindow: FUNDING_CARRY_V2_MODEL.zWindow,
    entrySignedZ: FUNDING_CARRY_V2_MODEL.entrySignedZ,
    minAbsFunding: FUNDING_CARRY_V2_MODEL.minAbsFunding,
    exitSignedZ: FUNDING_CARRY_V2_MODEL.exitSignedZ,
    confirmationEvents: FUNDING_CARRY_V2_MODEL.confirmationEvents,
    fundingReversion: FUNDING_CARRY_V2_MODEL.fundingReversion,
    atrMultiplier: FUNDING_CARRY_V2_MODEL.atrMultiplier,
    minStopPct: FUNDING_CARRY_V2_MODEL.minStopPct,
    maxHoldingHours: FUNDING_CARRY_V2_MODEL.maxHoldingHours,
    volatilityLookback: FUNDING_CARRY_V2_MODEL.volatilityLookback,
    volatilityPercentile: FUNDING_CARRY_V2_MODEL.volatilityPercentile,
    scanConcurrency: PAPER_SCAN_CONCURRENCY,
    trendRules: FUNDING_CARRY_V2_MODEL.trendRules,
    roundTripCostRate: ROUND_TRIP_COST
  };
}

function hasFundingConfirmation(rows, latest, model) {
  const ordered = (rows || []).filter((row) => Number(row.fundingTime) <= Number(latest.fundingTime) && Number.isFinite(Number(row.fundingRate))).sort((a, b) => Number(a.fundingTime) - Number(b.fundingTime));
  if (ordered.length < model.confirmationEvents) return false;
  const relevant = ordered.slice(-model.confirmationEvents);
  const sign = Math.sign(Number(latest.fundingRate));
  return relevant.every((row) => Math.sign(Number(row.fundingRate)) === sign && Math.abs(Number(row.fundingRate)) >= model.minAbsFunding);
}

function trendSnapshot(candles, ruleIds) {
  const closes = (candles || []).map((row) => Number(row.close)).filter((value) => value > 0);
  const required = Math.max(60, ...(ruleIds || []).map((ruleId) => {
    const ma = /^(?:sma|ema)(20|50|100)_slope(3|6|12)$/.exec(ruleId);
    const momentum = /^momentum(6|12|24)$/.exec(ruleId);
    return ma ? Number(ma[1]) + Number(ma[2]) + 1 : momentum ? Number(momentum[1]) + 1 : 60;
  }));
  if (closes.length < required) return { ready: false, long: false, short: false, strength: 0, details: {} };
  const details = {};
  let long = true;
  let short = true;
  for (const ruleId of ruleIds || []) {
    const ma = /^(sma|ema)(20|50|100)_slope(3|6|12)$/.exec(ruleId);
    const momentum = /^momentum(6|12|24)$/.exec(ruleId);
    let ruleLong = false;
    let ruleShort = false;
    let value = null;
    if (ma) {
      const kind = ma[1];
      const period = Number(ma[2]);
      const slopeBars = Number(ma[3]);
      const current = kind === "ema" ? ema(closes, period) : sma(closes, period);
      const previousValues = closes.slice(0, -slopeBars);
      const previous = kind === "ema" ? ema(previousValues, period) : sma(previousValues, period);
      value = current;
      ruleLong = Number.isFinite(current) && Number.isFinite(previous) && closes.at(-1) > current && current > previous;
      ruleShort = Number.isFinite(current) && Number.isFinite(previous) && closes.at(-1) < current && current < previous;
    } else if (momentum) {
      const lookback = Number(momentum[1]);
      value = closes.at(-1) / closes.at(-(lookback + 1)) - 1;
      ruleLong = value > 0;
      ruleShort = value < 0;
    }
    details[ruleId] = { long: ruleLong, short: ruleShort, value };
    long &&= ruleLong;
    short &&= ruleShort;
  }
  return { ready: true, long, short, strength: Object.values(details).reduce((sum, item) => sum + Math.abs(Number(item.value) || 0), 0) * 100, details };
}

function atrAt(candles, index, period = 14) {
  if (!Array.isArray(candles) || index < period || !candles[index]) return null;
  let total = 0;
  for (let cursor = index - period + 1; cursor <= index; cursor++) {
    const previous = Number(candles[cursor - 1]?.close || candles[cursor].close);
    total += Math.max(Number(candles[cursor].high) - Number(candles[cursor].low), Math.abs(Number(candles[cursor].high) - previous), Math.abs(Number(candles[cursor].low) - previous));
  }
  return total / period;
}

function percentile(values, ratio) {
  const ordered = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!ordered.length) return null;
  return ordered[Math.min(ordered.length - 1, Math.max(0, Math.ceil((ordered.length - 1) * ratio)))];
}

function sma(values, period) {
  if (values.length < period) return null;
  return values.slice(-period).reduce((sum, value) => sum + value, 0) / period;
}

function ema(values, period) {
  if (values.length < period) return null;
  const alpha = 2 / (period + 1);
  let value = values.slice(0, period).reduce((sum, item) => sum + item, 0) / period;
  for (const item of values.slice(period)) value = alpha * item + (1 - alpha) * value;
  return value;
}

function closedCandles(candles, now, intervalMs) {
  return (candles || []).filter((candle) => Number(candle.openTime) + intervalMs <= Number(now));
}

function latestClosedHour(now) {
  return Math.floor(Number(now) / HOUR_MS) * HOUR_MS - HOUR_MS;
}

function pendingReview(reason) {
  return { status: "pending", reason, modelVersion: FUNDING_CARRY_V2_MODEL.version };
}

function pendingPosition(target, entryTime, reason) {
  return { symbol: target.symbol, side: target.side, status: "pending", outcome: "open", entryTime: new Date(entryTime).toISOString(), markTime: null, exitTime: null, reason, returnPct: null, netContribution: null };
}

function blockedResult(reason, startedAt, rebalanceTime) {
  return {
    group: "funding-carry-v2-paper",
    modelId: FUNDING_CARRY_V2_MODEL.id,
    modelVersion: FUNDING_CARRY_V2_MODEL.version,
    state: "PAPER",
    deploymentGatePassed: false,
    historicalGateVersion: HISTORICAL_GATE_VERSION,
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
    group: "funding-carry-v2-paper",
    modelId: run.model_id,
    modelVersion: run.model_version,
    state: run.state,
    deploymentGatePassed: run.deployment_gate_passed === true,
    historicalGateVersion: run.diagnostics?.historicalGateVersion || HISTORICAL_GATE_VERSION,
    capitalWeight: Number(run.capital_weight || 0),
    rebalanceTime: run.rebalance_time,
    status,
    targets: run.targets || [],
    review,
    ...email,
    durationMs: Date.now() - startedAt
  };
}

function mean(values) {
  const finite = values.filter((value) => Number.isFinite(Number(value)));
  return finite.length ? finite.reduce((sum, value) => sum + Number(value), 0) / finite.length : null;
}

function durationWeeks(runs) {
  const times = runs.map((run) => new Date(run?.rebalance_time).getTime()).filter(Number.isFinite).sort((a, b) => a - b);
  return times.length >= 2 ? (times.at(-1) - times[0]) / (7 * 24 * HOUR_MS) : 0;
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

function formatNumber(value) {
  return Number.isFinite(Number(value)) ? Number(value).toLocaleString("en-US", { maximumFractionDigits: 8 }) : "n/a";
}
