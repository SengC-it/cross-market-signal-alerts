alter table public.paper_model_runs
  add column if not exists model_version text not null default 'V3.1 PAPER',
  add column if not exists risk_state jsonb not null default '{}'::jsonb;

alter table public.paper_model_runs
  drop constraint if exists paper_model_runs_risk_state_object_check;

alter table public.paper_model_runs
  add constraint paper_model_runs_risk_state_object_check
  check (jsonb_typeof(risk_state) = 'object');

alter table public.paper_model_runs
  drop constraint if exists paper_model_runs_email_status_check;

alter table public.paper_model_runs
  add constraint paper_model_runs_email_status_check
  check (email_status in ('pending', 'sending', 'sent', 'failed', 'suppressed'));

create index if not exists paper_model_runs_model_rebalance_idx
  on public.paper_model_runs (model_id, rebalance_time desc);

alter table public.paper_model_runs enable row level security;
revoke all on table public.paper_model_runs from anon, authenticated;
grant select, insert, update on table public.paper_model_runs to service_role;

do $scheduler$
declare
  source_command text;
begin
  select command
  into source_command
  from cron.job
  where jobname = 'cross_market_signal_v3_paper_hourly';

  if source_command is null then
    raise exception 'Existing protected V3.1 PAPER scheduler job is required';
  end if;

  source_command := replace(
    source_command,
    '''v3-paper''',
    '''v3-3-paper'''
  );

  if source_command not like '%v3-3-paper%' then
    raise exception 'Could not derive V3.3 SHADOW PAPER scheduler command';
  end if;

  perform cron.unschedule(jobname)
  from cron.job
  where jobname = 'cross_market_signal_v3_3_paper_hourly';

  perform cron.schedule(
    'cross_market_signal_v3_3_paper_hourly',
    '35 * * * *',
    source_command
  );
end;
$scheduler$;
