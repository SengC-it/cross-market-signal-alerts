alter table public.paper_model_runs
  add column if not exists review jsonb not null
  default '{"status":"pending","reason":"持仓周期未结束"}'::jsonb;

alter table public.paper_model_runs
  drop constraint if exists paper_model_runs_review_object_check;

alter table public.paper_model_runs
  add constraint paper_model_runs_review_object_check
  check (jsonb_typeof(review) = 'object');

revoke all on table public.paper_model_runs from anon, authenticated;
grant select, insert, update on table public.paper_model_runs to service_role;
