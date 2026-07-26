const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export async function hasSentSignal(signalKey) {
  if (!isSupabaseConfigured()) return false;
  const url = `${SUPABASE_URL}/rest/v1/sent_alerts?signal_key=eq.${encodeURIComponent(signalKey)}&select=signal_key&limit=1`;
  const response = await fetch(url, {
    headers: supabaseHeaders()
  });
  if (!response.ok) throw new Error(`Supabase sent lookup failed: ${response.status}`);
  const rows = await response.json();
  return rows.length > 0;
}

export async function recordSentSignal(alert) {
  if (!isSupabaseConfigured()) return;
  const response = await fetch(`${SUPABASE_URL}/rest/v1/sent_alerts`, {
    method: "POST",
    headers: {
      ...supabaseHeaders(),
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates"
    },
    body: JSON.stringify(alert)
  });
  if (!response.ok) throw new Error(`Supabase sent insert failed: ${response.status}`);
}

export async function updateSentAlertPayload(signalKey, payload) {
  if (!isSupabaseConfigured()) return;
  const response = await fetch(`${SUPABASE_URL}/rest/v1/sent_alerts?signal_key=eq.${encodeURIComponent(signalKey)}`, {
    method: "PATCH",
    headers: {
      ...supabaseHeaders(),
      "Content-Type": "application/json",
      Prefer: "return=minimal"
    },
    body: JSON.stringify({ payload })
  });
  if (!response.ok) throw new Error(`Supabase sent payload update failed: ${response.status} ${await response.text()}`);
}

export async function recordRunLog(log) {
  if (!isSupabaseConfigured()) return;
  let payload = { ...log };
  for (let attempt = 0; attempt <= 4; attempt++) {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/run_logs`, {
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
  return fetch(`${SUPABASE_URL}/rest/v1/run_logs?${params}`, {
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
    select: "signal_key,asset,strategy_id,interval,trigger_time,recommendation_score,sent_at,payload",
    order: "sent_at.desc",
    limit: String(limit)
  });
  const response = await fetch(`${SUPABASE_URL}/rest/v1/sent_alerts?${params}`, {
    headers: supabaseHeaders()
  });
  if (!response.ok) throw new Error(`Supabase sent alerts lookup failed: ${response.status}`);
  return response.json();
}

export async function fetchSentAlertsForReview(limit = 200) {
  if (!isSupabaseConfigured()) return [];
  const params = new URLSearchParams({
    select: "signal_key,asset,strategy_id,interval,trigger_time,recommendation_score,sent_at,payload",
    order: "sent_at.desc",
    limit: String(limit)
  });
  const response = await fetch(`${SUPABASE_URL}/rest/v1/sent_alerts?${params}`, {
    headers: supabaseHeaders()
  });
  if (!response.ok) throw new Error(`Supabase sent alerts review lookup failed: ${response.status}`);
  return response.json();
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
  const response = await fetch(`${SUPABASE_URL}/rest/v1/processed_scan_candles?${params}`, {
    headers: supabaseHeaders()
  });
  if (!response.ok) throw new Error(`Supabase processed candle lookup failed: ${response.status}`);
  const rows = await response.json();
  return rows.length > 0;
}

export async function recordProcessedScanCandle({ scanGroup, asset, interval, candleOpenTime }) {
  if (!isSupabaseConfigured()) return;
  const response = await fetch(`${SUPABASE_URL}/rest/v1/processed_scan_candles`, {
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
  const response = await fetch(`${SUPABASE_URL}/rest/v1/paper_model_runs?${params}`, {
    headers: supabaseHeaders()
  });
  if (!response.ok) throw new Error(`Supabase paper model lookup failed: ${response.status} ${await response.text()}`);
  const rows = await response.json();
  return rows[0] || null;
}

export async function recordPaperModelRun(run) {
  if (!isSupabaseConfigured()) return;
  const params = new URLSearchParams({
    on_conflict: "model_id,rebalance_time"
  });
  const response = await fetch(`${SUPABASE_URL}/rest/v1/paper_model_runs?${params}`, {
    method: "POST",
    headers: {
      ...supabaseHeaders(),
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal"
    },
    body: JSON.stringify(run)
  });
  if (!response.ok) throw new Error(`Supabase paper model upsert failed: ${response.status} ${await response.text()}`);
}

export async function fetchRecentPaperModelRuns(limit = 12) {
  if (!isSupabaseConfigured()) return [];
  const params = new URLSearchParams({
    select: paperModelRunSelect(),
    order: "rebalance_time.desc",
    limit: String(limit)
  });
  const response = await fetch(`${SUPABASE_URL}/rest/v1/paper_model_runs?${params}`, {
    headers: supabaseHeaders()
  });
  if (!response.ok) throw new Error(`Supabase paper model runs lookup failed: ${response.status} ${await response.text()}`);
  return response.json();
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
  const response = await fetch(`${SUPABASE_URL}/rest/v1/paper_model_runs?${params}`, {
    headers: supabaseHeaders()
  });
  if (!response.ok) throw new Error(`Supabase previous paper model lookup failed: ${response.status} ${await response.text()}`);
  const rows = await response.json();
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
  const response = await fetch(`${SUPABASE_URL}/rest/v1/paper_model_runs?${params}`, {
    headers: supabaseHeaders()
  });
  if (!response.ok) throw new Error(`Supabase paper model history lookup failed: ${response.status} ${await response.text()}`);
  return response.json();
}

export async function claimPaperModelEmail({ modelId, rebalanceTime }) {
  if (!isSupabaseConfigured()) return null;
  const params = new URLSearchParams({
    select: paperModelRunSelect(),
    model_id: `eq.${modelId}`,
    rebalance_time: `eq.${new Date(rebalanceTime).toISOString()}`,
    email_status: "in.(pending,failed)"
  });
  const response = await fetch(`${SUPABASE_URL}/rest/v1/paper_model_runs?${params}`, {
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
  const response = await fetch(`${SUPABASE_URL}/rest/v1/paper_model_runs?${params}`, {
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
  const response = await fetch(`${SUPABASE_URL}/rest/v1/paper_model_runs?${params}`, {
    method: "PATCH",
    headers: {
      ...supabaseHeaders(),
      "Content-Type": "application/json",
      Prefer: "return=minimal"
    },
    body: JSON.stringify({ review })
  });
  if (!response.ok) throw new Error(`Supabase paper model review update failed: ${response.status} ${await response.text()}`);
}

export function isSupabaseConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
}

function paperModelRunSelect() {
  return [
    "model_id",
    "model_version",
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

function supabaseHeaders() {
  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
  };
}
