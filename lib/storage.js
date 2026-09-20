const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const TABLES = Object.freeze({
  sentAlerts: "cr_sent_alerts",
  runLogs: "cr_run_logs",
  processedScanCandles: "cr_processed_scan_candles",
  paperModelRuns: "cr_paper_model_runs"
});

const HISTORICAL_PAGE_SIZE = 500;
const TRANSIENT_SUPABASE_STATUSES = new Set([429, 500, 502, 503, 504, 520]);

/**
 * Retry only idempotent/replay-safe Supabase requests at the call site.
 * Review reads and review JSON patches are safe to retry because they either
 * read a row or write the same review payload again.
 */
export async function fetchWithRetry(url, options = {}, {
  maxAttempts = 4,
  delaysMs = [250, 750, 1500],
  jitterRatio = 0.2,
  sleep = sleepForRetry
} = {}) {
  const attempts = Math.max(1, Math.trunc(Number(maxAttempts) || 1));
  let lastError = null;
  let lastResponse = null;

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetch(url, options);
      if (response.ok || !TRANSIENT_SUPABASE_STATUSES.has(response.status) || attempt === attempts - 1) {
        return response;
      }
      lastResponse = response;
    } catch (error) {
      lastError = error;
      if (attempt === attempts - 1) throw error;
    }

    const baseDelay = Number(delaysMs[Math.min(attempt, delaysMs.length - 1)]) || 0;
    const jitter = baseDelay > 0 && jitterRatio > 0
      ? baseDelay * Math.min(1, Number(jitterRatio) || 0) * Math.random()
      : 0;
    const delay = Math.max(0, Math.round(baseDelay + jitter));
    if (delay > 0) await sleep(delay);
  }

  if (lastResponse) return lastResponse;
  throw lastError || new Error("Supabase request failed without a response");
}

function sleepForRetry(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function readJsonResponse(response, label) {
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const detail = body ? ` ${body.slice(0, 500)}` : "";
    throw new Error(`${label}: ${response.status}${detail}`);
  }
  return response.json();
}

export async function hasSentSignal(signalKey) {
  if (!isSupabaseConfigured()) return false;
  const url = `${SUPABASE_URL}/rest/v1/${TABLES.sentAlerts}?signal_key=eq.${encodeURIComponent(signalKey)}&select=signal_key&limit=1`;
  const response = await fetch(url, {
    headers: supabaseHeaders()
  });
  if (!response.ok) throw new Error(`Supabase sent lookup failed: ${response.status}`);
  const rows = await response.json();
  return rows.length > 0;
}

export async function claimSentSignal(alert) {
  if (!isSupabaseConfigured()) return true;
  const params = new URLSearchParams({ on_conflict: "signal_key" });
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${TABLES.sentAlerts}?${params}`, {
    method: "POST",
    headers: {
      ...supabaseHeaders(),
      "Content-Type": "application/json",
      Prefer: "resolution=ignore-duplicates,return=representation"
    },
    body: JSON.stringify({
      ...alert,
      delivery_status: "sending",
      sent_at: new Date().toISOString()
    })
  });
  if (!response.ok) throw new Error(`Supabase sent claim failed: ${response.status} ${await response.text()}`);
  const rows = await response.json();
  return rows.length > 0;
}

export async function recordSentSignal(alert) {
  if (!isSupabaseConfigured()) return;
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${TABLES.sentAlerts}`, {
    method: "POST",
    headers: {
      ...supabaseHeaders(),
      "Content-Type": "application/json",
      Prefer: "resolution=ignore-duplicates"
    },
    body: JSON.stringify(alert)
  });
  if (!response.ok) throw new Error(`Supabase sent insert failed: ${response.status}`);
}

