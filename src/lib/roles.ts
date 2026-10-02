// Workspace roles and their order. Shared by the server guards
// (src/server/guard.ts re-exports these) and client components that hide
// controls a role cannot use; the server still enforces every check.

export type Role = "owner" | "admin" | "member";

const RANK: Record<Role, number> = { member: 0, admin: 1, owner: 2 };

export function roleAtLeast(actual: Role, required: Role): boolean {
  return RANK[actual] >= RANK[required];
}
