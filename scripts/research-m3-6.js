import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { aggregateMetrics } from "../lib/backtest/metrics.js";
import { runBacktest } from "../lib/backtest/backtest-engine.js";
import {
  CORE_SIGNAL_POLICY,
  ORDER_BOOK_AVAILABILITY,
  replayDynamicProductionSignals
} from "../lib/validation/dynamic-production-replay.js";
import {
  loadM3RealInput,
  M3_REAL_DATA_INTERVALS,
  M3_REAL_DATA_WINDOW,
  M3_REAL_MANIFEST_SHA256
} from "../lib/validation/real-data.js";
import { isPrimaryOosTrade } from "../lib/validation/validation-metrics.js";
import { DYNAMIC_PRODUCTION_HOLD_HOURS } from "../lib/strategies/dynamic-production.js";
import {
  M36_MAX_CANDIDATES,
  M36_OLD_WINDOW_ROLE,
  M36_RESEARCH_STATUS,
  buildM36CandidateSignals,
  buildM36SignalStrategy,
  candidateDefinitions,
  causalTimingForCandidate
} from "../lib/validation/m3-6-strategy-redesign.js";
import {
  buildM36ForwardTestDecision,
  compareM36Candidate
} from "../lib/validation/m3-6-gates.js";

const FROZEN_BASE_SHA = "975f0d11231947c306b02e0241ca5179eed5a650";
const BASELINE_WEAK_ID = "dynamic_relative_weakness_breakdown";
const OLD_REPORT_PATH = argumentValue("--frozen-report") || "artifacts/m3/m3-real-validation-report.json";
const DATA_DIR = argumentValue("--data-dir") || process.env.M3_REAL_DATA_DIR || ".local/m3-data";
const FORWARD_DATA_DIR = argumentValue("--forward-data-dir") || process.env.M3_6_FORWARD_DATA_DIR || null;
const OUTPUT_PATH = argumentValue("--output") || "artifacts/m3/m3-6-strategy-redesign.json";

