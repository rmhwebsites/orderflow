import { NextResponse } from "next/server";
import { archiveVendor, updateVendor } from "@/server/desk/vendors";
import { guardResponse, requireMember } from "@/server/guard";

type RouteContext = { params: Promise<{ id: string; vendorId: string }> };

// Partial update {name?, email?, cc?, notes?}. 200 {vendor}; 400 {error};
// 404 for another workspace's vendor, an unknown id or an archived vendor.
export async function PATCH(request: Request, context: RouteContext) {
  try {
    const { id, vendorId } = await context.params;
    const { db } = await requireMember(id, "admin");
    const body = (await request.json().catch(() => null)) as unknown;
    const result = await updateVendor(db, id, vendorId, body);
    switch (result.kind) {
      case "invalid":
        return NextResponse.json({ error: result.error }, { status: 400 });
      case "not-found":
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      case "updated":
        return NextResponse.json({ vendor: result.vendor });
    }
  } catch (e) {
    return guardResponse(e);
  }
}

// Archives the vendor (never a hard delete: purchase orders reference it).
export async function DELETE(_request: Request, context: RouteContext) {
  try {
    const { id, vendorId } = await context.params;
    const { db } = await requireMember(id, "admin");
    const result = await archiveVendor(db, id, vendorId);
    if (result.kind === "not-found") {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return guardResponse(e);
  }
}
