import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { workspaceMembers, workspaces } from "@/db/schema";

// Workspaces the user is a member of, with their role. Shared by the home
// page and GET /api/workspaces so the card list and the API cannot drift.
export function listWorkspacesForUser(db: Db, userId: string) {
  return db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      slug: workspaces.slug,
      accentColor: workspaces.accentColor,
      role: workspaceMembers.role,
    })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
    .where(eq(workspaceMembers.userId, userId));
}
