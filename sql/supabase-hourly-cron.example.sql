-- Optional cloud fallback scheduler for Supabase.
-- Replace YOUR_CRON_SECRET before running this in Supabase SQL Editor.
-- GitHub Actions remains the primary scheduler; this is a fallback if Actions is delayed or skipped.

create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

select cron.unschedule(jobname)
from cron.job
where jobname in (
  'cross_market_signal_hourly',
  'cross_market_signal_dynamic_30m',
  'cross_market_signal_short_hourly',
  'cross_market_signal_mid_4h',
  'cross_market_signal_daily'
);

select cron.schedule(
  'cross_market_signal_dynamic_30m',
  '*/30 * * * *',
  $$
  select net.http_get(
    url := 'https://cross-market-signal-alerts.vercel.app/api/cron',
    params := jsonb_build_object('group', grp),
    headers := jsonb_build_object('Authorization', 'Bearer YOUR_CRON_SECRET'),
    timeout_milliseconds := 60000
  )
  from unnest(array['dynamic-spot']) as grp;
  $$
);

select cron.schedule(
  'cross_market_signal_short_hourly',
  '0 * * * *',
  $$
  select net.http_get(
    url := 'https://cross-market-signal-alerts.vercel.app/api/cron',
    params := jsonb_build_object('group', grp),
    headers := jsonb_build_object('Authorization', 'Bearer YOUR_CRON_SECRET'),
    timeout_milliseconds := 60000
  )
  from unnest(array[
    'crypto-core-a-1h',
    'crypto-core-b-1h',
    'crypto-alt-a-1h',
    'crypto-alt-b-1h',
    'crypto-alt-c-1h',
    'futures-core-1h',
    'futures-arbitrage'
  ]) as grp;
  $$
);

select cron.schedule(
  'cross_market_signal_mid_4h',
  '8 */4 * * *',
  $$
  select net.http_get(
    url := 'https://cross-market-signal-alerts.vercel.app/api/cron',
    params := jsonb_build_object('group', grp),
    headers := jsonb_build_object('Authorization', 'Bearer YOUR_CRON_SECRET'),
    timeout_milliseconds := 60000
  )
  from unnest(array[
    'crypto-core-a-mid',
    'crypto-core-b-mid',
    'crypto-alt-a-mid',
    'crypto-alt-b-mid',
    'crypto-alt-c-mid',
    'futures-core-mid'
  ]) as grp;
  $$
);

select cron.schedule(
  'cross_market_signal_daily',
  '15 0 * * *',
  $$
  select net.http_get(
    url := 'https://cross-market-signal-alerts.vercel.app/api/cron',
    params := jsonb_build_object('group', grp),
    headers := jsonb_build_object('Authorization', 'Bearer YOUR_CRON_SECRET'),
    timeout_milliseconds := 60000
  )
  from unnest(array[
    'crypto-core-a-daily',
    'crypto-core-b-daily',
    'crypto-alt-a-daily',
    'crypto-alt-b-daily',
    'crypto-alt-c-daily',
    'futures-daily',
    'tradfi-daily'
  ]) as grp;
  $$
);
