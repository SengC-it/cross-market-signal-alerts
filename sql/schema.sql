create table if not exists sent_alerts (
  signal_key text primary key,
  asset text not null,
  strategy_id text not null,
  interval text not null,
  trigger_time timestamptz not null,
  recommendation_score numeric,
  payload jsonb,
  sent_at timestamptz not null default now()
);

create table if not exists run_logs (
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

create table if not exists processed_scan_candles (
  scan_group text not null,
  asset text not null,
  interval text not null,
  candle_open_time timestamptz not null,
  processed_at timestamptz not null default now(),
  primary key (scan_group, asset, interval, candle_open_time)
);

create table if not exists paper_model_runs (
  model_id text not null,
  rebalance_time timestamptz not null,
  data_cutoff_time timestamptz not null,
  state text not null default 'PAPER' check (state in ('PAPER', 'HALTED', 'LIVE')),
  deployment_gate_passed boolean not null default false,
  capital_weight numeric not null default 0 check (capital_weight >= 0 and capital_weight <= 1),
  predicted_beta numeric,
  gross_exposure numeric,
  eligible_symbols integer,
  targets jsonb not null default '[]'::jsonb,
  diagnostics jsonb not null default '{}'::jsonb,
  email_status text not null default 'pending' check (email_status in ('pending', 'sending', 'sent', 'failed')),
  email_claimed_at timestamptz,
  email_sent_at timestamptz,
  email_result jsonb,
  created_at timestamptz not null default now(),
  primary key (model_id, rebalance_time),
  check (state <> 'LIVE' or deployment_gate_passed),
  check (state <> 'LIVE' or capital_weight > 0)
);

alter table run_logs add column if not exists scan_group text;
alter table run_logs add column if not exists email_status text;
alter table run_logs add column if not exists warnings jsonb;
alter table run_logs add column if not exists email_result jsonb;
alter table run_logs add column if not exists sent_alert_keys jsonb;
alter table paper_model_runs add column if not exists email_status text not null default 'pending';
alter table paper_model_runs add column if not exists email_claimed_at timestamptz;
alter table paper_model_runs add column if not exists email_sent_at timestamptz;
alter table paper_model_runs add column if not exists email_result jsonb;

create index if not exists sent_alerts_asset_time_idx on sent_alerts (asset, trigger_time desc);
create index if not exists run_logs_created_at_idx on run_logs (created_at desc);
create index if not exists paper_model_runs_rebalance_idx on paper_model_runs (rebalance_time desc);

alter table paper_model_runs enable row level security;
revoke all on table paper_model_runs from anon, authenticated;
grant select, insert, update on table paper_model_runs to service_role;
