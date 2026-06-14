import { fetchRecentRunLogs, fetchRecentSentAlerts, isSupabaseConfigured } from "../lib/storage.js";

const EXPECTED_GROUPS = [
  "dynamic-spot",
  "crypto-core-a-1h",
  "crypto-core-b-1h",
  "crypto-alt-a-1h",
  "crypto-alt-b-1h",
  "crypto-alt-c-1h",
  "futures-scalp-a",
  "futures-scalp-b",
  "futures-core-1h",
  "futures-arbitrage",
  "crypto-core-a-mid",
  "crypto-core-b-mid",
  "crypto-alt-a-mid",
  "crypto-alt-b-mid",
  "crypto-alt-c-mid",
  "futures-core-mid",
  "crypto-core-a-daily",
  "crypto-core-b-daily",
  "crypto-alt-a-daily",
  "crypto-alt-b-daily",
  "crypto-alt-c-daily",
  "futures-daily",
  "tradfi-daily"
];

export default async function handler(req, res) {
  if (!isAuthorized(req)) {
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
    const [runLogsResult, sentAlertsResult] = await Promise.allSettled([
      fetchRecentRunLogs(limit),
      fetchRecentSentAlerts(alertLimit)
    ]);
    const warnings = [];
    const runLogs = normalizeRunLogs(unwrapResult(runLogsResult, "run_logs", warnings));
    const sentAlerts = unwrapResult(sentAlertsResult, "sent_alerts", warnings);

    if (runLogsResult.status === "rejected" && sentAlertsResult.status === "rejected") {
      throw new Error(warnings.map((warning) => `${warning.source}: ${warning.message}`).join("; "));
    }

    res.status(200).json({
      ok: true,
      generatedAt: new Date().toISOString(),
      warnings,
      summary: buildSummary(runLogs, sentAlerts),
      runLogs,
      sentAlerts
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

function buildSummary(runLogs, sentAlerts) {
  const sentAlertKeys = new Set(sentAlerts.map((alert) => alert.signal_key).filter(Boolean));
  const groups = new Map();
  for (const group of EXPECTED_GROUPS) {
    groups.set(group, emptyGroupSummary(group));
  }
  for (const log of runLogs) {
    const group = log.scan_group || "all";
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
  const latestAlert = sentAlerts[0] || null;
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
    totalAlertsReturned: sentAlerts.length,
    groups: [...groups.values()].sort((a, b) => String(a.group).localeCompare(String(b.group)))
  };
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

function isAuthorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;

  const auth = req.headers.authorization || "";
  const querySecret = req.query?.secret;
  return auth === `Bearer ${secret}` || querySecret === secret;
}
