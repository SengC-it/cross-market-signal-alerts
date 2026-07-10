# Strict Email TP/SL Evaluation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build one tested replay and evaluation path that enters at the email reference price, exits only on the email TP or SL, keeps untouched trades open, and evaluates signal filters under 0.12%, 0.20%, and 0.40% round-trip costs without tuning on the final diagnostic period.

**Architecture:** A pure replay module owns trade state, a pure performance module owns realized/marked statistics, and a pure validation module owns robustness gates. Thin scripts load existing JSON/candle caches and write reproducible reports; the live alert reviewer delegates to the same replay module so historical and production review semantics cannot diverge.

**Tech Stack:** Node.js 20+ ESM, built-in `node:test`, built-in `assert/strict`, existing Binance candle cache JSON, existing Supabase alert payload format.

## Global Constraints

- Do not add Binance private order, account, leverage, or withdrawal APIs.
- Do not send production email or mutate Supabase while testing or building reports.
- Entry is `executionPlan.entryReference`, falling back to email `close` only when needed.
- Only fully closed candles after `sent_at` may close a trade.
- TP/SL first touch closes the trade; same-candle collision is a stop loss.
- No time-based exit is allowed; untouched trades remain `open_unresolved`.
- Primary round-trip cost is 0.20%; also report 0.12% and 0.40%.
- Missing funding data is labeled incomplete and is never silently treated as complete zero funding.
- 2026H1 is `contaminated_test`, not clean out-of-sample evidence.
- Every production-code change follows red-green-refactor.
- Existing untracked artifacts belong to the user and must not be deleted, overwritten, or committed unintentionally.

---

### Task 1: Canonical TP/SL Replay State Machine

**Files:**
- Create: `test/trade-replay.test.js`
- Create: `lib/trade-replay.js`
- Modify: `package.json`

**Interfaces:**
- Consumes: `replayEmailTrade({ alert, candles, cutoffTime, intervalMs, costRate, fundingEvents })`.
- Produces: `{ status, outcome, entryPrice, exitPrice, exitTime, rawReturn, netReturn, markedReturn, tradingCost, fundingReturn, fundingStatus, sameCandleCollision, observationStart, observationStartSource, warnings }`.
- Produces: `normalizeCandles(candles)` for deterministic chronological, duplicate-free input.

- [ ] **Step 1: Add the test command and write failing replay tests**

Add `"test:unit": "node --test test/*.test.js"` and change `test` to run the unit tests followed by the existing smoke test.

Create tests using this shape:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { replayEmailTrade } from "../lib/trade-replay.js";

const HOUR = 3_600_000;
const sentAt = Date.UTC(2026, 0, 1, 1);

function alert(direction = "LONG") {
  return {
    signal_key: `BTCUSDT:${direction}`,
    sent_at: new Date(sentAt).toISOString(),
    trigger_time: new Date(sentAt - HOUR).toISOString(),
    interval: "1h",
    payload: {
      direction,
      close: 100,
      executionPlan: { entryReference: 100, stopLoss: direction === "SHORT" ? 103 : 97, takeProfit: direction === "SHORT" ? 95.5 : 104.5 }
    }
  };
}

test("long closes at the first take profit after the email", () => {
  const result = replayEmailTrade({
    alert: alert("LONG"),
    candles: [
      { openTime: sentAt, high: 110, low: 90, close: 100 },
      { openTime: sentAt + HOUR, high: 105, low: 99, close: 104 }
    ],
    cutoffTime: sentAt + 2 * HOUR,
    intervalMs: HOUR,
    costRate: 0.002
  });
  assert.equal(result.outcome, "take_profit");
  assert.equal(result.exitPrice, 104.5);
  assert.equal(result.netReturn, 0.043);
});

test("same candle collision is a stop loss", () => {
  const result = replayEmailTrade({
    alert: alert("LONG"),
    candles: [{ openTime: sentAt + HOUR, high: 105, low: 96, close: 100 }],
    cutoffTime: sentAt + 2 * HOUR,
    intervalMs: HOUR,
    costRate: 0.002
  });
  assert.equal(result.outcome, "stop_loss");
  assert.equal(result.sameCandleCollision, true);
});

