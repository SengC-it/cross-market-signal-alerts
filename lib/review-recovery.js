import {
  getCryptoCandlesRange,
  getFuturesCandlesRange,
  getFuturesFundingHistory
} from "./market-data.js";
import { reviewAlertWithCandles, reviewArbitrageAlert } from "./alert-review.js";
import { getTradeSpecForAlert, intervalMilliseconds } from "./trading/trade-spec.js";
import {
  fetchPendingPaperModelRunsForReview,
  fetchPendingSentAlertsForReview,
  isSupabaseConfigured,
  paperModelRunKey,
  recordRunLog,
  updatePaperModelReview,
  updateSentAlertPayload
} from "./storage.js";
import { reviewV31PaperRun, V31_MODEL } from "./v3-paper.js";
import { reviewV33PaperRun, V33_MODEL, V34_MODEL } from "./v3-3-paper.js";
import { FUNDING_CARRY_MODEL, reviewFundingCarryPaperRun } from "./funding-carry-paper.js";
import {
  FUNDING_CARRY_V2_MODEL,
  reviewFundingCarryV2PaperRun
} from "./funding-carry-v2-paper.js";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const FOUR_HOUR_MS = 4 * HOUR_MS;
const FUNDING_INTERVAL_MS = 8 * HOUR_MS;
const DEFAULT_BATCH_SIZE = 12;
const DEFAULT_CONCURRENCY = 3;
const DEFAULT_TIME_BUDGET_MS = 45 * 1000;
const RETRY_DELAYS_MS = [5 * MINUTE_MS, 15 * MINUTE_MS, 30 * MINUTE_MS, 60 * MINUTE_MS, 120 * MINUTE_MS];

export async function runReviewRecovery({
  dryRun = false,
  now = Date.now(),
  batchSize = DEFAULT_BATCH_SIZE,
  concurrency = DEFAULT_CONCURRENCY,
  timeBudgetMs = DEFAULT_TIME_BUDGET_MS,
  isConfigured = isSupabaseConfigured,
  fetchAlerts = fetchPendingSentAlertsForReview,
  fetchPaperRuns = fetchPendingPaperModelRunsForReview,
  processAlert = processOrdinaryReviewAlert,
  processPaper = processPaperReviewRun,
  writeRunLog = recordRunLog
} = {}) {
  const startedAt = Date.now();
  const asOf = Number(now);
  const deadline = startedAt + Math.max(1000, Number(timeBudgetMs) || DEFAULT_TIME_BUDGET_MS);
  const excludedAlertKeys = new Set();
  const excludedPaperKeys = new Set();
  let paperCursor = null;
  const errors = [];
  const warnings = [];
  const reviewRecovery = {
    ordinarySignals: emptyRecoveryCounters(),
    paperRuns: emptyRecoveryCounters(),
    oldestPendingAt: null,
    durationMs: 0
  };

  if (!isConfigured()) {
    reviewRecovery.durationMs = Date.now() - startedAt;
    return { ok: true, reviewRecovery, warnings, errors };
  }

  let ordinaryExhausted = false;
  let paperExhausted = false;
  while (Date.now() < deadline && (!ordinaryExhausted || !paperExhausted)) {
    const [ordinaryResult, paperResult] = await Promise.allSettled([
      ordinaryExhausted
        ? Promise.resolve([])
        : fetchAlerts({
            limit: batchSize,
            excludeSignalKeys: [...excludedAlertKeys]
          }),
      paperExhausted
        ? Promise.resolve([])
        : fetchPaperRuns({
            limit: batchSize,
            excludeRunKeys: [...excludedPaperKeys],
            afterRun: paperCursor
          })
    ]);

    const ordinary = unwrapRecoveryResult(ordinaryResult, "ordinary review queue", errors);
    const paper = unwrapRecoveryResult(paperResult, "paper review queue", errors);
    if (ordinaryResult.status === "rejected") ordinaryExhausted = true;
    if (paperResult.status === "rejected") paperExhausted = true;

    updateOldestPending(reviewRecovery, ordinary, "sent_at");
    updateOldestPending(reviewRecovery, paper, "rebalance_time");

    const ordinaryCandidates = ordinary.filter((alert) => alert?.signal_key && !excludedAlertKeys.has(alert.signal_key));
    const paperCandidates = paper.filter((run) => paperModelRunKey(run) && !excludedPaperKeys.has(paperModelRunKey(run)));
    if (paperCandidates.length) {
      const lastPaper = paperCandidates.at(-1);
      paperCursor = {
        rebalanceTime: new Date(lastPaper.rebalance_time).toISOString(),
        modelId: lastPaper.model_id
      };
    }
    if (!ordinaryCandidates.length && ordinaryResult.status === "fulfilled") ordinaryExhausted = true;
    if (!paperCandidates.length && paperResult.status === "fulfilled") paperExhausted = true;
    if (!ordinaryCandidates.length && !paperCandidates.length) continue;

    const [ordinaryProcessed, paperProcessed] = await Promise.all([
      mapLimit(ordinaryCandidates, concurrency, (alert) => processAlert(alert, { now: asOf, dryRun })),
      mapLimit(paperCandidates, Math.min(2, concurrency), (run) => processPaper(run, { now: asOf, dryRun }))
    ]);

    for (const result of ordinaryProcessed) {
      if (result.key) excludedAlertKeys.add(result.key);
      if (result.error) errors.push({ label: `ordinary review ${result.key || "unknown"}`, error: safeErrorText(result.error) });
      applyRecoveryResult(reviewRecovery.ordinarySignals, result);
    }
    for (const result of paperProcessed) {
      if (result.key) excludedPaperKeys.add(result.key);
      if (result.error) errors.push({ label: `paper review ${result.key || "unknown"}`, error: safeErrorText(result.error) });
      applyRecoveryResult(reviewRecovery.paperRuns, result);
    }
  }

  reviewRecovery.durationMs = Date.now() - startedAt;
  if (!dryRun) {
    try {
      await writeRunLog({
        started_at: new Date(startedAt).toISOString(),
        finished_at: new Date().toISOString(),
        scan_group: "review",
        candidates_count: reviewRecovery.ordinarySignals.checked + reviewRecovery.paperRuns.checked,
        signals_count: reviewRecovery.ordinarySignals.reviewed + reviewRecovery.paperRuns.reviewed,
        emailed: false,
        email_status: "review_recovery",
        email_result: { reviewRecovery },
        sent_alert_keys: [],
        warnings,
        errors
      });
    } catch (error) {
      errors.push({
        label: "review recovery run log",
        error: safeErrorText(error)
      });
    }
  }

  return {
    ok: errors.length === 0,
    reviewRecovery,
    warnings,
    errors
  };
}