if (!existsSync(resolve(DATA_DIR, "index.json"))) {
  failClosed("M3_REAL_DATA_REQUIRED");
} else {
  try {
    const input = await loadM3RealInput({ dataDir: DATA_DIR });
    const frozenReport = JSON.parse(await readFile(resolve(OLD_REPORT_PATH), "utf8"));
    assert.equal(input.manifestSha256, M3_REAL_MANIFEST_SHA256, "M3.6 must use the frozen manifest");
    assert.equal(input.windowStart, M3_REAL_DATA_WINDOW.start, "M3.6 old window start is fixed");
    assert.equal(input.windowEnd, M3_REAL_DATA_WINDOW.end, "M3.6 old window end is fixed");
    assertFrozenBaseline(frozenReport);

    const datasets = input.datasets.filter(isCompleteHourlyDataset);
    assert.ok(datasets.length > 0, "M3.6 requires the existing frozen historical dataset");
    const replayOptions = {
      datasets,
      strategyId: BASELINE_WEAK_ID,
      interval: M3_REAL_DATA_INTERVALS.candles,
      benchmarkCandles: input.benchmarkCandles,
      benchmarkInterval: M3_REAL_DATA_INTERVALS.benchmark,
      existingAssets: input.existingAssets || [],
      futuresSymbols: input.universeProvenance?.assets || datasets.map((dataset) => dataset.asset),
      historicalUniverse: input.historicalUniverse,
      historicalUniverseComplete: input.historicalUniverseComplete,
      universeSource: input.universeSource,
      dataSource: input.dataSource,
      productionGroup: input.productionGroup || "all",
      productionPolicy: CORE_SIGNAL_POLICY,
      dynamicSpotAssets: input.dynamicSpotAssets || [],
      selected: input.selected || null,
      orderBookAvailability: ORDER_BOOK_AVAILABILITY.UNAVAILABLE
    };

    const frozenWeakReplay = replayDynamicProductionSignals(replayOptions);
    assert.equal(frozenWeakReplay.signals.length, frozenReport.strategies[BASELINE_WEAK_ID].replayDiagnostics.replaySignalsTotal);
    const opportunityReplay = replayDynamicProductionSignals({
      ...replayOptions,
      includeOpportunityPassedSignals: true
    });
    const baselineResearch = runResearchForTimeline({
      strategyId: "BASELINE_V4_WEAK",
      signalTimeline: frozenWeakReplay.signals,
      datasets,
      window: M3_REAL_DATA_WINDOW
    });

    const definitions = candidateDefinitions();
    assert.ok(definitions.length <= M36_MAX_CANDIDATES, "M3.6 candidate count exceeded the fixed maximum");
    const candidateResults = definitions.map((definition) => {
      const signals = buildM36CandidateSignals({
        baseSignals: opportunityReplay.signals,
        datasets,
        candidateId: definition.id
      });
      return runResearchForTimeline({
        strategyId: definition.id,
        signalTimeline: signals,
        datasets,
        window: M3_REAL_DATA_WINDOW,
        candidateDefinition: definition
      });
    });

    const candidateComparison = candidateResults.map((result) => compareM36Candidate({
      baseline: baselineResearch.metrics,
      candidate: result
    }));
    const candidateComparisonById = Object.fromEntries(candidateComparison.map((row) => [row.candidateId, row]));
    const newUntouchedOos = detectNewUntouchedOos(FORWARD_DATA_DIR);
    const forwardTestDecision = buildM36ForwardTestDecision(
      candidateComparison,
      newUntouchedOos.available
    );
    const forwardTestCandidates = forwardTestDecision.forwardTestCandidates;
    const rejectedCandidates = candidateComparison
      .filter((comparison) => comparison.researchStatus === "REJECTED_CANDIDATE")
      .map((comparison) => ({
        candidateId: comparison.candidateId,
        failedGates: Object.entries(comparison.gates)
          .filter(([, passed]) => passed !== true)
          .map(([gate]) => gate)
      }));

    const report = {
      version: "V4-M3.6",
      frozenBaseSha: FROZEN_BASE_SHA,
      manifestSha256: input.manifestSha256,
      oldWindowRole: M36_OLD_WINDOW_ROLE,
      oldWindow: M3_REAL_DATA_WINDOW,
      formerHoldoutRole: "RESEARCH_ONLY_AFTER_BEING_OBSERVED",
      oldWindowFullyResearch: true,
      holdoutUsedForNewUntouchedValidation: false,
      newUntouchedOosAvailable: newUntouchedOos.available,
      newUntouchedOosReason: newUntouchedOos.reason,
      researchStatus: M36_RESEARCH_STATUS,
      baselineWeak: {
        strategyId: BASELINE_WEAK_ID,
        baselineId: "BASELINE_V4_WEAK",
        deploymentStatus: "NEGATIVE_EDGE_BASELINE",
        deploymentMode: "SHADOW_ONLY_RESEARCH_ONLY",
        actionable: false,
        frozenMetrics: frozenBaselineMetrics(frozenReport.strategies[BASELINE_WEAK_ID]),
        researchResult: baselineResearch
      },
      strongReference: {
        strategyId: "dynamic_relative_strength_breakout",
        status: "KEEP_FOR_MORE_DATA",
        changed: false,
        frozenMetrics: frozenBaselineMetrics(frozenReport.strategies.dynamic_relative_strength_breakout)
      },
      candidateDefinitions: definitions,
      causalTiming: Object.fromEntries(definitions.map((definition) => [
        definition.id,
        causalTimingForCandidate(definition.id)
      ])),
      researchResults: Object.fromEntries([
        [baselineResearch.strategyId, baselineResearch],
        ...candidateResults.map((result) => [result.strategyId, result])
      ]),
      candidateComparison: candidateComparisonById,
      forwardTestCandidates,
      rejectedCandidates,
      candidateGate: {
        reference: "same old-window research baseline, not frozen holdout optimization",
        minCompleteTrades: 10,
        drawdownMaterialImprovement: "+5 percentage points versus research baseline",
        assetAndFoldConcentrationMaxShare: 0.5,
        requiresAllGates: true,
        promisingEdgeWithoutNewUntouchedOos: false
      },
      dataSource: {
        source: input.dataSource,
        validationDatasetCount: datasets.length,
        historicalUniverse: input.universeSource,
        interval: M3_REAL_DATA_INTERVALS.candles,
        lowerTimeframe: M3_REAL_DATA_INTERVALS.lowerTimeframe,
        orderBookAvailability: ORDER_BOOK_AVAILABILITY.UNAVAILABLE,
        execution: "existing TradeSpec + M2-B runBacktest/simulateTrade"
      },
      flags: {
        oldHoldoutReusedForOptimization: false,
        parameterGridSearch: false,
        automaticThresholdOptimization: false,
        strategyParametersChanged: false,
        strongChanged: false,
        M2BChanged: false,
        enteredM4: false,
        mergedMain: false
      },
      validationVerdict: forwardTestDecision.validationVerdict
    };

    await mkdir(dirname(resolve(OUTPUT_PATH)), { recursive: true });
    await writeFile(resolve(OUTPUT_PATH), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({
      reportPath: resolve(OUTPUT_PATH),
      oldWindowRole: report.oldWindowRole,
      newUntouchedOosAvailable: report.newUntouchedOosAvailable,
      baseline: compactResult(baselineResearch),
      candidates: candidateResults.map(compactResult),
      forwardTestCandidates: report.forwardTestCandidates,
      rejectedCandidates: report.rejectedCandidates,
      validationVerdict: report.validationVerdict
    }, null, 2));
  } catch (error) {
    failClosed(error?.message || String(error));
  }
}

