-- Generated with the CLI; ordered after the legacy future-dated migration IDs.
-- Reconciles partial manual discovery installation without inventing historical counts.
do $$
begin
  perform set_config('lock_timeout','3s',true);
  if to_regclass('public.market_discovery_runs') is not null then
    lock table public.market_discovery_runs in access exclusive mode;
    if not exists(select 1 from information_schema.columns where table_schema='public'
      and table_name='market_discovery_runs' and column_name='invalid_candidate_count') then
      if exists(select 1 from public.market_discovery_runs) then
        raise exception 'Legacy invalid counts cannot be inferred: reconcile existing evidence before migration';
      end if;
      alter table public.market_discovery_runs add column invalid_candidate_count integer not null
        constraint market_discovery_runs_invalid_candidate_count_check check(invalid_candidate_count between 0 and 500);
    end if;
    if exists(select 1 from public.market_discovery_runs where actor_id is null or duplicate_candidate_count>500) then
      raise exception 'Legacy actor/count evidence requires explicit reconciliation';
    end if;
    alter table public.market_discovery_runs drop constraint if exists market_discovery_runs_actor_id_fkey;
    alter table public.market_discovery_runs alter column actor_id set not null;
    alter table public.market_discovery_runs drop constraint if exists market_discovery_runs_duplicate_candidate_count_check;
    alter table public.market_discovery_runs add constraint market_discovery_runs_duplicate_candidate_count_check
      check(duplicate_candidate_count between 0 and 500);
    -- This obsolete overload omits invalid_count; the web route uses the five-argument version.
    drop function if exists public.record_market_discovery(uuid,text,integer,jsonb);
  end if;

  if to_regprocedure('public.audit_identity_change()') is not null then
    revoke execute on function public.audit_identity_change() from public,anon,authenticated;
  end if;
  if to_regprocedure('public.has_workspace_role(uuid,public.workspace_role[])') is not null then
    revoke execute on function public.has_workspace_role(uuid,public.workspace_role[]) from public,anon;
  end if;
  if to_regprocedure('public.is_workspace_member(uuid)') is not null then
    revoke execute on function public.is_workspace_member(uuid) from public,anon;
  end if;
end;
$$;
