create table public.market_universes (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete restrict,
  name text not null check (length(btrim(name)) between 2 and 120),
  normalized_name text generated always as (lower(btrim(name))) stored,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  unique (workspace_id, normalized_name),
  unique (workspace_id, id)
);

create table public.market_universe_revisions (
  universe_id uuid not null,
  workspace_id uuid not null,
  revision integer not null check (revision > 0),
  provider_ids text[] not null check (cardinality(provider_ids) > 0),
  allowed_venues text[] not null default '{}',
  allowed_chains text[] not null default '{}',
  license_refs text[] not null check (cardinality(license_refs) > 0),
  max_candidates integer not null check (max_candidates between 1 and 500),
  status text not null check (status in ('active', 'paused')),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  primary key (universe_id, revision),
  foreign key (workspace_id, universe_id)
    references public.market_universes (workspace_id, id)
    on delete restrict,
  check (cardinality(allowed_venues) > 0 or cardinality(allowed_chains) > 0)
);

create index market_universes_workspace_created_idx
  on public.market_universes (workspace_id, created_at desc);
create index market_universe_revisions_workspace_created_idx
  on public.market_universe_revisions (workspace_id, created_at desc);

alter table public.market_universes enable row level security;
alter table public.market_universe_revisions enable row level security;

revoke all on public.market_universes from public, anon, authenticated;
revoke all on public.market_universe_revisions from public, anon, authenticated;
grant select on public.market_universes, public.market_universe_revisions to authenticated;

drop policy if exists "Workspace members can read market universes"
  on public.market_universes;
create policy "Workspace members can read market universes"
  on public.market_universes for select to authenticated
  using ((select public.is_workspace_member(workspace_id)));

drop policy if exists "Workspace members can read market universe revisions"
  on public.market_universe_revisions;
create policy "Workspace members can read market universe revisions"
  on public.market_universe_revisions for select to authenticated
  using ((select public.is_workspace_member(workspace_id)));

create or replace function public.reject_market_universe_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'market universes and revisions are append-only'
    using errcode = '55000';
end;
$$;

drop trigger if exists market_universes_no_row_mutation
  on public.market_universes;
drop trigger if exists market_universes_no_truncate
  on public.market_universes;
drop trigger if exists market_universe_revisions_no_row_mutation
  on public.market_universe_revisions;
drop trigger if exists market_universe_revisions_no_truncate
  on public.market_universe_revisions;

create trigger market_universes_no_row_mutation
  before update or delete on public.market_universes
  for each row execute function public.reject_market_universe_mutation();
create trigger market_universes_no_truncate
  before truncate on public.market_universes
  for each statement execute function public.reject_market_universe_mutation();
create trigger market_universe_revisions_no_row_mutation
  before update or delete on public.market_universe_revisions
  for each row execute function public.reject_market_universe_mutation();
create trigger market_universe_revisions_no_truncate
  before truncate on public.market_universe_revisions
  for each statement execute function public.reject_market_universe_mutation();

