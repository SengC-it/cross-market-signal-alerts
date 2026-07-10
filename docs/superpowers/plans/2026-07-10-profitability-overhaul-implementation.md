# Profitability-Oriented Signal Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. This session uses inline execution because subagent dispatch was not requested.

**Goal:** Stop the known negative-expectancy production path and make new alert outcomes reproducible, cost-aware, and bounded by the sent validity window.

**Architecture:** Keep the existing scanner, storage, report, and review structure. Configuration controls the enabled candidate universe, one exported futures-plan builder attaches immutable execution data before persistence, and the review module consumes only the stored plan to produce immutable net outcomes.

**Tech Stack:** Node.js 20+, ECMAScript modules, built-in `fetch`, Supabase JSONB payload storage, and the existing `scripts/smoke-test.js` harness.

## Global Constraints

- Do not deploy or change production environment variables.
- Do not write to production Supabase or rewrite historical reviews.
- Keep dynamic long alerts observation/research-only until 30 new immutable out-of-sample outcomes pass the profitability gates.
- Use configured round-trip costs: spot 0.20%, futures 0.12%.
- Do not add dependencies, schema migrations, automated order execution, leverage increases, or unrelated refactors.

---

### Task 1: Stop the losing production path and bound dynamic long candidates

**Files:**
- Modify: `scripts/smoke-test.js:45-240`
- Modify: `lib/config.js:90-127`
- Modify: `lib/scanner.js:240-380, 1330-1390`
- Modify: `sql/supabase-hourly-cron.example.sql:28-42`
- Modify: `README.md:14-25, 64-74`

**Interfaces:**
- Consumes: `CONFIG` and `evaluateDynamicSpotOpportunity(...)`.
- Produces: `CONFIG.relativeStrengthMaxRelativeStrength24h`, a disabled weak pool, and bounded dynamic-long filtering.

- [ ] **Step 1: Write failing configuration and filter tests**

Update the scheduler assertion to reject `dynamic-weak-spot`. Add assertions for these exact defaults:

```js
if (CONFIG.dynamicWeakSpotPoolEnabled) throw new Error("Dynamic weak production pool must be disabled");
if (CONFIG.relativeStrengthMaxMomentum24h !== 0.12) throw new Error("Dynamic long momentum ceiling must be 12%");
if (CONFIG.relativeStrengthMinRelativeStrength24h !== 0.10) throw new Error("Dynamic long relative-strength floor must be 10%");
if (CONFIG.relativeStrengthMaxRelativeStrength24h !== 0.15) throw new Error("Dynamic long relative-strength ceiling must be 15%");
if (CONFIG.maxSignalCurrentPriceDriftPct !== 0.005) throw new Error("Dynamic entry drift must be capped at 0.5%");
```

Change the existing dynamic-long tests so 11% momentum is accepted, 13% is rejected, 9% relative strength is rejected, 12% is accepted, and 16% is rejected with `overheated_relative_strength`.

- [ ] **Step 2: Run the suite and verify RED**

Run: `npm test`

Expected: failure on the weak scheduler/config assertion or missing `relativeStrengthMaxRelativeStrength24h`; no syntax/import error.

- [ ] **Step 3: Implement the minimal candidate controls**

Use these exact config values:

```js
relativeStrengthMinMomentum24h: 0.08,
relativeStrengthMaxMomentum24h: 0.12,
relativeStrengthMinRelativeStrength24h: 0.10,
relativeStrengthMaxRelativeStrength24h: 0.15,
dynamicSpotPoolMinPriceChangePercent: 8,
dynamicSpotPoolMaxPriceChangePercent: 12,
dynamicWeakSpotPoolEnabled: false,
maxSignalCurrentPriceDriftPct: Number(process.env.MAX_SIGNAL_CURRENT_PRICE_DRIFT_PCT || 0.005),
```

Add this upper-bound check immediately after the relative-strength lower-bound check:

