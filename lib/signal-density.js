const DYNAMIC_STRENGTH = "dynamic_relative_strength_breakout";

export function buildSignalDensityKpi({ sentAlerts = [], runLogs = [], now = Date.now() } = {}) {
  const end = toTimestamp(now) ?? Date.now();
  const start7d = end - 7 * 24 * 60 * 60 * 1000;
  const start30d = end - 30 * 24 * 60 * 60 * 1000;
  const recentAlerts = sentAlerts.filter((alert) => {
    const timestamp = alertTimestamp(alert);
    return timestamp != null && timestamp >= start30d && timestamp <= end;
  });

  const inWindow = (alert, start) => {
    const timestamp = alertTimestamp(alert);
    return timestamp != null && timestamp >= start && timestamp <= end;
  };
  const payloadOf = (alert) => alert?.payload || {};
  const tierOf = (alert) => payloadOf(alert).signalTier || alert?.signal_tier || null;
  const strategyOf = (alert) => payloadOf(alert).strategyId || alert?.strategy_id || null;
  const rankOf = (alert) => Number(
    payloadOf(alert).dynamicPoolRank
      ?? payloadOf(alert).details?.dynamicPoolRank
      ?? payloadOf(alert).poolRank
  );

  return {
    signalsLast7d: sentAlerts.filter((alert) => inWindow(alert, start7d)).length,
    signalsLast30d: recentAlerts.length,
    tradeWatchLast30d: recentAlerts.filter((alert) => tierOf(alert) === "TRADE_WATCH").length,
    strongObservationLast30d: recentAlerts.filter((alert) => (
      strategyOf(alert) === DYNAMIC_STRENGTH && tierOf(alert) === "OBSERVATION"
    )).length,
    shadowLast30d: recentAlerts.filter((alert) => tierOf(alert) === "SHADOW_ONLY").length,
    researchBlockedLast30d: countResearchBlocks(runLogs, start30d, end),
    strongRank1To10Last30d: recentAlerts.filter((alert) => (
      strategyOf(alert) === DYNAMIC_STRENGTH && rankBand(rankOf(alert)) === "1-10"
    )).length,
    strongRank11To25Last30d: recentAlerts.filter((alert) => (
      strategyOf(alert) === DYNAMIC_STRENGTH && rankBand(rankOf(alert)) === "11-25"
    )).length
  };
}

function countResearchBlocks(runLogs, start, end) {
  return runLogs.reduce((count, log) => {
    const timestamp = toTimestamp(log?.created_at || log?.finished_at || log?.started_at);
    if (timestamp == null || timestamp < start || timestamp > end) return count;
    const warnings = Array.isArray(log?.warnings) ? log.warnings : [];
    return count + warnings.filter((warning) => {
      const label = String(warning?.label || "").toLowerCase();
      const message = String(warning?.warning || warning?.message || "").toLowerCase();
      return label.includes("research-only production block")
        || message.includes("frozen research candidate");
    }).length;
  }, 0);
}

function alertTimestamp(alert) {
  return toTimestamp(alert?.sent_at || alert?.trigger_time || alert?.payload?.triggerTime);
}

function rankBand(rank) {
  if (!Number.isFinite(rank) || rank < 1) return null;
  if (rank <= 10) return "1-10";
  if (rank <= 25) return "11-25";
  return "26+";
}

function toTimestamp(value) {
  if (value == null || value === "") return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric < 1e12 ? numeric * 1000 : numeric;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}
