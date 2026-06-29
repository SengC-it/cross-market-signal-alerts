# Cross-Market Signal Alerts

Cloud-ready signal scanner for crypto spot, USDT perpetual futures, and funding-rate arbitrage opportunities.

## What It Does

- Runs from GitHub Actions on a tiered schedule and calls the deployed Vercel API.
- Scans multiple asset groups and strategies in smaller batches to avoid cloud function timeouts.
- Scores each signal with historical performance, risk, current environment, and liquidity.
- Sends a decision-card style email only for new medium/high confidence signals.
- Stores sent signal keys in Supabase to avoid duplicate alerts.
- Does not trade and does not access any brokerage/exchange account.

## Scan Coverage

Scheduled groups:

- `dynamic-spot`: dynamically selected high-volume, high-momentum Binance spot symbols; scans every 30 minutes on `1h`.
- `crypto-core-a-1h`, `crypto-core-b-1h`: major spot crypto groups; scan hourly on `1h`.
- `crypto-alt-a-1h`, `crypto-alt-b-1h`, `crypto-alt-c-1h`: altcoin spot groups; scan hourly on `1h`.
- `futures-scalp-a`, `futures-scalp-b`: USDT perpetual futures short-term groups; scan every 30 minutes on `15m` and `30m`.
- `futures-core-1h`: major USDT perpetual futures; scans hourly on `1h`.
- `futures-arbitrage`: funding-rate arbitrage watchlist; scans hourly.
- `crypto-core-a-mid`, `crypto-core-b-mid`, `crypto-alt-a-mid`, `crypto-alt-b-mid`, `crypto-alt-c-mid`: spot crypto swing groups; scan every 4 hours on `2h` and `4h`.
- `futures-core-mid`: perpetual futures swing group; scans every 4 hours on `2h` and `4h`.
- `crypto-core-a-daily`, `crypto-core-b-daily`, `crypto-alt-a-daily`, `crypto-alt-b-daily`, `crypto-alt-c-daily`, `futures-daily`: slower daily crypto context scans; run once per day.

Legacy group names such as `crypto-core-a`, `crypto-alt-a`, and `futures-core` are still supported for manual testing, but scheduled jobs use the frequency-specific group names above.

Strategy families include trend-following, Donchian breakouts, moving-average crosses, RSI/Bollinger rebounds, defensive breakdown alerts, short-term momentum/pullback/breakdown signals, and futures-specific short-side observation signals.

## Required Environment Variables

```text
ALERT_EMAIL_TO=sheng.chi@qq.com
ALERT_EMAIL_FROM=Signal Alerts <alerts@your-domain.com>
EMAIL_FROM_NAME=Crypto Signal Bot
CRON_SECRET=choose-a-long-random-secret
MAX_SIGNAL_CURRENT_PRICE_DRIFT_PCT=0.02

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

If your project was created before the warning/error split, run this once in Supabase SQL Editor:

```sql
alter table run_logs add column if not exists warnings jsonb;
alter table run_logs add column if not exists email_result jsonb;
alter table run_logs add column if not exists sent_alert_keys jsonb;
```

## Scheduling

Production scheduling is handled by [sql/supabase-hourly-cron.example.sql](sql/supabase-hourly-cron.example.sql) using Supabase `pg_cron` and `pg_net`. The scheduler uses this cadence:

- Every 30 minutes at minutes `7` and `37`: `dynamic-spot`, `futures-scalp-a`, and `futures-scalp-b`
- Every hour at minute `11`: `1h` crypto spot, `1h` futures, and futures arbitrage
- Every 4 hours at minute `17`: `2h`/`4h` crypto spot and futures swing scans
- Daily at `00:23 UTC`: split daily crypto spot and futures scans

Each scheduled job calls Vercel:

```text
GET /api/cron?secret=YOUR_CRON_SECRET&group=GROUP_NAME
GET /api/cron?secret=YOUR_CRON_SECRET&groups=GROUP_A,GROUP_B,GROUP_C
```

Use `groups` for scheduled batches. The API scans each group, de-duplicates new signals, and sends one combined email with a subject that includes the signal count, top asset, direction, and highest recommendation score.

Required GitHub Actions secrets for manual dispatch:

```text
VERCEL_APP_URL=https://your-vercel-app.vercel.app
CRON_SECRET=the-same-secret-used-in-vercel
```

Vercel Hobby cron is intentionally not used because the free plan only allows daily cron jobs. GitHub Actions is intentionally kept as manual dispatch only because scheduled runs can be delayed or skipped.

## Vercel

Vercel hosts the API endpoints. Keep the same environment variables in Vercel as listed above.

Manual test:

```text
GET /api/test-email?secret=YOUR_CRON_SECRET
GET /api/cron?secret=YOUR_CRON_SECRET&quick=1
GET /api/cron?secret=YOUR_CRON_SECRET&dryRun=1&group=crypto-core-a-1h
```

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
