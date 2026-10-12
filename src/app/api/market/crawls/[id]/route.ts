import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseRouteHandlerClient } from "@/lib/supabase/server";

const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!z.string().uuid().safeParse(id).success) return json({ error: "Invalid run ID." }, 400);
  const db = await createSupabaseRouteHandlerClient();
  const { data: auth, error: authError } = await db.auth.getUser();
  if (authError && (!authError.status || authError.status >= 500)) return json({ error: "Authentication unavailable." }, 503);
  if (!auth.user) return json({ error: "Authentication required." }, 401);
  const { data: run, error } = await db.from("market_crawl_runs").select("*").eq("id", id).maybeSingle();
  if (error) return json({ error: "Crawl unavailable." }, 503);
  if (!run) return json({ error: "Crawl not found." }, 404);
  const { data: observations, error: observationError } = await db.from("market_events")
    .select("id,instrument_ref,source,source_event_id,event_time,received_at,sequence,quality_status,quality_reasons,payload_hash,payload")
    .eq("crawl_run_id", id).order("instrument_ref").limit(500);
  if (observationError) return json({ error: "Observations unavailable." }, 503);
  // Never expose worker fencing tokens to browser clients.
  const { lease_token: _lease, result_hash: _hash, ...visibleRun } = run;
  void _lease; void _hash;
  return json({ run: visibleRun, observations, nextCursor: null, tradingEligible: false });
}