test("untouched trade stays open and reserves round trip cost", () => {
  const result = replayEmailTrade({
    alert: alert("LONG"),
    candles: [{ openTime: sentAt + HOUR, high: 102, low: 98, close: 101 }],
    cutoffTime: sentAt + 2 * HOUR,
    intervalMs: HOUR,
    costRate: 0.002
  });
  assert.equal(result.status, "open_unresolved");
  assert.equal(result.exitPrice, null);
  assert.equal(result.markedReturn, 0.008);
});
```

Add separate tests for short TP, short SL, ignoring pre-send candles, ignoring unclosed candles, fallback entry/source warning, invalid plan, unordered candles, and duplicate candle timestamps.

- [ ] **Step 2: Run the unit tests and verify RED**

Run: `npm.cmd run test:unit`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `lib/trade-replay.js`.

- [ ] **Step 3: Implement the minimal replay module**

Implement pure functions with these rules:

```js
export function normalizeCandles(candles = []) {
  const byTime = new Map();
  for (const candle of candles) {
    const openTime = Number(candle?.openTime);
    if (Number.isFinite(openTime)) byTime.set(openTime, { ...candle, openTime });
  }
  return [...byTime.values()].sort((a, b) => a.openTime - b.openTime);
}

export function replayEmailTrade({ alert, candles, cutoffTime, intervalMs, costRate = 0.002, fundingEvents = null }) {
  // Parse and validate the email plan.
  // Restrict candles to openTime > observationStart and openTime + intervalMs <= cutoffTime.
  // Test stop before target inside each candle.
  // Return a closed trade or open_unresolved mark without expiry.
  // Apply direction-aware funding only when coverage is supplied.
}
```

Use direction multiplier `-1` for short and `1` for long. Net return is `rawReturn + fundingReturn - costRate`. Preserve invalid inputs as `{ status: "invalid", warnings: [...] }`.

- [ ] **Step 4: Run replay tests and the existing smoke test**

Run: `npm.cmd test`

Expected: all `node:test` cases pass and output ends with `Smoke test passed`.

- [ ] **Step 5: Commit Task 1**

```powershell
git add package.json test/trade-replay.test.js lib/trade-replay.js
git commit -m "feat: add canonical email TP SL replay"
```

---

### Task 2: Realized and Marked Performance Metrics

**Files:**
- Create: `test/performance.test.js`
- Create: `lib/performance.js`

**Interfaces:**
- Consumes: replay results from Task 1.
- Produces: `summarizePerformance(trades, { periodsPerYear })`.
- Produces: `removeLargestWinner(trades)`.

- [ ] **Step 1: Write failing metric tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { removeLargestWinner, summarizePerformance } from "../lib/performance.js";

const closed = (netReturn, symbol = "BTCUSDT") => ({ status: "closed", netReturn, rawReturn: netReturn + 0.002, tradingCost: 0.002, fundingReturn: 0, symbol });

test("realized metrics exclude unresolved trades", () => {
  const summary = summarizePerformance([
    closed(0.04),
    closed(-0.02),
    { status: "open_unresolved", markedReturn: 0.5, symbol: "ETHUSDT" }
  ]);
  assert.equal(summary.realized.trades, 2);
  assert.equal(summary.realized.winRate, 0.5);
  assert.equal(summary.open.trades, 1);
});

test("calculates payoff profit factor drawdown and losing streak", () => {
  const summary = summarizePerformance([closed(0.04), closed(-0.02), closed(-0.01), closed(0.01)]);
  assert.equal(summary.realized.payoffRatio, 2.5);
  assert.equal(summary.realized.profitFactor, 5 / 3);
  assert.equal(summary.realized.maxConsecutiveLosses, 2);
  assert.ok(summary.realized.maxDrawdown < 0);
});

test("removes exactly the largest realized winner", () => {
  assert.deepEqual(removeLargestWinner([closed(0.01), closed(0.05), closed(-0.02)]).map((trade) => trade.netReturn), [0.01, -0.02]);
});
```

Add tests for compounded return, expectancy, Sharpe convention, total fees, total funding, marked equity, and largest-symbol profit concentration.

- [ ] **Step 2: Run tests and verify RED**

Run: `npm.cmd run test:unit`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `lib/performance.js`.

- [ ] **Step 3: Implement metrics without portfolio leverage assumptions**

