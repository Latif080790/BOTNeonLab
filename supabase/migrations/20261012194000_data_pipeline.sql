create type public.market_quality_status as enum (
  'ready',
  'needs_data',
  'stale',
  'future_timestamp',
  'out_of_order',
  'sequence_gap'
);

create table public.market_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  instrument_ref text not null,
  chain_id text not null,
  mint text not null,
  pool_address text not null,
  source text not null,
  source_lineage text not null,
  source_event_id text,
  event_time timestamptz,
  received_at timestamptz not null default now(),
  sequence bigint,
  schema_version text not null,
  quality_status public.market_quality_status not null,
  quality_reasons text[] not null default '{}',
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  payload jsonb not null check (jsonb_typeof(payload) = 'object')
);

create index market_events_workspace_instrument_time_idx
  on public.market_events (workspace_id, instrument_ref, received_at desc);
create index market_events_source_event_idx
  on public.market_events (workspace_id, source, source_event_id)
  where source_event_id is not null;

create table public.provider_states (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  provider_id text not null,
  endpoint_id text not null,
  status text not null check (status in ('healthy', 'degraded', 'backoff', 'unavailable')),
  last_success timestamptz,
  last_error_code text check (last_error_code is null or last_error_code ~ '^[a-z0-9_]{1,64}$'),
  quota_limit_per_minute integer check (quota_limit_per_minute is null or quota_limit_per_minute > 0),
  quota_remaining integer check (quota_remaining is null or quota_remaining >= 0),
  backoff_until timestamptz,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, provider_id, endpoint_id)
);

create table public.provider_quota_endpoints (
  provider_id text not null,
  endpoint_id text not null,
  requests_per_minute integer not null check (requests_per_minute > 0),
  primary key (provider_id, endpoint_id)
);

comment on table public.provider_quota_endpoints is
  'DEX Screener endpoint quotas documented at https://docs.dexscreener.com/api/reference.md; verify before changing.';

insert into public.provider_quota_endpoints (provider_id, endpoint_id, requests_per_minute)
values
  ('dexscreener', 'latest_dex_search', 300),
  ('dexscreener', 'latest_dex_pairs', 300),
  ('dexscreener', 'token_pairs', 300),
  ('dexscreener', 'tokens', 300),
  ('dexscreener', 'token_profiles_latest', 60);

create table public.provider_quota_attempts (
  id bigint generated always as identity primary key,
  provider_id text not null,
  endpoint_id text not null,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  actor_id uuid not null,
  reserved_at timestamptz not null
);

create index provider_quota_attempts_window_idx
  on public.provider_quota_attempts (provider_id, endpoint_id, reserved_at);

alter table public.market_events enable row level security;
alter table public.provider_states enable row level security;
alter table public.provider_quota_endpoints enable row level security;
alter table public.provider_quota_attempts enable row level security;

revoke all on public.market_events from public, anon, authenticated;
revoke all on public.provider_states from public, anon, authenticated;
revoke all on public.provider_quota_endpoints from public, anon, authenticated;
revoke all on public.provider_quota_attempts from public, anon, authenticated;

grant select on public.market_events, public.provider_states to authenticated;
grant select, insert on public.market_events to service_role;
grant select, insert, update on public.provider_states to service_role;
grant select on public.provider_quota_endpoints to service_role;
grant select, insert, delete on public.provider_quota_attempts to service_role;

create policy "Workspace members can read market events"
  on public.market_events for select to authenticated
  using ((select public.is_workspace_member(workspace_id)));

create policy "Workspace members can read provider state"
  on public.provider_states for select to authenticated
  using ((select public.is_workspace_member(workspace_id)));

create function public.reject_market_event_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'market_events is append-only'
    using errcode = '55000';
end;
$$;

create trigger market_events_no_row_mutation
  before update or delete on public.market_events
  for each row execute function public.reject_market_event_mutation();
create trigger market_events_no_truncate
  before truncate on public.market_events
  for each statement execute function public.reject_market_event_mutation();

create function public.reserve_market_provider_quota(
  target_workspace_id uuid,
  target_provider text,
  target_endpoint text
)
returns table (
  allowed boolean,
  retry_after_seconds integer,
  remaining_requests integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  authenticated_actor uuid;
  endpoint_limit integer;
  request_count integer;
  oldest_request timestamptz;
  reservation_time timestamptz;
begin
  authenticated_actor := auth.uid();
  if authenticated_actor is null then
    raise exception 'Authentication is required to reserve provider quota.'
      using errcode = '42501';
  end if;

  if not public.has_workspace_role(
    target_workspace_id,
    array['owner', 'researcher', 'operator']::public.workspace_role[]
  ) then
    raise exception 'The current user cannot reserve provider quota for this workspace.'
      using errcode = '42501';
  end if;

  select endpoint.requests_per_minute
    into endpoint_limit
    from public.provider_quota_endpoints as endpoint
    where endpoint.provider_id = target_provider
      and endpoint.endpoint_id = target_endpoint;

  if endpoint_limit is null then
    raise exception 'The provider endpoint has no configured quota.'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(target_provider || ':' || target_endpoint, 0)
  );
  reservation_time := clock_timestamp();

  delete from public.provider_quota_attempts as attempt
    where attempt.provider_id = target_provider
      and attempt.endpoint_id = target_endpoint
      and attempt.reserved_at <= reservation_time - interval '60 seconds';

  select count(*)::integer, min(attempt.reserved_at)
    into request_count, oldest_request
    from public.provider_quota_attempts as attempt
    where attempt.provider_id = target_provider
      and attempt.endpoint_id = target_endpoint
      and attempt.reserved_at > reservation_time - interval '60 seconds';

  if request_count >= endpoint_limit then
    return query
      select
        false,
        greatest(
          1,
          ceil(extract(epoch from (oldest_request + interval '60 seconds' - reservation_time)))::integer
        ),
        0;
    return;
  end if;

  insert into public.provider_quota_attempts (
    provider_id,
    endpoint_id,
    workspace_id,
    actor_id,
    reserved_at
  )
  values (
    target_provider,
    target_endpoint,
    target_workspace_id,
    authenticated_actor,
    reservation_time
  );

  return query select true, 0, endpoint_limit - request_count - 1;
end;
$$;

revoke all on function public.reserve_market_provider_quota(uuid, text, text) from public, anon;
grant execute on function public.reserve_market_provider_quota(uuid, text, text) to authenticated;
