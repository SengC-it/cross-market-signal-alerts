import { fetchRecentRunLogs, fetchRecentSentAlerts, isSupabaseConfigured } from "../lib/storage.js";

const EXPECTED_GROUPS = [
  "crypto-core-a",
  "crypto-core-b",
  "crypto-alt-a",
  "crypto-alt-b",
  "crypto-alt-c",
  "futures-core",
  "futures-arbitrage",
  "tradfi"
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
    const alertLimit = clampLimit(req.query?.alertLimit, 5, 50, 25);
    const [runLogsResult, sentAlertsResult] = await Promise.allSettled([
      fetchRecentRunLogs(limit),
      fetchRecentSentAlerts(alertLimit)
    ]);
    const warnings = [];
    const runLogs = unwrapResult(runLogsResult, "run_logs", warnings);
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

function unwrapResult(result, source, warnings) {
  if (result.status === "fulfilled") return result.value;
  warnings.push({
    source,
    message: result.reason instanceof Error ? result.reason.message : String(result.reason)
  });
  return [];
}

function buildSummary(runLogs, sentAlerts) {
  const groups = new Map();
  for (const group of EXPECTED_GROUPS) {
    groups.set(group, { group, runs: 0, lastRun: null, candidates: 0, signals: 0, emails: 0, errors: 0, warnings: 0 });
  }
  for (const log of runLogs) {
    const group = log.scan_group || "all";
    if (!groups.has(group)) groups.set(group, { group, runs: 0, lastRun: null, candidates: 0, signals: 0, emails: 0, errors: 0, warnings: 0 });
    const item = groups.get(group);
    item.runs += 1;
    item.candidates += Number(log.candidates_count || 0);
    item.signals += Number(log.signals_count || 0);
    if (log.emailed) item.emails += 1;
    if (Array.isArray(log.errors) && log.errors.length) item.errors += log.errors.length;
    if (Array.isArray(log.warnings) && log.warnings.length) item.warnings += log.warnings.length;
    if (!item.lastRun || new Date(log.created_at) > new Date(item.lastRun)) item.lastRun = log.created_at;
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
    latestRunErrors: Array.isArray(latestRun?.errors) ? latestRun.errors.length : 0,
    latestRunWarnings: Array.isArray(latestRun?.warnings) ? latestRun.warnings.length : 0,
    latestAlertAt: latestAlert?.sent_at || null,
    totalRunsReturned: runLogs.length,
    totalAlertsReturned: sentAlerts.length,
    groups: [...groups.values()].sort((a, b) => String(a.group).localeCompare(String(b.group)))
  };
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
