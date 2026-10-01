import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { storeConnections } from "@/db/schema";
import { guardResponse, requireMember } from "@/server/guard";
import { runSync } from "@/server/sync/run";

type RouteContext = { params: Promise<{ id: string }> };

// A manual sync may run at most once per 30 seconds per workspace.
const MANUAL_SYNC_COOLDOWN_MS = 30000;

// Connection card data as { connection: {...} | null }; Phase 5 builds
// against this shape.
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
      return NextResponse.json({ connection: null });
    }
    return NextResponse.json({
      connection: {
        lastSyncAt: connection.lastSyncAt,
        status: connection.status,
        lastError: connection.lastError,
        shopDomain: connection.shopDomain,
      },
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
      const retryAfterSeconds = Math.ceil(
        (connection.lastManualSyncAt + MANUAL_SYNC_COOLDOWN_MS - now) / 1000,
      );
      return NextResponse.json(
        { error: "Sync already ran in the last 30 seconds" },
        { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
      );
    }

    const { env } = getCloudflareContext();
    const result = await runSync(db, env, id);
    // The cooldown only counts runs that actually happened: a skipped run
    // (lease held, no connection, disabled) can be retried immediately.
    if (connection && !result.skipped) {
      await db
        .update(storeConnections)
        .set({ lastManualSyncAt: now })
        .where(eq(storeConnections.workspaceId, id));
    }
    // Phase 5/6 hook point: broadcast/notify from result.addedOrderIds and
    // result.updatedOrderIds here.

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
