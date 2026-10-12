-- A quota snapshot is updated for both the existing web path and the worker.
-- The shared admission ledger remains authoritative; remaining is an as-of observation.
create function public.record_market_quota_admission()
returns trigger language plpgsql security definer set search_path='' as $$
declare
  limit_count integer;
  used_count integer;
begin
  select requests_per_minute into limit_count from public.provider_quota_endpoints
    where provider_id=new.provider_id and endpoint_id=new.endpoint_id;
  select count(*) into used_count from public.provider_quota_attempts
    where provider_id=new.provider_id and endpoint_id=new.endpoint_id
      and reserved_at>new.reserved_at-interval '60 seconds';
  insert into public.provider_states(workspace_id,provider_id,endpoint_id,status,
    quota_limit_per_minute,quota_remaining,updated_at)
  values(new.workspace_id,new.provider_id,new.endpoint_id,'degraded',
    limit_count,greatest(0,limit_count-used_count),new.reserved_at)
  on conflict(workspace_id,provider_id,endpoint_id) do update set
    quota_limit_per_minute=excluded.quota_limit_per_minute,
    quota_remaining=excluded.quota_remaining,updated_at=excluded.updated_at;
  return new;
end;
$$;
revoke all on function public.record_market_quota_admission() from public,anon,authenticated;
create trigger market_quota_admission_state
  after insert on public.provider_quota_attempts
  for each row execute function public.record_market_quota_admission();
