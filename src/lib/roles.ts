// Workspace roles and their order. Shared by the server guards
// (src/server/guard.ts re-exports these) and client components that hide
// controls a role cannot use; the server still enforces every check.
//
// Stored roles (workspace_members.role, pending_invites.role) are manager
// and staff. "platform" is never stored: it is the effective role of a
// platform admin in any workspace, ranked above manager so a platform admin
// passes every workspace check.

export const WORKSPACE_ROLES = ["manager", "staff"] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export type Role = WorkspaceRole | "platform";

const RANK: Record<Role, number> = { staff: 0, manager: 1, platform: 2 };

export function roleAtLeast(actual: Role, required: Role): boolean {
  return RANK[actual] >= RANK[required];
}

export function isWorkspaceRole(value: unknown): value is WorkspaceRole {
  return value === "manager" || value === "staff";
}

const LABELS: Record<Role, string> = {
  staff: "Staff",
  manager: "Manager",
  platform: "Platform admin",
};

export function roleLabel(role: Role): string {
  return LABELS[role];
}
