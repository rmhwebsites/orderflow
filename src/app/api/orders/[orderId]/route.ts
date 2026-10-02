import { NextResponse } from "next/server";
import { getOrderDetail } from "@/server/desk/read";
import { AuthError, guardResponse, requireMemberByOrder } from "@/server/guard";

type RouteContext = { params: Promise<{ orderId: string }> };

// One order in full, including the whole stored Shopify snapshot.
export async function GET(_request: Request, context: RouteContext) {
  try {
    const { orderId } = await context.params;
    const { db, workspaceId } = await requireMemberByOrder(orderId, "member");
    const order = await getOrderDetail(db, workspaceId, orderId);
    if (!order) {
      throw new AuthError(404, "Not found");
    }
    return NextResponse.json({ order });
  } catch (e) {
    return guardResponse(e);
  }
}
