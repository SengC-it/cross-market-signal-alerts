import {
  V42_FORWARD_MODEL,
  buildPaperPerformanceSnapshot,
  buildSignalEmailPerformanceContext,
  isV42ForwardSignal
} from "./performance-summary.js";
import {
  fetchAllPaperEmailRunsForModel,
  fetchAllSentAlertsForModel,
  isSupabaseConfigured
} from "./storage.js";

export async function loadPaperEmailPerformanceSnapshot({
  modelId,
  modelLabel,
  basis = "Production PAPER 已完成周期",
  beforeTime = Date.now(),
  fallbackRuns = []
} = {}) {
  let history = [];
  try {
    history = await fetchAllPaperEmailRunsForModel({
      modelId,
      beforeTime
    });
  } catch {
    // Performance context must never prevent an otherwise eligible PAPER email.
  }
  return buildPaperPerformanceSnapshot({
    runs: [...(Array.isArray(history) ? history : []), ...(Array.isArray(fallbackRuns) ? fallbackRuns : [])],
    modelId,
    modelLabel,
    basis
  });
}

export async function loadSignalEmailPerformanceSnapshot({
  signals = [],
  historySignals = [],
  beforeTime = Date.now()
} = {}) {
  const current = Array.isArray(signals) ? signals : [];
  if (!current.length || !current.every(isV42ForwardSignal) || !isSupabaseConfigured()) {
    return buildSignalEmailPerformanceContext({ signals: current, historySignals });
  }

  let completeHistory = [];
  let loaded = false;
  try {
    completeHistory = await fetchAllSentAlertsForModel({
      modelVersion: V42_FORWARD_MODEL.modelId,
      strategyId: V42_FORWARD_MODEL.strategyId,
      signalVariant: V42_FORWARD_MODEL.signalVariant,
      beforeTime
    });
    loaded = true;
  } catch {
    // A performance lookup must never prevent an otherwise eligible signal email.
  }
  return buildSignalEmailPerformanceContext({
    signals: current,
    historySignals: loaded ? completeHistory : historySignals
  });
}

export function paperEmailPerformanceSnapshot(run, options = {}) {
  return buildPaperPerformanceSnapshot({
    runs: run ? [run] : [],
    ...options
  });
}
