do $$
declare
  existing_labels text[];
  expected_labels constant text[] := array['complete', 'partial', 'failed'];
begin
  select array_agg(enum_value.enumlabel order by enum_value.enumsortorder)
    into existing_labels
    from pg_type as enum_type
    join pg_namespace as enum_schema on enum_schema.oid = enum_type.typnamespace
    join pg_enum as enum_value on enum_value.enumtypid = enum_type.oid
    where enum_schema.nspname = 'public'
      and enum_type.typname = 'discovery_coverage';

  if existing_labels is null then
    create type public.discovery_coverage as enum ('complete', 'partial', 'failed');
  elsif existing_labels is distinct from expected_labels then
    raise exception 'public.discovery_coverage exists with unexpected labels: %', existing_labels
      using errcode = '55000';
  end if;
end;
$$;

create table if not exists public.market_discovery_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete restrict,
  actor_id uuid not null,
  provider_id text not null,
  endpoint_id text not null,
  query_hash text not null check (query_hash ~ '^[0-9a-f]{64}$'),
  coverage public.discovery_coverage not null,
  candidate_count integer not null check (candidate_count between 0 and 500),
  duplicate_candidate_count integer not null check (duplicate_candidate_count between 0 and 500),
  invalid_candidate_count integer not null check (invalid_candidate_count between 0 and 500),
  received_at timestamptz not null default now(),
  unique (id, workspace_id)
);

create index if not exists market_discovery_runs_workspace_time_idx
  on public.market_discovery_runs (workspace_id, received_at desc);

create table if not exists public.market_discovery_candidates (
  id uuid primary key default gen_random_uuid(),
  discovery_id uuid not null,
  workspace_id uuid not null,
  instrument_ref text not null,
  chain_id text not null,
  mint text not null,
  pool_address text not null,
  source text not null,
  source_lineage text not null,
  source_event_id text,
  event_time timestamptz,
  observed_at timestamptz not null,
  sequence bigint,
  schema_version text not null,
  quality_status public.market_quality_status not null,
  quality_reasons text[] not null default '{}',
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  unique (discovery_id, instrument_ref),
  foreign key (discovery_id, workspace_id)
    references public.market_discovery_runs (id, workspace_id)
    on delete restrict
);

create index if not exists market_discovery_candidates_workspace_instrument_idx
  on public.market_discovery_candidates (workspace_id, instrument_ref, observed_at desc);

alter table public.market_discovery_runs enable row level security;
alter table public.market_discovery_candidates enable row level security;

revoke all on public.market_discovery_runs from public, anon, authenticated;
revoke all on public.market_discovery_candidates from public, anon, authenticated;
grant select on public.market_discovery_runs, public.market_discovery_candidates to authenticated;
grant select, insert on public.market_discovery_runs to service_role;
grant select, insert on public.market_discovery_candidates to service_role;

drop policy if exists "Workspace members can read discovery runs"
  on public.market_discovery_runs;
create policy "Workspace members can read discovery runs"
  on public.market_discovery_runs for select to authenticated
  using ((select public.is_workspace_member(workspace_id)));

drop policy if exists "Workspace members can read discovery candidates"
  on public.market_discovery_candidates;
create policy "Workspace members can read discovery candidates"
  on public.market_discovery_candidates for select to authenticated
  using ((select public.is_workspace_member(workspace_id)));

create or replace function public.reject_market_discovery_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'market discovery records are append-only'
    using errcode = '55000';
end;
$$;

drop trigger if exists market_discovery_runs_no_row_mutation
  on public.market_discovery_runs;
drop trigger if exists market_discovery_runs_no_truncate
  on public.market_discovery_runs;
drop trigger if exists market_discovery_candidates_no_row_mutation
  on public.market_discovery_candidates;
drop trigger if exists market_discovery_candidates_no_truncate
  on public.market_discovery_candidates;

create trigger market_discovery_runs_no_row_mutation
  before update or delete on public.market_discovery_runs
  for each row execute function public.reject_market_discovery_mutation();
create trigger market_discovery_runs_no_truncate
  before truncate on public.market_discovery_runs
  for each statement execute function public.reject_market_discovery_mutation();
create trigger market_discovery_candidates_no_row_mutation
  before update or delete on public.market_discovery_candidates
  for each row execute function public.reject_market_discovery_mutation();
create trigger market_discovery_candidates_no_truncate
  before truncate on public.market_discovery_candidates
  for each statement execute function public.reject_market_discovery_mutation();