function runResearchForTimeline({
  strategyId,
  signalTimeline = [],
  datasets = [],
  window,
  candidateDefinition = null
} = {}) {
  const signalsByAsset = new Map();
  for (const signal of signalTimeline) {
    const asset = String(signal?.asset || "");
    if (!signalsByAsset.has(asset)) signalsByAsset.set(asset, []);
    signalsByAsset.get(asset).push(signal);
  }
  const allTrades = [];
  const allMissedEntries = [];
  for (const dataset of datasets) {
    const assetSignals = signalsByAsset.get(String(dataset.asset)) || [];
    if (!assetSignals.length) continue;
    const strategy = buildM36SignalStrategy({ strategyId, signalTimeline: assetSignals });
    const backtest = runBacktest({
      candles: dataset.candles,
      strategy,
      interval: M3_REAL_DATA_INTERVALS.candles,
      marketType: "futures",
      tradePlanType: "futures",
      asset: dataset.asset,
      startIndex: 24,
      executionModel: {
        ...(dataset.backtestOptions?.executionModel || {}),
        marketType: "futures",
        exchangeRulesRequired: true
      },
      fundingEvents: dataset.fundingEvents,
      fundingCoverage: dataset.fundingCoverage,
      lowerTimeframeCandles: dataset.lowerTimeframeCandles,
      lowerTimeframe: M3_REAL_DATA_INTERVALS.lowerTimeframe,
      exchangeFilters: dataset.exchangeFilters
    });
    allMissedEntries.push(...backtest.missedEntries);
    allTrades.push(...backtest.tradeResults.map((trade) => enrichResearchTrade({
      trade,
      signalTimeline: assetSignals,
      window,
      candidateDefinition
    })));
  }

  const completeTrades = allTrades.filter(isPrimaryOosTrade).sort(byExitTime);
  const degradedTrades = allTrades.filter((trade) => !isPrimaryOosTrade(trade));
  const metrics = summarizeResearchMetrics(completeTrades, {
    signalCount: signalTimeline.length,
    missedEntries: allMissedEntries
  });
  return {
    strategyId,
    candidateDefinitionId: candidateDefinition?.id || null,
    researchClassification: M36_RESEARCH_STATUS,
    signals: signalTimeline.length,
    rawTradeRows: allTrades.length,
    completeTrades: completeTrades.length,
    degradedTrades: degradedTrades.length,
    fundingIncompleteTrades: allTrades.filter((trade) => trade.dataQuality === "INCOMPLETE_FUNDING"
      || trade.dataQualityComponents?.funding === "INCOMPLETE_FUNDING").length,
    missedEntries: allMissedEntries.length,
    metrics,
    byAsset: summarizeGroups(completeTrades, (trade) => trade.asset),
    byFold: summarizeGroups(completeTrades, (trade) => trade.researchFold),
    byRegime: summarizeGroups(completeTrades, (trade) => trade.marketRegime),
    mfeMae: {
      averageMfeR: average(completeTrades.map((trade) => trade.mfeR)),
      averageMaeR: average(completeTrades.map((trade) => trade.maeR))
    },
    causalSignalCount: signalTimeline.filter((signal) => signal?.m36?.features?.complete !== false).length,
    candidateUsesRecommendationScoreAsGate: false
  };
}