create or replace function public.create_market_universe_revision(
  target_name text,
  target_provider_ids text[],
  target_allowed_venues text[],
  target_allowed_chains text[],
  target_license_refs text[],
  target_max_candidates integer,
  target_status text
)
returns table (
  universe_id uuid,
  revision integer,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  authenticated_actor uuid;
  resolved_workspace_id uuid;
  normalized_universe_name text;
  resolved_universe_id uuid;
  next_revision integer;
  normalized_provider_ids text[];
  normalized_allowed_venues text[];
  normalized_allowed_chains text[];
  normalized_license_refs text[];
begin
  authenticated_actor := auth.uid();
  if authenticated_actor is null then
    raise exception 'Authentication is required to create a market universe.'
      using errcode = '42501';
  end if;

  select membership.workspace_id
    into resolved_workspace_id
    from public.memberships as membership
    where membership.profile_id = authenticated_actor
    order by membership.created_at
    limit 1;

  if resolved_workspace_id is null or not public.has_workspace_role(
    resolved_workspace_id,
    array['owner', 'researcher', 'operator']::public.workspace_role[]
  ) then
    raise exception 'The current user cannot create a market universe.'
      using errcode = '42501';
  end if;

  normalized_universe_name := btrim(target_name);
  if normalized_universe_name is null
    or length(normalized_universe_name) < 2
    or length(normalized_universe_name) > 120
  then
    raise exception 'Universe name must contain 2 to 120 characters.'
      using errcode = '22023';
  end if;
  if target_status is null or target_status not in ('active', 'paused') then
    raise exception 'Universe status must be active or paused.'
      using errcode = '22023';
  end if;
  if target_max_candidates is null or target_max_candidates not between 1 and 500 then
    raise exception 'Universe candidate limit must be between 1 and 500.'
      using errcode = '22023';
  end if;

  select coalesce(array_agg(btrim(value) order by ordinal), '{}')
    into normalized_provider_ids
    from unnest(target_provider_ids) with ordinality as provider(value, ordinal);
  select coalesce(array_agg(btrim(value) order by ordinal), '{}')
    into normalized_allowed_venues
    from unnest(target_allowed_venues) with ordinality as venue(value, ordinal);
  select coalesce(array_agg(btrim(value) order by ordinal), '{}')
    into normalized_allowed_chains
    from unnest(target_allowed_chains) with ordinality as chain(value, ordinal);
  select coalesce(array_agg(btrim(value) order by ordinal), '{}')
    into normalized_license_refs
    from unnest(target_license_refs) with ordinality as license(value, ordinal);

  if cardinality(normalized_provider_ids) = 0
    or cardinality(normalized_license_refs) = 0
    or (
      cardinality(normalized_allowed_venues) = 0
      and cardinality(normalized_allowed_chains) = 0
    )
    or cardinality(normalized_provider_ids) > 10
    or cardinality(normalized_allowed_venues) > 100
    or cardinality(normalized_allowed_chains) > 100
    or cardinality(normalized_license_refs) > 20
  then
    raise exception 'Universe lists exceed their bounds or omit a provider, license reference, venue, or chain.'
      using errcode = '22023';
  end if;

  if exists (
    select 1
    from unnest(
      normalized_provider_ids
      || normalized_allowed_venues
      || normalized_allowed_chains
      || normalized_license_refs
    ) as item(value)
    where item.value is null or length(item.value) = 0 or length(item.value) > 256
  ) then
    raise exception 'Universe list values must contain 1 to 256 non-whitespace characters.'
      using errcode = '22023';
  end if;

  if cardinality(normalized_provider_ids) <>
    (select count(distinct item.value)::integer from unnest(normalized_provider_ids) as item(value))
    or cardinality(normalized_allowed_venues) <>
    (select count(distinct item.value)::integer from unnest(normalized_allowed_venues) as item(value))
    or cardinality(normalized_allowed_chains) <>
    (select count(distinct item.value)::integer from unnest(normalized_allowed_chains) as item(value))
    or cardinality(normalized_license_refs) <>
    (select count(distinct item.value)::integer from unnest(normalized_license_refs) as item(value))
  then
    raise exception 'Universe list values must be unique.'
      using errcode = '22023';
  end if;

  if exists (
    select 1
    from unnest(normalized_provider_ids) as requested(provider_id)
    where not exists (
      select 1
      from public.provider_quota_endpoints as configured
      where configured.provider_id = requested.provider_id
    )
  ) then
    raise exception 'Universe references an unsupported provider.'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      resolved_workspace_id::text || ':' || lower(normalized_universe_name),
      0
    )
  );

  insert into public.market_universes (workspace_id, name, created_by)
  values (resolved_workspace_id, normalized_universe_name, authenticated_actor)
  on conflict (workspace_id, normalized_name) do nothing;

  select universe.id
    into resolved_universe_id
    from public.market_universes as universe
    where universe.workspace_id = resolved_workspace_id
      and universe.normalized_name = lower(normalized_universe_name)
    limit 1;

  if resolved_universe_id is null then
    raise exception 'A workspace could not be resolved for this user.'
      using errcode = '42501';
  end if;

  select coalesce(max(universe_revision.revision), 0) + 1
    into next_revision
    from public.market_universe_revisions as universe_revision
    where universe_revision.universe_id = resolved_universe_id;

  insert into public.market_universe_revisions (
    universe_id,
    workspace_id,
    revision,
    provider_ids,
    allowed_venues,
    allowed_chains,
    license_refs,
    max_candidates,
    status,
    created_by
  )
  values (
    resolved_universe_id,
    resolved_workspace_id,
    next_revision,
    normalized_provider_ids,
    normalized_allowed_venues,
    normalized_allowed_chains,
    normalized_license_refs,
    target_max_candidates,
    target_status,
    authenticated_actor
  )
  returning
    market_universe_revisions.universe_id,
    market_universe_revisions.revision,
    market_universe_revisions.created_at
  into universe_id, revision, created_at;

  return next;
end;
$$;

revoke all on function public.create_market_universe_revision(
  text, text[], text[], text[], text[], integer, text
) from public, anon;
grant execute on function public.create_market_universe_revision(
  text, text[], text[], text[], text[], integer, text
) to authenticated;

create or replace function public.list_market_universe_revisions(
  target_workspace_id uuid,
  target_after_name text,
  target_limit integer
)
returns table (
  universe_id uuid,
  name text,
  revision integer,
  provider_ids text[],
  allowed_venues text[],
  allowed_chains text[],
  license_refs text[],
  max_candidates integer,
  status text,
  created_at timestamptz
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if target_limit is null or target_limit not between 1 and 101 then
    raise exception 'Universe page limit must be between 1 and 101.'
      using errcode = '22023';
  end if;

  if not public.is_workspace_member(target_workspace_id) then
    raise exception 'The current user cannot read this workspace universe.'
      using errcode = '42501';
  end if;

  return query
    select
      universe.id,
      universe.name,
      universe_revision.revision,
      universe_revision.provider_ids,
      universe_revision.allowed_venues,
      universe_revision.allowed_chains,
      universe_revision.license_refs,
      universe_revision.max_candidates,
      universe_revision.status,
      universe_revision.created_at
    from public.market_universes as universe
    join public.market_universe_revisions as universe_revision
      on universe_revision.universe_id = universe.id
    where universe.workspace_id = target_workspace_id
      and (
        target_after_name is null
        or (universe.normalized_name, universe_revision.revision) >
          (target_after_name, 0)
      )
      and universe_revision.revision = (
        select max(latest.revision)
        from public.market_universe_revisions as latest
        where latest.universe_id = universe.id
      )
    order by universe.normalized_name
    limit target_limit;
end;
$$;

revoke all on function public.list_market_universe_revisions(uuid, text, integer)
  from public, anon;
grant execute on function public.list_market_universe_revisions(uuid, text, integer)
  to authenticated;
