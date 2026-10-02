import { DurableObject } from "cloudflare:workers";

// One room per workspace (idFromName(workspaceId)). Every open desk holds a
// WebSocket here; server mutations POST compact JSON events to /broadcast,
// which fans them out to every socket. The room persists nothing: a client
// that reconnects refetches the desk instead of replaying missed events.
//
// Hibernation API: sockets are accepted with ctx.acceptWebSocket, so an idle
// room is evicted from memory while its sockets stay open, and the "ping"
// heartbeat is answered by an auto-response that does not wake it.
//
// Reachable only through the ROOM binding: custom-worker.ts forwards a
// verified /live upgrade (src/realtime/live.ts) and src/server/broadcast.ts
// posts to /broadcast. Nothing public routes to /broadcast.
export class WorkspaceRoom extends DurableObject<CloudflareEnv> {
  constructor(ctx: DurableObjectState, env: CloudflareEnv) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/broadcast") {
      if (request.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
      }
      const body = await request.text();
      let sent = 0;
      for (const socket of this.ctx.getWebSockets()) {
        try {
          socket.send(body);
          sent++;
        } catch {
          // A socket mid-close; the runtime cleans it up.
        }
      }
      return Response.json({ sent });
    }

    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  // Normally answered by the auto-response; kept for a ping that arrives
  // while the room is awake and the auto-response is not consulted.
  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (message === "ping") {
      socket.send("pong");
    }
  }

  async webSocketClose(socket: WebSocket, code: number, reason: string, _wasClean: boolean): Promise<void> {
    // 1005 and 1006 describe how the peer left and may not be sent back.
    try {
      socket.close(code === 1005 || code === 1006 ? 1000 : code, reason);
    } catch {
      // Already closed.
    }
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    try {
      socket.close(1011, "error");
    } catch {
      // Already closed.
    }
  }
}
