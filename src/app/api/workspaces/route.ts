import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { statuses, workspaceMembers, workspaces, workspaceSettings } from "@/db/schema";
import { guardResponse, requireSession } from "@/server/guard";

// Default statuses seeded into every new workspace. Colors are design token
// names resolved by the UI, not hex values.
const DEFAULT_STATUSES = [
  { key: "new", label: "New", color: "lime", triggersPo: false },
  { key: "processing", label: "Processing", color: "blue", triggersPo: false },
  { key: "on_hold", label: "On Hold", color: "amber", triggersPo: false },
  { key: "approved", label: "Approved", color: "green", triggersPo: true },
  { key: "shipped", label: "Shipped", color: "violet", triggersPo: false },
  { key: "delivered", label: "Delivered", color: "slate", triggersPo: false },
  { key: "issue", label: "Issue", color: "red", triggersPo: false },
];

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "workspace";
}

export async function GET() {
  try {
    const { userId, db } = await requireSession();
    const rows = await db
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
    return NextResponse.json({ workspaces: rows });
  } catch (e) {
    return guardResponse(e);
  }
}

export async function POST(request: Request) {
  try {
    const { userId, db } = await requireSession();
    const body = (await request.json().catch(() => null)) as { name?: unknown } | null;
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (name.length === 0 || name.length > 80) {
      return NextResponse.json({ error: "Workspace name is required" }, { status: 400 });
    }

    const base = slugify(name);
    let slug = base;
    for (let suffix = 2; ; suffix++) {
      const existing = await db
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.slug, slug))
        .limit(1);
      if (existing.length === 0) {
        break;
      }
      slug = `${base}-${suffix}`;
    }

    const workspaceId = crypto.randomUUID();
    const now = Date.now();
    // One D1 batch so a failed statement cannot leave a half-created workspace.
    await db.batch([
      db.insert(workspaces).values({
        id: workspaceId,
        name,
        slug,
        createdBy: userId,
        createdAt: now,
      }),
      db.insert(workspaceMembers).values({
        id: crypto.randomUUID(),
        workspaceId,
        userId,
        role: "owner",
      }),
      db.insert(workspaceSettings).values({ workspaceId }),
      db.insert(statuses).values(
        DEFAULT_STATUSES.map((status, sort) => ({
          id: crypto.randomUUID(),
          workspaceId,
          sort,
          ...status,
        })),
      ),
    ]);
    return NextResponse.json(
      { workspace: { id: workspaceId, name, slug, role: "owner" } },
      { status: 201 },
    );
  } catch (e) {
    return guardResponse(e);
  }
}