export async function markSentSignal({ signalKey, payload, sentAt = new Date().toISOString() }) {
  if (!isSupabaseConfigured()) return;
  const params = new URLSearchParams({
    signal_key: `eq.${signalKey}`,
    delivery_status: "eq.sending"
  });
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${TABLES.sentAlerts}?${params}`, {
    method: "PATCH",
    headers: {
      ...supabaseHeaders(),
      "Content-Type": "application/json",
      Prefer: "return=minimal"
    },
    body: JSON.stringify({
      delivery_status: "sent",
      sent_at: sentAt,
      payload
    })
  });
  if (!response.ok) throw new Error(`Supabase sent status update failed: ${response.status} ${await response.text()}`);
}

export async function markFailedSentSignal(signalKey) {
  if (!isSupabaseConfigured()) return;
  const params = new URLSearchParams({
    signal_key: `eq.${signalKey}`,
    delivery_status: "eq.sending"
  });
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${TABLES.sentAlerts}?${params}`, {
    method: "PATCH",
    headers: {
      ...supabaseHeaders(),
      "Content-Type": "application/json",
      Prefer: "return=minimal"
    },
    body: JSON.stringify({ delivery_status: "failed" })
  });
  if (!response.ok) throw new Error(`Supabase sent failure update failed: ${response.status} ${await response.text()}`);
}

export async function releaseSentSignal(signalKey) {
  if (!isSupabaseConfigured()) return;
  const params = new URLSearchParams({
    signal_key: `eq.${signalKey}`,
    delivery_status: "eq.sending"
  });
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${TABLES.sentAlerts}?${params}`, {
    method: "DELETE",
    headers: supabaseHeaders()
  });
  if (!response.ok) throw new Error(`Supabase sent claim release failed: ${response.status} ${await response.text()}`);
}

export async function updateSentAlertPayload(signalKey, payload) {
  if (!isSupabaseConfigured()) return;
  const response = await fetchWithRetry(`${SUPABASE_URL}/rest/v1/${TABLES.sentAlerts}?signal_key=eq.${encodeURIComponent(signalKey)}`, {
    method: "PATCH",
    headers: {
      ...supabaseHeaders(),
      "Content-Type": "application/json",
      Prefer: "return=minimal"
    },
    body: JSON.stringify({ payload })
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Supabase sent payload update failed: ${response.status} ${body}`);
  }
}

export async function recordRunLog(log) {
  if (!isSupabaseConfigured()) return;
  let payload = { ...log };
  for (let attempt = 0; attempt <= 4; attempt++) {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/${TABLES.runLogs}`, {
      method: "POST",
      headers: {
        ...supabaseHeaders(),
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
    if (response.ok) return;

    const body = await response.text();
    if (response.status !== 400 || !hasOptionalRunLogColumnError(body)) {
      throw new Error(`Supabase run log insert failed: ${response.status} ${body}`);
    }
    payload = { ...payload };
    for (const column of ["email_status", "warnings", "email_result", "sent_alert_keys"]) {
      if (body.includes(column)) delete payload[column];
    }
  }

  throw new Error("Supabase run log insert failed after compatibility retries");
}

export async function fetchRecentRunLogs(limit = 50) {
  if (!isSupabaseConfigured()) return [];
  let optionalColumns = ["email_status", "warnings", "email_result", "sent_alert_keys"];
  for (let attempt = 0; attempt <= optionalColumns.length; attempt++) {
    const response = await fetchRunLogs(limit, runLogSelect(optionalColumns));
    if (response.ok) return response.json();

    const body = await response.text();
    if (response.status !== 400 || !hasOptionalRunLogColumnError(body)) {
      throw new Error(`Supabase run log lookup failed: ${response.status}`);
    }
    optionalColumns = optionalColumns.filter((column) => !body.includes(column));
  }

  throw new Error("Supabase run log lookup failed after compatibility retries");
}

function fetchRunLogs(limit, select) {
  const params = new URLSearchParams({
    select,
    order: "created_at.desc",
    limit: String(limit)
  });
  return fetch(`${SUPABASE_URL}/rest/v1/${TABLES.runLogs}?${params}`, {
    headers: supabaseHeaders()
  });
}

function runLogSelect(optionalColumns = ["email_status", "warnings", "email_result", "sent_alert_keys"]) {
  return [
    "id",
    "created_at",
    "started_at",
    "finished_at",
    "scan_group",
    "candidates_count",
    "signals_count",
    "emailed",
    ...optionalColumns,
    "errors"
  ].join(",");
}

function hasOptionalRunLogColumnError(body) {
  return ["email_status", "warnings", "email_result", "sent_alert_keys"].some((column) => body.includes(column));
}

export async function fetchRecentSentAlerts(limit = 25) {
  if (!isSupabaseConfigured()) return [];
  const params = new URLSearchParams({
    select: sentAlertSelect(),
    delivery_status: "eq.sent",
    order: "sent_at.desc",
    limit: String(limit)
  });
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${TABLES.sentAlerts}?${params}`, {
    headers: supabaseHeaders()
  });
  if (!response.ok) throw new Error(`Supabase sent alerts lookup failed: ${response.status}`);
  return response.json();
}

