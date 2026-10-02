import { describe, it, expect, beforeAll } from "vitest";
import { WorkspaceRoom } from "./room";

// workerd globals the room touches, played by minimal stand-ins (vitest runs
// on Node; "cloudflare:workers" is aliased to src/test/cloudflare-workers-stub.ts).
class FakePair {
  constructor(
    readonly request: string,
    readonly response: string,
  ) {}
}

beforeAll(() => {
  (globalThis as Record<string, unknown>).WebSocketRequestResponsePair = FakePair;
});

type FakeSocket = { sent: string[]; send(data: string): void; close(code?: number, reason?: string): void; closed?: [number?, string?] };

function socket(opts?: { throws?: boolean }): FakeSocket {
  const s: FakeSocket = {
    sent: [],
    send(data: string) {
      if (opts?.throws) {
        throw new Error("socket closing");
      }
      s.sent.push(data);
    },
    close(code?: number, reason?: string) {
      s.closed = [code, reason];
    },
  };
  return s;
}

function room(sockets: FakeSocket[]) {
  const autoResponses: unknown[] = [];
  const ctx = {
    getWebSockets: () => sockets,
    acceptWebSocket: () => undefined,
    setWebSocketAutoResponse: (pair: unknown) => autoResponses.push(pair),
  };
  const instance = new WorkspaceRoom(ctx as unknown as DurableObjectState, {} as CloudflareEnv);
  return { instance, autoResponses };
}

describe("WorkspaceRoom", () => {
  it("answers ping with pong without waking from hibernation", () => {
    const { autoResponses } = room([]);
    expect(autoResponses).toEqual([new FakePair("ping", "pong")]);
  });

  it("also answers a ping that reaches the handler", async () => {
    const ws = socket();
    const { instance } = room([ws]);
    await instance.webSocketMessage(ws as unknown as WebSocket, "ping");
    await instance.webSocketMessage(ws as unknown as WebSocket, "hello");
    expect(ws.sent).toEqual(["pong"]);
  });

  it("fans a broadcast out to every socket, past one that fails", async () => {
    const a = socket();
    const broken = socket({ throws: true });
    const b = socket();
    const { instance } = room([a, broken, b]);
    const body = JSON.stringify({ kind: "order.note", event: { id: "e1" } });
    const response = await instance.fetch(
      new Request("https://workspace-room/broadcast", { method: "POST", body }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sent: 2 });
    expect(a.sent).toEqual([body]);
    expect(b.sent).toEqual([body]);
  });

  it("only broadcasts on POST", async () => {
    const a = socket();
    const { instance } = room([a]);
    const response = await instance.fetch(new Request("https://workspace-room/broadcast"));
    expect(response.status).toBe(405);
    expect(a.sent).toEqual([]);
  });

  it("refuses anything else that is not a WebSocket upgrade", async () => {
    const { instance } = room([]);
    const response = await instance.fetch(new Request("https://workspace-room/live"));
    expect(response.status).toBe(426);
  });

  it("completes the close handshake, mapping reserved codes", async () => {
    const ws = socket();
    const { instance } = room([ws]);
    await instance.webSocketClose(ws as unknown as WebSocket, 1001, "going away", true);
    expect(ws.closed).toEqual([1001, "going away"]);
    const silent = socket();
    await instance.webSocketClose(silent as unknown as WebSocket, 1005, "", false);
    expect(silent.closed).toEqual([1000, ""]);
  });
});
