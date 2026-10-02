import { NextResponse } from "next/server";
import { listEvents } from "@/server/desk/read";
import { guardResponse, requireMember } from "@/server/guard";

type RouteContext = { params: Promise<{ id: string }> };

// Activity feed: the latest 300 events, newest first. With ?orderId=<id>,
// that order's full timeline instead (404 when the order is not in this
// workspace).
export async function GET(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const { db } = await requireMember(id, "member");
    const orderId = new URL(request.url).searchParams.get("orderId");
    const result = await listEvents(db, id, orderId);
    if (result.kind === "not-found") {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({ events: result.events });
  } catch (e) {
    return guardResponse(e);
  }
}