export async function fetchAllSentAlerts({ pageSize = HISTORICAL_PAGE_SIZE, fetchImpl = fetch } = {}) {
  if (!isSupabaseConfigured()) return [];
  const params = new URLSearchParams({
    select: sentAlertSelect(),
    delivery_status: "eq.sent",
    order: "sent_at.asc,signal_key.asc"
  });
  return fetchAllPages({
    table: TABLES.sentAlerts,
    params,
    pageSize,
    fetchImpl,
    errorLabel: "Supabase historical sent alerts lookup"
  });
}

export async function fetchSentAlertsForReview(limit = 200) {
  if (!isSupabaseConfigured()) return [];
  const params = new URLSearchParams({
    select: sentAlertSelect(),
    delivery_status: "eq.sent",
    order: "sent_at.desc",
    limit: String(limit)
  });
  const response = await fetchWithRetry(`${SUPABASE_URL}/rest/v1/${TABLES.sentAlerts}?${params}`, {
    headers: supabaseHeaders()
  });
  return readJsonResponse(response, `Supabase sent alerts review lookup failed`);
}

export async function fetchSentAlertsForReviewPage({ limit = 100, offset = 0 } = {}) {
  if (!isSupabaseConfigured()) return [];
  const params = new URLSearchParams({
    select: sentAlertSelect(),
    delivery_status: "eq.sent",
    order: "sent_at.asc,signal_key.asc",
    limit: String(Math.max(1, Math.trunc(Number(limit) || 100))),
    offset: String(Math.max(0, Math.trunc(Number(offset) || 0)))
  });
  const response = await fetchWithRetry(`${SUPABASE_URL}/rest/v1/${TABLES.sentAlerts}?${params}`, {
    headers: supabaseHeaders()
  });
  return readJsonResponse(response, `Supabase sent alerts review page lookup failed`);
}

export async function fetchPendingSentAlertsForReview({
  limit = 20,
  excludeSignalKeys = []
} = {}) {
  if (!isSupabaseConfigured()) return [];
  const requestedLimit = Math.max(1, Math.trunc(Number(limit) || 20));
  const excluded = new Set((excludeSignalKeys || []).filter(Boolean));
  const queryLimit = Math.min(200, requestedLimit * 2);
  const [missingReview, pendingReview] = await Promise.all([
    fetchPendingSentAlertVariant({
      filter: ["payload->review", "is.null"],
      limit: queryLimit,
      excludeSignalKeys: excluded
    }),
    fetchPendingSentAlertVariant({
      filter: ["payload->review->>status", "eq.pending"],
      limit: queryLimit,
      excludeSignalKeys: excluded
    })
  ]);
  const byKey = new Map();
  for (const alert of [...missingReview, ...pendingReview]) {
    if (alert?.signal_key && !excluded.has(alert.signal_key)) byKey.set(alert.signal_key, alert);
  }
  return [...byKey.values()]
    .sort((left, right) => compareReviewTimes(left?.sent_at, right?.sent_at)
      || String(left?.signal_key || "").localeCompare(String(right?.signal_key || "")))
    .slice(0, requestedLimit);
}

async function fetchPendingSentAlertVariant({ filter, limit, excludeSignalKeys = new Set() }) {
  const params = new URLSearchParams({
    select: sentAlertSelect(),
    delivery_status: "eq.sent",
    order: "sent_at.asc,signal_key.asc",
    limit: String(limit)
  });
  if (excludeSignalKeys.size) {
    params.set("signal_key", `not.in.(${[...excludeSignalKeys].join(",")})`);
  }
  params.set(filter[0], filter[1]);
  const response = await fetchWithRetry(`${SUPABASE_URL}/rest/v1/${TABLES.sentAlerts}?${params}`, {
    headers: supabaseHeaders()
  });
  return readJsonResponse(response, `Supabase pending sent alerts lookup failed`);
}

