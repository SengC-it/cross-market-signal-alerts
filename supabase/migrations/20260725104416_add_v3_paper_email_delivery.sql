alter table public.paper_model_runs
  add column if not exists email_status text not null default 'pending',
  add column if not exists email_claimed_at timestamptz,
  add column if not exists email_sent_at timestamptz,
  add column if not exists email_result jsonb;

alter table public.paper_model_runs
  drop constraint if exists paper_model_runs_email_status_check;

alter table public.paper_model_runs
  add constraint paper_model_runs_email_status_check
  check (email_status in ('pending', 'sending', 'sent', 'failed'));