create or replace function public.record_market_discovery(
  target_workspace_id uuid,
  target_query_hash text,
  target_duplicate_count integer,
  target_invalid_count integer,
  target_candidates jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  authenticated_actor uuid;
  discovery_id uuid;
  candidate_count integer;
  candidate record;
begin
  authenticated_actor := auth.uid();
  if authenticated_actor is null then
    raise exception 'Authentication is required to record a discovery run.'
      using errcode = '42501';
  end if;

  if not public.has_workspace_role(
    target_workspace_id,
    array['owner', 'researcher', 'operator']::public.workspace_role[]
  ) then
    raise exception 'The current user cannot record discovery in this workspace.'
      using errcode = '42501';
  end if;

  if target_query_hash is null or target_query_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'A SHA-256 query hash is required.'
      using errcode = '22023';
  end if;
  if target_duplicate_count is null or target_duplicate_count < 0 then
    raise exception 'Duplicate candidate count must be non-negative.'
      using errcode = '22023';
  end if;
  if target_invalid_count is null or target_invalid_count < 0 then
    raise exception 'Invalid candidate count must be non-negative.'
      using errcode = '22023';
  end if;
  if target_candidates is null or jsonb_typeof(target_candidates) <> 'array' then
    raise exception 'Discovery candidates must be a JSON array.'
      using errcode = '22023';
  end if;

  candidate_count := jsonb_array_length(target_candidates);
  if candidate_count > 500 then
    raise exception 'A discovery run cannot contain more than 500 candidates.'
      using errcode = '22023';
  end if;
  if candidate_count + target_duplicate_count + target_invalid_count > 500 then
    raise exception 'Discovery candidate counts exceed the provider response limit.'
      using errcode = '22023';
  end if;

  insert into public.market_discovery_runs (
    workspace_id,
    actor_id,
    provider_id,
    endpoint_id,
    query_hash,
    coverage,
    candidate_count,
    duplicate_candidate_count,
    invalid_candidate_count
  )
  values (
    target_workspace_id,
    authenticated_actor,
    'dexscreener',
    'latest_dex_search',
    target_query_hash,
    'partial',
    candidate_count,
    target_duplicate_count,
    target_invalid_count
  )
  returning id into discovery_id;

  for candidate in
    select *
    from jsonb_to_recordset(target_candidates) as item(
      instrument_ref text,
      chain_id text,
      mint text,
      pool_address text,
      source text,
      source_lineage text,
      source_event_id text,
      event_time timestamptz,
      observed_at timestamptz,
      sequence bigint,
      schema_version text,
      quality_status text,
      quality_reasons text[],
      payload_hash text,
      payload jsonb
    )
  loop
    if candidate.instrument_ref is null or length(btrim(candidate.instrument_ref)) = 0
      or candidate.chain_id is null or length(btrim(candidate.chain_id)) = 0
      or candidate.mint is null or length(btrim(candidate.mint)) = 0
      or candidate.pool_address is null or length(btrim(candidate.pool_address)) = 0
      or candidate.chain_id like '%:%'
      or candidate.mint like '%:%'
      or candidate.pool_address like '%:%'
      or candidate.instrument_ref is distinct from (
        'dex:' || candidate.chain_id || ':' || candidate.mint || ':' || candidate.pool_address
      )
      or candidate.source is distinct from 'dexscreener'
      or candidate.source_lineage is distinct from 'dexscreener'
      or candidate.source_event_id is not null
      or candidate.event_time is not null
      or candidate.observed_at is null
      or candidate.sequence is not null
      or candidate.schema_version is distinct from 'dexscreener-search-v1'
      or candidate.quality_status is distinct from 'needs_data'
      or candidate.payload is null or jsonb_typeof(candidate.payload) <> 'object'
      or candidate.payload_hash is null or candidate.payload_hash !~ '^[0-9a-f]{64}$'
    then
      raise exception 'Discovery candidate failed required-field validation.'
        using errcode = '22023';
    end if;

    insert into public.market_discovery_candidates (
      discovery_id,
      workspace_id,
      instrument_ref,
      chain_id,
      mint,
      pool_address,
      source,
      source_lineage,
      source_event_id,
      event_time,
      observed_at,
      sequence,
      schema_version,
      quality_status,
      quality_reasons,
      payload_hash,
      payload
    )
    values (
      discovery_id,
      target_workspace_id,
      candidate.instrument_ref,
      candidate.chain_id,
      candidate.mint,
      candidate.pool_address,
      candidate.source,
      candidate.source_lineage,
      candidate.source_event_id,
      candidate.event_time,
      candidate.observed_at,
      candidate.sequence,
      candidate.schema_version,
      candidate.quality_status::public.market_quality_status,
      coalesce(candidate.quality_reasons, '{}'),
      candidate.payload_hash,
      candidate.payload
    );
  end loop;

  return discovery_id;
end;
$$;

revoke all on function public.record_market_discovery(uuid, text, integer, integer, jsonb) from public, anon;
grant execute on function public.record_market_discovery(uuid, text, integer, integer, jsonb) to authenticated;
