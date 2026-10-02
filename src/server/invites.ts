import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { applyBatch } from "@/db/batch";
import { pendingInvites, platformAdmins, workspaceMembers, user } from "@/db/schema";
import { materializeRoster } from "./roster";

async function emailOf(db: Db, userId: string, email?: string): Promise<string | null> {
  if (email) {
    return email.trim().toLowerCase();
  }
  const rows = await db.select({ email: user.email }).from(user).where(eq(user.id, userId)).limit(1);
  return rows[0] ? rows[0].email.toLowerCase() : null;
}

// Claims pending invites for a user: a workspace invite becomes a source =
// manual membership with the invited role, a platform-admin invite becomes a
// platform_admins row granted by the inviter. Runs after user creation
// (first sign-up) and after session creation (every sign-in), so invites
// created AFTER the user's first sign-up are still claimed at their next
// sign-in. Invite emails are stored lowercased; the user's email is
// lowercased here before comparing.
export async function claimPendingInvites(db: Db, userId: string, email?: string): Promise<void> {
  const normalized = await emailOf(db, userId, email);
  if (!normalized) {
    return;
  }
  const invites = await db.select().from(pendingInvites).where(eq(pendingInvites.email, normalized));
  for (const invite of invites) {
    // One atomic pair per claim: the grant ignores an already-existing
    // membership or admin row, and the invite row is deleted either way, so
    // concurrent sign-ins cannot double-grant or strand an invite.
    const grant =
      invite.platformAdmin || invite.workspaceId === null || invite.role === null
        ? db
            .insert(platformAdmins)
            .values({ userId, grantedBy: invite.invitedBy, createdAt: Date.now() })
            .onConflictDoNothing()
        : db
            .insert(workspaceMembers)
            .values({
              id: crypto.randomUUID(),
              workspaceId: invite.workspaceId,
              userId,
              role: invite.role,
              source: "manual",
            })
            .onConflictDoNothing();
    await applyBatch(db, [grant, db.delete(pendingInvites).where(eq(pendingInvites.id, invite.id))]);
  }
}

// Everything a sign-in grants: pending invites first, then the Shopify
// roster, so a manual invite and a tag for the same workspace end as the
// manual membership (materializeRoster never touches manual rows).
export async function claimAccessOnSignIn(db: Db, userId: string, email?: string): Promise<void> {
  const normalized = await emailOf(db, userId, email);
  if (!normalized) {
    return;
  }
  await claimPendingInvites(db, userId, normalized);
  await materializeRoster(db, userId, normalized);
}
