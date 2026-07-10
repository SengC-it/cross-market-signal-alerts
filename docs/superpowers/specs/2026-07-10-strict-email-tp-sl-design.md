# Strict Email TP/SL Evaluation Design

## Objective

Create one evidence-based evaluation path for every emailed futures signal. A trade enters at the price printed in the email and exits only when the email stop-loss or take-profit is touched. The system must never manufacture an expiry exit, promise profit, or select parameters using the final evaluation period.

The work remains research, historical replay, paper trading, and testnet only. It does not add Binance private trading APIs or authorize real-money orders.

## Canonical Trade Semantics

Each email represents one independent trade with these fields:

- Entry price: `executionPlan.entryReference`; fall back to the email `close` only when the execution plan does not contain a finite entry.
- Stop price: `executionPlan.stopLoss`.
- Target price: `executionPlan.takeProfit`.
- Direction: derived from the email direction and strategy metadata.
- Observation start: the email `sent_at` timestamp. If historical input has no send timestamp, use the trigger timestamp and mark the fallback in the replay result.
- Eligible candles: candles that open after the observation start and are fully closed at the replay cutoff.
- Stop-first ordering: evaluate candles chronologically. The first candle touching either boundary closes the trade.
- Same-candle collision: if a candle touches both stop and target, count the stop first.
- No expiry: when neither boundary has been touched, keep the trade in `open_unresolved` state indefinitely.

Closed trades contribute to realized win rate, expectancy, payoff ratio, Profit Factor, realized return, drawdown, and consecutive-loss statistics. Open trades do not contribute to those realized metrics. They receive separate mark-to-market values using the latest fully closed candle and are included in open exposure and marked-equity reporting.

## Cost and Funding Model

Every baseline must report three round-trip cost scenarios:

- Low: 0.12%.
- Primary: 0.20%.
- Stress: 0.40%.

Closed trades deduct the complete selected round-trip cost. Open trades reserve the same complete round-trip cost in marked return so that closing cost is not ignored.

Funding is accumulated at each historical funding timestamp strictly after entry and up to exit or the mark-to-market cutoff. A positive rate is paid by longs and received by shorts; a negative rate is received by longs and paid by shorts. Funding coverage must be reported. Missing funding observations are not silently replaced with zero. Results without adequate funding data must be labeled `funding_incomplete` and reported separately from funding-adjusted results.

## Execution-Bias Diagnostics

Strict email replay intentionally uses the email entry reference because that is the user's requested operating rule. It must also report execution feasibility:

- First fully observable market price after email send time.
- Absolute and signed drift from the email reference.
- Percentage of signals whose drift exceeds 0.20%, 0.50%, 1.00%, and the existing production guard.

These diagnostics do not rewrite the requested entry price. They show whether the requested entry was realistically available after delivery.

## Data Integrity

Every generated report records:

- Source signal files and their hashes.
- Candle and funding source directories.
- Data start and end timestamps.
- Replay cutoff timestamp.
- Missing candle and funding coverage.
- Code revision when available.
- Exact cost scenario and filter parameters.

Signal candles cannot be used as exit candles. Only fully closed candles after the email observation start are eligible. Duplicate email signal keys are reported and replayed once.

The historical universe must not be described as point-in-time complete unless delisted contracts and historical listings are included. Current-symbol-only datasets receive a `survivorship_bias` warning.

## Validation Protocol

The intended clean split is:

- Training: 2023-01-01 through 2024-12-31.
- Validation: 2025-01-01 through 2025-12-31.
- Test: 2026-01-01 through 2026-06-30.

The existing project has already optimized against 2026H1. Therefore 2026H1 is explicitly labeled `contaminated_test` and cannot support a claim of unseen out-of-sample profitability. It remains useful for transparent regression and regime diagnostics. A clean final evaluation requires a period not used for strategy or threshold selection.