export async function processOrdinaryReviewAlert(alert, {
  now = Date.now(),
  dryRun = false,
  loadCandles = fetchReviewCandles,
  persist = updateSentAlertPayload,
  review = reviewAlertWithCandles
} = {}) {
  const key = alert?.signal_key || null;
  const payload = alert?.payload || {};
  const previousReview = payload.review || null;
  const due = classifyReviewState(previousReview, now);
  if (!key || !due.due) {
    return {
      key,
      status: "skipped",
      skippedUntilRetry: due.state === "awaiting_window" || due.state === "retrying",
      review: previousReview
    };
  }

  let nextReview;
  let failed = false;
  try {
    nextReview = payload.kind === "futures_arbitrage"
      ? reviewArbitrageAlert(alert, now)
      : review(alert, await loadCandles(alert, now), now);
    nextReview = decorateReview(nextReview, previousReview, now);
  } catch (error) {
    failed = true;
    nextReview = buildFailureReview(previousReview, now, error);
  }

  let persisted = false;
  if (!dryRun && shouldPersistReview(previousReview, nextReview)) {
    try {
      await persist(key, { ...payload, review: nextReview });
      persisted = true;
    } catch (error) {
      return {
        key,
        status: "failed",
        failed: true,
        review: nextReview,
        error: safeErrorText(error)
      };
    }
  }

  return {
    key,
    status: nextReview?.status === "reviewed" ? "reviewed" : "pending",
    failed,
    persisted,
    review: nextReview
  };
}

