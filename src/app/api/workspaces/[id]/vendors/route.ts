import { NextResponse } from "next/server";
import { createVendor, listVendors } from "@/server/desk/vendors";
import { guardResponse, requireMember } from "@/server/guard";

type RouteContext = { params: Promise<{ id: string }> };

// Active (non-archived) vendors, by name.
export async function GET(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const { db } = await requireMember(id, "member");
    return NextResponse.json({ vendors: await listVendors(db, id) });
  } catch (e) {
    return guardResponse(e);
  }
}

// Body {name, email, cc?, notes?}. 201 {vendor}; 400 {error}.
export async function POST(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const { db } = await requireMember(id, "admin");
    const body = (await request.json().catch(() => null)) as unknown;
    const result = await createVendor(db, id, body);
    if (result.kind === "invalid") {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }
    return NextResponse.json({ vendor: result.vendor }, { status: 201 });
  } catch (e) {
    return guardResponse(e);
  }
}
