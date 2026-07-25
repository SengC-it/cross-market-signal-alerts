create table if not exists public.paper_model_runs (
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
  created_at timestamptz not null default now(),
  primary key (model_id, rebalance_time),
  check (state <> 'LIVE' or deployment_gate_passed),
  check (state <> 'LIVE' or capital_weight > 0)
);

create index if not exists paper_model_runs_rebalance_idx
  on public.paper_model_runs (rebalance_time desc);

alter table public.paper_model_runs enable row level security;
revoke all on table public.paper_model_runs from anon, authenticated;
grant select, insert, update on table public.paper_model_runs to service_role;