export async function processPaperReviewRun(run, {
  now = Date.now(),
  dryRun = false,
  persist = updatePaperModelReview,
  review = reviewPaperRun
} = {}) {
  const key = paperModelRunKey(run);
  const previousReview = run?.review || null;
  const entryTime = new Date(run?.rebalance_time || "").getTime();
  if (Number.isFinite(entryTime) && entryTime > Number(now)) {
    return {
      key,
      status: "skipped",
      skippedUntilRetry: true,
      review: previousReview
    };
  }
  const due = classifyReviewState(previousReview, now);
  if (!key || !due.due) {
    return {
      key,
      status: "skipped",
      skippedUntilRetry: due.state === "awaiting_window" || due.state === "retrying",
      review: previousReview
    };
  }

  let nextReview;
  let failed = false;
  try {
    nextReview = await review(run, now);
    nextReview = decorateReview(nextReview, previousReview, now);
  } catch (error) {
    failed = true;
    nextReview = buildFailureReview(previousReview, now, error);
  }

  if (!dryRun) {
    try {
      await persist({
        modelId: run.model_id,
        rebalanceTime: run.rebalance_time,
        review: nextReview
      });
    } catch (error) {
      return {
        key,
        status: "failed",
        failed: true,
        review: nextReview,
        error: safeErrorText(error)
      };
    }
  }

  return {
    key,
    status: nextReview?.status === "reviewed" ? "reviewed" : "pending",
    failed,
    persisted: !dryRun,
    review: nextReview
  };
}

export function classifyReviewState(review, now = Date.now()) {
  if (!review) return { state: "history_pending", due: true };
  if (review.status === "reviewed") return { state: "reviewed", due: false };
  if (review.status !== "pending") return { state: "data_error", due: true };

  const diagnostics = review.diagnostics || {};
  const retryAt = firstFiniteTimestamp(diagnostics.nextRetryAt, review.reviewAfter);
  if (Number.isFinite(retryAt) && retryAt > Number(now)) {
    return {
      state: diagnostics.status === "data_error" ? "retrying" : "awaiting_window",
      due: false,
      retryAt
    };
  }
  return {
    state: diagnostics.status === "data_error" ? "retrying" : "pending_review",
    due: true,
    retryAt
  };
}

export function reviewStatusLabel(review) {
  const diagnostics = review?.diagnostics || {};
  const retryAt = firstFiniteTimestamp(diagnostics.nextRetryAt);
  if (diagnostics.status === "data_error") {
    return Number.isFinite(retryAt) && retryAt > Date.now() ? "复盘重试中" : "复盘数据异常";
  }
  const state = classifyReviewState(review).state;
  if (state === "reviewed") return "已复盘";
  if (state === "awaiting_window") return "等待复盘窗口";
  if (state === "retrying") return "复盘重试中";
  if (state === "history_pending") return "历史待补录";
  if (state === "data_error") return "复盘数据异常";
  return "待复盘";
}