```js
if (relativeStrength > CONFIG.relativeStrengthMaxRelativeStrength24h) {
  return { passed: false, score: 0, reason: "overheated_relative_strength" };
}
```

Remove `dynamic-weak-spot` from the scheduled `groups` string and update README scheduling text to say it is research-only and not scheduled.

- [ ] **Step 4: Make missing current prices fail closed**

Change `filterSignalsByCurrentPrice` so a signal requiring a price check is rejected when no current price is available. Keep a warning with the exact phrase `dropped signal: current price unavailable`.

- [ ] **Step 5: Run the suite and verify GREEN**

Run: `npm test`

Expected: `Smoke test passed` and exit code 0.

---

### Task 2: Persist one ATR execution plan for every futures price signal

**Files:**
- Modify: `scripts/smoke-test.js:1-10, 240-320`
- Modify: `lib/scanner.js:384-610, 985-1045`

**Interfaces:**
- Produces: `buildFuturesExecutionPlan({ candles, strategy, interval, funding, openInterest, sentiment }) -> executionPlan`.
- Consumed by: `enhanceFuturesSignal(...)`, dynamic-long construction, dynamic-weak offline construction, email persistence, and Task 3 reviews.

- [ ] **Step 1: Write a failing pure-plan test**

Import `buildFuturesExecutionPlan` and call it with 20 completed synthetic 1h candles whose final closed candle is 100, plus `{ direction: "LONG" }`. Assert:

```js
if (
  plan.entryReference !== 100 ||
  !Number.isFinite(plan.stopLoss) ||
  !Number.isFinite(plan.takeProfit) ||
  plan.rewardRiskRatio !== CONFIG.futuresRewardRiskRatio ||
  plan.tradingCost !== CONFIG.futuresTradingCost ||
  plan.suggestedLeverage > CONFIG.futuresMaxSuggestedLeverage
) {
  throw new Error("Futures execution plans must freeze entry, exits, cost, and risk controls");
}
```

- [ ] **Step 2: Run the suite and verify RED**

Run: `npm test`

Expected: module import failure because `buildFuturesExecutionPlan` is not exported.

- [ ] **Step 3: Extract the existing futures-plan calculation**

Move the numeric plan calculation from `enhanceFuturesSignal` into the exported pure function. Return these existing fields plus the cost:

```js
return {
  style,
  scanCadence,
  validFor,
  entryReference: latest.close,
  stopLoss,
  takeProfit,
  stopPct,
  rewardRiskRatio: CONFIG.futuresRewardRiskRatio,
  suggestedLeverage,
  maxPositionPct,
  tradingCost: CONFIG.futuresTradingCost,
  fundingRate,
  openInterest: Number.isFinite(openInterest?.openInterest) ? openInterest.openInterest : null,
  accountLongShortRatio: Number.isFinite(accountRatio) ? accountRatio : null,
  topTraderLongShortRatio: Number.isFinite(topRatio) ? topRatio : null
};
```

`enhanceFuturesSignal` adds only `simpleThesis` and `plainInvalidCondition` to this returned object.

- [ ] **Step 4: Attach the plan before pushing dynamic candidates**

Create each dynamic signal object first, then pass it through `enhanceFuturesSignal` with its candles, `1h` interval, and LONG/SHORT strategy direction before adding it to `candidates`. Do this for both dynamic functions even though the weak production pool is disabled, so offline research uses identical semantics.

- [ ] **Step 5: Run the suite and verify GREEN**

Run: `npm test`

Expected: `Smoke test passed` and exit code 0.

---

### Task 3: Make reviews immutable, cost-aware, and time-bounded

**Files:**
- Modify: `scripts/smoke-test.js:88-110, 442-550`
- Modify: `lib/alert-review.js:1-120`
- Modify: `lib/scanner.js:1082-1095`

**Interfaces:**
- Consumes: persisted `payload.executionPlan`, `payload.validUntil`, `payload.market`, and configured trading costs.
- Produces: immutable review objects containing `grossReturnPct`, `costPct`, and net `returnPct`.

- [ ] **Step 1: Write failing immutable-review tests**

