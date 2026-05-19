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

alter table run_logs add column if not exists scan_group text;
alter table run_logs add column if not exists email_status text;
alter table run_logs add column if not exists warnings jsonb;

create index if not exists sent_alerts_asset_time_idx on sent_alerts (asset, trigger_time desc);
create index if not exists run_logs_created_at_idx on run_logs (created_at desc);