function enrichResearchTrade({ trade, signalTimeline, window }) {
  const signal = signalTimeline.find((row) => String(row.asset) === String(trade.asset)
    && Number(row.signalCandleOpenTime) === Number(trade.signalCandleOpenTime));
  const benchmarkMomentum = Number(signal?.details?.benchmarkMomentum24h);
  const marketRegime = Number.isFinite(benchmarkMomentum)
    ? benchmarkMomentum > 0.02 ? "btc_up" : benchmarkMomentum < -0.02 ? "btc_down" : "btc_flat"
    : "btc_unknown";
  return {
    ...trade,
    researchFold: researchFoldForTime(trade.signalAvailableAt, window),
    marketRegime,
    sourceRecommendationScore: Number.isFinite(Number(signal?.recommendationScore))
      ? Number(signal.recommendationScore)
      : null,
    m36Features: signal?.m36?.features || null
  };
}

function summarizeResearchMetrics(trades, { signalCount, missedEntries }) {
  const aggregate = aggregateMetrics(trades, {
    signals: signalCount,
    missedEntries
  });
  const grossR = trades.map((trade) => safeRatio(trade.grossReturnPct, trade.initialRiskPct));
  return {
    signals: signalCount,
    completeTrades: trades.length,
    grossExpectancyR: average(grossR),
    netExpectancyR: aggregate.expectancyR,
    profitFactor: aggregate.profitFactor,
    winRate: aggregate.winRate,
    averageNetReturn: aggregate.averageNetReturn,
    totalNetReturn: aggregate.totalNetReturn,
    maxDrawdown: aggregate.maxDrawdown,
    feeDrag: aggregate.feeDrag,
    spreadDrag: aggregate.spreadDrag,
    slippageDrag: aggregate.slippageDrag,
    fundingDrag: aggregate.fundingDrag,
    avgWinR: aggregate.avgWinR,
    avgLossR: aggregate.avgLossR,
    mfeR: average(trades.map((trade) => trade.mfeR)),
    maeR: average(trades.map((trade) => trade.maeR)),
    maxAssetTradeShare: maxTradeShare(trades, (trade) => trade.asset),
    maxFoldTradeShare: maxTradeShare(trades, (trade) => trade.researchFold)
  };
}

function frozenBaselineMetrics(strategyReport = {}) {
  return {
    replaySignals: strategyReport.replayDiagnostics?.replaySignalsTotal ?? null,
    developmentOosSignals: (strategyReport.walkForward?.folds || [])
      .reduce((sum, fold) => sum + (Number(fold.rawSignals) || 0), 0),
    completeTrades: strategyReport.aggregateOOS?.completeTrades ?? null,
    degradedTrades: strategyReport.aggregateOOS?.degradedTrades ?? null,
    fundingIncompleteTrades: strategyReport.aggregateOOS?.fundingIncompleteTrades ?? null,
    expectancyR: strategyReport.aggregateOOS?.expectancyR ?? null,
    profitFactor: strategyReport.aggregateOOS?.profitFactor ?? null,
    holdoutCompleteTrades: strategyReport.holdout?.completeTrades ?? null,
    holdoutExpectancyR: strategyReport.holdout?.expectancyR ?? null,
    holdoutProfitFactor: strategyReport.holdout?.profitFactor ?? null,
    statisticalVerdict: strategyReport.statisticalVerdict ?? null
  };
}

function assertFrozenBaseline(report) {
  const weak = report?.strategies?.[BASELINE_WEAK_ID];
  assert.ok(weak, "frozen Weak report is required");
  assert.equal(weak.aggregateOOS?.completeTrades, 61);
  assert.equal(weak.aggregateOOS?.profitFactor, 0.5699430218673189);
  assert.equal(weak.aggregateOOS?.expectancyR, -0.2023577937552056);
  assert.equal(weak.holdout?.completeTrades, 13);
  assert.equal(weak.holdout?.expectancyR, -0.13831305506178365);
  assert.equal(weak.statisticalVerdict, "NEGATIVE_EDGE");
}

