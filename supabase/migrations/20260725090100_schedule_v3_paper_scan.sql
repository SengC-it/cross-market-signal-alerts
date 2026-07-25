do $scheduler$
declare
  source_command text;
begin
  select command
  into source_command
  from cron.job
  where jobname = 'cross_market_signal_dynamic_30m';

  if source_command is null then
    raise exception 'Existing protected dynamic scheduler job is required';
  end if;

  source_command := replace(source_command, '''groups''', '''group''');
  source_command := replace(
    source_command,
    '''dynamic-spot,dynamic-weak-spot''',
    '''v3-paper'''
  );

  if source_command not like '%v3-paper%' then
    raise exception 'Could not derive V3 PAPER scheduler command';
  end if;

  perform cron.unschedule(jobname)
  from cron.job
  where jobname in (
    'cross_market_signal_v3_paper_hourly',
    'cross_market_signal_inverse_watch_4h',
    'cross_market_signal_inverse_watch_daily'
  );

  perform cron.schedule(
    'cross_market_signal_v3_paper_hourly',
    '15 * * * *',
    source_command
  );
end;
$scheduler$;
