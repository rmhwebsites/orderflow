import { cache } from "react";
import { and, eq } from "drizzle-orm";
import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { workspaceMembers, workspaces } from "@/db/schema";
import { getAuth } from "./auth";

export type Role = "owner" | "admin" | "member";

const RANK: Record<Role, number> = { member: 0, admin: 1, owner: 2 };

export function roleAtLeast(actual: Role, required: Role): boolean {
  return RANK[actual] >= RANK[required];
}

export class AuthError extends Error {
  readonly status: 401 | 404;

  constructor(status: 401 | 404, message: string) {
    super(message);
    this.name = "AuthError";
    this.status = status;
  }
}

// Session guard for routes that are not workspace-scoped (listing and
// creating workspaces). 401 without a session.
export async function requireSession() {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (!session) {
    throw new AuthError(401, "Not signed in");
  }
  return { userId: session.user.id, db: getDb(), session };
}

// Membership guard for workspace-scoped routes. 401 without a session; 404
// both when the workspace has no membership for the user and when the role is
// under-ranked, so a non-member cannot distinguish "exists but forbidden"
// from "does not exist".
export async function requireMember(workspaceId: string, required: Role) {
  const { userId, db, session } = await requireSession();
  const rows = await db
    .select()
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, userId),
      ),
    )
    .limit(1);
  const membership = rows[0];
  if (!membership || !roleAtLeast(membership.role, required)) {
    throw new AuthError(404, "Not found");
  }
  return { userId, role: membership.role, db, session };
}

// Guard for /w/[slug] server components. EVERY server component under
// /w/[slug] (layout, page, nested segments) must call this itself: layouts
// are NOT an auth boundary, because Next renders layouts and pages
// independently (and pages can be requested without their layout re-running).
// cache() dedupes the session and membership queries across the components
// of one request.
export const requireMemberBySlug = cache(async (slug: string, required: Role) => {
  const db = getDb();
  const rows = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.slug, slug))
    .limit(1);
  const workspace = rows[0];
  if (!workspace) {
    throw new AuthError(404, "Not found");
  }
  const { userId, role, session } = await requireMember(workspace.id, required);
  return { workspace, userId, role, db, session };
});

export function guardResponse(e: unknown): NextResponse {
  if (e instanceof AuthError) {
    return NextResponse.json({ error: e.message }, { status: e.status });
  }
  console.error("Unhandled route error", e);
  return NextResponse.json({ error: "Internal error" }, { status: 500 });
}
