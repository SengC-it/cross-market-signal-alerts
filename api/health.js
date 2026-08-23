import { SIGNAL_ONLY_RELEASE } from "../lib/production-signal-policy.js";

export default function handler(req, res) {
  res.status(200).json({
    ok: true,
    service: "cross-market-signal-alerts",
    signalOnly: SIGNAL_ONLY_RELEASE,
    timestamp: new Date().toISOString()
  });
}
