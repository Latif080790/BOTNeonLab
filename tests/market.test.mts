import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fetchCrawlAttempt, retryDelayMs, runWorkerOnce, crawlInputSchema } from "../src/lib/market/crawler.ts";
import { parseDexSearchResponse } from "../src/lib/market/dexscreener.ts";
import { evaluateScanSnapshot } from "../src/lib/market/scan.ts";

const now = Date.parse("2026-10-12T12:00:00Z");
const pair = { chainId: "solana", dexId: "raydium", pairAddress: "Pool", baseToken: { address: "Mint", name: "Token", symbol: "SAME" }, quoteToken: { symbol: "SOL" } };
const claim = { id: randomUUID(), lease_token: randomUUID(), attempts: 1, query: "SOL/USDC", deadline_at: new Date(now + 30000).toISOString(), lease_until: new Date(now + 10000).toISOString() };
const policy = { version: "test-only-1", maxSnapshotAgeMs: 2000, minimumLiquidityUsd: 100, minimumVolume24hUsd: 100, maximumSpreadPct: 1, minimumInstrumentAgeMs: 60000, minimumPriceChange24hPct: -10, maximumPriceChange24hPct: 10 };
const snapshot = { eventTime: new Date(now - 100).toISOString(), receivedAt: new Date(now).toISOString(), sequence: 11, previousSequence: 10, independentSourceLineages: ["fixture-a", "fixture-b"], liquidityUsd: 100, volume24hUsd: 100, spreadPct: 1, instrumentCreatedAt: new Date(now - 60000).toISOString(), priceChange24hPct: 10 };
const scan = (changes = {}) => evaluateScanSnapshot({ snapshot: { ...snapshot, ...changes }, policy, now: new Date(now).toISOString() });

test("identity and case survive duplicate delivery; missing provider facts remain missing", () => {
  const result = parseDexSearchResponse({ pairs: [pair, pair, { ...pair, baseToken: { ...pair.baseToken, address: "mint" } }, { ...pair, chainId: "other" }] }, new Date(now).toISOString());
  assert.equal(result.observations.length, 3);
  assert.equal(result.duplicatePairCount, 1);
  for (const o of result.observations) { assert.equal(o.eventTime, null); assert.equal(o.sequence, null); assert.equal(o.sourceEventId, null); assert.equal(o.qualityStatus, "needs_data"); }
});
test("search schema failure is explicit", () => {
  assert.throws(() => parseDexSearchResponse({}, new Date(now).toISOString()));
  assert.throws(() => parseDexSearchResponse({ pairs: [{ ...pair, chainId: null }] }, new Date(now).toISOString()));
});
test("SCAN boundaries, replay and incomplete metrics", () => {
  assert.equal(scan().outcome, "PASS");
  assert.deepEqual(scan(), scan());
  assert.equal(scan({ liquidityUsd: 99.999 }).outcome, "EXCLUDE");
  assert.equal(scan({ liquidityUsd: null }).outcome, "NEEDS_DATA");
  assert.equal(scan({ eventTime: new Date(now - 2100).toISOString() }).eligibleUntil, null);
  assert.equal(scan({ eventTime: new Date(now - 2100).toISOString() }).outcome, "NEEDS_DATA");
  assert.equal(scan({ sequence: 12 }).outcome, "NEEDS_DATA");
  assert.equal(scan({ independentSourceLineages: ["same-upstream", "same-upstream"] }).outcome, "NEEDS_DATA");
});
test("crawl request requires an executable seed and rejects arbitrary endpoint injection", () => {
  const input = { workspaceId: randomUUID(), universeId: randomUUID(), universeRevision: 1, idempotencyKey: randomUUID(), query: "SOL" };
  assert.equal(crawlInputSchema.safeParse(input).success, true);
  assert.equal(crawlInputSchema.safeParse({ ...input, query: "" }).success, false);
  assert.equal(crawlInputSchema.safeParse({ ...input, url: "https://other.invalid" }).success, false);
});
test("retry is deterministic and respects Retry-After", () => {
  assert.equal(retryDelayMs(claim.id, 1, "2", now), 2000);
  assert.equal(retryDelayMs(claim.id, 1, null, now), retryDelayMs(claim.id, 1, null, now));
  assert.ok(retryDelayMs(claim.id, 1, null, now) <= 750);
});
test("one admitted attempt is one fetch with a pinned URL; empty remains partial", async () => {
  let calls = 0;
  const result = await fetchCrawlAttempt(claim, { now: () => now, fetch: async (url) => {
    calls++; assert.equal(new URL(String(url)).origin, "https://api.dexscreener.com");
    return Response.json({ pairs: [] });
  } });
  assert.equal(calls, 1); assert.equal(result.code, "DISCOVERY_PARTIAL");
});
test("429, 401, schema errors, timeout and network loss stay distinguishable", async () => {
  for (const [response, expected] of [[new Response("", { status: 429, headers: { "Retry-After": "10" } }), "HTTP_429"], [new Response("", { status: 401 }), "HTTP_REJECTED"], [new Response("not json"), "SCHEMA_INVALID"]] as const) {
    const result = await fetchCrawlAttempt(claim, { now: () => now, fetch: async () => response });
    assert.equal(result.code, expected);
  }
  for (const [error, expected] of [[new DOMException("timeout", "TimeoutError"), "PROVIDER_TIMEOUT"], [new TypeError("network"), "NETWORK_ERROR"]] as const) {
    const result = await fetchCrawlAttempt(claim, { now: () => now, fetch: async () => { throw error; } });
    assert.equal(result.code, expected);
  }
});
test("expired jobs never fetch; oversized bodies never persist observations", async () => {
  let calls = 0;
  const expired = await fetchCrawlAttempt(claim, { now: () => now + 40000, fetch: async () => { calls++; return Response.json({}); } });
  assert.equal(calls, 0); assert.equal(expired.code, "DEADLINE_EXCEEDED");
  const huge = await fetchCrawlAttempt(claim, { now: () => now, fetch: async () => new Response("x".repeat(2_000_001)) });
  assert.equal(huge.code, "BODY_TOO_LARGE");
});
test("claim failure and ambiguous commit do not trigger additional network requests", async () => {
  let calls = 0;
  const perform = async () => { calls++; return { ok: true, code: "DISCOVERY_PARTIAL", backoff_ms: 0, observations: [], duplicate_count: 0, invalid_count: 0 }; };
  await assert.rejects(runWorkerOnce({ claim: async () => { throw new Error("DB unavailable"); }, finish: async () => null }, randomUUID(), perform));
  assert.equal(calls, 0);
  await assert.rejects(runWorkerOnce({ claim: async () => claim, finish: async () => { throw new Error("COMMIT_UNKNOWN"); } }, randomUUID(), perform));
  assert.equal(calls, 1);
});
