create type public.workspace_kind as enum ('personal', 'team');
create type public.workspace_role as enum (
  'owner',
  'researcher',
  'operator',
  'risk_approver',
  'auditor',
  'platform_admin'
);

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 2 and 120),
  kind public.workspace_kind not null default 'personal',
  created_at timestamptz not null default now()
);

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null check (length(btrim(display_name)) between 2 and 80),
  timezone text not null default 'UTC' check (length(timezone) between 1 and 64),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.memberships (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  profile_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (workspace_id, profile_id)
);

create table public.membership_roles (
  workspace_id uuid not null,
  profile_id uuid not null,
  role public.workspace_role not null,
  created_at timestamptz not null default now(),
  primary key (workspace_id, profile_id, role),
  foreign key (workspace_id, profile_id)
    references public.memberships (workspace_id, profile_id)
    on delete cascade
);

create table public.execution_accounts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete restrict,
  name text not null check (length(btrim(name)) between 2 and 80),
  created_at timestamptz not null default now(),
  unique (workspace_id, id)
);

comment on table public.execution_accounts is
  'Workspace-scoped account identity only. Venue credentials and trading state are stored separately.';

create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces (id),
  actor_id uuid,
  action text not null,
  entity_table text not null,
  entity_id uuid,
  before_state jsonb,
  after_state jsonb,
  reason text not null,
  occurred_at timestamptz not null default now(),
  correlation_id uuid
);

create index audit_events_workspace_time_idx
  on public.audit_events (workspace_id, occurred_at desc);
create index audit_events_actor_time_idx
  on public.audit_events (actor_id, occurred_at desc)
  where actor_id is not null;
create index membership_roles_profile_workspace_idx
  on public.membership_roles (profile_id, workspace_id);
create index execution_accounts_workspace_idx
  on public.execution_accounts (workspace_id, created_at);

create function public.reject_audit_event_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'audit_events is append-only'
    using errcode = '55000';
end;
$$;

create trigger audit_events_no_row_mutation
  before update or delete on public.audit_events
  for each row execute function public.reject_audit_event_mutation();
create trigger audit_events_no_truncate
  before truncate on public.audit_events
  for each statement execute function public.reject_audit_event_mutation();

create function public.is_workspace_member(target_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.memberships membership
    where membership.workspace_id = target_workspace_id
      and membership.profile_id = (select auth.uid())
  );
$$;

create function public.has_workspace_role(
  target_workspace_id uuid,
  allowed_roles public.workspace_role[]
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.membership_roles membership_role
    where membership_role.workspace_id = target_workspace_id
      and membership_role.profile_id = (select auth.uid())
      and membership_role.role = any (allowed_roles)
  );
$$;

revoke all on function public.is_workspace_member(uuid) from public;
revoke all on function public.has_workspace_role(uuid, public.workspace_role[]) from public;
grant execute on function public.is_workspace_member(uuid) to authenticated;
grant execute on function public.has_workspace_role(uuid, public.workspace_role[]) to authenticated;

create function public.audit_identity_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  old_row jsonb;
  new_row jsonb;
  row_data jsonb;
  workspace_value text;
  entity_value text;
  actor_value uuid;
begin
  if tg_op <> 'INSERT' then
    old_row := to_jsonb(old);
  end if;
  if tg_op <> 'DELETE' then
    new_row := to_jsonb(new);
  end if;

  row_data := coalesce(new_row, old_row);
  workspace_value := coalesce(
    row_data ->> 'workspace_id',
    case when tg_table_name = 'workspaces' then row_data ->> 'id' end
  );
  entity_value := coalesce(
    row_data ->> 'id',
    row_data ->> 'profile_id',
    row_data ->> 'workspace_id'
  );
  actor_value := coalesce(
    auth.uid(),
    nullif(current_setting('app.audit_actor', true), '')::uuid
  );

  insert into public.audit_events (
    workspace_id,
    actor_id,
    action,
    entity_table,
    entity_id,
    before_state,
    after_state,
    reason,
    correlation_id
  )
  values (
    workspace_value::uuid,
    actor_value,
    lower(tg_op),
    tg_table_name,
    entity_value::uuid,
    old_row,
    new_row,
    coalesce(
      nullif(current_setting('app.audit_reason', true), ''),
      format('%s %s', tg_table_name, lower(tg_op))
    ),
    nullif(current_setting('app.correlation_id', true), '')::uuid
  );

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger audit_workspaces
  after insert or update or delete on public.workspaces
  for each row execute function public.audit_identity_change();
create trigger audit_profiles
  after insert or update or delete on public.profiles
  for each row execute function public.audit_identity_change();
create trigger audit_memberships
  after insert or update or delete on public.memberships
  for each row execute function public.audit_identity_change();
