// The realtime socket endpoint, served by custom-worker.ts before requests
// reach OpenNext (a Next.js route handler cannot reliably return a WebSocket
// upgrade). The client opens
//   wss://<host>/live?workspace=<workspace id>&ticket=<live ticket>
// with a ticket from GET /api/workspaces/[id]/live-ticket. A genuine,
// unexpired ticket for that workspace is forwarded to the workspace's
// WorkspaceRoom; anything else gets a 401 and no upgrade. Relative imports
// only: bundled into the custom worker.

import { verifyLiveTicket } from "./ticket";

export const LIVE_PATH = "/live";

export async function handleLiveRequest(request: Request, env: CloudflareEnv): Promise<Response> {
  const url = new URL(request.url);
  const workspaceId = url.searchParams.get("workspace") ?? "";
  const ticket = url.searchParams.get("ticket") ?? "";
  const claims =
    workspaceId.length > 0 && ticket.length > 0
      ? await verifyLiveTicket(ticket, { secret: env.BETTER_AUTH_SECRET, workspaceId })
      : null;
  if (!claims) {
    return new Response("Unauthorized", { status: 401 });
  }
  if (request.method !== "GET" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response("Expected a WebSocket upgrade", { status: 426 });
  }
  // The room routes by path and only ever upgrades this request; its
  // /broadcast path is reachable through the binding alone, never from here.
  const room = env.ROOM.get(env.ROOM.idFromName(claims.workspaceId));
  return room.fetch(request);
}
