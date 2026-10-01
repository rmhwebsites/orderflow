import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { pendingInvites, workspaceMembers, user } from "@/db/schema";

// Claims pending invites for a user. Runs after user creation (first sign-up)
// and after session creation (every sign-in), so invites created AFTER the
// user's first sign-up are still claimed at their next sign-in. Invite emails
// are stored lowercased; the user's email is lowercased here before comparing.
export async function claimPendingInvites(
  db: Db,
  userId: string,
  email?: string,
): Promise<void> {
  let normalized = email?.toLowerCase();
  if (!normalized) {
    const rows = await db
      .select({ email: user.email })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);
    if (rows.length === 0) {
      return;
    }
    normalized = rows[0].email.toLowerCase();
  }
  const invites = await db
    .select()
    .from(pendingInvites)
    .where(eq(pendingInvites.email, normalized));
  if (invites.length === 0) {
    return;
  }
  const memberships = await db
    .select({ workspaceId: workspaceMembers.workspaceId })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, userId));
  const existing = new Set(memberships.map((m) => m.workspaceId));
  for (const invite of invites) {
    if (!existing.has(invite.workspaceId)) {
      await db.insert(workspaceMembers).values({
        id: crypto.randomUUID(),
        workspaceId: invite.workspaceId,
        userId,
        role: invite.role,
      });
    }
    await db.delete(pendingInvites).where(eq(pendingInvites.id, invite.id));
  }
}
