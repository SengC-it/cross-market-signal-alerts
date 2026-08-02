# Cross-Market Signal Alerts

Cloud-ready signal scanner for crypto spot, USDT perpetual futures, and funding-rate arbitrage opportunities.

## What It Does

- Runs from Supabase `pg_cron` and calls the deployed Vercel API.
- Keeps dynamic strength/weakness alerts behind a family-level reviewed-performance circuit breaker.
- Scores each signal with historical performance, risk, current environment, and liquidity.
- Sends a decision-card style email only for new medium/high confidence signals.
- Stores sent signal keys in Supabase to avoid duplicate alerts.
- Persists V3.1 residual-momentum portfolios as a silent forward PAPER benchmark.
- Sends one V3.4 UNIFIED PAPER portfolio that combines the V3.1 residual-momentum/beta-neutral signal with the frozen V3.3 volatility target, 8% portfolio catastrophe stop, and 10% drawdown/4-week performance gate.
- Does not trade and does not access any brokerage/exchange account.

## Scan Coverage

Scheduled groups:

- `dynamic-spot`: dynamically selected high-volume, high-momentum Binance spot symbols; scans every 30 minutes on `1h`.
- `dynamic-weak-spot`: dynamically selected high-volume, high-downside Binance spot symbols for short observation; scans every 30 minutes on `1h`.
- `v3-paper`: maintains the three-long/three-short V3.1 benchmark and its reviews without sending duplicate emails.
- `v3-4-paper`: becomes active at the 2026-08-06 weekly boundary, scales the V3.1 base portfolio from 0.25x to 1.25x using a 30-day volatility forecast, monitors the portfolio catastrophe stop hourly, and sends the single unified PAPER email. Before activation it finishes the open V3.3 review.
- `funding-carry-paper`: reserved for the perpetual-only Funding Carry trend-filter PAPER model. It is currently disabled because the corrected historical research Gate has not passed; no scheduler migration is active.
- `funding-carry-v2-paper`: the independent 100-symbol perpetual Funding Carry V2 PAPER model. Its default Train-only single-rule selection chooses `ema100_slope12` from the permitted trend candidates, then uses a 90-event funding z-score, funding mean-reversion confirmation, 48-hour maximum holding, and zero capital weight; it is not a replacement for the existing dynamic alerts or V1 benchmark.

The legacy `v3-3-paper` API group remains available during transition, but it is no longer scheduled after V3.4 deployment.

Strategy families include trend-following, Donchian breakouts, moving-average crosses, RSI/Bollinger rebounds, defensive breakdown alerts, short-term momentum/pullback/breakdown signals, and futures-specific short-side observation signals.

## Required Environment Variables

```text
ALERT_EMAIL_TO=sheng.chi@qq.com
ALERT_EMAIL_FROM=Signal Alerts <alerts@your-domain.com>
EMAIL_FROM_NAME=Crypto Signal Bot
CRON_SECRET=choose-a-long-random-secret
DASHBOARD_SECRET=choose-a-separate-query-password
MAX_SIGNAL_CURRENT_PRICE_DRIFT_PCT=0.003

# Choose one email provider.
# Recommended if you do not own a domain:
GMAIL_SMTP_USER=your-gmail-address@gmail.com
GMAIL_APP_PASSWORD=your-16-character-google-app-password

# Recommended if you own a verified sending domain:
RESEND_API_KEY=...
# or
SENDGRID_API_KEY=...

# Supabase state storage
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...
```

## Supabase Setup

Run [sql/schema.sql](sql/schema.sql) in Supabase SQL Editor.

The tables are prefixed with `cr_` so they are isolated from other projects sharing the same Supabase project:

- `cr_sent_alerts`: de-duplicates sent signals.
- `cr_run_logs`: records each scan run, system errors, and recoverable market-data warnings.
- `cr_processed_scan_candles`: de-duplicates completed scan candles.
- `cr_paper_model_runs`: stores versioned V3.1/V3.3/V3.4 PAPER targets, risk state, email delivery state, zero capital weight, diagnostics, and cost-adjusted reviews.

The perpetual Funding Carry research command includes price PnL, funding PnL, costs, ATR stops, trend exits, 48-hour time exits, portfolio risk caps, and train/validation/test gates:

```bash
npm run backtest:funding-carry-perp
```

Funding Carry V2 uses a Train-only liquid-universe manifest, rolling funding z-scores, a funding mean-reversion filter, a 4h ATR/price P90 volatility cap, and a staged Train-only parameter search. The default PAPER-candidate mode fixes the funding/exit/risk grid to the audited values (`z-window 90`, entry z 1, minimum funding 0.02%, exit z 0.5, two confirmations, ATR×2, 1.2% minimum stop, 48 hours), evaluates all permitted single trend rules on Train, and selects `ema100_slope12` by the Train risk-adjusted ranking. Its full Train/Validation/Test Gate passed. The unrestricted research grid still covers every parameter and every two-rule combination; it remains diagnostic only (raise `FUNDING_CARRY_V2_FILTER_EXPANSION_LIMIT` for a wider, slower audit):

