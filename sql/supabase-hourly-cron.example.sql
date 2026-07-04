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
  'cross_market_signal_inverse_watch_4h',
  'cross_market_signal_inverse_watch_daily',
  'cross_market_signal_review_4h',
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
          'dynamic-spot,dynamic-weak-spot'
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
    'cross_market_signal_review_4h',
    '0 */4 * * *',
    format(
      $job$
      select net.http_get(
        url := %L,
        params := jsonb_build_object(
          'group',
          'review'
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
    'cross_market_signal_inverse_watch_4h',
    '15 */4 * * *',
    format(
      $job$
      select net.http_get(
        url := %L,
        params := jsonb_build_object(
          'group',
          'inverse-watch-4h'
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
    'cross_market_signal_inverse_watch_daily',
    '30 0 * * *',
    format(
      $job$
      select net.http_get(
        url := %L,
        params := jsonb_build_object(
          'group',
          'inverse-watch-daily'
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
