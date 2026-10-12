import type { User } from "@supabase/supabase-js";
import { redirect } from "next/navigation";
import { isWorkspaceRole, type WorkspaceRole } from "./roles";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function requireAuthenticatedUser(): Promise<User> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getUser();
  if (error && error.name !== "AuthSessionMissingError") {
    if (error.status === undefined || error.status === 0 || error.status >= 500) {
      throw new Error("Authentication service is temporarily unavailable.");
    }
    redirect("/login");
  }
  if (!data?.user) {
    redirect("/login");
  }
  return data.user;
}

export async function requireWorkspaceRole(
  workspaceId: string,
  requiredRoles: WorkspaceRole[],
): Promise<{ user: User; roles: WorkspaceRole[] }> {
  const user = await requireAuthenticatedUser();
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("membership_roles")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("profile_id", user.id);

  if (error) {
    throw new Error("Unable to verify workspace permissions.");
  }

  const roles = data.map(({ role }) => {
    if (!isWorkspaceRole(role)) {
      throw new Error("The workspace contains an unsupported role.");
    }
    return role;
  });
  if (!requiredRoles.some((role) => roles.includes(role))) {
    throw new Error("The authenticated user is not authorized for this workspace action.");
  }

  return { user, roles };
}

export async function requireStepUpAuthentication(returnTo: string): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getClaims();
  if (error && (error.status === undefined || error.status === 0 || error.status >= 500)) {
    throw new Error("Unable to verify the current authentication assurance level.");
  }
  if (!data?.claims?.sub) {
    redirect("/login");
  }
  if (data.claims.aal !== "aal2") {
    const target = returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/";
    redirect(`/security/mfa?next=${encodeURIComponent(target)}`);
  }
}
