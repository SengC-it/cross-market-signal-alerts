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
  await fetch(`${SUPABASE_URL}/rest/v1/run_logs`, {
    method: "POST",
    headers: {
      ...supabaseHeaders(),
      "Content-Type": "application/json"
    },
    body: JSON.stringify(log)
  });
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