function compareReviewTimes(left, right) {
  const leftTime = new Date(left || 0).getTime();
  const rightTime = new Date(right || 0).getTime();
  return (Number.isFinite(leftTime) ? leftTime : 0) - (Number.isFinite(rightTime) ? rightTime : 0);
}

export async function hasProcessedScanCandle({ scanGroup, asset, interval, candleOpenTime }) {
  if (!isSupabaseConfigured()) return false;
  const params = new URLSearchParams({
    select: "scan_group",
    scan_group: `eq.${scanGroup}`,
    asset: `eq.${asset}`,
    interval: `eq.${interval}`,
    candle_open_time: `eq.${new Date(candleOpenTime).toISOString()}`,
    limit: "1"
  });
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${TABLES.processedScanCandles}?${params}`, {
    headers: supabaseHeaders()
  });
  if (!response.ok) throw new Error(`Supabase processed candle lookup failed: ${response.status}`);
  const rows = await response.json();
  return rows.length > 0;
}

export async function recordProcessedScanCandle({ scanGroup, asset, interval, candleOpenTime }) {
  if (!isSupabaseConfigured()) return;
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${TABLES.processedScanCandles}`, {
    method: "POST",
    headers: {
      ...supabaseHeaders(),
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates"
    },
    body: JSON.stringify({
      scan_group: scanGroup,
      asset,
      interval,
      candle_open_time: new Date(candleOpenTime).toISOString()
    })
  });
  if (!response.ok) throw new Error(`Supabase processed candle insert failed: ${response.status}`);
}

export async function fetchPaperModelRun({ modelId, rebalanceTime }) {
  if (!isSupabaseConfigured()) return null;
  const params = new URLSearchParams({
    select: paperModelRunSelect(),
    model_id: `eq.${modelId}`,
    rebalance_time: `eq.${new Date(rebalanceTime).toISOString()}`,
    limit: "1"
  });
  const response = await fetchWithRetry(`${SUPABASE_URL}/rest/v1/${TABLES.paperModelRuns}?${params}`, {
    headers: supabaseHeaders()
  });
  const rows = await readJsonResponse(response, "Supabase paper model lookup failed");
  return rows[0] || null;
}

