import { createHash } from "node:crypto";
import { z } from "zod";
import { parseDexSearchResponse, DexProviderSchemaError } from "./dexscreener.ts";

export const crawlInputSchema = z.object({
  workspaceId: z.string().uuid(),
  universeId: z.string().uuid(),
  universeRevision: z.number().int().positive(),
  query: z.string().trim().min(2).max(100).regex(/^[^\u0000-\u001f\u007f]+$/),
  idempotencyKey: z.string().uuid(),
}).strict();

export const crawlClaimSchema = z.object({
  id: z.string().uuid(),
  lease_token: z.string().uuid(),
  attempts: z.number().int().min(1).max(3),
  query: z.string().min(2).max(100),
  deadline_at: z.string().datetime({ offset: true }),
  lease_until: z.string().datetime({ offset: true }),
});
export type CrawlClaim = z.infer<typeof crawlClaimSchema>;

export function retryDelayMs(runId: string, attempt: number, retryAfter: string | null, now: number): number {
  const jitter = createHash("sha256").update(`${runId}:${attempt}`).digest().readUInt32BE(0) % 251;
  let providerDelay = 0;
  if (retryAfter) {
    const seconds = Number(retryAfter);
    providerDelay = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : Date.parse(retryAfter) - now;
    if (!Number.isFinite(providerDelay)) providerDelay = 0;
  }
  // Clamp to one day: any larger delay already exceeds this run's 30-second deadline.
  return Math.min(86_400_000, Math.ceil(Math.max((attempt === 1 ? 500 : 1000) + jitter, providerDelay)));
}

export async function fetchCrawlAttempt(
  claim: CrawlClaim,
  deps: { fetch: typeof fetch; now: () => number } = { fetch, now: Date.now },
) {
  const remaining = Math.min(Date.parse(claim.deadline_at), Date.parse(claim.lease_until)) - deps.now();
  const failure = (code: string, retryAfter: string | null = null) => ({
    ok: false, code,
    backoff_ms: retryDelayMs(claim.id, claim.attempts, retryAfter, deps.now()),
  });
  if (remaining <= 0) return failure("DEADLINE_EXCEEDED");
  const url = new URL("https://api.dexscreener.com/latest/dex/search");
  url.searchParams.set("q", claim.query);
  try {
    const response = await deps.fetch(url, {
      headers: { Accept: "application/json" }, cache: "no-store", redirect: "error",
      signal: AbortSignal.timeout(Math.min(5000, remaining)),
    });
    if (!response.ok) return failure(
      response.status === 429 ? "HTTP_429" : response.status >= 500 ? "HTTP_5XX" : "HTTP_REJECTED",
      response.headers.get("Retry-After"),
    );
    // Stream a bounded body; the same abort signal covers headers and body.
    const reader = response.body?.getReader();
    if (!reader) return failure("SCHEMA_INVALID");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 2_000_000) { await reader.cancel(); return failure("BODY_TOO_LARGE"); }
      chunks.push(part.value);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const parsed = parseDexSearchResponse(body, new Date(deps.now()).toISOString());
    return {
      ok: true, code: "DISCOVERY_PARTIAL", backoff_ms: 0,
      duplicate_count: parsed.duplicatePairCount, invalid_count: parsed.invalidPairCount,
      observations: parsed.observations.map((observation) => {
        const payload = {
          name: observation.name, symbol: observation.symbol, quoteSymbol: observation.quoteSymbol,
          dexId: observation.dexId, priceUsd: observation.priceUsd,
          liquidityUsd: observation.liquidityUsd, pairCreatedAt: observation.pairCreatedAt,
        };
        return {
          instrument_ref: observation.instrument.canonicalId, chain_id: observation.instrument.chainId,
          mint: observation.instrument.mint, pool_address: observation.instrument.poolAddress,
          source: observation.source, source_lineage: observation.sourceLineage,
          source_event_id: null, event_time: null, sequence: null,
          observed_at: observation.receivedAt, quality_status: observation.qualityStatus,
          payload_hash: createHash("sha256").update(JSON.stringify(payload)).digest("hex"), payload,
        };
      }),
    };
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof DexProviderSchemaError) return failure("SCHEMA_INVALID");
    if (error instanceof DOMException && ["TimeoutError", "AbortError"].includes(error.name)) return failure("PROVIDER_TIMEOUT");
    if (error instanceof TypeError) return failure("NETWORK_ERROR");
    throw error;
  }
}

export type WorkerStore = {
  claim(workerId: string): Promise<unknown>;
  finish(runId: string, leaseToken: string, result: unknown): Promise<unknown>;
};

// Database admission owns retry budget, quota and lease; this process performs one GET only.
export async function runWorkerOnce(store: WorkerStore, workerId: string, perform = fetchCrawlAttempt) {
  const raw = await store.claim(workerId);
  if (raw === null) return { status: "idle" };
  if (typeof raw === "object" && raw !== null && "skipped" in raw && raw.skipped === true) return { status: "deferred" };
  const claim = crawlClaimSchema.parse(raw);
  const result = await perform(claim);
  // An ambiguous finish is never followed by another fetch here. Lease recovery resolves it.
  const outcome = await store.finish(claim.id, claim.lease_token, result);
  return { status: "processed", runId: claim.id, outcome };
}
