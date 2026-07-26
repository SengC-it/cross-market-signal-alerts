# Cross-Market Signal Alerts

Cloud-ready signal scanner for crypto spot, USDT perpetual futures, and funding-rate arbitrage opportunities.

## What It Does

- Runs from Supabase `pg_cron` and calls the deployed Vercel API.
- Keeps dynamic strength/weakness alerts behind a family-level reviewed-performance circuit breaker.
- Scores each signal with historical performance, risk, current environment, and liquidity.
- Sends a decision-card style email only for new medium/high confidence signals.
- Stores sent signal keys in Supabase to avoid duplicate alerts.
- Persists V3.1 residual-momentum portfolio targets for forward PAPER validation only.
- Runs V3.3 as a separate zero-capital SHADOW PAPER model with a 15% annualized volatility target, an 8% portfolio catastrophe stop, and a 10% drawdown/4-week breaker.
- Does not trade and does not access any brokerage/exchange account.

## Scan Coverage

Scheduled groups:

- `dynamic-spot`: dynamically selected high-volume, high-momentum Binance spot symbols; scans every 30 minutes on `1h`.
- `dynamic-weak-spot`: dynamically selected high-volume, high-downside Binance spot symbols for short observation; scans every 30 minutes on `1h`.
- `v3-paper`: checks hourly for a new 168-hour V3.1 rebalance, stores three long and three short beta-neutral PAPER targets, and sends one de-duplicated PAPER email for each new weekly portfolio. It never sends orders and its live capital weight is fixed at zero.
- `v3-3-paper`: checks hourly at a separate offset, scales the same six-pair base portfolio from 0.25x to 1.25x using a 30-day volatility forecast, monitors the portfolio catastrophe stop at hourly closes, and records time/stop exits for review. Its failed research gate keeps it in SHADOW PAPER with zero live capital.

Legacy group names remain available in scanner code for local research. The protected production cron endpoint allows only dynamic strength/weakness scans, review, and the isolated V3.1/V3.3 PAPER groups; unproven inverse-watch and legacy groups are rejected.

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

The tables are:

- `sent_alerts`: de-duplicates sent signals.
- `run_logs`: records each scan run, system errors, and recoverable market-data warnings.
- `paper_model_runs`: stores versioned V3.1/V3.3 PAPER targets, risk state, email delivery state, zero capital weight, diagnostics, and cost-adjusted reviews.

If your project was created before the warning/error split, run this once in Supabase SQL Editor:

```sql
alter table run_logs add column if not exists warnings jsonb;
alter table run_logs add column if not exists email_result jsonb;
alter table run_logs add column if not exists sent_alert_keys jsonb;
```

## Scheduling

Production scheduling is handled by [sql/supabase-hourly-cron.example.sql](sql/supabase-hourly-cron.example.sql) using Supabase `pg_cron` and `pg_net`. The scheduler uses this CPU-light cadence:

- Every 30 minutes at minutes `0` and `30`: `dynamic-spot` and `dynamic-weak-spot`
- Hourly at minute `15`: check whether V3.1 has a new weekly PAPER rebalance to persist
- Hourly at minute `35`: create or monitor the V3.3 SHADOW PAPER portfolio
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
GET /api/cron?dryRun=1&group=v3-paper
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