create trigger audit_membership_roles
  after insert or update or delete on public.membership_roles
  for each row execute function public.audit_identity_change();
create trigger audit_execution_accounts
  after insert or update or delete on public.execution_accounts
  for each row execute function public.audit_identity_change();

create function public.set_profile_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger profiles_updated_at
  before update on public.profiles
  for each row execute function public.set_profile_updated_at();

create function public.provision_identity_for_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_profile_id uuid;
  profile_name text;
  workspace_id uuid;
begin
  new_profile_id := new.id;
  perform set_config('app.audit_actor', new_profile_id::text, true);
  perform set_config('app.audit_reason', 'Initial workspace provisioning', true);
  profile_name := left(
    btrim(coalesce(
      new.raw_user_meta_data ->> 'display_name',
      nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
      'Owner'
    )),
    80
  );

  if length(profile_name) < 2 then
    profile_name := 'Owner';
  end if;

  insert into public.profiles (id, display_name)
  values (new_profile_id, profile_name);

  insert into public.workspaces (name, kind)
  values (left(profile_name || ' Workspace', 120), 'personal')
  returning id into workspace_id;

  insert into public.memberships (workspace_id, profile_id)
  values (workspace_id, new_profile_id);

  insert into public.membership_roles (workspace_id, profile_id, role)
  values (workspace_id, new_profile_id, 'owner');

  return new;
end;
$$;

revoke all on function public.provision_identity_for_auth_user() from public, anon, authenticated;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.provision_identity_for_auth_user();

alter table public.workspaces enable row level security;
alter table public.profiles enable row level security;
alter table public.memberships enable row level security;
alter table public.membership_roles enable row level security;
alter table public.execution_accounts enable row level security;
alter table public.audit_events enable row level security;

revoke all on public.workspaces from public, anon, authenticated;
revoke all on public.profiles from public, anon, authenticated;
revoke all on public.memberships from public, anon, authenticated;
revoke all on public.membership_roles from public, anon, authenticated;
revoke all on public.execution_accounts from public, anon, authenticated;
revoke all on public.audit_events from public, anon, authenticated;

grant select on public.workspaces to authenticated;
grant update (name) on public.workspaces to authenticated;
grant select on public.profiles to authenticated;
grant update (display_name, timezone) on public.profiles to authenticated;
grant select on public.memberships to authenticated;
grant select on public.membership_roles to authenticated;
grant select on public.execution_accounts to authenticated;
grant insert (workspace_id, name) on public.execution_accounts to authenticated;
grant update (name) on public.execution_accounts to authenticated;
grant select on public.audit_events to authenticated;

create policy "Members can read their workspaces"
  on public.workspaces for select to authenticated
  using ((select public.is_workspace_member(id)));
create policy "Owners can rename their workspaces"
  on public.workspaces for update to authenticated
  using ((select public.has_workspace_role(id, array['owner']::public.workspace_role[])))
  with check ((select public.has_workspace_role(id, array['owner']::public.workspace_role[])));

create policy "Users can read their own profile"
  on public.profiles for select to authenticated
  using (id = (select auth.uid()));
create policy "Users can update their own profile"
  on public.profiles for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

create policy "Members can read workspace memberships"
  on public.memberships for select to authenticated
  using (
    profile_id = (select auth.uid())
    or (select public.has_workspace_role(
      workspace_id,
      array['owner', 'auditor']::public.workspace_role[]
    ))
  );

create policy "Members can read visible workspace roles"
  on public.membership_roles for select to authenticated
  using (
    profile_id = (select auth.uid())
    or (select public.has_workspace_role(
      workspace_id,
      array['owner', 'auditor']::public.workspace_role[]
    ))
  );

create policy "Workspace members can read account identities"
  on public.execution_accounts for select to authenticated
  using ((select public.is_workspace_member(workspace_id)));
create policy "Owners can create account identities"
  on public.execution_accounts for insert to authenticated
  with check ((select public.has_workspace_role(workspace_id, array['owner']::public.workspace_role[])));
create policy "Owners can update account identities"
  on public.execution_accounts for update to authenticated
  using ((select public.has_workspace_role(workspace_id, array['owner']::public.workspace_role[])))
  with check ((select public.has_workspace_role(workspace_id, array['owner']::public.workspace_role[])));

create policy "Owners and auditors can read workspace audit events"
  on public.audit_events for select to authenticated
  using (
    actor_id = (select auth.uid())
    or (
      workspace_id is not null
      and (select public.has_workspace_role(
        workspace_id,
        array['owner', 'auditor']::public.workspace_role[]
      ))
    )
  );

revoke update, delete, truncate on public.audit_events from anon, authenticated;
