import { sendEmail } from "../lib/email.js";
import { renderTestEmail } from "../lib/report.js";
import { isAuthorizedRequest, setPrivateResponseHeaders } from "../lib/api-auth.js";

export default async function handler(req, res) {
  setPrivateResponseHeaders(res);
  if (!isAuthorizedRequest(req)) {
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
