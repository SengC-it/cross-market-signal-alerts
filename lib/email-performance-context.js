import { buildPaperPerformanceSnapshot } from "./performance-summary.js";
import { fetchPaperModelRunsForModel } from "./storage.js";

const PAPER_EMAIL_HISTORY_LIMIT = 104;

export async function loadPaperEmailPerformanceSnapshot({
  modelId,
  modelLabel,
  basis = "Production PAPER 已完成周期",
  beforeTime = Date.now(),
  fallbackRuns = []
} = {}) {
  let history = [];
  try {
    history = await fetchPaperModelRunsForModel({
      modelId,
      beforeTime,
      limit: PAPER_EMAIL_HISTORY_LIMIT
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

export function paperEmailPerformanceSnapshot(run, options = {}) {
  return buildPaperPerformanceSnapshot({
    runs: run ? [run] : [],
    ...options
  });
}
