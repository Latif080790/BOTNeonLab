import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { fetchCrawlAttempt } from "../src/lib/market/crawler.ts";

const url = process.env.E03_TEST_SUPABASE_URL;
const publicKey = process.env.E03_TEST_PUBLIC_KEY;
const serviceKey = process.env.E03_TEST_SERVICE_KEY;
// Fail instead of silently skipping or targeting production.
if (!url || !publicKey || !serviceKey || !["localhost", "127.0.0.1"].includes(new URL(url).hostname)) {
  throw new Error("This integration suite requires explicit local E03_TEST_* credentials.");
}
const options = { auth: { persistSession: false, autoRefreshToken: false }, db: { retry: false }, global: {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, { ...init, signal: AbortSignal.timeout(10_000) }),
} };
const admin = createClient(url, serviceKey, options);
const anon = createClient(url, publicKey, options);
async function user() {
  const email = `e03-${randomUUID()}@example.test`, password = `${randomUUID()}!aA1`;
  console.log("Creating local fixture user");
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  assert.equal(created.error, null);
  const db = createClient(url!, publicKey!, options);
  console.log("Signing in local fixture user");
  assert.equal((await db.auth.signInWithPassword({ email, password })).error, null);
  console.log("Reading fixture workspace");
  const membership = await db.from("memberships").select("workspace_id").single();
  assert.equal(membership.error, null);
  return { db, workspace: membership.data!.workspace_id };
}

test("local Auth/RLS, universe, durable crawl, commit replay, scope and outbox", async () => {
  const a = await user(), b = await user();
  const definition = { target_name: `E03 ${randomUUID()}`, target_provider_ids: ["dexscreener"], target_allowed_venues: ["raydium"], target_allowed_chains: ["solana"], target_license_refs: ["TEST_ONLY:local-fixture"], target_max_candidates: 2, target_status: "active" };
  const universe = await a.db.rpc("create_market_universe_revision", definition);
  assert.equal(universe.error, null);
  const input = { target_workspace_id: a.workspace, target_universe_id: universe.data[0].universe_id, target_revision: 1, target_query: "TEST_ONLY_SOL", target_idempotency_key: randomUUID() };
  assert.ok((await anon.rpc("enqueue_market_crawl", input)).error);
  assert.ok((await b.db.rpc("enqueue_market_crawl", input)).error);
  assert.ok((await a.db.rpc("claim_market_crawl", { target_worker_id: randomUUID() })).error);
  const enqueued = await a.db.rpc("enqueue_market_crawl", input);
  assert.equal(enqueued.error, null);
  assert.equal((await a.db.rpc("enqueue_market_crawl", input)).data, enqueued.data);
  assert.equal((await a.db.rpc("enqueue_market_crawl", { ...input, target_query: "changed" })).error?.code, "23505");
  assert.equal((await a.db.rpc("enqueue_market_crawl", { ...input, target_idempotency_key: randomUUID() })).error?.code, "23505");
  assert.equal((await b.db.from("market_crawl_runs").select("id").eq("id", enqueued.data)).data?.length, 0);
  const claimed = await admin.rpc("claim_market_crawl", { target_worker_id: randomUUID() });
  assert.equal(claimed.error, null); assert.equal(claimed.data.id, enqueued.data);
  const pair = { chainId: "solana", dexId: "raydium", pairAddress: "TEST_ONLY_POOL", baseToken: { address: "TEST_ONLY_MINT", name: "Fixture", symbol: "FIX" }, quoteToken: { symbol: "SOL" } };
  const result = await fetchCrawlAttempt(claimed.data, { now: Date.now, fetch: async () => Response.json({ pairs: [pair, pair, { ...pair, chainId: "outside" }] }) });
  const args = { target_run_id: claimed.data.id, target_lease_token: claimed.data.lease_token, target_result: result };
  assert.ok((await a.db.rpc("finish_market_crawl", args)).error);
  const finished = await admin.rpc("finish_market_crawl", args);
  assert.equal(finished.error, null); assert.equal(finished.data.status, "succeeded");
  assert.equal((await admin.rpc("finish_market_crawl", args)).data.replayed, true);
  assert.equal((await admin.rpc("finish_market_crawl", { ...args, target_result: { ok: false, code: "HTTP_REJECTED" } })).error?.code, "PT409");
  const events = await a.db.from("market_events").select("*").eq("crawl_run_id", enqueued.data);
  assert.equal(events.error, null); assert.equal(events.data!.length, 1);
  assert.equal(events.data![0].event_time, null); assert.equal(events.data![0].quality_status, "needs_data");
  assert.equal((await b.db.from("market_events").select("id").eq("crawl_run_id", enqueued.data)).data?.length, 0);
  const outbox = await a.db.from("market_crawl_outbox").select("*").eq("run_id", enqueued.data);
  assert.equal(outbox.data!.length, 1); assert.equal(outbox.data![0].payload.coverage, "PARTIAL");
  assert.equal(outbox.data![0].payload.tradingEligible, false);
  const provider = await a.db.from("provider_states").select("*").eq("workspace_id", a.workspace).single();
  assert.ok(provider.data!.last_success);
  const paused = await a.db.rpc("create_market_universe_revision", { ...definition, target_status: "paused" });
  assert.equal(paused.error, null);
  assert.equal((await a.db.rpc("enqueue_market_crawl", { ...input, target_revision: 2, target_idempotency_key: randomUUID() })).error?.code, "PT409");
});