async function reviewPaperRun(run, now) {
  if (run.model_id === V31_MODEL.id) {
    const entryTime = new Date(run.rebalance_time).getTime();
    const { candles, funding } = await loadPaperTargetData(run.targets, {
      interval: V31_MODEL.interval,
      candleLimit: V31_MODEL.candleLimit,
      entryTime,
      endTime: Math.min(now, entryTime + V31_MODEL.rebalanceHours * HOUR_MS + FOUR_HOUR_MS),
      concurrency: 2,
      includeFourHourly: false
    });
    return reviewV31PaperRun({
      run,
      exitCandlesBySymbol: candles,
      fundingBySymbol: funding,
      exitTime: now,
      reviewedAt: now
    });
  }

  if (run.model_id === V33_MODEL.id || run.model_id === V34_MODEL.id) {
    const entryTime = new Date(run.rebalance_time).getTime();
    const { candles, funding } = await loadPaperTargetData(run.targets, {
      interval: "1h",
      candleLimit: V33_MODEL.monitorCandleLimit,
      entryTime,
      endTime: Math.min(now, entryTime + 168 * HOUR_MS + HOUR_MS),
      concurrency: 2,
      includeFourHourly: false
    });
    return reviewV33PaperRun({
      run,
      hourlyCandlesBySymbol: candles,
      fundingBySymbol: funding,
      now,
      reviewedAt: now
    });
  }

  if (run.model_id === FUNDING_CARRY_MODEL.id) {
    const entryTime = new Date(run.rebalance_time).getTime();
    const { candles, fourHourly, funding } = await loadPaperTargetData(run.targets, {
      interval: "1h",
      candleLimit: 160,
      entryTime,
      endTime: Math.min(now, entryTime + Number(FUNDING_CARRY_MODEL.maxHoldingHours || 48) * HOUR_MS + FOUR_HOUR_MS),
      concurrency: 2,
      includeFourHourly: true,
      fourHourlyLimit: 160,
      fourHourlyStartTime: entryTime - 160 * FOUR_HOUR_MS
    });
    return reviewFundingCarryPaperRun({
      run,
      hourlyCandlesBySymbol: candles,
      fourHourlyBySymbol: fourHourly,
      fundingBySymbol: funding,
      now,
      reviewedAt: now
    });
  }

  if (run.model_id === FUNDING_CARRY_V2_MODEL.id) {
    const entryTime = new Date(run.rebalance_time).getTime();
    const { candles, fourHourly, funding } = await loadPaperTargetData(run.targets, {
      interval: "1h",
      candleLimit: 240,
      entryTime: entryTime - 280 * FUNDING_INTERVAL_MS,
      endTime: Math.min(now, entryTime + Number(FUNDING_CARRY_V2_MODEL.maxHoldingHours || 48) * HOUR_MS + FOUR_HOUR_MS),
      concurrency: 2,
      includeFourHourly: true,
      fourHourlyLimit: 220,
      fourHourlyStartTime: entryTime - 220 * FOUR_HOUR_MS,
      fundingStartTime: entryTime - 280 * FUNDING_INTERVAL_MS
    });
    return reviewFundingCarryV2PaperRun({
      run,
      hourlyCandlesBySymbol: candles,
      fourHourlyBySymbol: fourHourly,
      fundingBySymbol: funding,
      now,
      reviewedAt: now
    });
  }

  throw new Error(`Unsupported paper review model: ${run.model_id || "unknown"}`);
}

async function loadPaperTargetData(targets, {
  interval,
  candleLimit,
  entryTime,
  endTime,
  concurrency,
  includeFourHourly = false,
  fourHourlyLimit = 160,
  fourHourlyStartTime = entryTime - fourHourlyLimit * FOUR_HOUR_MS,
  fundingStartTime = entryTime
}) {
  const candles = new Map();
  const fourHourly = new Map();
  const funding = new Map();
  await mapLimit(Array.isArray(targets) ? targets : [], concurrency, async (target) => {
    const symbol = target?.symbol;
    if (!symbol) throw new Error("Paper review target is missing a symbol");
    const requests = [
      getFuturesCandlesRange(symbol, interval, entryTime, endTime, candleLimit),
      getFuturesFundingHistory(symbol, fundingStartTime, endTime)
    ];
    if (includeFourHourly) {
      requests.splice(1, 0, getFuturesCandlesRange(symbol, "4h", fourHourlyStartTime, endTime, fourHourlyLimit));
    }
    const values = await Promise.all(requests);
    candles.set(symbol, values[0]);
    if (includeFourHourly) {
      fourHourly.set(symbol, values[1]);
      funding.set(symbol, values[2]);
    } else {
      funding.set(symbol, values[1]);
    }
  });
  return { candles, fourHourly, funding };
}

async function fetchReviewCandles(alert, now = Date.now()) {
  const tradeSpec = getTradeSpecForAlert(alert);
  if (!tradeSpec) return [];
  const payload = alert?.payload || {};
  const interval = alert?.interval || payload.interval || "1h";
  const intervalMs = intervalMilliseconds(interval);
  const entryTime = Number(tradeSpec.entryEligibleAt);
  const maxHoldingTime = Number(tradeSpec.maxHoldingTime);
  const startTime = Number.isFinite(entryTime) ? Math.max(0, entryTime - intervalMs) : null;
  const endTime = Number.isFinite(maxHoldingTime)
    ? Math.min(Number(now), maxHoldingTime + intervalMs)
    : Number(now);
  const market = String(payload.market || "");
  if (market.includes("USDT") || market.includes("合约") || market.includes("鍚堢害")) {
    return getFuturesCandlesRange(alert.asset, interval, startTime, Math.max(endTime, startTime || endTime), 1000);
  }
  return getCryptoCandlesRange(alert.asset, interval, startTime, Math.max(endTime, startTime || endTime), 1000);
}

