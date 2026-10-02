// Tagged Shopify customers as workspace members (platform amendment
// section 2). The Shopify stage fills shopify_roster from customer webhooks
// and the periodic sync, and adds or removes source = shopify memberships as
// tags change (src/server/shopify/roster-sync.ts). This module holds the
// shared rules: the tag names and turning roster entries into memberships
// when the person signs in.

// Relative imports on purpose: the cron roster sync
// (src/server/shopify/roster-sync.ts) bundles this into the custom worker.

import { eq, sql } from "drizzle-orm";
import type { Db } from "../db";
import { applyBatch } from "../db/batch";
import { shopifyRoster, workspaceMembers, type RosterTags } from "../db/schema";
import { isRecord } from "./desk/shapes";

export const DEFAULT_ROSTER_TAGS: RosterTags = {
  manager: "Ordering Desk Manager",
  staff: "Ordering Desk Staff",
};

// The workspace's tag names: workspaces.roster_tags when set, each missing
// or blank tag falling back to its default.
export function resolveRosterTags(stored: unknown): RosterTags {
  const tags = isRecord(stored) ? stored : {};
  const pick = (value: unknown, fallback: string) =>
    typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
  return {
    manager: pick(tags.manager, DEFAULT_ROSTER_TAGS.manager),
    staff: pick(tags.staff, DEFAULT_ROSTER_TAGS.staff),
  };
}

// Grants every roster entry for this email as a source = shopify membership
// with the roster's role. A manual membership in the same workspace is never
// touched (a manager's invite outranks a tag); an existing shopify
// membership takes the roster's current role. Removing memberships whose
// tag is gone is the Shopify stage's job, not sign-in's.
export async function materializeRoster(db: Db, userId: string, email: string): Promise<void> {
  const entries = await db
    .select({ workspaceId: shopifyRoster.workspaceId, role: shopifyRoster.role })
    .from(shopifyRoster)
    .where(eq(shopifyRoster.email, email.trim().toLowerCase()));
  await applyBatch(
    db,
    entries.map((entry) =>
      db
        .insert(workspaceMembers)
        .values({
          id: crypto.randomUUID(),
          workspaceId: entry.workspaceId,
          userId,
          role: entry.role,
          source: "shopify",
        })
        .onConflictDoUpdate({
          target: [workspaceMembers.workspaceId, workspaceMembers.userId],
          set: { role: entry.role },
          setWhere: sql`${workspaceMembers.source} = 'shopify'`,
        }),
    ),
  );
}
