import { NextResponse } from "next/server";
import { changeOrderStatus } from "@/server/desk/mutations";
import { guardResponse, requireMemberByOrder } from "@/server/guard";

type RouteContext = { params: Promise<{ orderId: string }> };

// Body {statusKey}. 200 {unchanged: true} when the order already has that
// status (nothing is written); otherwise 200 {event, order, triggersPo}, where
// triggersPo tells the client to open the PO review flow.
export async function POST(request: Request, context: RouteContext) {
  try {
    const { orderId } = await context.params;
    const { db, userId, workspaceId } = await requireMemberByOrder(orderId, "member");
    const body = (await request.json().catch(() => null)) as unknown;
    const result = await changeOrderStatus(db, { workspaceId, orderId, userId }, body);
    switch (result.kind) {
      case "invalid":
        return NextResponse.json({ error: result.error }, { status: 400 });
      case "not-found":
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      case "unchanged":
        return NextResponse.json({ unchanged: true });
      case "changed":
        // Phase 5 hook point: broadcast this event to the workspace room.
        return NextResponse.json({
          event: result.event,
          order: result.order,
          triggersPo: result.triggersPo,
        });
    }
  } catch (e) {
    return guardResponse(e);
  }
}