export async function recordPaperModelRun(run) {
  if (!isSupabaseConfigured()) return;
  const params = new URLSearchParams({
    on_conflict: "model_id,rebalance_time"
  });
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${TABLES.paperModelRuns}?${params}`, {
    method: "POST",
    headers: {
      ...supabaseHeaders(),
      "Content-Type": "application/json",
      Prefer: "resolution=ignore-duplicates,return=minimal"
    },
    body: JSON.stringify(run)
  });
  if (!response.ok) throw new Error(`Supabase paper model upsert failed: ${response.status} ${await response.text()}`);
}

export async function fetchRecentPaperModelRuns(limit = 12) {
  if (!isSupabaseConfigured()) return [];
  const params = new URLSearchParams({
    select: paperModelRunSelect(),
    order: "rebalance_time.desc,created_at.desc",
    limit: String(limit)
  });
  const response = await fetchWithRetry(`${SUPABASE_URL}/rest/v1/${TABLES.paperModelRuns}?${params}`, {
    headers: supabaseHeaders()
  });
  return readJsonResponse(response, "Supabase paper model runs lookup failed");
}

export async function fetchRecentPaperEmailRuns(limit = 100) {
  if (!isSupabaseConfigured()) return [];
  const params = new URLSearchParams({
    select: paperModelRunSelect(),
    email_status: "eq.sent",
    email_sent_at: "not.is.null",
    order: "email_sent_at.desc",
    limit: String(limit)
  });
  const response = await fetchWithRetry(`${SUPABASE_URL}/rest/v1/${TABLES.paperModelRuns}?${params}`, {
    headers: supabaseHeaders()
  });
  return readJsonResponse(response, "Supabase paper email history lookup failed");
}

export async function fetchAllPaperEmailRuns({ pageSize = HISTORICAL_PAGE_SIZE, fetchImpl = fetch } = {}) {
  if (!isSupabaseConfigured()) return [];
  const params = new URLSearchParams({
    select: paperModelRunSelect(),
    email_status: "eq.sent",
    email_sent_at: "not.is.null",
    order: "email_sent_at.asc,model_id.asc,rebalance_time.asc"
  });
  return fetchAllPages({
    table: TABLES.paperModelRuns,
    params,
    pageSize,
    fetchImpl,
    errorLabel: "Supabase historical paper email runs lookup"
  });
}

export async function fetchPreviousPaperModelRun({ modelId, beforeTime }) {
  if (!isSupabaseConfigured()) return null;
  const params = new URLSearchParams({
    select: paperModelRunSelect(),
    model_id: `eq.${modelId}`,
    rebalance_time: `lt.${new Date(beforeTime).toISOString()}`,
    order: "rebalance_time.desc",
    limit: "1"
  });
  const response = await fetchWithRetry(`${SUPABASE_URL}/rest/v1/${TABLES.paperModelRuns}?${params}`, {
    headers: supabaseHeaders()
  });
  const rows = await readJsonResponse(response, "Supabase previous paper model lookup failed");
  return rows[0] || null;
}

export async function fetchPaperModelRunsForModel({
  modelId,
  beforeTime,
  limit = 52
}) {
  if (!isSupabaseConfigured()) return [];
  const params = new URLSearchParams({
    select: paperModelRunSelect(),
    model_id: `eq.${modelId}`,
    rebalance_time: `lt.${new Date(beforeTime).toISOString()}`,
    order: "rebalance_time.desc",
    limit: String(limit)
  });
  const response = await fetchWithRetry(`${SUPABASE_URL}/rest/v1/${TABLES.paperModelRuns}?${params}`, {
    headers: supabaseHeaders()
  });
  return readJsonResponse(response, "Supabase paper model history lookup failed");
}

export async function fetchPaperModelRunsPage({
  modelId = null,
  limit = 100,
  offset = 0
} = {}) {
  if (!isSupabaseConfigured()) return [];
  const params = new URLSearchParams({
    select: paperModelRunSelect(),
    order: "rebalance_time.asc,created_at.asc",
    limit: String(Math.max(1, Math.trunc(Number(limit) || 100))),
    offset: String(Math.max(0, Math.trunc(Number(offset) || 0)))
  });
  if (modelId) params.set("model_id", `eq.${modelId}`);
  const response = await fetchWithRetry(`${SUPABASE_URL}/rest/v1/${TABLES.paperModelRuns}?${params}`, {
    headers: supabaseHeaders()
  });
  return readJsonResponse(response, "Supabase paper model review page lookup failed");
}

export async function fetchPendingPaperModelRunsForReview({
  modelId = null,
  limit = 20,
  excludeRunKeys = [],
  afterRun = null
} = {}) {
  if (!isSupabaseConfigured()) return [];
  const requestedLimit = Math.max(1, Math.trunc(Number(limit) || 20));
  const excluded = new Set((excludeRunKeys || []).filter(Boolean));
  const queryLimit = Math.min(200, requestedLimit * 2);
  const [missingReview, pendingReview] = await Promise.all([
    fetchPendingPaperModelVariant({ modelId, filter: ["review", "is.null"], limit: queryLimit, afterRun }),
    fetchPendingPaperModelVariant({ modelId, filter: ["review->>status", "eq.pending"], limit: queryLimit, afterRun })
  ]);
  const byKey = new Map();
  for (const run of [...missingReview, ...pendingReview]) {
    const key = paperModelRunKey(run);
    if (key && !excluded.has(key) && Array.isArray(run?.targets) && run.targets.length > 0) {
      byKey.set(key, run);
    }
  }
  return [...byKey.values()]
    .sort((left, right) => compareReviewTimes(left?.rebalance_time, right?.rebalance_time)
      || String(left?.model_id || "").localeCompare(String(right?.model_id || "")))
    .slice(0, requestedLimit);
}

async function fetchPendingPaperModelVariant({ modelId, filter, limit, afterRun = null }) {
  const params = new URLSearchParams({
    select: paperModelRunSelect(),
    order: "rebalance_time.asc,model_id.asc",
    limit: String(limit),
    targets: "neq.[]"
  });
  if (modelId) params.set("model_id", `eq.${modelId}`);
  if (afterRun?.rebalanceTime && afterRun?.modelId) {
    params.set(
      "or",
      `(rebalance_time.gt.${afterRun.rebalanceTime},and(rebalance_time.eq.${afterRun.rebalanceTime},model_id.gt.${afterRun.modelId}))`
    );
  }
  params.set(filter[0], filter[1]);
  const response = await fetchWithRetry(`${SUPABASE_URL}/rest/v1/${TABLES.paperModelRuns}?${params}`, {
    headers: supabaseHeaders()
  });
  return readJsonResponse(response, "Supabase pending paper model lookup failed");
}

export function paperModelRunKey(run) {
  if (!run?.model_id || !run?.rebalance_time) return null;
  return `${run.model_id}:${new Date(run.rebalance_time).toISOString()}`;
}

export async function fetchAllPaperEmailRunsForModel({
  modelId,
  beforeTime = Date.now(),
  pageSize = HISTORICAL_PAGE_SIZE,
  fetchImpl = fetch
} = {}) {
  if (!isSupabaseConfigured()) return [];
  const params = new URLSearchParams({
    select: paperModelRunSelect(),
    model_id: `eq.${modelId}`,
    email_status: "eq.sent",
    email_sent_at: "not.is.null",
    rebalance_time: `lt.${new Date(beforeTime).toISOString()}`,
    order: "rebalance_time.asc"
  });
  return fetchAllPages({
    table: TABLES.paperModelRuns,
    params,
    pageSize,
    fetchImpl,
    errorLabel: "Supabase historical paper email runs for model lookup"
  });
}

export async function fetchAllSentAlertsForModel({
  modelVersion,
  strategyId,
  signalVariant = null,
  beforeTime = Date.now(),
  pageSize = HISTORICAL_PAGE_SIZE,
  fetchImpl = fetch
} = {}) {
  if (!isSupabaseConfigured()) return [];
  const params = new URLSearchParams({
    select: sentAlertSelect(),
    delivery_status: "eq.sent",
    sent_at: `lt.${new Date(beforeTime).toISOString()}`,
    order: "sent_at.asc,signal_key.asc"
  });
  if (modelVersion) params.set("model_version", `eq.${modelVersion}`);
  if (strategyId) params.set("strategy_id", `eq.${strategyId}`);
  if (signalVariant) params.set("payload->>signalVariant", `eq.${signalVariant}`);
  return fetchAllPages({
    table: TABLES.sentAlerts,
    params,
    pageSize,
    fetchImpl,
    errorLabel: "Supabase historical sent alerts for model lookup"
  });
}

export async function fetchPendingPaperModelRunsForModel({
  modelId,
  limit = 12,
  fetchImpl = fetch
}) {
  if (!isSupabaseConfigured()) return [];
  const params = new URLSearchParams({
    select: paperModelRunSelect(),
    model_id: `eq.${modelId}`,
    "review->>status": "eq.pending",
    targets: "neq.[]",
    order: "rebalance_time.asc",
    limit: String(Math.min(50, Math.max(1, Number(limit) || 12)))
  });
  const response = await fetchImpl(`${SUPABASE_URL}/rest/v1/${TABLES.paperModelRuns}?${params}`, {
    headers: supabaseHeaders()
  });
  if (!response.ok) throw new Error(`Supabase pending paper model runs lookup failed: ${response.status} ${await response.text()}`);
  const rows = await response.json();
  return Array.isArray(rows) ? rows.filter((run) => Array.isArray(run.targets) && run.targets.length) : [];
}

export async function claimPaperModelEmail({ modelId, rebalanceTime }) {
  if (!isSupabaseConfigured()) return null;
  const params = new URLSearchParams({
    select: paperModelRunSelect(),
    model_id: `eq.${modelId}`,
    rebalance_time: `eq.${new Date(rebalanceTime).toISOString()}`,
    email_status: "eq.pending"
  });
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${TABLES.paperModelRuns}?${params}`, {
    method: "PATCH",
    headers: {
      ...supabaseHeaders(),
      "Content-Type": "application/json",
      Prefer: "return=representation"
    },
    body: JSON.stringify({
      email_status: "sending",
      email_claimed_at: new Date().toISOString()
    })
  });
  if (!response.ok) throw new Error(`Supabase paper email claim failed: ${response.status} ${await response.text()}`);
  const rows = await response.json();
  return rows[0] || null;
}

