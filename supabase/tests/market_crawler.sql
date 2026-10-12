-- Transactional integration checks. Fixtures, temporary quota changes and identities all roll back.
-- No provider I/O. Refuses to run alongside unfinished crawl jobs.
begin;
set local statement_timeout='15s';
lock table public.market_crawl_runs in exclusive mode nowait;
do $$ begin
  if exists(select 1 from public.market_crawl_runs where status in ('queued','running')) then
    raise exception 'Run this test on an idle database: active crawl jobs exist';
  end if;
end $$;
create function pg_temp.check_true(ok boolean, label text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'E03 assertion: %',label; end if; end $$;

do $$
declare
  actor uuid:=gen_random_uuid();
  workspace uuid;
  universe uuid;
  run uuid;
  first_claim jsonb;
  next_claim jsonb;
  result jsonb;
  i integer;
  success_payload jsonb:='{"ok":true,"code":"DISCOVERY_PARTIAL","observations":[],"backoff_ms":0}'::jsonb;
  observation jsonb;
begin
  insert into auth.users(id,email,raw_user_meta_data) values(actor,'e03-rollback-'||actor||'@example.test','{}');
  perform set_config('request.jwt.claim.sub',actor::text,true);
  select workspace_id into workspace from public.memberships where profile_id=actor;
  select universe_id into universe from public.create_market_universe_revision(
    'E03 SQL fixture',array['dexscreener'],array['raydium'],array['solana'],array['TEST_ONLY:rollback'],2,'active');
  perform set_config('e03.workspace',workspace::text,true);
  perform set_config('e03.actor',actor::text,true);
  delete from public.provider_quota_attempts where provider_id='dexscreener' and endpoint_id='latest_dex_search';
  update public.provider_states set backoff_until=null where provider_id='dexscreener' and endpoint_id='latest_dex_search';

  -- A late invalid item rolls back earlier inserts, checkpoint, provider state and outbox together.
  run:=public.enqueue_market_crawl(workspace,universe,1,'atomic-fixture',gen_random_uuid());
  first_claim:=public.claim_market_crawl(gen_random_uuid());
  observation:=jsonb_build_object('instrument_ref','dex:solana:TEST_ONLY_MINT:TEST_ONLY_POOL',
    'chain_id','solana','mint','TEST_ONLY_MINT','pool_address','TEST_ONLY_POOL','source','dexscreener',
    'source_lineage','dexscreener','quality_status','needs_data','observed_at',clock_timestamp(),
    'payload',jsonb_build_object('dexId','raydium'),'payload_hash',repeat('a',64));
  begin
    perform public.finish_market_crawl(run,(first_claim->>'lease_token')::uuid,
      jsonb_build_object('ok',true,'code','DISCOVERY_PARTIAL','observations',jsonb_build_array(observation,'{}'::jsonb)));
    raise exception 'Malformed second item was accepted';
  exception when sqlstate '22023' then null; end;
  perform pg_temp.check_true((select count(*)=0 from public.market_events where crawl_run_id=run),'failed finish rolls back earlier insert');
  perform pg_temp.check_true((select count(*)=0 from public.market_crawl_outbox where run_id=run),'failed finish does not publish');
  perform pg_temp.check_true((select status='running' from public.market_crawl_runs where id=run),'failed finish preserves recoverable claim');
  perform public.finish_market_crawl(run,(first_claim->>'lease_token')::uuid,success_payload);

  -- Attempts 1 and 2 fail with identical payloads. Attempt 3 succeeds, never NO_TRADE.
  run:=public.enqueue_market_crawl(workspace,universe,1,'retry-fixture',gen_random_uuid());
  for i in 1..3 loop
    first_claim:=public.claim_market_crawl(gen_random_uuid());
    perform pg_temp.check_true((first_claim->>'attempts')::integer=i,'retry count survives repeated identical result');
    result:=public.finish_market_crawl(run,(first_claim->>'lease_token')::uuid,
      case when i=3 then success_payload else '{"ok":false,"code":"HTTP_5XX","backoff_ms":0}'::jsonb end);
    perform pg_temp.check_true(result->>'status'=case when i=3 then 'succeeded' else 'queued' end,'third attempt accepted');
  end loop;
  perform pg_temp.check_true((select count(*)=1 from public.market_crawl_outbox where run_id=run),'one terminal outbox');
  perform pg_temp.check_true((select attempts=3 and coverage='partial' from public.market_crawl_runs where id=run),'empty search is still partial');

  -- Lost response/crashed process: charge old attempt, fence it and reclaim without resetting budget.
  run:=public.enqueue_market_crawl(workspace,universe,1,'crash-fixture',gen_random_uuid());
  first_claim:=public.claim_market_crawl(gen_random_uuid());
  update public.market_crawl_runs set lease_until=clock_timestamp()-interval '1 second' where id=run;
  next_claim:=public.claim_market_crawl(gen_random_uuid());
  perform pg_temp.check_true((next_claim->>'attempts')::integer=2,'reclaim retains attempts');
  begin
    perform public.finish_market_crawl(run,(first_claim->>'lease_token')::uuid,success_payload);
    raise exception 'Old worker was accepted';
  exception when sqlstate 'PT409' then null; end;
  perform public.finish_market_crawl(run,(next_claim->>'lease_token')::uuid,success_payload);
  perform pg_temp.check_true((select outcome='lease_expired' from public.market_crawl_attempts where run_id=run and attempt=1),'crash recorded');

  -- No retry for invalid schema; last successful fetch is retained.
  run:=public.enqueue_market_crawl(workspace,universe,1,'schema-fixture',gen_random_uuid());
  first_claim:=public.claim_market_crawl(gen_random_uuid());
  result:=public.finish_market_crawl(run,(first_claim->>'lease_token')::uuid,'{"ok":false,"code":"SCHEMA_INVALID","backoff_ms":0}');
  perform pg_temp.check_true(result->>'status'='failed','schema failure is terminal');
  perform pg_temp.check_true((select last_success is not null and last_error_code='schema_invalid' from public.provider_states where workspace_id=workspace and provider_id='dexscreener' and endpoint_id='latest_dex_search'),'provider history retained');

  -- Same global quota ledger for web and worker; denied admission does not charge a provider attempt.
  delete from public.provider_quota_attempts where provider_id='dexscreener' and endpoint_id='latest_dex_search';
  update public.provider_quota_endpoints set requests_per_minute=1 where provider_id='dexscreener' and endpoint_id='latest_dex_search';
  perform pg_temp.check_true((select allowed from public.reserve_market_provider_quota(workspace,'dexscreener','latest_dex_search')),'web acquires last quota');
  perform pg_temp.check_true((select quota_limit_per_minute=1 and quota_remaining=0 from public.provider_states where workspace_id=workspace and provider_id='dexscreener' and endpoint_id='latest_dex_search'),'quota snapshot persisted');
  run:=public.enqueue_market_crawl(workspace,universe,1,'quota-fixture',gen_random_uuid());
  first_claim:=public.claim_market_crawl(gen_random_uuid());
  perform pg_temp.check_true((first_claim->>'skipped')::boolean,'worker respects web quota');
  perform pg_temp.check_true((select attempts=0 from public.market_crawl_runs where id=run),'no attempt charged without admission');
  update public.market_crawl_runs set deadline_at=clock_timestamp()-interval '1 second',available_at=clock_timestamp()-interval '1 second' where id=run;
  perform public.claim_market_crawl(gen_random_uuid());
  perform pg_temp.check_true((select status='failed' and reason_codes=array['DEADLINE_EXCEEDED'] from public.market_crawl_runs where id=run),'waiting job expires without fake success');
  update public.provider_quota_endpoints set requests_per_minute=300 where provider_id='dexscreener' and endpoint_id='latest_dex_search';
  delete from public.provider_quota_attempts where provider_id='dexscreener' and endpoint_id='latest_dex_search';

  -- Retry-After is shared across workspaces/callers, and cannot extend the run deadline.
  run:=public.enqueue_market_crawl(workspace,universe,1,'backoff-fixture',gen_random_uuid());
  first_claim:=public.claim_market_crawl(gen_random_uuid());
  result:=public.finish_market_crawl(run,(first_claim->>'lease_token')::uuid,'{"ok":false,"code":"HTTP_429","backoff_ms":60000}');
  perform pg_temp.check_true(result->>'status'='failed','backoff outside deadline ends run');
  perform pg_temp.check_true(not (select allowed from public.reserve_market_provider_quota(workspace,'dexscreener','latest_dex_search')),'web honors worker backoff');
  update public.provider_states set backoff_until=null where provider_id='dexscreener' and endpoint_id='latest_dex_search';

  -- Universe changes invalidate jobs which have not fetched yet.
  run:=public.enqueue_market_crawl(workspace,universe,1,'revision-fixture',gen_random_uuid());
  perform public.create_market_universe_revision('E03 SQL fixture',array['dexscreener'],array['raydium'],array['solana'],array['TEST_ONLY:rollback'],2,'paused');
  perform public.claim_market_crawl(gen_random_uuid());
  perform pg_temp.check_true((select status='failed' and attempts=0 and reason_codes=array['UNIVERSE_CHANGED'] from public.market_crawl_runs where id=run),'revision change blocks fetch');
  perform public.create_market_universe_revision('E03 SQL fixture',array['dexscreener'],array['raydium'],array['solana'],array['TEST_ONLY:rollback'],2,'active');
  run:=public.enqueue_market_crawl(workspace,universe,3,'revoked-fixture',gen_random_uuid());
  delete from public.membership_roles where workspace_id=workspace and profile_id=actor;
  perform public.claim_market_crawl(gen_random_uuid());
  perform pg_temp.check_true((select status='failed' and attempts=0 and reason_codes=array['AUTH_REVOKED'] from public.market_crawl_runs where id=run),'role revoked blocks new fetch');
  begin
    perform public.enqueue_market_crawl(workspace,universe,3,'unauthorized-fixture',gen_random_uuid());
    raise exception 'Member without role enqueued work';
  exception when insufficient_privilege then null; end;
  perform pg_temp.check_true(not has_function_privilege('authenticated','public.claim_market_crawl(uuid)','EXECUTE'),'browser cannot claim');
  perform pg_temp.check_true(not has_function_privilege('authenticated','public.finish_market_crawl(uuid,uuid,jsonb)','EXECUTE'),'browser cannot write provider facts');
  perform pg_temp.check_true(not has_function_privilege('anon','public.enqueue_market_crawl(uuid,uuid,integer,text,uuid)','EXECUTE'),'anon cannot enqueue');
end $$;

-- Exercise actual database role and RLS, not just privileged SELECTs.
set local role authenticated;
do $$ begin
  perform pg_temp.check_true((select count(*)>0 from public.market_crawl_runs where workspace_id=current_setting('e03.workspace')::uuid),'owner reads own runs');
  perform set_config('request.jwt.claim.sub',gen_random_uuid()::text,true);
  perform pg_temp.check_true((select count(*)=0 from public.market_crawl_runs where workspace_id=current_setting('e03.workspace')::uuid),'outsider cannot read runs');
end $$;
reset role;
rollback;
select 'PASS: transactional retry, fencing, quota, failure, revision, outbox and RLS checks; fixtures rolled back' as result;
