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

export function isSupabaseConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
}

function supabaseHeaders() {
  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
  };
}
