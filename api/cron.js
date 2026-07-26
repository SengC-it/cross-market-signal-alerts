import { runSignalBatch, runSignalScan } from "../lib/scanner.js";
import { isAuthorizedRequest, setPrivateResponseHeaders } from "../lib/api-auth.js";
import { runV31PaperScan } from "../lib/v3-paper.js";
import { runV33PaperScan } from "../lib/v3-3-paper.js";

export const config = {
  maxDuration: 60
};

const ENABLED_CRON_GROUPS = new Set([
  "dynamic-spot",
  "dynamic-weak-spot",
  "review",
  "v3-paper",
  "v3-3-paper"
]);

export default async function handler(req, res) {
  setPrivateResponseHeaders(res);
  if (!isAuthorizedRequest(req)) {
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

    const paperGroups = groups.filter((group) =>
      group === "v3-paper" || group === "v3-3-paper"
    );
    if (paperGroups.length && groups.length > 1) {
      res.status(400).json({
        ok: false,
        error: "paper_model_must_run_as_a_dedicated_group"
      });
      return;
    }

    if (groups[0] === "v3-paper") {
      const result = await runV31PaperScan({ dryRun: req.query?.dryRun === "1" });
      res.status(200).json({ ok: true, skippedGroups, ...result });
      return;
    }

    if (groups[0] === "v3-3-paper") {
      const result = await runV33PaperScan({ dryRun: req.query?.dryRun === "1" });
      res.status(200).json({ ok: true, skippedGroups, ...result });
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
