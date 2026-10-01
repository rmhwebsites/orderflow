import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { storeConnections } from "@/db/schema";
import { guardResponse, requireMember } from "@/server/guard";
import { runSync } from "@/server/sync/run";

type RouteContext = { params: Promise<{ id: string }> };

// A manual sync may run at most once per 30 seconds per workspace.
const MANUAL_SYNC_COOLDOWN_MS = 30000;

// Connection card data: null when the workspace has no store connection.
export async function GET(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const { db } = await requireMember(id, "member");
    const rows = await db
      .select()
      .from(storeConnections)
      .where(eq(storeConnections.workspaceId, id))
      .limit(1);
    const connection = rows[0];
    if (!connection) {
      return NextResponse.json(null);
    }
    return NextResponse.json({
      lastSyncAt: connection.lastSyncAt,
      status: connection.status,
      lastError: connection.lastError,
      shopDomain: connection.shopDomain,
    });
  } catch (e) {
    return guardResponse(e);
  }
}

export async function POST(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const { db } = await requireMember(id, "member");

    const now = Date.now();
    const rows = await db
      .select()
      .from(storeConnections)
      .where(eq(storeConnections.workspaceId, id))
      .limit(1);
    const connection = rows[0];
    if (connection && connection.lastManualSyncAt > now - MANUAL_SYNC_COOLDOWN_MS) {
      return NextResponse.json(
        { error: "Sync already ran in the last 30 seconds" },
        { status: 429 },
      );
    }
    if (connection) {
      await db
        .update(storeConnections)
        .set({ lastManualSyncAt: now })
        .where(eq(storeConnections.workspaceId, id));
    }

    const { env } = getCloudflareContext();
    const result = await runSync(db, env, id);
    // Phase 5/6 hook point: broadcast/notify from result.addedOrderIds here.

    if (result.error) {
      // 502 so the connection card can surface the failure text.
      return NextResponse.json({ error: result.error }, { status: 502 });
    }
    // 200 even for skipped results; the card renders the skip reason.
    return NextResponse.json(result);
  } catch (e) {
    return guardResponse(e);
  }
}