Implement arithmetic expectancy and trade-return Sharpe as `mean / sampleStandardDeviation * sqrt(numberOfTrades)`; label it `tradeSequenceSharpe`, not annualized market Sharpe. Compute drawdown in chronological input order and report concentration as the largest positive symbol contribution divided by total positive symbol contribution.

- [ ] **Step 4: Verify all tests**

Run: `npm.cmd test`

Expected: all unit tests and smoke tests pass.

- [ ] **Step 5: Commit Task 2**

```powershell
git add test/performance.test.js lib/performance.js
git commit -m "feat: add strict trade performance metrics"
```

---

### Task 3: Make Alert Review Use the Canonical Engine

**Files:**
- Modify: `test/trade-replay.test.js`
- Modify: `scripts/smoke-test.js`
- Modify: `lib/alert-review.js`

**Interfaces:**
- Consumes: `replayEmailTrade` from Task 1.
- Preserves: `reviewAlertWithCandles(alert, candles, now)` public API.

- [ ] **Step 1: Add a failing compatibility test**

Add an assertion that a review with no TP/SL touch remains pending after `validUntil`, and that its result contains no finite exit price. Add a second assertion that a pre-send candle touching TP is ignored. Add a closed-trade assertion expecting `netReturn`, `tradingCost`, and `fundingStatus` from the canonical result; this assertion is the RED behavior because the current reviewer exposes only raw `returnPct`.

- [ ] **Step 2: Run tests and verify the new assertion fails against any divergent behavior**

Run: `npm.cmd test`

Expected: FAIL because the current review result has no `netReturn`, `tradingCost`, or `fundingStatus`.

- [ ] **Step 3: Delegate directional TP/SL evaluation to `replayEmailTrade`**

Keep arbitrage review separate. Map replay outcomes back to the existing Chinese review payload:

```js
const outcomeLabels = { take_profit: "止盈", stop_loss: "止损" };
```

Closed results return `status: "reviewed"`, keep `returnPct` as the raw directional return for compatibility, and add `netReturn`, `tradingCost`, and `fundingStatus`. Unresolved results return `pendingReview("等待止盈止损触发", now + intervalMs)`. Do not reintroduce `validUntil` as an exit.

- [ ] **Step 4: Verify tests**

Run: `npm.cmd test`

Expected: unit and smoke tests pass.

- [ ] **Step 5: Commit Task 3**

```powershell
git add lib/alert-review.js scripts/smoke-test.js test/trade-replay.test.js
git commit -m "refactor: unify alert review with strict replay"
```

---

### Task 4: Reproducible Three-Cost Baseline Builder

**Files:**
- Create: `test/baseline.test.js`
- Create: `lib/strict-baseline.js`
- Create: `scripts/build-strict-baseline.js`
- Modify: `package.json`

**Interfaces:**
- Produces: `loadSignalArtifact(path)`, `loadCachedCandles(cacheDir, symbol)`, and `buildStrictBaseline({ signals, candlesBySymbol, fundingBySymbol, cutoffTime, costRates })`.
- CLI environment: `STRICT_SIGNAL_FILE`, `STRICT_CACHE_DIR`, `STRICT_FUNDING_DIR`, `STRICT_OUTPUT_FILE`, `STRICT_CUTOFF`.

- [ ] **Step 1: Write failing baseline tests with temporary in-memory data**

Test deduplication by `signalKey`/`signal_key`, three exact cost scenarios, invalid signal counts, unresolved counts, source hashes, missing funding coverage, and survivorship warning metadata.

- [ ] **Step 2: Run tests and verify RED**

Run: `npm.cmd run test:unit`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `lib/strict-baseline.js`.

- [ ] **Step 3: Implement baseline composition and a thin CLI**

The library must be side-effect free. The CLI reads inputs, calls the library, writes only `STRICT_OUTPUT_FILE`, and exits non-zero on invalid JSON. Default costs are:

```js
const COST_SCENARIOS = { low: 0.0012, primary: 0.002, stress: 0.004 };
```

Default source should be the existing strict email artifact only when explicitly present; never fetch network data from this command.

- [ ] **Step 4: Run unit and smoke tests**

Run: `npm.cmd test`

Expected: all tests pass.

- [ ] **Step 5: Run the baseline on the existing cached dataset**

Run with explicit paths to the existing user artifacts and a new output named `strict_email_baseline_2026h1.json`. Do not overwrite earlier JSON files.

Expected: a report containing `low`, `primary`, and `stress`, plus funding/data coverage and unresolved trades.

