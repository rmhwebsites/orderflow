import { NextResponse } from "next/server";
import { addOrderNote } from "@/server/desk/mutations";
import { guardResponse, requireMemberByOrder } from "@/server/guard";

type RouteContext = { params: Promise<{ orderId: string }> };

// Body {text}: trimmed, 1 to 4000 characters. 200 {event}.
export async function POST(request: Request, context: RouteContext) {
  try {
    const { orderId } = await context.params;
    const { db, userId, workspaceId } = await requireMemberByOrder(orderId, "member");
    const body = (await request.json().catch(() => null)) as unknown;
    const result = await addOrderNote(db, { workspaceId, orderId, userId }, body);
    switch (result.kind) {
      case "invalid":
        return NextResponse.json({ error: result.error }, { status: 400 });
      case "not-found":
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      case "added":
        // Phase 5 hook point: broadcast this event to the workspace room.
        return NextResponse.json({ event: result.event });
    }
  } catch (e) {
    return guardResponse(e);
  }
}
