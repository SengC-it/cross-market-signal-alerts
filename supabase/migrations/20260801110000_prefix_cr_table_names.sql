-- Rename the four application tables without rewriting historical migrations.
-- ALTER TABLE preserves rows, indexes, constraints, grants, and RLS policies.

do $$
declare
  table_pair record;
  old_exists boolean;
  new_exists boolean;
begin
  for table_pair in
    select *
    from (values
      ('sent_alerts', 'cr_sent_alerts'),
      ('run_logs', 'cr_run_logs'),
      ('processed_scan_candles', 'cr_processed_scan_candles'),
      ('paper_model_runs', 'cr_paper_model_runs')
    ) as mappings(old_name, new_name)
  loop
    old_exists := to_regclass(format('public.%I', table_pair.old_name)) is not null;
    new_exists := to_regclass(format('public.%I', table_pair.new_name)) is not null;

    if old_exists and new_exists then
      raise exception 'Cannot rename %. Both % and % already exist',
        table_pair.old_name, table_pair.old_name, table_pair.new_name;
    elsif old_exists then
      execute format(
        'alter table public.%I rename to %I',
        table_pair.old_name,
        table_pair.new_name
      );
    elsif not new_exists then
      raise exception 'Cannot rename %. Neither % nor % exists',
        table_pair.old_name, table_pair.old_name, table_pair.new_name;
    end if;
  end loop;
end
$$;

do $$
declare
  index_pair record;
begin
  for index_pair in
    select *
    from (values
      ('sent_alerts_asset_time_idx', 'cr_sent_alerts_asset_time_idx'),
      ('sent_alerts_model_family_version_time_idx', 'cr_sent_alerts_model_family_version_time_idx'),
      ('sent_alerts_strategy_version_time_idx', 'cr_sent_alerts_strategy_version_time_idx'),
      ('run_logs_created_at_idx', 'cr_run_logs_created_at_idx'),
      ('paper_model_runs_rebalance_idx', 'cr_paper_model_runs_rebalance_idx'),
      ('paper_model_runs_model_rebalance_idx', 'cr_paper_model_runs_model_rebalance_idx')
    ) as mappings(old_name, new_name)
  loop
    if to_regclass(format('public.%I', index_pair.old_name)) is not null
      and to_regclass(format('public.%I', index_pair.new_name)) is null then
      execute format(
        'alter index public.%I rename to %I',
        index_pair.old_name,
        index_pair.new_name
      );
    end if;
  end loop;
end
$$;
