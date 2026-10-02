// Fans a realtime event out to a workspace's open desks through its
// WorkspaceRoom (src/realtime/room.ts). Best effort by design: the write the
// event describes has already committed, and clients refetch after every
// reconnect and poll while disconnected, so a lost broadcast only delays an
// update. broadcast therefore never throws into its caller: failures, a
// refusal or a room that does not answer within BROADCAST_TIMEOUT_MS are
// logged and the caller continues. Relative imports only: the cron path
// (src/server/sync/cron.ts) bundles this into the custom worker.

import type { LiveEvent } from "../lib/live-events";

const BROADCAST_TIMEOUT_MS = 3000;
const ROOM_BROADCAST_URL = "https://workspace-room/broadcast";

function timeout(ms: number): { promise: Promise<never>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${ms}ms`)), ms);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

export async function broadcast(env: CloudflareEnv, workspaceId: string, event: LiveEvent): Promise<void> {
  // Tools and tests that build a partial env have no ROOM; production always
  // does (wrangler.jsonc durable_objects).
  if (!env.ROOM) {
    return;
  }
  const limit = timeout(BROADCAST_TIMEOUT_MS);
  try {
    const room = env.ROOM.get(env.ROOM.idFromName(workspaceId));
    const response = await Promise.race([
      room.fetch(ROOM_BROADCAST_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(event),
      }),
      limit.promise,
    ]);
    if (!response.ok) {
      console.warn("[live] " + JSON.stringify({ workspaceId, kind: event.kind, status: response.status }));
    }
  } catch (e) {
    console.warn(
      "[live] " +
        JSON.stringify({
          workspaceId,
          kind: event.kind,
          error: e instanceof Error ? e.message : "broadcast failed",
        }),
    );
  } finally {
    limit.cancel();
  }
}

// After a sync run (manual or cron): one orders.synced event when the run
// landed anything. The id lists are rows-affected truth from runSync.
export async function broadcastSync(
  env: CloudflareEnv,
  workspaceId: string,
  result: { addedOrderIds: string[]; updatedOrderIds: string[] },
): Promise<void> {
  if (result.addedOrderIds.length + result.updatedOrderIds.length === 0) {
    return;
  }
  await broadcast(env, workspaceId, {
    kind: "orders.synced",
    addedOrderIds: result.addedOrderIds,
    updatedOrderIds: result.updatedOrderIds,
  });
}
