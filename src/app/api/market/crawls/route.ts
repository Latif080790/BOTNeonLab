import { NextRequest, NextResponse } from "next/server";
import { createSupabaseRouteHandlerClient } from "@/lib/supabase/server";
import { getPublicSiteUrl } from "@/lib/supabase/config";
import { crawlInputSchema } from "@/lib/market/crawler";

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest) {
  // Cookie-authenticated mutation: reject cross-origin browser requests.
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(getPublicSiteUrl()).origin) {
    return json({ error: "Origin not allowed." }, 403);
  }
  const supabase = await createSupabaseRouteHandlerClient();
  const { data: auth, error: authError } = await supabase.auth.getUser();
  if (authError && (!authError.status || authError.status >= 500)) return json({ error: "Authentication unavailable." }, 503);
  if (!auth.user) return json({ error: "Authentication required." }, 401);
  let body: unknown;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON." }, 400); }
  const input = crawlInputSchema.safeParse(body);
  if (!input.success) return json({ error: "Invalid crawl input." }, 400);
  const { workspaceId, universeId, universeRevision, query, idempotencyKey } = input.data;
  const { data, error } = await supabase.rpc("enqueue_market_crawl", {
    target_workspace_id: workspaceId, target_universe_id: universeId,
    target_revision: universeRevision, target_query: query, target_idempotency_key: idempotencyKey,
  });
  if (error) {
    const status = error.code === "42501" ? 403 : ["PT409", "23505"].includes(error.code) ? 409 : error.code === "22023" ? 400 : 503;
    return json({ error: status === 409 ? "Input conflict, active crawl or universe revision changed." : "Crawl could not be accepted." }, status);
  }
  if (typeof data !== "string") return json({ error: "Crawl persistence was not confirmed." }, 503);
  return json({ runId: data, persistence: "durable", tradingEligible: false, statusUrl: `/api/market/crawls/${data}` }, 202);
}
