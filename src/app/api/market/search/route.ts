import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isWorkspaceRole } from "@/lib/auth/roles";
import { createSupabaseRouteHandlerClient } from "@/lib/supabase/server";
import {
  DexProviderSchemaError,
  parseDexSearchResponse,
} from "@/lib/market/dexscreener";

const quotaReservationSchema = z.array(z.object({
  allowed: z.boolean(),
  retry_after_seconds: z.number().int().nonnegative(),
  remaining_requests: z.number().int().nonnegative(),
})).length(1);

const SEARCH_URL = "https://api.dexscreener.com/latest/dex/search";
const MAX_ATTEMPTS = 3;
const REQUEST_DEADLINE_MS = 8_000;
const REQUEST_TIMEOUT_MS = 2_500;

function json(data: unknown, status = 200, headers?: HeadersInit) {
  return NextResponse.json(data, {
    status,
    headers: { "Cache-Control": "no-store", ...headers },
  });
}

function parseRetryAfter(value: string | null, now: number): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1_000);
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : null;
}

function isRetryableNetworkError(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    (error instanceof DOMException && error.name === "TimeoutError")
  );
}

async function reserveQuota(
  supabase: Awaited<ReturnType<typeof createSupabaseRouteHandlerClient>>,
  workspaceId: string,
) {
  const { data, error } = await supabase.rpc("reserve_market_provider_quota", {
    target_workspace_id: workspaceId,
    target_provider: "dexscreener",
    target_endpoint: "latest_dex_search",
  });

  if (error) {
    return { error: true as const };
  }

  const parsed = quotaReservationSchema.safeParse(data);
  if (!parsed.success) {
    return { error: true as const };
  }
  return { error: false as const, ...parsed.data[0] };
}

