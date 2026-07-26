do $scheduler$
declare
  app_url text := 'https://cross-market-signal-alerts.vercel.app/api/cron';
begin
  if not exists (
    select 1
    from vault.decrypted_secrets
    where name = 'cross_market_cron_secret'
      and length(decrypted_secret) >= 32
  ) then
    raise exception 'Create Vault secret cross_market_cron_secret before scheduling jobs';
  end if;

  perform cron.unschedule(jobname)
  from cron.job
  where jobname in (
    'cross_market_signal_dynamic_30m',
    'cross_market_signal_v3_paper_hourly',
    'cross_market_signal_v3_3_paper_hourly',
    'cross_market_signal_review_4h'
  );

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
          'Bearer ' || (
            select decrypted_secret
            from vault.decrypted_secrets
            where name = 'cross_market_cron_secret'
          )
        ),
        timeout_milliseconds := 60000
      );
      $job$,
      app_url
    )
  );

  perform cron.schedule(
    'cross_market_signal_v3_paper_hourly',
    '15 * * * *',
    format(
      $job$
      select net.http_get(
        url := %L,
        params := jsonb_build_object('group', 'v3-paper'),
        headers := jsonb_build_object(
          'Authorization',
          'Bearer ' || (
            select decrypted_secret
            from vault.decrypted_secrets
            where name = 'cross_market_cron_secret'
          )
        ),
        timeout_milliseconds := 60000
      );
      $job$,
      app_url
    )
  );

  perform cron.schedule(
    'cross_market_signal_v3_3_paper_hourly',
    '35 * * * *',
    format(
      $job$
      select net.http_get(
        url := %L,
        params := jsonb_build_object('group', 'v3-3-paper'),
        headers := jsonb_build_object(
          'Authorization',
          'Bearer ' || (
            select decrypted_secret
            from vault.decrypted_secrets
            where name = 'cross_market_cron_secret'
          )
        ),
        timeout_milliseconds := 60000
      );
      $job$,
      app_url
    )
  );

  perform cron.schedule(
    'cross_market_signal_review_4h',
    '0 */4 * * *',
    format(
      $job$
      select net.http_get(
        url := %L,
        params := jsonb_build_object('group', 'review'),
        headers := jsonb_build_object(
          'Authorization',
          'Bearer ' || (
            select decrypted_secret
            from vault.decrypted_secrets
            where name = 'cross_market_cron_secret'
          )
        ),
        timeout_milliseconds := 60000
      );
      $job$,
      app_url
    )
  );
end;
$scheduler$;
