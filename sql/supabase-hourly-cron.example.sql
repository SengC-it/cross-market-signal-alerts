-- Optional cloud fallback scheduler for Supabase.
-- Replace the URL and CRON_SECRET before running this in Supabase SQL Editor.
-- This keeps the scanner running hourly even if GitHub Actions schedule is delayed or skipped.

create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

select cron.unschedule('cross_market_signal_hourly')
where exists (
  select 1
  from cron.job
  where jobname = 'cross_market_signal_hourly'
);

select cron.schedule(
  'cross_market_signal_hourly',
  '0 * * * *',
  $$
  select net.http_get(
    url := 'https://cross-market-signal-alerts.vercel.app/api/cron',
    params := jsonb_build_object('group', grp),
    headers := jsonb_build_object('Authorization', 'Bearer YOUR_CRON_SECRET'),
    timeout_milliseconds := 60000
  )
  from unnest(array[
    'crypto-core-a',
    'crypto-core-b',
    'crypto-alt-a',
    'crypto-alt-b',
    'crypto-alt-c',
    'futures-core',
    'futures-arbitrage',
    'tradfi'
  ]) as grp;
  $$
);
