# Cross-Market Signal Alerts

Cloud-ready signal scanner for crypto, US equities/ETFs, and commodity proxies.

## What It Does

- Runs on Vercel Cron every 4 hours.
- Scans multiple assets and strategies.
- Scores each signal with historical performance, risk, current environment, and liquidity.
- Sends a decision-card style email only for new medium/high confidence signals.
- Stores sent signal keys in Supabase to avoid duplicate alerts.
- Does not trade and does not access any brokerage/exchange account.

## Required Environment Variables

```text
ALERT_EMAIL_TO=sheng.chi@qq.com
ALERT_EMAIL_FROM=Signal Alerts <alerts@your-domain.com>
CRON_SECRET=choose-a-long-random-secret

# Choose one email provider
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
- `run_logs`: records each scan run.

## Vercel

The cron schedule is in [vercel.json](vercel.json):

```json
{
  "crons": [
    {
      "path": "/api/cron",
      "schedule": "10 */4 * * *"
    }
  ]
}
```

Manual test:

```text
GET /api/test-email?secret=YOUR_CRON_SECRET
GET /api/cron?secret=YOUR_CRON_SECRET&dryRun=1
```

## Notes

Crypto data uses Binance public REST where available. US equity/ETF and commodity proxy data uses Yahoo chart endpoints as a lightweight source. For production-grade market data, replace or augment Yahoo with a paid provider such as Polygon, Twelve Data, Alpha Vantage, or Nasdaq Data Link.
