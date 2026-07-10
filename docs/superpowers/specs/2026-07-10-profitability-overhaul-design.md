# Profitability-Oriented Signal Overhaul Design

## Objective

Reduce negative-expectancy production alerts and make every reported outcome reproducible from the execution plan that was actually sent. The project remains an alerting system, not an auto-trader, and no change may be described as guaranteeing profit.

## Evidence baseline

The production Supabase dataset contains 209 stored alerts from 2026-05-19 through 2026-07-08. Of these, 182 have completed strict take-profit or stop-loss reviews: 61 wins and 121 losses, for a 33.52% win rate. Their gross summed return is -46.20 percentage points. Applying the configured 0.20% spot and 0.12% futures cost assumptions produces a modeled net summed return of -80.92 percentage points and a net profit factor of 0.790.

Strategy-level modeled net results are:

- `short_term_momentum_24h`: 8 closed alerts, 0 wins, -25.60 percentage points.
- `dynamic_relative_strength_breakout`: 138 closed alerts, 34.8% win rate, -44.54 percentage points.
- `dynamic_relative_weakness_breakdown`: 36 closed alerts, 36.1% win rate, -10.78 percentage points.

The six completed alerts after the latest exit-policy change contain one win and five losses. All 209 stored alerts lack a frozen `executionPlan`, so historical reviews are not fully reproducible.

## Approved approach

Use the current production source as the implementation baseline, then make a safety-first, test-driven change. Do not implement against the stale local checkout. Do not deploy and do not write to production Supabase in this work session.

The change has four bounded units:

1. Production candidate controls.
2. Immutable execution plans.
3. Immutable, cost-aware, time-bounded reviews.
4. Verification and paper-trading gates.

## Production candidate controls

`short_term_momentum_24h` remains excluded from production strategy sets.

The dynamic weak pool is disabled in production scheduling and configuration. Its current-filter historical cohort has only seven completed alerts, two wins, and -5.1 gross percentage points; its latest completed cohort is one win from six. Disabling means it produces no production candidates, while its code remains available for offline research.

Dynamic long alerts remain observation/research alerts. Candidate bounds are changed to the historically less harmful region:

- 24-hour momentum: at least 8% and at most 12%.
- Relative strength versus BTC: at least 10% and at most 15%.
- Volume multiple: at least 1.5x and at most 2.0x.
- Current-price drift from the reference entry: at most 0.5%.

These bounds are a research hypothesis, not proof of profitability. Their intersection has only four stored alerts. Recommendation scores stay below 90 and must not be promoted to trade-grade status without new out-of-sample evidence.

## Immutable execution plans

Every futures price signal, including dynamic signals, uses one shared ATR-based execution-plan builder. The plan is created before email rendering and persisted inside the stored signal payload.

The plan contains:

- `entryReference`;
- `stopLoss` and `takeProfit`;
- `stopPct` and `rewardRiskRatio`;
- `suggestedLeverage` and `maxPositionPct`;
- the configured cost assumption;
- the signal validity deadline and human-readable validity window.

Email rendering and review consume this stored plan. They may not regenerate targets from whatever configuration happens to be active later.

## Review lifecycle

A new review evaluates only fully completed candles after the alert was sent and no later than the stored validity deadline.

The first stop-loss or take-profit touch finalizes the review. If neither is touched by the deadline, the review finalizes as `超时` using the close of the last completed candle within the validity window.

Each finalized directional review stores:

- `grossReturnPct`;
- `costPct`;
- `returnPct`, defined as net return after configured cost;
- outcome, exit price, exit time, and review timestamp.

Any review whose status is already `reviewed` is immutable. Later deployments may not reinterpret or rewrite historical outcomes. Existing production rows are not migrated or rewritten in this implementation.

Funding-arbitrage review semantics remain unchanged because they use a different payoff model.

## Data flow

1. The scheduler requests the enabled dynamic long group only.
2. The scanner obtains futures tickers, candles, order-book context, and BTC benchmark data.
3. Candidate filters enforce the bounded momentum, relative-strength, volume, and liquidity region.
4. The shared futures-plan builder attaches the immutable execution plan.
5. The current-price guard rejects stale entries beyond 0.5%.
6. Email rendering displays the persisted plan.
7. Supabase stores the complete signal payload.
8. The review job evaluates the same persisted plan until TP, SL, or timeout, and stores net performance without rewriting completed history.

## Failure handling

Missing execution plans do not silently use current configuration for new records. New directional alerts without a valid entry, stop, and target remain pending with an explicit reason and are not counted as completed performance.

Market-data failures remain warnings and skip the affected candidate. A missing current futures mark price rejects the candidate rather than accepting an unverified stale entry.

No production database schema change is required for this phase because the signal payload and review are JSONB.

## Testing strategy

The existing Node smoke-test suite remains the test harness. Tests are written and observed failing before production code changes.

Required regression tests cover:

- the weak pool being disabled in both configuration and scheduler example;
- dynamic long acceptance inside all bounds and rejection above every upper bound;
- 0.5% current-price drift enforcement;
- ATR plan creation for a dynamic futures signal;
- email and review consuming the same persisted plan;
- gross, cost, and net TP/SL returns;
- timeout at `validUntil`;
- completed reviews never being recalculated.

The final verification runs the complete test command, a syntax check where applicable, and a diff review limited to files named in the implementation plan.

## Deployment and profitability gates

This work stops before deployment. The revised dynamic long strategy stays paper-only until it accumulates at least 30 new immutable out-of-sample outcomes and satisfies all of the following:

- positive net expectancy;
- net profit factor of at least 1.2;
- no negative deterioration in the most recent 20 outcomes;
- recommendation score buckets that are directionally calibrated rather than inversely predictive;
- 100% of new records contain a persisted execution plan.

Only after these gates pass should a separate deployment task update production scheduling and configuration.

## Scope exclusions

- No production deployment or environment-variable changes.
- No production Supabase writes or historical review rewrites.
- No new database tables or migrations.
- No unrelated refactoring.
- No leverage increase, portfolio allocator, automated order execution, or claim of guaranteed profit.
