-- Primary cloud scheduler for Supabase.
-- Replace YOUR_CRON_SECRET once in the scheduler block before running this in Supabase SQL Editor.
-- GitHub Actions is kept for manual dispatch only.

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

do $scheduler$
declare
  app_url text := 'https://cross-market-signal-alerts.vercel.app/api/cron';
  cron_secret text := 'YOUR_CRON_SECRET';
begin
  if cron_secret = 'YOUR_CRON_SECRET' or length(cron_secret) < 16 then
    raise exception 'Replace cron_secret with the Vercel CRON_SECRET before scheduling jobs';
  end if;

  perform cron.schedule(
    'cross_market_signal_dynamic_30m',
    '0,30 * * * *',
    format(
      $job$
      select net.http_get(
        url := %L,
        params := jsonb_build_object(
          'groups',
          'dynamic-spot,futures-scalp-a,futures-scalp-b'
        ),
        headers := jsonb_build_object(
          'Authorization',
          %L
        ),
        timeout_milliseconds := 60000
      );
      $job$,
      app_url,
      'Bearer ' || cron_secret
    )
  );

  perform cron.schedule(
    'cross_market_signal_short_hourly',
    '0 * * * *',
    format(
      $job$
      select net.http_get(
        url := %L,
        params := jsonb_build_object(
          'groups',
          'crypto-core-a-1h,crypto-core-b-1h,crypto-alt-a-1h,crypto-alt-b-1h,crypto-alt-c-1h,futures-core-1h,futures-arbitrage'
        ),
        headers := jsonb_build_object(
          'Authorization',
          %L
        ),
        timeout_milliseconds := 60000
      );
      $job$,
      app_url,
      'Bearer ' || cron_secret
    )
  );

  perform cron.schedule(
    'cross_market_signal_mid_4h',
    '0 */4 * * *',
    format(
      $job$
      select net.http_get(
        url := %L,
        params := jsonb_build_object(
          'groups',
          'crypto-core-a-mid,crypto-core-b-mid,crypto-alt-a-mid,crypto-alt-b-mid,crypto-alt-c-mid,futures-core-mid'
        ),
        headers := jsonb_build_object(
          'Authorization',
          %L
        ),
        timeout_milliseconds := 60000
      );
      $job$,
      app_url,
      'Bearer ' || cron_secret
    )
  );

  perform cron.schedule(
    'cross_market_signal_daily',
    '0 0 * * *',
    format(
      $job$
      select net.http_get(
        url := %L,
        params := jsonb_build_object(
          'groups',
          'crypto-core-a-daily,crypto-core-b-daily,crypto-alt-a-daily,crypto-alt-b-daily,crypto-alt-c-daily,futures-daily'
        ),
        headers := jsonb_build_object(
          'Authorization',
          %L
        ),
        timeout_milliseconds := 60000
      );
      $job$,
      app_url,
      'Bearer ' || cron_secret
    )
  );
end;
$scheduler$;