function decorateReview(review, previousReview, now) {
  const next = review || { status: "pending", reason: "复盘没有返回结果" };
  const nextRetryAt = Number.isFinite(Number(next.reviewAfter))
    ? new Date(Number(next.reviewAfter)).toISOString()
    : null;
  const status = next.status === "reviewed"
    ? "reviewed"
    : nextRetryAt && new Date(nextRetryAt).getTime() > Number(now)
      ? "awaiting_window"
      : "pending_review";
  return {
    ...next,
    diagnostics: {
      ...(previousReview?.diagnostics || {}),
      status,
      attemptCount: 0,
      lastAttemptAt: new Date(now).toISOString(),
      nextRetryAt,
      lastError: null,
      retryEligible: !nextRetryAt || new Date(nextRetryAt).getTime() <= Number(now)
    }
  };
}

function buildFailureReview(previousReview, now, error) {
  const previousDiagnostics = previousReview?.diagnostics || {};
  const attemptCount = Number(previousDiagnostics.attemptCount || 0) + 1;
  const delay = RETRY_DELAYS_MS[Math.min(attemptCount - 1, RETRY_DELAYS_MS.length - 1)];
  const nextRetryAt = Number(now) + delay;
  return {
    ...(previousReview || {}),
    status: "pending",
    reason: "复盘数据暂时异常，系统将在退避后重试",
    diagnostics: {
      ...previousDiagnostics,
      status: "data_error",
      attemptCount,
      lastAttemptAt: new Date(now).toISOString(),
      nextRetryAt: new Date(nextRetryAt).toISOString(),
      lastError: safeErrorText(error),
      retryEligible: false
    }
  };
}

function shouldPersistReview(previous, next) {
  if (!next) return false;
  if (!previous) return true;
  return ["status", "outcome", "returnPct", "reason", "reviewAfter"].some((key) => previous[key] !== next[key])
    || JSON.stringify(previous.diagnostics || {}) !== JSON.stringify(next.diagnostics || {});
}

function firstFiniteTimestamp(...values) {
  const timestamps = values
    .map((value) => {
      if (value == null || value === "") return null;
      const number = Number(value);
      if (Number.isFinite(number)) return number;
      const parsed = new Date(value || "").getTime();
      return Number.isFinite(parsed) ? parsed : null;
    })
    .filter(Number.isFinite);
  return timestamps.length ? Math.max(...timestamps) : null;
}

function emptyRecoveryCounters() {
  return {
    checked: 0,
    reviewed: 0,
    pending: 0,
    failed: 0,
    skippedUntilRetry: 0
  };
}

function applyRecoveryResult(counters, result) {
  counters.checked++;
  if (result.skippedUntilRetry) counters.skippedUntilRetry++;
  if (result.failed) counters.failed++;
  if (result.status === "reviewed") counters.reviewed++;
  else if (result.status === "pending") counters.pending++;
}

function updateOldestPending(metrics, rows, timeField) {
  for (const row of rows || []) {
    const value = row?.[timeField];
    if (!value) continue;
    const timestamp = new Date(value).getTime();
    if (!Number.isFinite(timestamp)) continue;
    if (!metrics.oldestPendingAt || timestamp < new Date(metrics.oldestPendingAt).getTime()) {
      metrics.oldestPendingAt = new Date(timestamp).toISOString();
    }
  }
}

function unwrapRecoveryResult(result, label, errors) {
  if (result.status === "fulfilled") return result.value || [];
  errors.push({ label, error: safeErrorText(result.reason) });
  return [];
}

async function mapLimit(items, limit, fn) {
  const queue = [...items];
  const results = [];
  const workerCount = Math.max(1, Math.min(Number(limit) || 1, queue.length || 1));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (queue.length) {
      const item = queue.shift();
      results.push(await fn(item));
    }
  }));
  return results;
}

function safeErrorText(error) {
  const text = error instanceof Error ? error.message : String(error);
  return text
    .replace(/(supabase[_-]?(service[_-])?role[_-]?key|cron[_-]?secret|dashboard[_-]?secret|api[-_]?key|authorization|secret|password)\s*[:=]?\s*\S+/gi, "$1=[redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .slice(0, 500);
}