- [ ] **Step 6: Commit code but not generated user-data artifacts**

```powershell
git add package.json test/baseline.test.js lib/strict-baseline.js scripts/build-strict-baseline.js
git commit -m "feat: build reproducible strict email baseline"
```

---

### Task 5: Validation Gates, Best-Trade Removal, Stability, and Monte Carlo

**Files:**
- Create: `test/validation.test.js`
- Create: `lib/validation.js`
- Create: `scripts/validate-signal-filters.js`
- Modify: `package.json`

**Interfaces:**
- Produces: `splitTradePeriod(trade)`, `evaluateAcceptanceGates(summary, robustness, limits)`, `runSeededMonteCarlo(returns, options)`, and `evaluateCandidates({ trades, candidates, limits, seed })`.
- CLI environment: `STRICT_BASELINE_FILE`, `STRICT_VALIDATION_OUTPUT`, `MONTE_CARLO_SEED`, `MONTE_CARLO_RUNS`.

- [ ] **Step 1: Write failing validation tests**

Test exact date boundaries, `contaminated_test` labeling, deterministic output with a fixed seed, best-trade removal, rejection when PF is at or below 1, rejection when expectancy is non-positive, rejection for excessive concentration/drawdown, and mandatory `stop_trading` when every candidate fails.

```js
test("returns stop_trading instead of the least bad loser", () => {
  const result = evaluateCandidates({
    trades: losingTrades,
    candidates: [{ id: "all", predicate: () => true }],
    limits,
    seed: 42
  });
  assert.equal(result.recommendation, "stop_trading");
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npm.cmd run test:unit`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `lib/validation.js`.

- [ ] **Step 3: Implement minimal deterministic validation**

Candidate predicates may use only fields already present in the email: strategy, direction, score, momentum bucket, relative strength, volume multiple, and symbol allow/deny lists derived from training data. Do not optimize TP/SL prices or ratios.

Monte Carlo must report at least median return, 5th percentile return, median maximum drawdown, 95th percentile maximum drawdown magnitude, and probability of negative aggregate return.

- [ ] **Step 4: Verify all tests**

Run: `npm.cmd test`

Expected: all unit and smoke tests pass.

- [ ] **Step 5: Run validation using the strict baseline**

Generate `strict_email_validation_2026h1.json`. Confirm training, validation, and contaminated diagnostic results are separated and that the tool produces `stop_trading` if no candidate clears every gate.

- [ ] **Step 6: Commit Task 5**

```powershell
git add package.json test/validation.test.js lib/validation.js scripts/validate-signal-filters.js
git commit -m "feat: validate strict signal filters"
```

---

### Task 6: Evidence Review and Production Recommendation

**Files:**
- Modify only if validation passes: `lib/config.js`
- Modify only if validation passes: `scripts/smoke-test.js`
- Create: `docs/strict-email-evaluation-report.md`

**Interfaces:**
- Consumes: strict baseline and validation reports.
- Produces: an evidence report and either `stop_trading`, `paper_trade_only`, or a narrowly scoped filter recommendation.

- [ ] **Step 1: Compare old and strict baselines on identical 2026H1 signals**

Report closed/open counts, win rate, payoff ratio, expectancy, PF, maximum drawdown, trade-sequence Sharpe, consecutive losses, fees, funding coverage, symbol/month concentration, and results after removing the largest winner under all three costs.

- [ ] **Step 2: Apply the acceptance gates without discretion**

If validation fails, document `stop_trading` and do not edit production thresholds. If validation passes, write one failing smoke assertion for the single recommended filter change before editing `lib/config.js`.

- [ ] **Step 3: If and only if RED exists for a validated filter, implement the minimal config change**

Change one filter family only. Do not change TP/SL parameters in this phase.

- [ ] **Step 4: Run final verification**

Run: `npm.cmd test`

Run: `git diff --check`

Expected: all tests pass, smoke test passes, and diff check emits no errors.

- [ ] **Step 5: Commit the evidence report and any validated production change separately**

```powershell
git add docs/strict-email-evaluation-report.md
git commit -m "docs: report strict email strategy validation"
```

If a production filter change is justified:

```powershell
git add lib/config.js scripts/smoke-test.js
git commit -m "fix: restrict signals to validated filters"
```

If no filter passes, omit the second commit.
