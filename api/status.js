import {
  fetchRecentPaperModelRuns,
  fetchRecentRunLogs,
  fetchRecentSentAlerts,
  isSupabaseConfigured
} from "../lib/storage.js";
import { isDashboardAuthorizedRequest, setPrivateResponseHeaders } from "../lib/api-auth.js";
import { FUNDING_CARRY_V2_MODEL, FUNDING_CARRY_V2_MODEL_METADATA } from "../lib/funding-carry-v2-paper.js";

const EXPECTED_GROUPS = [
  "dynamic-spot",
  "dynamic-weak-spot"
];

export default async function handler(req, res) {
  setPrivateResponseHeaders(res);
  if (!isDashboardAuthorizedRequest(req)) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return;
  }

  if (!isSupabaseConfigured()) {
    res.status(503).json({
      ok: false,
      error: "supabase_not_configured",
      message: "SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing"
    });
    return;
  }

  try {
    const limit = clampLimit(req.query?.limit, 10, 100, 50);
    const alertLimit = clampLimit(req.query?.alertLimit, 5, 200, 100);
    const paperLimit = clampLimit(req.query?.paperLimit, 1, 52, 12);
    const [runLogsResult, sentAlertsResult, paperRunsResult] = await Promise.allSettled([
      fetchRecentRunLogs(limit),
      fetchRecentSentAlerts(alertLimit),
      fetchRecentPaperModelRuns(paperLimit)
    ]);
    const warnings = [];
    const runLogs = normalizeRunLogs(unwrapResult(runLogsResult, "cr_run_logs", warnings));
    const sentAlerts = unwrapResult(sentAlertsResult, "cr_sent_alerts", warnings);
    const paperModelRuns = unwrapResult(paperRunsResult, "cr_paper_model_runs", warnings);
    const emailNotifications = buildEmailNotifications(sentAlerts, paperModelRuns);

    if ([runLogsResult, sentAlertsResult, paperRunsResult].every((result) => result.status === "rejected")) {
      throw new Error(warnings.map((warning) => `${warning.source}: ${warning.message}`).join("; "));
    }

    res.status(200).json({
      ok: true,
      generatedAt: new Date().toISOString(),
      warnings,
      summary: buildSummary(runLogs, sentAlerts, emailNotifications, paperModelRuns),
      runLogs,
      sentAlerts,
      paperModelRuns,
      fundingCarryV2: {
        modelId: FUNDING_CARRY_V2_MODEL.id,
        modelVersion: FUNDING_CARRY_V2_MODEL.version,
        modelFingerprint: FUNDING_CARRY_V2_MODEL_METADATA.fingerprint,
        codeCommit: FUNDING_CARRY_V2_MODEL_METADATA.codeCommit,
        state: FUNDING_CARRY_V2_MODEL.state,
        researchGatePassed: FUNDING_CARRY_V2_MODEL.researchGatePassed,
        deploymentGatePassed: FUNDING_CARRY_V2_MODEL.deploymentGatePassed,
        capitalWeight: FUNDING_CARRY_V2_MODEL.capitalWeight,
        universeSize: FUNDING_CARRY_V2_MODEL.universe.length,
        paperRunCount: paperModelRuns.filter((run) => run.model_id === FUNDING_CARRY_V2_MODEL.id).length
      },
      emailNotifications
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

function normalizeRunLogs(runLogs) {
  return runLogs.map((log) => ({
    ...log,
    warnings: filterActionableWarnings(log.warnings)
  }));
}

function filterActionableWarnings(warnings) {
  if (!Array.isArray(warnings)) return warnings;
  return warnings.filter((warning) => {
    const label = String(warning?.label || "");
    const message = String(warning?.warning || warning?.message || warning?.error || "");
    return !label.includes("arbitrage threshold") && !message.includes("低于提醒阈值");
  });
}

function unwrapResult(result, source, warnings) {
  if (result.status === "fulfilled") return result.value;
  warnings.push({
    source,
    message: result.reason instanceof Error ? result.reason.message : String(result.reason)
  });
  return [];
}

function buildSummary(runLogs, sentAlerts, emailNotifications = [], paperModelRuns = []) {
  const sentAlertKeys = new Set(sentAlerts.map((alert) => alert.signal_key).filter(Boolean));
  const groups = new Map();
  for (const group of EXPECTED_GROUPS) {
    groups.set(group, emptyGroupSummary(group));
  }
  for (const log of runLogs) {
    const group = log.scan_group || "all";
    if (isBatchGroup(group)) continue;
    if (!groups.has(group)) groups.set(group, emptyGroupSummary(group));
    const item = groups.get(group);
    item.runs += 1;
    item.candidates += Number(log.candidates_count || 0);
    item.signals += Number(log.signals_count || 0);
    const consistency = emailConsistency(log, sentAlertKeys);
    log.email_consistency = consistency;
    if (consistency.status === "verified") item.emails += 1;
    if (consistency.status === "legacy_unverified" || consistency.status === "missing_sent_alert_record") item.unverifiedEmails += 1;
    const errorCount = Array.isArray(log.errors) ? log.errors.length : 0;
    const warningCount = Array.isArray(log.warnings) ? log.warnings.length : 0;
    item.totalErrors += errorCount;
    item.totalWarnings += warningCount;
    if (!item.lastRun || new Date(log.created_at) > new Date(item.lastRun)) {
      item.lastRun = log.created_at;
      item.errors = errorCount;
      item.warnings = warningCount;
      item.latestCandidates = Number(log.candidates_count || 0);
      item.latestSignals = Number(log.signals_count || 0);
      item.latestEmailed = Boolean(log.emailed);
    }
  }

  const latestRun = runLogs[0] || null;
  const latestAlert = emailNotifications[0] || null;
  const latestPaperRun = paperModelRuns[0] || null;
  const newestRunMs = latestRun?.created_at ? Date.now() - new Date(latestRun.created_at).getTime() : null;

  return {
    latestRunAt: latestRun?.created_at || null,
    latestScanGroup: latestRun?.scan_group || null,
    latestRunAgeMinutes: newestRunMs == null ? null : Math.round(newestRunMs / 60000),
    latestRunHadSignal: Boolean(latestRun && Number(latestRun.signals_count || 0) > 0),
    latestRunEmailed: Boolean(latestRun?.emailed),
    latestRunEmailConsistency: latestRun ? emailConsistency(latestRun, sentAlertKeys) : { status: "none" },
    latestRunErrors: Array.isArray(latestRun?.errors) ? latestRun.errors.length : 0,
    latestRunWarnings: Array.isArray(latestRun?.warnings) ? latestRun.warnings.length : 0,
    latestAlertAt: latestAlert?.sent_at || null,
    totalRunsReturned: runLogs.length,
    totalAlertsReturned: emailNotifications.length,
    paperModel: latestPaperRun ? {
      modelId: latestPaperRun.model_id,
      modelVersion: latestPaperRun.model_version || "V3.1 PAPER",
      modelFingerprint: latestPaperRun.model_fingerprint || null,
      codeCommit: latestPaperRun.code_commit || null,
      rebalanceTime: latestPaperRun.rebalance_time,
      state: latestPaperRun.state,
      deploymentGatePassed: latestPaperRun.deployment_gate_passed,
      historicalGateVersion: latestPaperRun.diagnostics?.historicalGateVersion || null,
      capitalWeight: Number(latestPaperRun.capital_weight),
      predictedBeta: Number(latestPaperRun.predicted_beta),
      emailStatus: latestPaperRun.email_status,
      emailSentAt: latestPaperRun.email_sent_at,
      targetCount: Array.isArray(latestPaperRun.targets) ? latestPaperRun.targets.length : 0,
      review: latestPaperRun.review || { status: "pending", reason: "持仓周期未结束" }
    } : null,
    groups: [...groups.values()].sort((a, b) => String(a.group).localeCompare(String(b.group)))
  };
}

export function buildEmailNotifications(sentAlerts = [], paperModelRuns = []) {
  const legacyNotifications = sentAlerts
    .filter((alert) => !isSuppressedPaperSignal(alert))
    .map((alert) => ({
      ...alert,
      model_version: inferLegacyModelVersion(alert)
    }));
  const paperNotifications = paperModelRuns
    .filter((run) => run.email_status === "sent" && run.email_sent_at)
    .flatMap((run) => {
      const targets = Array.isArray(run.targets) ? run.targets : [];
      const modelVersion = run.model_version || "V3.1 PAPER";
      const isV33 = modelVersion.startsWith("V3.3");
      const isV34 = modelVersion.startsWith("V3.4");
      const isFundingCarry = modelVersion.startsWith("FUNDING CARRY");
      const isFundingCarryV2 = modelVersion.startsWith("FUNDING CARRY PERP Z-SCORE V2");
      const isRiskManaged = isV33 || isV34;
      const riskState = run.risk_state || {};
      return targets.map((target) => ({
        signal_key: `paper:${run.model_id}:${run.rebalance_time}:${target.symbol}`,
        sent_at: run.email_sent_at,
        asset: target.symbol,
        strategy_id: run.model_id,
        interval: isFundingCarry ? "8h funding" : "168h",
        trigger_time: run.rebalance_time,
        recommendation_score: null,
        model_version: modelVersion,
        model_fingerprint: run.model_fingerprint || null,
        code_commit: run.code_commit || null,
        payload: {
          kind: isFundingCarry ? "funding_carry_paper_position" : "v3_paper_portfolio",
          market: isFundingCarry ? "USDT Perpetual Funding Carry" : "USDT 永续合约组合",
          strategyName: isFundingCarry
            ? isFundingCarryV2
              ? "Funding Carry V2 perpetual z-score/trend/volatility PAPER"
              : "Funding Carry perpetual trend-filter PAPER"
            : isV34
            ? "残差动量 beta 中性 + 波动率目标 + 灾难止损 + 回撤熔断"
            : isV33
              ? "组合波动率目标 + 灾难止损 + 回撤熔断"
              : "残差动量 beta 中性",
          modelVersion,
          historicalGateVersion: run.diagnostics?.historicalGateVersion || null,
          modelFingerprint: run.model_fingerprint || null,
          codeCommit: run.code_commit || null,
          alertTierLabel: isFundingCarry
            ? isFundingCarryV2 ? "PAPER / 不执行交易" : "PAPER no execution"
            : isV34
            ? "UNIFIED PAPER 验证"
            : isV33 ? "SHADOW PAPER 验证" : "PAPER 验证",
          executionPlan: {
            kind: isFundingCarry ? "funding_carry_paper_position" : "v3_paper_position",
            side: target.side,
            targetWeight: Number(target.targetWeight),
            baseTargetWeight: numberOrNull(target.baseTargetWeight),
            referencePrice: Number(target.referencePrice),
            stopLoss: numberOrNull(target.stopLoss),
            fundingRate: numberOrNull(target.fundingRate),
            signedZ: numberOrNull(target.signedZ),
            zScore: numberOrNull(target.zScore),
            zWindow: numberOrNull(target.zWindow),
            minAbsFunding: numberOrNull(target.minAbsFunding),
            exitSignedZ: numberOrNull(target.exitSignedZ),
            volatility: target.volatility || null,
            nextFundingTime: target.nextFundingTime || null,
            trendRules: target.trendRules || [],
            beta: Number(target.beta),
            score: Number(target.score),
            grossExposure: Number(run.gross_exposure),
            predictedBeta: Number(run.predicted_beta),
            currentRisk: numberOrNull(riskState.currentRisk ?? riskState.aggregateRisk),
            maxAggregateRisk: numberOrNull(riskState.maxAggregateRisk),
            openPositionCount: numberOrNull(riskState.openPositionCount),
            catastropheStopPct: numberOrNull(riskState.catastropheStop),
            maxHoldingHours: isFundingCarry
              ? Number(target.maxHoldingHours || 48)
              : isRiskManaged ? 168 : null,
            takeProfit: null
          },
          scoringBreakdown: {
            kind: isFundingCarry ? "funding_carry_paper_position" : "v3_paper_position",
            eligibleSymbols: Number(run.eligible_symbols),
            beta: Number(target.beta),
            score: Number(target.score),
            quoteVolume24h: Number(target.quoteVolume24h),
            forecastAnnualVolatility: numberOrNull(
              riskState.forecastAnnualVolatility
            ),
            targetAnnualVolatility: numberOrNull(
              riskState.targetAnnualVolatility
            )
          },
          review: buildPaperTargetReview(run.review, target, modelVersion)
        }
      }));
    });

  return [...legacyNotifications, ...paperNotifications]
    .sort((a, b) => new Date(b.sent_at).getTime() - new Date(a.sent_at).getTime());
}

function isSuppressedPaperSignal(alert) {
  return alert?.payload?.delivery?.mode === "PAPER"
    && alert?.payload?.delivery?.emailSuppressed === true;
}

function buildPaperTargetReview(review, target, modelVersion) {
  const position = Array.isArray(review?.positions)
    ? review.positions.find((item) => item.symbol === target.symbol)
    : null;
  if (review?.status !== "reviewed") {
    if (!review) {
      return {
        status: "pending",
        reason: "持仓周期未结束"
      };
    }
    if (!position) return review;
    return {
      status: "pending",
      reason: review.reason,
      outcome: position.outcome || review.outcome || "持仓中",
      modelVersion: review.modelVersion || modelVersion || "V3.1 PAPER",
      method: review.method,
      holdingHours: review.holdingHours,
      entryTime: review.entryTime,
      markTime: review.markTime || review.latestMarkTime,
      expectedExitTime: review.expectedExitTime,
      entryPrice: position.entryPrice,
      markPrice: position.markPrice,
      priceReturn: position.directionalPriceReturn,
      fundingReturn: position.fundingReturn,
      tradingCost: position.tradingCost,
      returnPct: position.returnPct,
      netOfCosts: review.netOfCosts === true,
      portfolioReturnPct: review.returnPct ?? review.latestMarkedReturn
    };
  }

  if (!position) return review;

  return {
    status: "reviewed",
    outcome: position.outcome || "已复盘",
    modelVersion: review.modelVersion || modelVersion || "V3.1 PAPER",
    method: review.method,
    exitReason: review.exitReason,
    holdingHours: review.holdingHours,
    entryTime: review.entryTime,
    exitTime: review.exitTime,
    reviewedAt: review.reviewedAt,
    entryPrice: position.entryPrice,
    exitPrice: position.exitPrice,
    priceReturn: position.directionalPriceReturn,
    fundingReturn: position.fundingReturn,
    tradingCost: position.tradingCost,
    returnPct: position.returnPct,
    netOfCosts: true,
    portfolioReturnPct: review.returnPct
  };
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function inferLegacyModelVersion(alert) {
  const explicit = alert?.model_version
    || alert?.payload?.modelVersion
    || alert?.payload?.modelMetadata?.modelVersion
    || alert?.payload?.executionPlan?.modelVersion
    || alert?.payload?.review?.modelVersion;
  if (explicit === "trade_plan_v2") return "交易计划 V2";
  if (explicit && explicit !== "legacy") return String(explicit);
  return "旧版信号模型";
}

function isBatchGroup(group) {
  return String(group || "").startsWith("batch:");
}

function emptyGroupSummary(group) {
  return {
    group,
    runs: 0,
    lastRun: null,
    candidates: 0,
    signals: 0,
    latestCandidates: 0,
    latestSignals: 0,
    latestEmailed: false,
    emails: 0,
    unverifiedEmails: 0,
    errors: 0,
    warnings: 0,
    totalErrors: 0,
    totalWarnings: 0
  };
}

function emailConsistency(log, sentAlertKeys) {
  if (!log?.emailed) return { status: "none", missingKeys: [] };
  const keys = Array.isArray(log.sent_alert_keys) ? log.sent_alert_keys.filter(Boolean) : [];
  if (!keys.length) return { status: "legacy_unverified", missingKeys: [] };

  const missingKeys = keys.filter((key) => !sentAlertKeys.has(key));
  return missingKeys.length
    ? { status: "missing_sent_alert_record", missingKeys }
    : { status: "verified", missingKeys: [] };
}

function clampLimit(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}
