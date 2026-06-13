# Cross-Market Signal Alerts

Cloud-ready signal scanner for crypto spot, crypto perpetual futures, US equities/ETFs, and commodity proxies.

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
- `futures-core-1h`: major USDT perpetual futures; scans hourly on `1h`.
- `futures-arbitrage`: funding-rate arbitrage watchlist; scans hourly.
- `crypto-core-a-mid`, `crypto-core-b-mid`, `crypto-alt-a-mid`, `crypto-alt-b-mid`, `crypto-alt-c-mid`: spot crypto swing groups; scan every 4 hours on `2h` and `4h`.
- `futures-core-mid`: perpetual futures swing group; scans every 4 hours on `2h` and `4h`.
- `crypto-core-a-daily`, `crypto-core-b-daily`, `crypto-alt-a-daily`, `crypto-alt-b-daily`, `crypto-alt-c-daily`, `futures-daily`, `tradfi-daily`: slower daily context scans; run once per day.

Legacy group names such as `crypto-core-a`, `crypto-alt-a`, `futures-core`, and `tradfi` are still supported for manual testing, but scheduled jobs use the frequency-specific group names above.

Strategy families include trend-following, Donchian breakouts, moving-average crosses, RSI/Bollinger rebounds, defensive breakdown alerts, short-term momentum/pullback/breakdown signals, and futures-specific short-side observation signals.

## Required Environment Variables

```text
ALERT_EMAIL_TO=sheng.chi@qq.com
ALERT_EMAIL_FROM=Signal Alerts <alerts@your-domain.com>
CRON_SECRET=choose-a-long-random-secret

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

Production scheduling is handled by [`.github/workflows/signal-cron.yml`](.github/workflows/signal-cron.yml). The workflow uses this cadence:

- Every 30 minutes: `dynamic-spot`
- Every hour at minute `0`: `1h` crypto spot, `1h` futures, and futures arbitrage
- Every 4 hours at minute `8`: `2h`/`4h` crypto spot and futures swing scans
- Daily at `00:15 UTC`: split daily crypto, futures, and traditional-market scans

Each scheduled job calls:

```text
GET /api/cron?secret=YOUR_CRON_SECRET&group=GROUP_NAME
```

Required GitHub Actions secrets:

```text
VERCEL_APP_URL=https://your-vercel-app.vercel.app
CRON_SECRET=the-same-secret-used-in-vercel
```

Vercel Hobby cron is intentionally not used because the free plan only allows daily cron jobs.

Supabase also has an optional cloud fallback scheduler in [sql/supabase-hourly-cron.example.sql](sql/supabase-hourly-cron.example.sql). It uses `pg_cron` and `pg_net` to call the same Vercel API on the same tiered cadence, so the scanner can keep running even if GitHub Actions schedule is delayed or skipped.

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
ALERT_EMAIL_TO=sheng.chi@qq.com
```

Gmail App Passwords are different from your normal Google password. Do not commit them to GitHub.

## Notes

Crypto data uses Binance public REST where available, with Yahoo crypto chart data as a fallback for supported symbols and intervals. If Binance returns a geo-restriction response and no fallback data is available, the scanner skips that asset/interval instead of failing the whole batch. US equity/ETF and commodity proxy data uses Yahoo chart endpoints as a lightweight source. For production-grade market data, replace or augment Yahoo with a paid provider such as Polygon, Twelve Data, Alpha Vantage, or Nasdaq Data Link.