Change the completed-review assertion so every `{ status: "reviewed" }` returns `false` from `shouldReviewAlert`, regardless of outcome text.

Add futures TP and SL assertions using market `USDT 永续合约（动态强势池）`:

```js
if (
  reviewedWin.grossReturnPct !== 0.05 ||
  reviewedWin.costPct !== CONFIG.futuresTradingCost ||
  reviewedWin.returnPct !== 0.05 - CONFIG.futuresTradingCost
) throw new Error("TP review must store gross, cost, and net return");

if (
  reviewedLoss.grossReturnPct !== -0.03 ||
  reviewedLoss.returnPct !== -0.03 - CONFIG.futuresTradingCost
) throw new Error("SL review must include trading cost");
```

Replace the after-validity tests so a later TP is ignored and the result is a timeout at the last completed in-window candle.

- [ ] **Step 2: Run the suite and verify RED**

Run: `npm test`

Expected: failure because completed legacy reviews are still selected, returns lack cost fields, or after-deadline candles are still used.

- [ ] **Step 3: Require the persisted plan and validity deadline**

Remove the fallback 3% plan from review. `tradePlan` returns `null` unless persisted stop and target values are finite. Return pending reasons `缺少止损止盈` or `缺少有效期` instead of deriving values from current config.

- [ ] **Step 4: Bound candles and add timeout**

Only include candles satisfying all conditions:

```js
candle.openTime > reviewStartTime &&
candle.openTime + intervalMs <= Math.min(now, validUntil)
```

If `now < validUntil` and neither exit is hit, keep the review pending until `validUntil`. Otherwise finalize a timeout at the last completed in-window candle close.

- [ ] **Step 5: Store net performance and freeze completed reviews**

Determine cost from `payload.executionPlan.tradingCost` first, then fall back to futures or spot configured cost based on `payload.market`. Store:

```js
{
  status: "reviewed",
  outcome,
  exitPrice,
  exitTime,
  grossReturnPct,
  costPct,
  returnPct: grossReturnPct - costPct,
  reviewedAt
}
```

Simplify `shouldReviewAlert` so `review.status === "reviewed"` always returns `false`.

- [ ] **Step 6: Run the suite and verify GREEN**

Run: `npm test`

Expected: `Smoke test passed` and exit code 0.

---

### Task 4: Verify behavior, scope, and deployment boundary

**Files:**
- Modify only if verification exposes a defect caused by Tasks 1-3.
- Review: `README.md`, `lib/config.js`, `lib/scanner.js`, `lib/alert-review.js`, `scripts/smoke-test.js`, `sql/supabase-hourly-cron.example.sql`.

**Interfaces:**
- Consumes all prior task outputs.
- Produces fresh verification evidence and a deployment handoff that makes no production changes.

- [ ] **Step 1: Run complete tests**

Run: `npm test`

Expected: exit code 0 and `Smoke test passed`.

- [ ] **Step 2: Run syntax checks**

Run:

```powershell
node --check lib/config.js
node --check lib/scanner.js
node --check lib/alert-review.js
node --check scripts/smoke-test.js
```

Expected: every command exits 0 without output.

- [ ] **Step 3: Inspect scope and whitespace**

Run:

```powershell
git diff --check
git status --short
git diff -- lib/config.js lib/scanner.js lib/alert-review.js scripts/smoke-test.js sql/supabase-hourly-cron.example.sql README.md
```

Expected: no whitespace errors; only approved files plus specs/plans are modified.

- [ ] **Step 4: Reconcile acceptance gates**

Confirm line by line that weak production scheduling is absent, dynamic bounds are enforced, dynamic futures payloads contain plans, completed reviews are immutable, costs are netted, and timeout occurs at the validity deadline.

- [ ] **Step 5: Stop before deployment**

Do not run Vercel deploy, do not apply the scheduler SQL, and do not update Supabase. Report that the next phase is paper collection of at least 30 new immutable outcomes before any profitability claim or production promotion.
