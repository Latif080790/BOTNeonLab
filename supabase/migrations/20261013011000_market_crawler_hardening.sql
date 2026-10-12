-- Domain conflicts must not use serialization SQLSTATE 40001 (PostgREST retries it).
alter table public.market_crawl_runs add column duplicate_count integer not null default 0;
alter table public.market_crawl_runs add column invalid_count integer not null default 0;

create or replace function public.enqueue_market_crawl(
  target_workspace_id uuid, target_universe_id uuid, target_revision integer,
  target_query text, target_idempotency_key uuid
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  u public.market_universe_revisions;
  old public.market_crawl_runs;
  run_id uuid;
  seed text := btrim(target_query);
begin
  if auth.uid() is null or not public.has_workspace_role(target_workspace_id,
    array['owner','researcher','operator']::public.workspace_role[]) then
    raise exception 'Crawl permission denied' using errcode='42501';
  end if;
  if target_idempotency_key is null or seed is null or length(seed) not between 2 and 100 or seed ~ '[[:cntrl:]]' then
    raise exception 'Invalid crawl input' using errcode='22023';
  end if;
  -- Share the universe revision lock with create_market_universe_revision.
  perform pg_advisory_xact_lock(hashtextextended(target_workspace_id::text || ':' ||
    (select normalized_name from public.market_universes where id=target_universe_id and workspace_id=target_workspace_id),0));
  perform pg_advisory_xact_lock(hashtextextended(target_workspace_id::text || ':' || target_idempotency_key::text,0));
  select * into old from public.market_crawl_runs
    where workspace_id=target_workspace_id and idempotency_key=target_idempotency_key;
  if found then
    if old.universe_id is distinct from target_universe_id or old.universe_revision is distinct from target_revision or old.query is distinct from seed then
      raise exception 'Idempotency input conflict' using errcode='23505';
    end if;
    return old.id;
  end if;
  select * into u from public.market_universe_revisions
    where workspace_id=target_workspace_id and universe_id=target_universe_id order by revision desc limit 1;
  if not found then raise exception 'Universe inaccessible' using errcode='42501'; end if;
  if u.status <> 'active' or u.revision is distinct from target_revision then
    raise exception 'Universe paused or revision changed' using errcode='PT409';
  end if;
  -- This adapter only implements DEX Screener search. Never silently omit other providers.
  if u.provider_ids <> array['dexscreener']::text[] then
    raise exception 'Unsupported acquisition plan' using errcode='22023';
  end if;
  insert into public.market_crawl_runs(workspace_id,universe_id,universe_revision,actor_id,idempotency_key,query)
    values(target_workspace_id,target_universe_id,target_revision,auth.uid(),target_idempotency_key,seed)
    returning id into run_id;
  return run_id;
end;
$$;

create or replace function public.claim_market_crawl(target_worker_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  r public.market_crawl_runs;
  u public.market_universe_revisions;
  latest_revision integer;
  limit_count integer;
  used_count integer;
  oldest timestamptz;
  ts timestamptz;
  token uuid;
  blocked_reason text;
  wait_until timestamptz;
begin
  if target_worker_id is null then raise exception 'Worker ID required' using errcode='22023'; end if;
  select * into r from public.market_crawl_runs
    where (status='queued' and available_at<=clock_timestamp())
       or (status='running' and lease_until<=clock_timestamp())
    order by created_at for update skip locked limit 1;
  if not found then return null; end if;
  select * into u from public.market_universe_revisions where universe_id=r.universe_id and revision=r.universe_revision;
  select max(revision) into latest_revision from public.market_universe_revisions where universe_id=r.universe_id;
  if r.status='running' then
    update public.market_crawl_attempts set completed_at=clock_timestamp(),outcome='lease_expired'
      where run_id=r.id and attempt=r.attempts and outcome='in_flight';
  end if;
  if r.deadline_at<=clock_timestamp() then blocked_reason:='DEADLINE_EXCEEDED';
  elsif r.attempts>=3 then blocked_reason:='ATTEMPTS_EXHAUSTED';
  elsif latest_revision<>r.universe_revision then blocked_reason:='UNIVERSE_CHANGED';
  elsif not exists(select 1 from public.membership_roles where workspace_id=r.workspace_id and profile_id=r.actor_id
    and role in ('owner','researcher','operator')) then
    blocked_reason:='AUTH_REVOKED';
  end if;
  if blocked_reason is not null then
    update public.market_crawl_runs set status='failed',coverage='failed',reason_codes=array[blocked_reason],completed_at=clock_timestamp(),lease_token=null,lease_until=null where id=r.id;
    insert into public.market_crawl_outbox(workspace_id,run_id,event_type,payload)
      values(r.workspace_id,r.id,'discovery.failed',jsonb_build_object('reason',blocked_reason,'tradingEligible',false));
    return jsonb_build_object('skipped',true,'run_id',r.id);
  end if;
  -- Same advisory lock and quota ledger as the authenticated search endpoint.
  perform pg_advisory_xact_lock(hashtextextended('dexscreener:latest_dex_search',0));
  ts:=clock_timestamp();
  select requests_per_minute into limit_count from public.provider_quota_endpoints
    where provider_id='dexscreener' and endpoint_id='latest_dex_search';
  if limit_count is null then raise exception 'Quota configuration missing'; end if;
  select max(backoff_until) into wait_until from public.provider_states
    where provider_id='dexscreener' and endpoint_id='latest_dex_search';
  delete from public.provider_quota_attempts where provider_id='dexscreener' and endpoint_id='latest_dex_search' and reserved_at<=ts-interval '60 seconds';
  select count(*),min(reserved_at) into used_count,oldest from public.provider_quota_attempts
    where provider_id='dexscreener' and endpoint_id='latest_dex_search' and reserved_at>ts-interval '60 seconds';
  if used_count>=limit_count or wait_until>ts then
    wait_until:=greatest(wait_until,case when used_count>=limit_count then oldest+interval '60 seconds' else ts end);
    update public.market_crawl_runs set status='queued',lease_token=null,lease_until=null,
      available_at=least(wait_until,r.deadline_at),reason_codes=array['QUOTA_BACKOFF'] where id=r.id;
    return jsonb_build_object('skipped',true,'run_id',r.id);
  end if;
  insert into public.provider_quota_attempts(provider_id,endpoint_id,workspace_id,actor_id,reserved_at)
    values('dexscreener','latest_dex_search',r.workspace_id,r.actor_id,ts);
  token:=gen_random_uuid();
  update public.market_crawl_runs set status='running',attempts=attempts+1,lease_token=token,
    lease_until=least(ts+interval '10 seconds',deadline_at) where id=r.id returning * into r;
  insert into public.market_crawl_attempts(run_id,workspace_id,attempt,worker_id,lease_token)
    values(r.id,r.workspace_id,r.attempts,target_worker_id,token);
  return to_jsonb(r)||jsonb_build_object('universe',to_jsonb(u),'quota_remaining',limit_count-used_count-1);
end;
$$;

create or replace function public.finish_market_crawl(
  target_run_id uuid, target_lease_token uuid, target_result jsonb
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  r public.market_crawl_runs;
  u public.market_universe_revisions;
  item jsonb;
  result_digest text;
  succeeded boolean;
  code text;
  retryable boolean;
  backoff_ms integer;
  accepted integer:=0;
  excluded integer:=0;
  ts timestamptz:=clock_timestamp();
  next_time timestamptz;
  terminal boolean;
begin
  if target_result is null or jsonb_typeof(target_result)<>'object' or
    (target_result->>'ok') is null then raise exception 'Invalid result' using errcode='22023'; end if;
  result_digest:=encode(sha256(convert_to(target_result::text,'UTF8')),'hex');
  select * into r from public.market_crawl_runs where id=target_run_id for update;
  if not found then raise exception 'Run missing' using errcode='22023'; end if;
  if r.status<>'running' and r.result_hash=result_digest and r.lease_token=target_lease_token then
    return jsonb_build_object('status',r.status,'replayed',true);
  end if;
  if r.status<>'running' or r.lease_token is distinct from target_lease_token or r.lease_until<=ts then
    raise exception 'Stale worker fence' using errcode='PT409';
  end if;
  select * into u from public.market_universe_revisions where universe_id=r.universe_id and revision=r.universe_revision;
  succeeded:=(target_result->>'ok')::boolean;
  code:=target_result->>'code';
  if code is null or code !~ '^[A-Z0-9_]{1,64}$' then raise exception 'Invalid reason' using errcode='22023'; end if;
  retryable:=not succeeded and code in ('HTTP_429','HTTP_5XX','NETWORK_ERROR','PROVIDER_TIMEOUT');
  backoff_ms:=coalesce((target_result->>'backoff_ms')::integer,0);
  if backoff_ms<0 or backoff_ms>86400000 then raise exception 'Invalid backoff' using errcode='22023'; end if;
  if succeeded then
    if jsonb_typeof(target_result->'observations') is distinct from 'array' or jsonb_array_length(target_result->'observations')>500 then
      raise exception 'Invalid observations' using errcode='22023';
    end if;
    for item in select value from jsonb_array_elements(target_result->'observations') loop
      if (item->>'source') is distinct from 'dexscreener' or (item->>'source_lineage') is distinct from 'dexscreener'
        or (item->>'quality_status') is distinct from 'needs_data'
        or item->>'event_time' is not null or item->>'sequence' is not null or item->>'source_event_id' is not null
        or jsonb_typeof(item->'payload') is distinct from 'object'
        or (item->>'instrument_ref') is distinct from ('dex:'||(item->>'chain_id')||':'||(item->>'mint')||':'||(item->>'pool_address'))
        or coalesce(item->>'payload_hash','') !~ '^[0-9a-f]{64}$' then
        raise exception 'Invalid discovery provenance' using errcode='22023';
      end if;
      if (cardinality(u.allowed_chains)>0 and not ((item->>'chain_id')=any(u.allowed_chains))) or
        (cardinality(u.allowed_venues)>0 and not ((item->'payload'->>'dexId')=any(u.allowed_venues))) or accepted>=u.max_candidates then
        excluded:=excluded+1; continue;
      end if;
      insert into public.market_events(workspace_id,instrument_ref,chain_id,mint,pool_address,source,source_lineage,
        source_event_id,event_time,received_at,sequence,schema_version,quality_status,quality_reasons,payload_hash,payload,crawl_run_id)
      values(r.workspace_id,item->>'instrument_ref',item->>'chain_id',item->>'mint',item->>'pool_address','dexscreener','dexscreener',
        null,null,(item->>'observed_at')::timestamptz,null,'dexscreener-search-v1','needs_data',
        array['event_time_missing','sequence_missing','insufficient_independent_sources'],item->>'payload_hash',item->'payload',r.id);
      accepted:=accepted+1;
    end loop;
  end if;
  next_time:=ts+make_interval(secs=>backoff_ms/1000.0);
  terminal:=succeeded or not retryable or r.attempts>=3 or next_time>=r.deadline_at;
  update public.market_crawl_attempts set completed_at=ts,outcome=code where run_id=r.id and attempt=r.attempts;
  update public.market_crawl_runs set
    status=case when succeeded then 'succeeded' when terminal then 'failed' else 'queued' end,
    coverage=case when succeeded then 'partial'::public.discovery_coverage when terminal then 'failed'::public.discovery_coverage else null end,
    reason_codes=case when succeeded then array['PROVIDER_ENUMERATION_UNSUPPORTED'] else array[code] end,
    candidate_count=accepted,excluded_count=excluded,
    duplicate_count=coalesce((target_result->>'duplicate_count')::integer,0),invalid_count=coalesce((target_result->>'invalid_count')::integer,0),
    available_at=next_time,completed_at=case when terminal then ts else null end,
    result_hash=result_digest where id=r.id;
  insert into public.provider_states(workspace_id,provider_id,endpoint_id,status,last_success,last_error_code,backoff_until,updated_at)
    values(r.workspace_id,'dexscreener','latest_dex_search',case when succeeded then 'healthy' when retryable then 'backoff' else 'degraded' end,
      case when succeeded then ts else null end,case when succeeded then null else lower(code) end,
      case when retryable then next_time else null end,ts)
    on conflict(workspace_id,provider_id,endpoint_id) do update set
      status=excluded.status,last_success=coalesce(excluded.last_success,public.provider_states.last_success),
      last_error_code=excluded.last_error_code,backoff_until=greatest(public.provider_states.backoff_until,excluded.backoff_until),updated_at=excluded.updated_at;
  if terminal then
    insert into public.market_crawl_outbox(workspace_id,run_id,event_type,payload)
      values(r.workspace_id,r.id,case when succeeded then 'discovery.completed' else 'discovery.failed' end,
        jsonb_build_object('discovery_id',r.id,'universe_revision',r.universe_revision,'coverage',case when succeeded then 'PARTIAL' else 'FAILED' end,
          'candidate_count',accepted,'excluded_count',excluded,'tradingEligible',false,'next_cursor',null,'contract_version',r.contract_version));
  end if;
  return jsonb_build_object('status',case when succeeded then 'succeeded' when terminal then 'failed' else 'queued' end,'replayed',false);
end;
$$;

-- Web and worker honor the same provider backoff, as well as the same quota ledger.
create or replace function public.reserve_market_provider_quota(
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
  shared_backoff timestamptz;
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
  select max(backoff_until) into shared_backoff from public.provider_states
    where provider_id=target_provider and endpoint_id=target_endpoint;
  if shared_backoff > reservation_time then
    return query select false, greatest(1,ceil(extract(epoch from(shared_backoff-reservation_time)))::integer),0;
    return;
  end if;

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
