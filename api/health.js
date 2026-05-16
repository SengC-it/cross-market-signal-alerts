export default function handler(req, res) {
  res.status(200).json({
    ok: true,
    service: "cross-market-signal-alerts",
    timestamp: new Date().toISOString()
  });
}
