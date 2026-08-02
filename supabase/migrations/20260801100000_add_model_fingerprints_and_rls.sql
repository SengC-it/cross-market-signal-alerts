-- Versioned signal provenance and defense-in-depth access control.
-- The application writes through service_role; anon/authenticated are intentionally denied.

alter table if exists public.sent_alerts
  add column if not exists model_version text,
  add column if not exists model_fingerprint text,
  add column if not exists code_commit text,
  add column if not exists signal_family text,
  add column if not exists signal_direction text,
  add column if not exists delivery_mode text;

alter table if exists public.paper_model_runs
  add column if not exists model_version text,
  add column if not exists model_fingerprint text,
  add column if not exists code_commit text,
  add column if not exists risk_state jsonb not null default '{}'::jsonb,
  add column if not exists review jsonb;

alter table if exists public.paper_model_runs
  drop constraint if exists paper_model_runs_email_status_check;

alter table if exists public.paper_model_runs
  add constraint paper_model_runs_email_status_check
  check (email_status in ('pending', 'sending', 'sent', 'failed', 'suppressed'));

create index if not exists sent_alerts_model_family_version_time_idx
  on public.sent_alerts (signal_family, model_version, sent_at desc);

create index if not exists sent_alerts_strategy_version_time_idx
  on public.sent_alerts (strategy_id, model_version, sent_at desc);

alter table if exists public.sent_alerts enable row level security;
alter table if exists public.run_logs enable row level security;
alter table if exists public.processed_scan_candles enable row level security;
alter table if exists public.paper_model_runs enable row level security;

revoke all on table public.sent_alerts from anon, authenticated;
revoke all on table public.run_logs from anon, authenticated;
revoke all on table public.processed_scan_candles from anon, authenticated;
revoke all on table public.paper_model_runs from anon, authenticated;

grant select, insert, update on table public.sent_alerts to service_role;
grant select, insert on table public.run_logs to service_role;
grant select, insert on table public.processed_scan_candles to service_role;
grant select, insert, update on table public.paper_model_runs to service_role;
grant usage, select on sequence public.run_logs_id_seq to service_role;