```bash
npm run prepare:funding-carry-v2-data
npm run select:funding-carry-v2
npm run backtest:funding-carry-perp-v2
```

The default backtest command reruns the Train-only trend selection above and must pass with `FUNDING_CARRY_PERP_V2_REQUIRE_PASS=1`. To run the unrestricted research grid instead, set `FUNDING_CARRY_V2_MODE=research-grid`; that grid remains diagnostic and is not a deployment candidate. The selected reversion branch is the only branch authorized for zero-capital PAPER; it must still complete the separate eight-week PAPER Gate before any LIVE capital is enabled. Apply the new scheduler migration only after deploying this PAPER code; no LIVE deployment is authorized by the historical result alone.

If your project was created before the warning/error split, run this once in Supabase SQL Editor:

```sql
alter table cr_run_logs add column if not exists warnings jsonb;
alter table cr_run_logs add column if not exists email_result jsonb;
alter table cr_run_logs add column if not exists sent_alert_keys jsonb;
```

## Scheduling

Production scheduling is handled by [sql/supabase-hourly-cron.example.sql](sql/supabase-hourly-cron.example.sql) using Supabase `pg_cron` and `pg_net`. The scheduler uses this CPU-light cadence:

- Every 30 minutes at minutes `0` and `30`: `dynamic-spot` and `dynamic-weak-spot`
- Hourly at minute `15`: maintain the silent V3.1 PAPER benchmark
- Hourly at minute `35`: create or monitor the unified V3.4 PAPER portfolio
- Every 4 hours at minute `0`: review recent sent alerts only; this does not scan the whole market

Each scheduled job calls Vercel:

```text
GET /api/cron?group=GROUP_NAME
Authorization: Bearer YOUR_CRON_SECRET
```

Use `groups` for scheduled batches. The API scans each group, de-duplicates new signals, and sends one combined email with a subject that includes the signal count, top asset, direction, and highest recommendation score.

Before running the scheduler SQL, create a Supabase Vault secret named `cross_market_cron_secret` with the same value as Vercel `CRON_SECRET`. The scheduled command resolves the secret from Vault at execution time instead of storing the plaintext value in `cron.job`.

To verify scheduled jobs and recent HTTP results in Supabase SQL Editor:

```sql
select jobid, jobname, schedule, active
from cron.job
where jobname like 'cross_market_signal%';

select id, status_code, error_msg, created
from net._http_response
order by created desc
limit 20;
```

A `401` response from `/api/cron` means Supabase reached Vercel but the scheduled request did not use the same `CRON_SECRET` as Vercel.

Required GitHub Actions secrets for manual dispatch:

```text
VERCEL_APP_URL=https://your-vercel-app.vercel.app
CRON_SECRET=the-same-secret-used-in-vercel
```

Vercel Hobby cron is intentionally not used because the free plan only allows daily cron jobs. GitHub Actions is intentionally kept as manual dispatch only because scheduled runs can be delayed or skipped.

## Vercel

Vercel hosts the API endpoints. Keep the same environment variables in Vercel as listed above.

Manual tests should send the secret in an `Authorization: Bearer ...` header, not in the URL:

```text
GET /api/test-email
GET /api/cron?quick=1
GET /api/cron?dryRun=1&group=v3-4-paper
```

## Inverse Signal Research

Run a local inverse-signal report before considering any production signal changes:

```bash
npm run inverse-report
```

By default this scans the futures core group on `1h` candles and writes `inverse_signal_report.json`. Useful narrower runs:

```bash
npm run inverse-report -- --assets BTCUSDT,ETHUSDT --intervals 1h,4h
npm run inverse-report -- --market spot --group crypto-core --intervals 1h
npm run inverse-report -- --market all --assets BTCUSDT --output inverse_signal_report.btc.json
```

Treat `inverse_candidate` as research output only. It means the inverse direction beat the original after configured trading cost, including out-of-sample checks in the available candle window. `inverse-watch-*` scans remain manual until live performance is proven. The system still does not place trades.

## Gmail SMTP

If you do not own a sending domain, Gmail SMTP is the easiest production email path.

1. Enable 2-Step Verification on the Gmail account.
2. Create an App Password for this app.
3. Add these Vercel environment variables:

```text
GMAIL_SMTP_USER=your-gmail-address@gmail.com
GMAIL_APP_PASSWORD=your-16-character-app-password
ALERT_EMAIL_FROM=Signal Alerts <your-gmail-address@gmail.com>
EMAIL_FROM_NAME=Crypto Signal Bot
ALERT_EMAIL_TO=sheng.chi@qq.com
```

Gmail App Passwords are different from your normal Google password. Do not commit them to GitHub.

## Notes

Crypto data uses Binance public REST directly for spot candles, spot depth, USDT perpetual futures candles, funding rates, open interest, and long/short positioning. Vercel production runs are expected to connect to Binance directly; the scanner does not substitute proxy or Yahoo spot data for failed Binance futures responses. If Binance returns a geo-restriction response or times out, that asset/interval is skipped and recorded as a warning instead of failing the whole batch. For production-grade redundancy, add a paid crypto data provider that supports the same spot and futures fields without changing the signal semantics.
