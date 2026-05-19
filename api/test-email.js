import { sendEmail } from "../lib/email.js";
import { renderTestEmail } from "../lib/report.js";

export default async function handler(req, res) {
  if (!isAuthorized(req)) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return;
  }

  try {
    await sendEmail({
      subject: "测试：云端跨市场信号提醒已接通",
      text: renderTestEmail()
    });

    res.status(200).json({ ok: true, sent: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

function isAuthorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;

  const auth = req.headers.authorization || "";
  const querySecret = req.query?.secret;
  return auth === `Bearer ${secret}` || querySecret === secret;
}
