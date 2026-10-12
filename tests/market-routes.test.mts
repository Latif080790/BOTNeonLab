import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { fetchCrawlAttempt, runWorkerOnce } from "../src/lib/market/crawler.ts";

const url = process.env.E03_TEST_SUPABASE_URL;
const publicKey = process.env.E03_TEST_PUBLIC_KEY;
const serviceKey = process.env.E03_TEST_SERVICE_KEY;
const appUrl = process.env.E03_TEST_APP_URL;
if (!url || !publicKey || !serviceKey || !appUrl || [url, appUrl].some((v) => !["localhost", "127.0.0.1"].includes(new URL(v).hostname))) {
  throw new Error("Route integration requires explicit local E03_TEST_* and E03_TEST_APP_URL.");
}
const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false }, db: { retry: false } });

test("authenticated HTTP enqueue/read, cross-origin rejection, worker and durable result", async () => {
  const email = `e03-route-${randomUUID()}@example.test`, password = `${randomUUID()}!A1`;
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  assert.equal(created.error, null);
  const jar = new Map<string, string>();
  const user = createServerClient(url!, publicKey!, {
    cookies: { getAll: () => [...jar].map(([name, value]) => ({ name, value })), setAll: (list) => { for (const c of list) jar.set(c.name, c.value); } },
  });
  assert.equal((await user.auth.signInWithPassword({ email, password })).error, null);
  const membership = await user.from("memberships").select("workspace_id").single();
  assert.equal(membership.error, null);
  const universe = await user.rpc("create_market_universe_revision", { target_name: `Route ${randomUUID()}`, target_provider_ids: ["dexscreener"], target_allowed_venues: [],
    target_allowed_chains: ["solana"], target_license_refs: ["TEST_ONLY:route-fixture"], target_max_candidates: 2, target_status: "active" });
  assert.equal(universe.error, null);
  const body = { workspaceId: membership.data!.workspace_id, universeId: universe.data[0].universe_id, universeRevision: 1, query: "TEST_ONLY_ROUTE", idempotencyKey: randomUUID() };
  const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  const headers = { "Content-Type": "application/json", Cookie: cookie, Origin: appUrl! };
  const invalid = await fetch(`${appUrl}/api/market/crawls`, { method: "POST", headers: { ...headers, Origin: "https://untrusted.invalid" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  assert.equal(invalid.status, 403);
  const response = await fetch(`${appUrl}/api/market/crawls`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  assert.equal(response.status, 202, await response.clone().text());
  const run = await response.json();
  const result = await runWorkerOnce({
    claim: async (workerId) => { const r = await admin.rpc("claim_market_crawl", { target_worker_id: workerId }); assert.equal(r.error, null); return r.data; },
    finish: async (id, token, output) => { const r = await admin.rpc("finish_market_crawl", { target_run_id: id, target_lease_token: token, target_result: output }); assert.equal(r.error, null); return r.data; },
  }, randomUUID(), (claim) => fetchCrawlAttempt(claim, { now: Date.now, fetch: async () => Response.json({ pairs: [] }) }));
  assert.equal(result.runId, run.runId);
  const status = await fetch(`${appUrl}${run.statusUrl}`, { headers: { Cookie: cookie }, signal: AbortSignal.timeout(30000) });
  assert.equal(status.status, 200, await status.clone().text());
  const data = await status.json();
  assert.equal(data.run.status, "succeeded"); assert.equal(data.run.coverage, "partial");
  assert.equal(data.tradingEligible, false); assert.equal(data.nextCursor, null);
  assert.equal(data.run.lease_token, undefined);
  const anonymous = await fetch(`${appUrl}${run.statusUrl}`, { redirect: "manual" });
  assert.ok([401, 307].includes(anonymous.status));
});
