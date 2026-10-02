import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { guardResponse, requireMember } from "@/server/guard";
import { signLiveTicket } from "@/realtime/ticket";

type RouteContext = { params: Promise<{ id: string }> };

// A 60 second ticket for opening this workspace's realtime socket
// (src/realtime/live.ts): 200 {ticket, expiresAt}. Members only; never cached.
export async function GET(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const { userId } = await requireMember(id, "member");
    const { env } = getCloudflareContext();
    const { ticket, expiresAt } = await signLiveTicket(
      { workspaceId: id, userId },
      env.BETTER_AUTH_SECRET,
    );
    return NextResponse.json({ ticket, expiresAt }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return guardResponse(e);
  }
}
