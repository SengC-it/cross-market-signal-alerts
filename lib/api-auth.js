export function isAuthorizedRequest(req) {
  return hasMatchingBearer(req, process.env.CRON_SECRET);
}

export function isDashboardAuthorizedRequest(req) {
  return hasMatchingBearer(req, process.env.DASHBOARD_SECRET)
    || hasMatchingBearer(req, process.env.CRON_SECRET);
}

function hasMatchingBearer(req, secret) {
  if (!secret) return false;
  const auth = req.headers?.authorization || "";
  return auth === `Bearer ${secret}`;
}

export function setPrivateResponseHeaders(res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
}
