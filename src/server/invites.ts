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
  for (const invite of invites) {
    // One atomic pair per claim: the insert ignores an already-existing
    // membership (member_unique), and the invite row is deleted either way,
    // so concurrent sign-ins cannot double-grant or strand an invite.
    await db.batch([
      db
        .insert(workspaceMembers)
        .values({
          id: crypto.randomUUID(),
          workspaceId: invite.workspaceId,
          userId,
          role: invite.role,
        })
        .onConflictDoNothing(),
      db.delete(pendingInvites).where(eq(pendingInvites.id, invite.id)),
    ]);
  }
}
