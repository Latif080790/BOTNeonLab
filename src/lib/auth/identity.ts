import { redirect } from "next/navigation";
import { isWorkspaceRole, type WorkspaceRole } from "./roles";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export type DashboardIdentity = {
  displayName: string;
  email: string;
  workspaceName: string;
  workspaceKind: "personal" | "team";
  roles: WorkspaceRole[];
};

export async function getDashboardIdentity(): Promise<DashboardIdentity> {
  const supabase = await createSupabaseServerClient();
  const { data: claimsData, error: claimsError } = await supabase.auth.getClaims();

  if (claimsError && (claimsError.status === undefined || claimsError.status === 0 || claimsError.status >= 500)) {
    throw new Error("Authentication service is temporarily unavailable.");
  }
  if (!claimsData?.claims?.sub) {
    redirect("/login");
  }

  const userId = claimsData.claims.sub;
  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("display_name")
    .eq("id", userId)
    .maybeSingle();

  if (profileError) {
    throw new Error("Unable to load the authenticated user's profile.");
  }
  if (!profile) {
    throw new Error("The authenticated user has no provisioned profile.");
  }

  const { data: memberships, error: membershipsError } = await supabase
    .from("memberships")
    .select("workspace_id, created_at")
    .eq("profile_id", userId)
    .order("created_at", { ascending: true })
    .limit(1);

  if (membershipsError) {
    throw new Error("Unable to load workspace memberships.");
  }
  const membership = memberships[0];
  if (!membership) {
    throw new Error("The authenticated user does not belong to a workspace.");
  }

  const { data: workspace, error: workspaceError } = await supabase
    .from("workspaces")
    .select("id, name, kind")
    .eq("id", membership.workspace_id)
    .maybeSingle();

  if (workspaceError) {
    throw new Error("Unable to load the active workspace.");
  }
  if (!workspace || (workspace.kind !== "personal" && workspace.kind !== "team")) {
    throw new Error("The active workspace identity is incomplete or invalid.");
  }

  const { data: roleRows, error: rolesError } = await supabase
    .from("membership_roles")
    .select("role")
    .eq("workspace_id", workspace.id)
    .eq("profile_id", userId)
    .order("role");

  if (rolesError) {
    throw new Error("Unable to load workspace roles.");
  }

  const roles = roleRows.map(({ role }) => {
    if (!isWorkspaceRole(role)) {
      throw new Error("The active workspace contains an unsupported role.");
    }
    return role;
  });
  if (roles.length === 0) {
    throw new Error("The authenticated user has no role in the active workspace.");
  }

  return {
    displayName: profile.display_name,
    email: typeof claimsData.claims.email === "string" ? claimsData.claims.email : "",
    workspaceName: workspace.name,
    workspaceKind: workspace.kind,
    roles,
  };
}
