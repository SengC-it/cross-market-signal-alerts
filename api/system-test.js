import { sendEmail } from "../lib/email.js";
import { CONFIG } from "../lib/config.js";
import { fetchRecentRunLogs, fetchRecentSentAlerts, isSupabaseConfigured } from "../lib/storage.js";

export const config = {
  maxDuration: 60
};

export default async function handler(req, res) {
  if (!isAuthorized(req)) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return;
  }

  const startedAt = new Date();
  const checks = [];

  await runCheck(checks, "运行环境", async () => ({
    node: process.version,
    recipient: CONFIG.recipient,
    supabaseConfigured: isSupabaseConfigured(),
    gmailConfigured: Boolean(process.env.GMAIL_SMTP_USER && process.env.GMAIL_APP_PASSWORD),
    resendConfigured: Boolean(process.env.RESEND_API_KEY),
    sendgridConfigured: Boolean(process.env.SENDGRID_API_KEY)
  }));

  await runCheck(checks, "Supabase 最近运行记录", async () => {
    const rows = await fetchRecentRunLogs(12);
    return {
      count: rows.length,
      latestRunAt: rows[0]?.created_at || null,
      latestGroup: rows[0]?.scan_group || null,
      futuresArbitrageRuns: rows.filter((row) => row.scan_group === "futures-arbitrage").length
    };
  });

  await runCheck(checks, "Supabase 最近邮件记录", async () => {
    const rows = await fetchRecentSentAlerts(12);
    return {
      count: rows.length,
      latestAlertAt: rows[0]?.sent_at || null,
      latestAsset: rows[0]?.asset || null
    };
  });

  await runCheck(checks, "Binance 现货行情", async () => probeJson("https://api.binance.com/api/v3/time"));
  await runCheck(checks, "Binance U本位合约行情", async () => probeJson("https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT"));
  await runCheck(checks, "Binance 合约资金费率", async () => probeJson("https://fapi.binance.com/fapi/v1/fundingRate?symbol=BTCUSDT&limit=1"));

  const finishedAt = new Date();
  const report = renderReport({ startedAt, finishedAt, checks });
  const shouldNotify = req.query?.notify !== "0";
  let email = null;

  if (shouldNotify) {
    email = await sendEmail({
      subject: `系统测试报告：${overallStatus(checks)} - 加密信号提醒`,
      text: report
    });
  }

  res.status(hasFailedRequiredCheck(checks) ? 500 : 200).json({
    ok: !hasFailedRequiredCheck(checks),
    notified: shouldNotify,
    email: summarizeEmail(email),
    checks
  });
}

async function runCheck(checks, name, fn) {
  const startedAt = Date.now();
  try {
    const details = await fn();
    checks.push({
      name,
      ok: true,
      durationMs: Date.now() - startedAt,
      details
    });
  } catch (error) {
    checks.push({
      name,
      ok: false,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

async function probeJson(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(12000)
  });
  const text = await response.text();
  return {
    status: response.status,
    ok: response.ok,
    sample: text.slice(0, 160)
  };
}

function renderReport({ startedAt, finishedAt, checks }) {
  const passed = checks.filter((check) => check.ok).length;
  const failed = checks.length - passed;
  const lines = [
    "【加密信号提醒系统测试报告】",
    "",
    `测试时间：${formatDate(startedAt)} 至 ${formatDate(finishedAt)}`,
    `总体结果：${failed ? `有 ${failed} 项需要关注` : "全部检查通过"}`,
    `通过项：${passed}/${checks.length}`,
    "",
    "检查明细："
  ];

  for (const check of checks) {
    lines.push("");
    lines.push(`${check.ok ? "通过" : "失败"}：${check.name}：${check.durationMs}ms`);
    if (check.ok) {
      lines.push(formatDetails(check.details));
    } else {
      lines.push(`原因：${check.error}`);
    }
  }

  lines.push("");
  lines.push("说明：这封邮件只说明系统功能是否正常，不代表任何交易建议。系统不会自动交易，也不会访问交易账户。");
  return lines.join("\n");
}

function formatDetails(details) {
  if (!details || typeof details !== "object") return String(details ?? "");
  return Object.entries(details)
    .map(([key, value]) => `- ${key}: ${typeof value === "object" ? JSON.stringify(value) : value}`)
    .join("\n");
}

function overallStatus(checks) {
  return hasFailedRequiredCheck(checks) ? "需要关注" : "正常";
}

function hasFailedRequiredCheck(checks) {
  return checks.some((check) => !check.ok);
}

function summarizeEmail(email) {
  if (!email || typeof email !== "object") return null;
  return {
    messageId: email.messageId || email.id || null,
    accepted: Array.isArray(email.accepted) ? email.accepted : undefined,
    rejected: Array.isArray(email.rejected) ? email.rejected : undefined,
    skipped: Boolean(email.skipped),
    reason: email.reason || undefined
  };
}

function formatDate(value) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(value);
}

function isAuthorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;

  const auth = req.headers.authorization || "";
  const querySecret = req.query?.secret;
  return auth === `Bearer ${secret}` || querySecret === secret;
}
