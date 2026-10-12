import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseRouteHandlerClient } from "@/lib/supabase/server";

const cursorSchema = z.object({
  version: z.literal(1),
  workspaceId: z.string().uuid(),
  observedAt: z.string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/)
    .refine((value) => Number.isFinite(Date.parse(value))),
  id: z.string().uuid(),
}).strict();

type DiscoveryCursor = z.infer<typeof cursorSchema>;

function json(data: unknown, status = 200) {
  return NextResponse.json(data, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function decodeCursor(value: string): DiscoveryCursor | null {
  if (value.length > 1_024 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    return null;
  }

  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    if (Buffer.from(decoded, "utf8").toString("base64url") !== value) {
      return null;
    }
    const parsed = cursorSchema.safeParse(JSON.parse(decoded));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function encodeCursor(cursor: DiscoveryCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const cursorValues = searchParams.getAll("cursor");
  const limitValues = searchParams.getAll("limit");
  if (cursorValues.length > 1 || limitValues.length > 1) {
    return json({ error: "Each pagination parameter may be supplied only once." }, 400);
  }

  const limitInput = limitValues[0] ?? "50";
  if (!/^\d+$/.test(limitInput)) {
    return json({ error: "The page limit must be an integer from 1 to 100." }, 400);
  }
  const limit = Number(limitInput);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    return json({ error: "The page limit must be an integer from 1 to 100." }, 400);
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

  const cursorValue = cursorValues[0];
  const cursor = cursorValue === undefined ? null : decodeCursor(cursorValue);
  if (cursorValue !== undefined && (!cursor || cursor.workspaceId !== workspaceId)) {
    return json({ error: "The discovery cursor is invalid for this workspace." }, 400);
  }

  let query = supabase
    .from("market_discovery_candidates")
    .select(
      "id, discovery_id, instrument_ref, chain_id, mint, pool_address, source, source_lineage, observed_at, quality_status, quality_reasons, payload_hash, payload",
    )
    .eq("workspace_id", workspaceId);

  if (cursor) {
    query = query.or(
      `observed_at.lt.${cursor.observedAt},and(observed_at.eq.${cursor.observedAt},id.lt.${cursor.id})`,
    );
  }

  const { data: candidates, error: candidatesError } = await query
    .order("observed_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + 1);

  if (candidatesError) {
    return json({ error: "Persisted discovery results could not be loaded." }, 503);
  }

  const hasMore = candidates.length > limit;
  const observations = candidates.slice(0, limit);
  const lastObservation = observations.at(-1);
  const nextCursor = hasMore && lastObservation
    ? encodeCursor({
        version: 1,
        workspaceId,
        observedAt: lastObservation.observed_at,
        id: lastObservation.id,
      })
    : null;

  return json({
    observations,
    pagination: {
      limit,
      nextCursor,
      hasMore,
    },
  });
}
