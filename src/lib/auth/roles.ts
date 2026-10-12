export const workspaceRoles = [
  "owner",
  "researcher",
  "operator",
  "risk_approver",
  "auditor",
  "platform_admin",
] as const;

export type WorkspaceRole = (typeof workspaceRoles)[number];

export const workspaceRoleLabels: Record<WorkspaceRole, string> = {
  owner: "Owner",
  researcher: "Researcher",
  operator: "Operator",
  risk_approver: "Risk Approver",
  auditor: "Auditor",
  platform_admin: "Platform Admin",
};

export function isWorkspaceRole(value: string): value is WorkspaceRole {
  return workspaceRoles.some((role) => role === value);
}