export async function updatePaperModelEmail({
  modelId,
  rebalanceTime,
  emailStatus,
  emailResult = null,
  sentAt = null
}) {
  if (!isSupabaseConfigured()) return;
  const params = new URLSearchParams({
    model_id: `eq.${modelId}`,
    rebalance_time: `eq.${new Date(rebalanceTime).toISOString()}`
  });
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${TABLES.paperModelRuns}?${params}`, {
    method: "PATCH",
    headers: {
      ...supabaseHeaders(),
      "Content-Type": "application/json",
      Prefer: "return=minimal"
    },
    body: JSON.stringify({
      email_status: emailStatus,
      email_result: emailResult,
      email_sent_at: sentAt
    })
  });
  if (!response.ok) throw new Error(`Supabase paper email status update failed: ${response.status} ${await response.text()}`);
}

export async function updatePaperModelReview({ modelId, rebalanceTime, review }) {
  if (!isSupabaseConfigured()) return;
  const params = new URLSearchParams({
    model_id: `eq.${modelId}`,
    rebalance_time: `eq.${new Date(rebalanceTime).toISOString()}`
  });
  const response = await fetchWithRetry(`${SUPABASE_URL}/rest/v1/${TABLES.paperModelRuns}?${params}`, {
    method: "PATCH",
    headers: {
      ...supabaseHeaders(),
      "Content-Type": "application/json",
      Prefer: "return=minimal"
    },
    body: JSON.stringify({ review })
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Supabase paper model review update failed: ${response.status} ${body}`);
  }
}

