alter table public.cr_sent_alerts
  add column if not exists delivery_status text not null default 'sent';

update public.cr_sent_alerts
set delivery_status = 'sent'
where delivery_status is null;

alter table public.cr_sent_alerts
  drop constraint if exists cr_sent_alerts_delivery_status_check;

alter table public.cr_sent_alerts
  add constraint cr_sent_alerts_delivery_status_check
  check (delivery_status in ('sending', 'sent', 'failed'));

grant delete on table public.cr_sent_alerts to service_role;