export async function GET(request: NextRequest) {
  const query = request.nextUrl.searchParams.get("q")?.trim() ?? "";
  if (query.length < 2 || query.length > 100 || /[\u0000-\u001f\u007f]/.test(query)) {
    return json({ error: "Search query must contain 2–100 printable characters." }, 400);
  }

  const supabase = await createSupabaseRouteHandlerClient();
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError && (userError.status === undefined || userError.status === 0 || userError.status >= 500)) {
    return json({ error: "Authentication service is temporarily unavailable." }, 503);
  }
  if (!userData.user) {
    return json({ error: "Authentication is required." }, 401);
  }

  const { data: memberships, error: membershipsError } = await supabase
    .from("memberships")
    .select("workspace_id, created_at")
    .eq("profile_id", userData.user.id)
    .order("created_at", { ascending: true })
    .limit(1);

  if (membershipsError) {
    return json({ error: "Workspace access could not be verified." }, 503);
  }
  const workspaceId = memberships[0]?.workspace_id;
  if (!workspaceId) {
    return json({ error: "No workspace is available for this account." }, 403);
  }

  const { data: roleRows, error: rolesError } = await supabase
    .from("membership_roles")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("profile_id", userData.user.id);

  if (rolesError) {
    return json({ error: "Workspace permissions could not be verified." }, 503);
  }
  const hasDiscoveryRole = roleRows.some(
    ({ role }) => isWorkspaceRole(role) && ["owner", "researcher", "operator"].includes(role),
  );
  if (!hasDiscoveryRole) {
    return json({ error: "A researcher, operator, or owner role is required." }, 403);
  }

  const deadline = Date.now() + REQUEST_DEADLINE_MS;
  let response: Response | null = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const reservation = await reserveQuota(supabase, workspaceId);
    if (reservation.error) {
      return json({ error: "The shared provider quota could not be reserved." }, 503);
    }
    if (!reservation.allowed) {
      const retryAfter = Math.max(1, reservation.retry_after_seconds);
      return json(
        { error: "DEX Screener search quota is temporarily exhausted." },
        429,
        { "Retry-After": String(retryAfter) },
      );
    }

    const remainingTime = deadline - Date.now();
    if (remainingTime <= 0) {
      return json({ error: "The provider request deadline expired." }, 504);
    }

    const url = new URL(SEARCH_URL);
    url.searchParams.set("q", query);

    try {
      response = await fetch(url, {
        headers: { Accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, remainingTime)),
      });
    } catch (error) {
      if (!isRetryableNetworkError(error)) {
        throw error;
      }
      if (attempt + 1 === MAX_ATTEMPTS || Date.now() >= deadline) {
        return json({ error: "DEX Screener could not be reached before the request deadline." }, 504);
      }

      const delayMs = (attempt === 0 ? 500 : 1_000) + Math.floor(Math.random() * 251);
      if (Date.now() + delayMs >= deadline) {
        return json({ error: "DEX Screener could not be reached before the request deadline." }, 504);
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      continue;
    }

    if (response.ok) break;
    const retryableStatus = response.status === 429 || response.status >= 500;
    if (!retryableStatus) {
      return json({ error: "DEX Screener rejected the search request." }, 502);
    }
    if (attempt + 1 === MAX_ATTEMPTS) {
      const retryAfterMs = parseRetryAfter(response.headers.get("Retry-After"), Date.now());
      const headers = retryAfterMs === null
        ? undefined
        : { "Retry-After": String(Math.max(1, Math.ceil(retryAfterMs / 1_000))) };
      return json({ error: "DEX Screener is temporarily rate-limited or unavailable." }, 503, headers);
    }

    const retryAfterMs = parseRetryAfter(response.headers.get("Retry-After"), Date.now());
    const backoffMs = (attempt === 0 ? 500 : 1_000) + Math.floor(Math.random() * 251);
    const delayMs = retryAfterMs === null ? backoffMs : Math.max(backoffMs, retryAfterMs);
    if (Date.now() + delayMs >= deadline) {
      const headers = retryAfterMs === null
        ? undefined
        : { "Retry-After": String(Math.max(1, Math.ceil(retryAfterMs / 1_000))) };
      return json({ error: "DEX Screener is temporarily unavailable." }, 503, headers);
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  if (!response?.ok) {
    return json({ error: "DEX Screener did not return a usable response." }, 502);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    if (error instanceof SyntaxError) {
      return json({ error: "DEX Screener returned invalid JSON." }, 502);
    }
    throw error;
  }

  let parsed;
  try {
    parsed = parseDexSearchResponse(body, new Date().toISOString());
  } catch (error) {
    if (error instanceof DexProviderSchemaError) {
      return json({ error: "DEX Screener returned data that failed schema or identity validation." }, 502);
    }
    throw error;
  }

  if (parsed.observations.length > 500) {
    return json({ error: "DEX Screener returned more candidates than a single discovery can store." }, 502);
  }

  const candidates = parsed.observations.map((observation) => {
    const payload = {
      name: observation.name,
      symbol: observation.symbol,
      quoteSymbol: observation.quoteSymbol,
      dexId: observation.dexId,
      priceUsd: observation.priceUsd,
      liquidityUsd: observation.liquidityUsd,
      pairCreatedAt: observation.pairCreatedAt,
    };
    const payloadHash = createHash("sha256")
      .update(JSON.stringify(payload))
      .digest("hex");

    return {
      instrument_ref: observation.instrument.canonicalId,
      chain_id: observation.instrument.chainId,
      mint: observation.instrument.mint,
      pool_address: observation.instrument.poolAddress,
      source: observation.source,
      source_lineage: observation.sourceLineage,
      source_event_id: observation.sourceEventId,
      event_time: observation.eventTime,
      observed_at: observation.receivedAt,
      sequence: observation.sequence,
      schema_version: observation.schemaVersion,
      quality_status: observation.qualityStatus,
      quality_reasons: observation.qualityReasons,
      payload_hash: payloadHash,
      payload,
    };
  });

  const queryHash = createHash("sha256").update(query).digest("hex");
  const { data: discoveryId, error: persistenceError } = await supabase.rpc(
    "record_market_discovery",
    {
      target_workspace_id: workspaceId,
      target_query_hash: queryHash,
      target_duplicate_count: parsed.duplicatePairCount,
      target_invalid_count: parsed.invalidPairCount,
      target_candidates: candidates,
    },
  );
  if (persistenceError || typeof discoveryId !== "string") {
    return json({ error: "Discovery results could not be stored safely." }, 503);
  }

  return json({
    provider: "dexscreener",
    endpoint: "latest_dex_search",
    coverage: "PARTIAL",
    tradingEligible: false,
    persistence: "durable",
    discoveryId,
    disclaimer: "Search observations are public discovery data, not executable or freshness-certified prices.",
    duplicatePairCount: parsed.duplicatePairCount,
    invalidPairCount: parsed.invalidPairCount,
    observations: parsed.observations,
  });
}
