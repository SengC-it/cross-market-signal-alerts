import { runSignalScan } from "../lib/scanner.js";

export const config = {
  maxDuration: 60
};

export default async function handler(req, res) {
  if (!isAuthorized(req)) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return;
  }

  try {
    if (req.query?.quick === "1") {
      res.status(200).json({ ok: true, mode: "quick", message: "cron endpoint reachable" });
      return;
    }

    const result = await runSignalScan({ dryRun: req.query?.dryRun === "1" });
    res.status(200).json({ ok: true, ...result });
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
