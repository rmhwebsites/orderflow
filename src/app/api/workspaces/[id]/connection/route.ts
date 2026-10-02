import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { deleteConnection, saveConnection } from "@/server/desk/connection";
import { guardResponse, requireMember } from "@/server/guard";

type RouteContext = { params: Promise<{ id: string }> };

// OWNER ONLY, both methods: this route carries the Shopify access token.
// Never log the request body or echo the token. Errors thrown by
// saveConnection are already redacted (no token, no ciphertext, no cause
// chain), so guardResponse may log them.

// Body {shopDomain, token}. The pair is verified with Shopify before
// anything is stored. 200 {connection: {shopDomain, status, lastSyncAt,
// lastError, shopName}}; 400 {error} for a bad domain or token, or no store
// at the address; 409 {error} when the workspace already has orders and the
// domain names another store; 422 {error} when Shopify rejects the token or
// it cannot read orders; 502 {error} when Shopify cannot be reached or errors.
export async function PUT(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const { db } = await requireMember(id, "owner");
    const body = (await request.json().catch(() => null)) as unknown;
    const { env } = getCloudflareContext();
    const result = await saveConnection(
      db,
      { workspaceId: id, encryptionKey: env.ENCRYPTION_KEY },
      body,
    );
    switch (result.kind) {
      case "invalid":
        return NextResponse.json({ error: result.error }, { status: 400 });
      case "rejected":
        return NextResponse.json({ error: result.error }, { status: 422 });
      case "store-change":
        return NextResponse.json({ error: result.error }, { status: 409 });
      case "unreachable":
        return NextResponse.json({ error: result.error }, { status: 502 });
      case "saved":
        return NextResponse.json({ connection: result.connection });
    }
  } catch (e) {
    return guardResponse(e);
  }
}

// Disconnects the store; orders stay.
export async function DELETE(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const { db } = await requireMember(id, "owner");
    await deleteConnection(db, id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return guardResponse(e);
  }
}
