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

alter table run_logs add column if not exists scan_group text;
alter table run_logs add column if not exists email_status text;
alter table run_logs add column if not exists warnings jsonb;
alter table run_logs add column if not exists email_result jsonb;
alter table run_logs add column if not exists sent_alert_keys jsonb;

create index if not exists sent_alerts_asset_time_idx on sent_alerts (asset, trigger_time desc);
create index if not exists run_logs_created_at_idx on run_logs (created_at desc);
