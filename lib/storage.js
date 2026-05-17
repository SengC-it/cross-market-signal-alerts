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
  const response = await fetch(`${SUPABASE_URL}/rest/v1/run_logs`, {
    method: "POST",
    headers: {
      ...supabaseHeaders(),
      "Content-Type": "application/json"
    },
    body: JSON.stringify(log)
  });
  if (response.ok) return;

  const body = await response.text();
  if (response.status === 400 && body.includes("email_status")) {
    const { email_status, ...legacyLog } = log;
    const retry = await fetch(`${SUPABASE_URL}/rest/v1/run_logs`, {
      method: "POST",
      headers: {
        ...supabaseHeaders(),
        "Content-Type": "application/json"
      },
      body: JSON.stringify(legacyLog)
    });
    if (retry.ok) return;
    throw new Error(`Supabase run log insert failed: ${retry.status} ${await retry.text()}`);
  }

  throw new Error(`Supabase run log insert failed: ${response.status} ${body}`);
}

export async function fetchRecentRunLogs(limit = 50) {
  if (!isSupabaseConfigured()) return [];
  const response = await fetchRunLogs(limit, "id,created_at,started_at,finished_at,scan_group,candidates_count,signals_count,emailed,email_status,errors");
  if (response.ok) return response.json();

  const body = await response.text();
  if (response.status === 400 && body.includes("email_status")) {
    const retry = await fetchRunLogs(limit, "id,created_at,started_at,finished_at,scan_group,candidates_count,signals_count,emailed,errors");
    if (retry.ok) return retry.json();
    throw new Error(`Supabase run log lookup failed: ${retry.status}`);
  }

  throw new Error(`Supabase run log lookup failed: ${response.status}`);
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

export function isSupabaseConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
}

function supabaseHeaders() {
  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
  };
}