export async function updatePendingPaperModelReview({
  modelId,
  rebalanceTime,
  review,
  fetchImpl = fetch
}) {
  if (!isSupabaseConfigured()) return null;
  const params = new URLSearchParams({
    select: paperModelRunSelect(),
    model_id: `eq.${modelId}`,
    rebalance_time: `eq.${new Date(rebalanceTime).toISOString()}`,
    "review->>status": "eq.pending"
  });
  const response = await fetchImpl(`${SUPABASE_URL}/rest/v1/${TABLES.paperModelRuns}?${params}`, {
    method: "PATCH",
    headers: {
      ...supabaseHeaders(),
      "Content-Type": "application/json",
      Prefer: "return=representation"
    },
    body: JSON.stringify({ review })
  });
  if (!response.ok) throw new Error(`Supabase pending paper model review update failed: ${response.status} ${await response.text()}`);
  const rows = await response.json();
  return rows[0] || null;
}

export function isSupabaseConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
}

function paperModelRunSelect() {
  return [
    "model_id",
    "model_version",
    "model_fingerprint",
    "code_commit",
    "rebalance_time",
    "data_cutoff_time",
    "state",
    "deployment_gate_passed",
    "capital_weight",
    "predicted_beta",
    "gross_exposure",
    "eligible_symbols",
    "targets",
    "risk_state",
    "diagnostics",
    "review",
    "email_status",
    "email_claimed_at",
    "email_sent_at",
    "email_result",
    "created_at"
  ].join(",");
}

function sentAlertSelect() {
  return [
    "signal_key",
    "asset",
    "strategy_id",
    "interval",
    "trigger_time",
    "recommendation_score",
    "model_version",
    "model_fingerprint",
    "code_commit",
    "signal_family",
    "signal_direction",
    "delivery_mode",
    "delivery_status",
    "sent_at",
    "payload"
  ].join(",");
}

async function fetchAllPages({ table, params, pageSize, fetchImpl, errorLabel }) {
  const limit = Number.isInteger(pageSize) && pageSize > 0
    ? Math.min(pageSize, 1000)
    : HISTORICAL_PAGE_SIZE;
  const rows = [];
  for (let offset = 0; ; offset += limit) {
    const pageParams = new URLSearchParams(params);
    pageParams.set("limit", String(limit));
    pageParams.set("offset", String(offset));
    const response = await fetchImpl(`${SUPABASE_URL}/rest/v1/${table}?${pageParams}`, {
      headers: supabaseHeaders()
    });
    if (!response.ok) throw new Error(`${errorLabel} failed: ${response.status} ${await response.text()}`);
    const page = await response.json();
    if (!Array.isArray(page)) throw new Error(`${errorLabel} returned a non-array response`);
    rows.push(...page);
    if (page.length < limit) return rows;
  }
}

function supabaseHeaders() {
  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
  };
}