The first optimization pass changes only whether a signal is accepted. It does not search TP/SL multipliers. Candidate filters are selected on training data, accepted or rejected on validation data, and reported once on the contaminated diagnostic period without further tuning.

## Acceptance Gates

A candidate filter can be recommended for paper trading only if all applicable gates pass on the validation set:

- Primary-cost expectancy is positive.
- Primary-cost Profit Factor is greater than 1.0.
- Removing the single largest winning trade leaves non-negative aggregate realized return.
- Stress-cost results do not show catastrophic loss.
- Profit is not dominated by one symbol or one short time window.
- Maximum drawdown remains inside an explicitly reported risk budget.
- Neighboring parameter values produce directionally consistent results.
- Monte Carlo trade-order and trade-sampling tests do not show unacceptable ruin or drawdown probability.

If no candidate passes, the output is `stop_trading`; the tool must not select the least-bad losing candidate.

## Components

### `lib/trade-replay.js`

Owns the canonical TP/SL state machine. It consumes an email signal, chronological candles, replay cutoff, cost rate, and optional funding observations. It returns a closed or unresolved trade with realized/marked return, funding coverage, collision information, and entry-feasibility diagnostics.

### `lib/performance.js`

Calculates realized and marked metrics without mixing open trades into realized statistics. It reports net return, win rate, payoff ratio, expectancy, Profit Factor, maximum drawdown, Sharpe with its stated convention, consecutive losses, symbol/time breakdowns, cost totals, funding totals, and concentration.

### `scripts/build-strict-baseline.js`

Loads existing email signal artifacts and cached Binance futures candles, deduplicates signals, runs the canonical replay for all three cost scenarios, and writes a reproducible baseline report.

### `scripts/validate-signal-filters.js`

Applies time splits, evaluates candidate filters, deletes the best trade, checks parameter neighborhoods, performs cost stress and seeded Monte Carlo tests, and emits pass/fail gates. It never mutates production configuration.

### Existing integrations

`lib/alert-review.js` will call the canonical replay state machine for one alert. Existing replay scripts will either delegate to the same module or be marked legacy so their exit semantics cannot silently diverge.

## Error Handling

- Missing or invalid entry, stop, target, direction, or timestamps produce an explicit invalid trade record; they are not dropped silently.
- Missing candles produce an unresolved trade with a data-coverage warning.
- Non-monotonic or duplicate candles are normalized deterministically and reported.
- Funding gaps set `funding_incomplete`.
- Invalid JSON input terminates the baseline command with the file name and parse error.
- Output files are written only after the complete report is successfully constructed.

## Testing Strategy

Implementation follows red-green-refactor cycles. Tests cover:

- Long and short TP first.
- Long and short SL first.
- Same-candle collision resolves to SL.
- Signal/pre-send candles are ignored.
- Unclosed candles are ignored.
- No boundary touch remains open without expiry.
- Mark-to-market return and reserved closing cost.
- All three cost scenarios.
- Long/short funding signs and incomplete coverage.
- Duplicate and unordered candles.
- Realized metrics exclude unresolved trades.
- Profit Factor, payoff ratio, drawdown, Sharpe, and consecutive losses.
- Deleting the best trade.
- Deterministic seeded Monte Carlo.
- Training, validation, and contaminated-test boundaries.
- `stop_trading` when no candidate passes all gates.

The existing smoke test remains a compatibility check. New behavior lives in focused Node test files using the built-in `node:test` runner.

## Rollback and Deliverables

Changes are separated by responsibility and can be reverted independently. Production signal thresholds are not changed until the strict baseline and validation gates exist and have been reviewed.

Deliverables are:

1. Canonical replay and performance modules with tests.
2. Reproducible strict baseline under 0.12%, 0.20%, and 0.40% costs.
3. Funding and data-coverage report.
4. Training/validation/diagnostic evaluation with robustness tests.
5. Evidence-backed recommendation: keep, restrict, or stop each signal family.
6. Before/after comparison using identical signals and market data.