function detectNewUntouchedOos(dataDir) {
  if (!dataDir || !existsSync(resolve(dataDir, "index.json"))) {
    return { available: false, reason: "FORWARD_DATASET_NOT_CONFIGURED" };
  }
  try {
    const index = JSON.parse(requireRead(resolve(dataDir, "index.json")));
    const startsAfterOldWindow = Date.parse(index.windowStart) >= Date.parse(M3_REAL_DATA_WINDOW.end);
    const extendsPastOldWindow = Date.parse(index.windowEnd) > Date.parse(M3_REAL_DATA_WINDOW.end);
    return startsAfterOldWindow && extendsPastOldWindow
      ? { available: true, reason: "UNSEEN_FORWARD_WINDOW_CONFIGURED" }
      : { available: false, reason: "FORWARD_WINDOW_OVERLAPS_OLD_RESEARCH_WINDOW" };
  } catch {
    return { available: false, reason: "FORWARD_DATASET_INVALID" };
  }
}

function compactResult(result) {
  return {
    strategyId: result.strategyId,
    signals: result.signals,
    completeTrades: result.completeTrades,
    degradedTrades: result.degradedTrades,
    grossExpectancyR: result.metrics.grossExpectancyR,
    netExpectancyR: result.metrics.netExpectancyR,
    profitFactor: result.metrics.profitFactor,
    maxDrawdown: result.metrics.maxDrawdown,
    researchStatus: result.researchClassification
  };
}

function summarizeGroups(trades, keyFn) {
  const groups = new Map();
  for (const trade of trades) {
    const key = String(keyFn(trade) || "UNKNOWN");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(trade);
  }
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right))
    .map(([key, rows]) => ({
      key,
      trades: rows.length,
      netExpectancyR: average(rows.map((trade) => trade.realizedR)),
      profitFactor: aggregateMetrics(rows).profitFactor,
      winRate: aggregateMetrics(rows).winRate,
      totalNetReturn: aggregateMetrics(rows).totalNetReturn,
      maxDrawdown: aggregateMetrics(rows).maxDrawdown
    }));
}

function maxTradeShare(trades, keyFn) {
  if (!trades.length) return 0;
  const counts = new Map();
  for (const trade of trades) {
    const key = String(keyFn(trade) || "UNKNOWN");
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return Math.max(...counts.values()) / trades.length;
}

function researchFoldForTime(value, window) {
  const timestamp = Number(value);
  const start = Date.parse(window.start);
  const end = Date.parse(window.end);
  const fraction = (timestamp - start) / Math.max(1, end - start);
  return `research-fold-${Math.min(5, Math.max(1, Math.floor(fraction * 5) + 1))}`;
}

function isCompleteHourlyDataset(dataset) {
  const candles = dataset?.candles;
  if (!Array.isArray(candles) || candles.length !== 8760) return false;
  return Number(candles[0]?.openTime) === Date.parse(M3_REAL_DATA_WINDOW.start)
    && Number(candles.at(-1)?.openTime) + 3600 * 1000 === Date.parse(M3_REAL_DATA_WINDOW.end)
    && candles.every((candle, index) => index === 0
      || Number(candle?.openTime) - Number(candles[index - 1]?.openTime) === 3600 * 1000);
}

function byExitTime(left, right) {
  return Number(left.exitTime) - Number(right.exitTime)
    || String(left.asset).localeCompare(String(right.asset));
}

function safeRatio(numerator, denominator) {
  const left = Number(numerator);
  const right = Number(denominator);
  return Number.isFinite(left) && Number.isFinite(right) && right !== 0 ? left / right : null;
}

function average(values) {
  const finite = values.map(Number).filter(Number.isFinite);
  return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : null;
}

function requireRead(path) {
  // This synchronous helper is intentionally limited to the optional forward-index probe.
  return readFileSync(path, "utf8");
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || null : null;
}

function failClosed(message) {
  console.error(message);
  process.exitCode = 1;
}
