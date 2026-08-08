create table if not exists cr_sent_alerts (
  signal_key text primary key,
  asset text not null,
  strategy_id text not null,
  interval text not null,
  trigger_time timestamptz not null,
  recommendation_score numeric,
  model_version text,
  model_fingerprint text,
  code_commit text,
  signal_family text,
  signal_direction text,
  delivery_mode text,
  delivery_status text not null default 'sent' check (delivery_status in ('sending', 'sent', 'failed')),
  payload jsonb,
  sent_at timestamptz not null default now()
);

create table if not exists cr_run_logs (
  id bigserial primary key,
  started_at timestamptz,
  finished_at timestamptz,
  scan_group text,
  candidates_count integer,
  signals_count integer,
  emailed boolean,
  errors jsonb,
  created_at timestamptz not null default now()
);

create table if not exists cr_processed_scan_candles (
  scan_group text not null,
  asset text not null,
  interval text not null,
  candle_open_time timestamptz not null,
  processed_at timestamptz not null default now(),
  primary key (scan_group, asset, interval, candle_open_time)
);

create table if not exists cr_paper_model_runs (
  model_id text not null,
  model_version text,
  rebalance_time timestamptz not null,
  data_cutoff_time timestamptz not null,
  state text not null default 'PAPER' check (state in ('PAPER', 'HALTED', 'LIVE')),
  deployment_gate_passed boolean not null default false,
  capital_weight numeric not null default 0 check (capital_weight >= 0 and capital_weight <= 1),
  predicted_beta numeric,
  gross_exposure numeric,
  eligible_symbols integer,
  targets jsonb not null default '[]'::jsonb,
  risk_state jsonb not null default '{}'::jsonb,
  diagnostics jsonb not null default '{}'::jsonb,
  review jsonb,
  model_fingerprint text,
  code_commit text,
  email_status text not null default 'pending' check (email_status in ('pending', 'sending', 'sent', 'failed', 'suppressed')),
  email_claimed_at timestamptz,
  email_sent_at timestamptz,
  email_result jsonb,
  created_at timestamptz not null default now(),
  primary key (model_id, rebalance_time),
  check (state <> 'LIVE' or deployment_gate_passed),
  check (state <> 'LIVE' or capital_weight > 0)
);

alter table cr_run_logs add column if not exists scan_group text;
alter table cr_run_logs add column if not exists email_status text;
alter table cr_run_logs add column if not exists warnings jsonb;
alter table cr_run_logs add column if not exists email_result jsonb;
alter table cr_run_logs add column if not exists sent_alert_keys jsonb;
alter table cr_paper_model_runs add column if not exists email_status text not null default 'pending';
alter table cr_paper_model_runs add column if not exists email_claimed_at timestamptz;
alter table cr_paper_model_runs add column if not exists email_sent_at timestamptz;
alter table cr_paper_model_runs add column if not exists email_result jsonb;
alter table cr_sent_alerts add column if not exists model_version text;
alter table cr_sent_alerts add column if not exists model_fingerprint text;
alter table cr_sent_alerts add column if not exists code_commit text;
alter table cr_sent_alerts add column if not exists signal_family text;
alter table cr_sent_alerts add column if not exists signal_direction text;
alter table cr_sent_alerts add column if not exists delivery_mode text;
alter table cr_paper_model_runs add column if not exists model_version text;
alter table cr_paper_model_runs add column if not exists model_fingerprint text;
alter table cr_paper_model_runs add column if not exists code_commit text;
alter table cr_paper_model_runs add column if not exists risk_state jsonb not null default '{}'::jsonb;
alter table cr_paper_model_runs add column if not exists review jsonb;

create index if not exists cr_sent_alerts_asset_time_idx on cr_sent_alerts (asset, trigger_time desc);
create index if not exists cr_sent_alerts_model_family_version_time_idx on cr_sent_alerts (signal_family, model_version, sent_at desc);
create index if not exists cr_sent_alerts_strategy_version_time_idx on cr_sent_alerts (strategy_id, model_version, sent_at desc);
create index if not exists cr_run_logs_created_at_idx on cr_run_logs (created_at desc);
create index if not exists cr_paper_model_runs_rebalance_idx on cr_paper_model_runs (rebalance_time desc);

alter table cr_sent_alerts enable row level security;
alter table cr_run_logs enable row level security;
alter table cr_processed_scan_candles enable row level security;
alter table cr_paper_model_runs enable row level security;
revoke all on table cr_sent_alerts from anon, authenticated;
revoke all on table cr_run_logs from anon, authenticated;
revoke all on table cr_processed_scan_candles from anon, authenticated;
revoke all on table cr_paper_model_runs from anon, authenticated;
grant select, insert, update on table cr_sent_alerts to service_role;
grant delete on table cr_sent_alerts to service_role;
grant select, insert on table cr_run_logs to service_role;
grant select, insert on table cr_processed_scan_candles to service_role;
grant select, insert, update on table cr_paper_model_runs to service_role;
grant usage, select on sequence run_logs_id_seq to service_role;
