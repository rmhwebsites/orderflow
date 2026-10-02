import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { broadcastSync } from "@/server/broadcast";
import { getSyncConnection, manualSync, manualSyncResponse } from "@/server/desk/sync";
import { guardResponse, requireMember } from "@/server/guard";

type RouteContext = { params: Promise<{ id: string }> };

// Connection card data: {connection: {shopDomain, status, lastSyncAt,
// lastError, catchingUp} | null}. Never the token.
export async function GET(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const { db } = await requireMember(id, "member");
    return NextResponse.json({ connection: await getSyncConnection(db, id) });
  } catch (e) {
    return guardResponse(e);
  }
}

// Manual sync: 200 with the sync result (skipped runs included); 429
// {error} with Retry-After seconds inside the 30 second cooldown; 502
// {error, added, updated} when the run failed, with what still landed.
export async function POST(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const { db } = await requireMember(id, "member");
    const { env, ctx } = getCloudflareContext();
    const outcome = await manualSync(db, env, id);
    if (outcome.kind !== "cooldown") {
      // Failed runs too: their id lists still name exactly what landed.
      // Phase 6 hook point: notify from outcome.result.addedOrderIds here.
      ctx.waitUntil(broadcastSync(env, id, outcome.result));
    }
    const reply = manualSyncResponse(outcome);
    return NextResponse.json(reply.body, { status: reply.status, headers: reply.headers });
  } catch (e) {
    return guardResponse(e);
  }
}
