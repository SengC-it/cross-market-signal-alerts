import { runSignalBatch, runSignalScan } from "../lib/scanner.js";

export const config = {
  maxDuration: 60
};

const ENABLED_CRON_GROUPS = new Set([
  "dynamic-spot",
  "dynamic-weak-spot",
  "inverse-watch-4h",
  "inverse-watch-daily",
  "review"
]);

export default async function handler(req, res) {
  if (!isAuthorized(req)) {
    console.warn("Unauthorized cron request", {
      hasAuthorizationHeader: Boolean(req.headers.authorization),
      hasQuerySecret: Boolean(req.query?.secret),
      queryKeys: Object.keys(req.query || {}).filter((key) => key !== "secret")
    });
    res.status(401).json({ ok: false, error: "unauthorized" });
    return;
  }

  try {
    if (req.query?.quick === "1") {
      res.status(200).json({ ok: true, mode: "quick", message: "cron endpoint reachable" });
      return;
    }

    const requestedGroups = parseCronGroups(req.query || {});
    const groups = requestedGroups.filter((group) => ENABLED_CRON_GROUPS.has(group));
    const skippedGroups = requestedGroups.filter((group) => !ENABLED_CRON_GROUPS.has(group));
    if (!groups.length) {
      res.status(200).json({
        ok: true,
        mode: "skipped_no_enabled_groups",
        requestedGroups,
        skippedGroups,
        enabledGroups: [...ENABLED_CRON_GROUPS]
      });
      return;
    }

    const result = groups.length > 1
      ? await runSignalBatch({ dryRun: req.query?.dryRun === "1", groups })
      : await runSignalScan({
        dryRun: req.query?.dryRun === "1",
        group: groups[0] || "all"
      });
    res.status(200).json({ ok: true, skippedGroups, ...result });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

export function parseCronGroups(query) {
  if (query?.groups) {
    return String(query.groups)
      .split(",")
      .map((group) => group.trim())
      .filter(Boolean);
  }
  if (query?.group) return [String(query.group).trim()].filter(Boolean);
  return ["all"];
}

function isAuthorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;

  const auth = req.headers.authorization || "";
  const querySecret = req.query?.secret;
  return auth === `Bearer ${secret}` || querySecret === secret;
}