test("concurrent workers share one remaining quota and do not double-claim a run", async () => {
  const a = await user();
  const universe = await a.db.rpc("create_market_universe_revision", {
    target_name: `Quota ${randomUUID()}`, target_provider_ids: ["dexscreener"], target_allowed_venues: [],
    target_allowed_chains: ["solana"], target_license_refs: ["TEST_ONLY:local-fixture"], target_max_candidates: 2, target_status: "active",
  });
  assert.equal(universe.error, null);
  const prior = await admin.from("provider_quota_endpoints").select("requests_per_minute")
    .eq("provider_id", "dexscreener").eq("endpoint_id", "latest_dex_search").single();
  assert.equal(prior.error, null);
  // Change only this isolated local database's quota, restored even if an assertion fails.
  const records = await admin.from("provider_quota_attempts").select("id", { count: "exact", head: true })
    .eq("provider_id", "dexscreener").eq("endpoint_id", "latest_dex_search").gt("reserved_at", new Date(Date.now() - 55000).toISOString());
  assert.equal(records.error, null);
  const runIds: string[] = [];
  try {
    const quota = await admin.from("provider_quota_endpoints").update({ requests_per_minute: (records.count ?? 0) + 1 })
      .eq("provider_id", "dexscreener").eq("endpoint_id", "latest_dex_search");
    assert.equal(quota.error, null);
    for (let n = 0; n < 8; n++) {
      const job: { data: string | null; error: unknown } = await a.db.rpc("enqueue_market_crawl", { target_workspace_id: a.workspace, target_universe_id: universe.data[0].universe_id,
        target_revision: 1, target_query: `TEST_ONLY_QUOTA_${n}`, target_idempotency_key: randomUUID() });
      assert.equal(job.error, null); assert.equal(typeof job.data, "string"); runIds.push(job.data!);
    }
    const claims = await Promise.all(Array.from({ length: 12 }, () => admin.rpc("claim_market_crawl", { target_worker_id: randomUUID() })));
    for (const c of claims) assert.equal(c.error, null);
    const admitted = claims.filter((c) => c.data?.lease_token);
    assert.equal(admitted.length, 1);
    const done = await admin.rpc("finish_market_crawl", { target_run_id: admitted[0].data.id, target_lease_token: admitted[0].data.lease_token,
      target_result: { ok: true, code: "DISCOVERY_PARTIAL", observations: [], backoff_ms: 0 } });
    assert.equal(done.error, null);
  } finally {
    assert.equal((await admin.from("provider_quota_endpoints").update({ requests_per_minute: prior.data!.requests_per_minute })
      .eq("provider_id", "dexscreener").eq("endpoint_id", "latest_dex_search")).error, null);
    // Await the original 30s deadlines; recovery is tested through the real worker claim RPC.
    // No direct mutation of control rows or production credentials is needed.
    if (runIds.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 31000));
      for (let n = 0; n < runIds.length; n++) {
        const recovered = await admin.rpc("claim_market_crawl", { target_worker_id: randomUUID() });
        assert.equal(recovered.error, null);
      }
      const remaining = await a.db.from("market_crawl_runs").select("status").in("id", runIds).in("status", ["queued", "running"]);
      assert.equal(remaining.data?.length, 0);
    }
  }
});
