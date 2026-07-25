export function isAuthorizedRequest(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;

  const auth = req.headers?.authorization || "";
  return auth === `Bearer ${secret}`;
}

export function setPrivateResponseHeaders(res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
}
