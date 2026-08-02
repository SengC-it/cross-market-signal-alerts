-- Run Funding Carry V2 as its own hourly PAPER group after the historical Gate.
-- The model remains capitalWeight = 0 and deploymentGatePassed = false until
-- the separate eight-week PAPER Gate is satisfied in application code.
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
  where jobname = 'cross_market_signal_funding_carry_v2_paper_hourly';

  perform cron.schedule(
    'cross_market_signal_funding_carry_v2_paper_hourly',
    '50 * * * *',
    format(
      $job$
      select net.http_get(
        url := %L,
        params := jsonb_build_object('group', 'funding-carry-v2-paper'),
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
