import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isWorkspaceRole } from "@/lib/auth/roles";
import { createSupabaseRouteHandlerClient } from "@/lib/supabase/server";

const cursorSchema = z.object({
  version: z.literal(1),
  workspaceId: z.string().uuid(),
  afterName: z.string().min(2).max(120),
}).strict();

const createUniverseSchema = z.object({
  name: z.string().trim().min(2).max(120),
  providerIds: z.array(z.string().trim().min(1).max(256)).min(1).max(10),
  allowedVenues: z.array(z.string().trim().min(1).max(256)).max(100),
  allowedChains: z.array(z.string().trim().min(1).max(256)).max(100),
  licenseRefs: z.array(z.string().trim().min(1).max(256)).min(1).max(20),
  maxCandidates: z.number().int().min(1).max(500),
  status: z.enum(["active", "paused"]),
}).strict().refine(
  (universe) => universe.allowedVenues.length > 0 || universe.allowedChains.length > 0,
  { message: "At least one allowed venue or chain is required." },
);

const listedUniverseSchema = z.object({
  universe_id: z.string().uuid(),
  name: z.string().min(2).max(120),
  revision: z.number().int().positive(),
  provider_ids: z.array(z.string()),
  allowed_venues: z.array(z.string()),
  allowed_chains: z.array(z.string()),
  license_refs: z.array(z.string()),
  max_candidates: z.number().int().min(1).max(500),
  status: z.enum(["active", "paused"]),
  created_at: z.string(),
});

function json(data: unknown, status = 200) {
  return NextResponse.json(data, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function decodeCursor(value: string): z.infer<typeof cursorSchema> | null {
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

function encodeCursor(cursor: z.infer<typeof cursorSchema>): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

async function getWorkspaceContext() {
  const supabase = await createSupabaseRouteHandlerClient();
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError && (userError.status === undefined || userError.status === 0 || userError.status >= 500)) {
    return { response: json({ error: "Authentication service is temporarily unavailable." }, 503) };
  }
  if (!userData.user) {
    return { response: json({ error: "Authentication is required." }, 401) };
  }

  const { data: memberships, error: membershipsError } = await supabase
    .from("memberships")
    .select("workspace_id, created_at")
    .eq("profile_id", userData.user.id)
    .order("created_at", { ascending: true })
    .limit(1);

  if (membershipsError) {
    return { response: json({ error: "Workspace access could not be verified." }, 503) };
  }
  const workspaceId = memberships[0]?.workspace_id;
  if (!workspaceId) {
    return { response: json({ error: "No workspace is available for this account." }, 403) };
  }

  const { data: roleRows, error: rolesError } = await supabase
    .from("membership_roles")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("profile_id", userData.user.id);

  if (rolesError) {
    return { response: json({ error: "Workspace permissions could not be verified." }, 503) };
  }

  const roles = roleRows.map(({ role }) => {
    if (!isWorkspaceRole(role)) {
      throw new Error("The workspace contains an unsupported role.");
    }
    return role;
  });

  return { supabase, user: userData.user, workspaceId, roles };
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

  const context = await getWorkspaceContext();
  if ("response" in context) return context.response;

  const cursorValue = cursorValues[0];
  const cursor = cursorValue === undefined ? null : decodeCursor(cursorValue);
  if (cursorValue !== undefined && (!cursor || cursor.workspaceId !== context.workspaceId)) {
    return json({ error: "The universe cursor is invalid for this workspace." }, 400);
  }

  const { data, error } = await context.supabase.rpc("list_market_universe_revisions", {
    target_workspace_id: context.workspaceId,
    target_after_name: cursor?.afterName ?? null,
    target_limit: limit + 1,
  });
  if (error) {
    return json({ error: "Market universes could not be loaded." }, 503);
  }
  const parsedUniverses = z.array(listedUniverseSchema).safeParse(data);
  if (!parsedUniverses.success) {
    return json({ error: "The market universe registry returned an invalid response." }, 502);
  }

  const hasMore = parsedUniverses.data.length > limit;
  const universes = parsedUniverses.data.slice(0, limit);
  const lastUniverse = universes.at(-1);

  return json({
    workspaceId: context.workspaceId,
    universes,
    pagination: {
      limit,
      hasMore,
      nextCursor: hasMore && lastUniverse
        ? encodeCursor({
            version: 1,
            workspaceId: context.workspaceId,
            afterName: lastUniverse.name.trim().toLowerCase(),
          })
        : null,
    },
  });
}

export async function POST(request: NextRequest) {
  const context = await getWorkspaceContext();
  if ("response" in context) return context.response;
  if (!context.roles.some((role) => ["owner", "researcher", "operator"].includes(role))) {
    return json({ error: "A researcher, operator, or owner role is required." }, 403);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch (error) {
    if (error instanceof SyntaxError) {
      return json({ error: "Request body must be valid JSON." }, 400);
    }
    throw error;
  }
  const parsed = createUniverseSchema.safeParse(body);
  if (!parsed.success) {
    return json({
      error: "Universe definition failed validation.",
      issues: parsed.error.issues.map(({ path, message }) => ({ path, message })),
    }, 400);
  }

  const universe = parsed.data;
  const { data, error } = await context.supabase.rpc("create_market_universe_revision", {
    target_name: universe.name,
    target_provider_ids: universe.providerIds,
    target_allowed_venues: universe.allowedVenues,
    target_allowed_chains: universe.allowedChains,
    target_license_refs: universe.licenseRefs,
    target_max_candidates: universe.maxCandidates,
    target_status: universe.status,
  });

  if (error) {
    if (error.code === "42501") {
      return json({ error: "The current account is not authorized to create this universe." }, 403);
    }
    if (error.code === "22023") {
      return json({ error: "Universe definition was rejected by database validation." }, 400);
    }
    return json({ error: "Universe revision could not be stored." }, 503);
  }

  if (!Array.isArray(data) || data.length !== 1) {
    return json({ error: "Universe revision was not confirmed by the database." }, 502);
  }

  return json({ universe: data[0] }, 201);
}
