// One workspace's Shopify sync pass: lease, fetch, normalize, upsert, record.
// Relative imports on purpose: this module is bundled into the custom worker
// entrypoint (cron), not only the Next.js build.

import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../../db";
import { events, orders, statuses, storeConnections } from "../../db/schema";
import { decryptSecret } from "../crypto";
import { fetchOrdersUpdatedSince } from "../shopify/client";
import { normalizeOrders } from "../shopify/normalize";

export type SyncResult = {
  added: number;
  updated: number;
  // Order row ids inserted this run. Phase 5/6 call sites broadcast to the
  // workspace room and fan out notifications from these.
  addedOrderIds: string[];
  skipped?: "running" | "no-connection" | "disabled";
  error?: string;
};

export type SyncOptions = {
  fetchImpl?: typeof fetch;
  now?: () => number;
};

const LEASE_MS = 120000;
// Re-fetch a 5 minute overlap so clock skew between this worker and Shopify
// cannot drop orders updated right around the previous lastSyncAt.
const OVERLAP_MS = 300000;
const FIRST_SYNC_WINDOW_MS = 60 * 24 * 60 * 60 * 1000;
const SYNC_ERROR_TEXT_MAX = 300;

const TOKEN_UNREADABLE = "Token unreadable, re-enter it in Settings";
const TOKEN_REJECTED = "Shopify rejected the token. Update the connection in Settings.";

// Two statements that must land together. db.batch is the atomic path on D1;
// the better-sqlite3-backed Db injected by tests has no batch method, so fall
// back to sequential awaits (drizzle builders are thenables that run on await).
async function applyPair(db: Db, a: PromiseLike<unknown>, b: PromiseLike<unknown>): Promise<void> {
  const batchable = db as unknown as {
    batch?: (statements: [PromiseLike<unknown>, PromiseLike<unknown>]) => Promise<unknown>;
  };
  if (typeof batchable.batch === "function") {
    await batchable.batch([a, b]);
  } else {
    await a;
    await b;
  }
}

export async function runSync(
  db: Db,
  env: CloudflareEnv,
  workspaceId: string,
  opts?: SyncOptions,
): Promise<SyncResult> {
  const now = opts?.now?.() ?? Date.now();
  const none: SyncResult = { added: 0, updated: 0, addedOrderIds: [] };

  const connectionRows = await db
    .select()
    .from(storeConnections)
    .where(eq(storeConnections.workspaceId, workspaceId))
    .limit(1);
  const connection = connectionRows[0];
  if (!connection) {
    return { ...none, skipped: "no-connection" };
  }
  if (connection.status === "disabled") {
    return { ...none, skipped: "disabled" };
  }
  if (connection.runningUntil > now) {
    return { ...none, skipped: "running" };
  }

  // Take the lease. D1 has no transactions, so this read-then-write can race:
  // two overlapping runs may both pass the check and the last writer wins.
  // That is acceptable here because the worst case is two syncs upserting
  // identical Shopify data idempotently.
  await db
    .update(storeConnections)
    .set({ runningUntil: now + LEASE_MS })
    .where(eq(storeConnections.workspaceId, workspaceId));

  let token: string;
  try {
    token = await decryptSecret(connection.encryptedToken, env.ENCRYPTION_KEY, workspaceId);
  } catch {
    await db
      .update(storeConnections)
      .set({ status: "error", lastError: TOKEN_UNREADABLE, runningUntil: 0 })
      .where(eq(storeConnections.workspaceId, workspaceId));
    return { ...none, error: TOKEN_UNREADABLE };
  }

  const sinceMs =
    connection.lastSyncAt === 0
      ? now - FIRST_SYNC_WINDOW_MS
      : Math.max(connection.lastSyncAt - OVERLAP_MS, 0);
  const sinceIso = new Date(sinceMs).toISOString();

  const fetched = await fetchOrdersUpdatedSince(
    connection.shopDomain,
    token,
    sinceIso,
    opts?.fetchImpl ?? fetch,
  );

  if (fetched.kind === "auth") {
    await db
      .update(storeConnections)
      .set({ status: "error", lastError: TOKEN_REJECTED, runningUntil: 0 })
      .where(eq(storeConnections.workspaceId, workspaceId));
    return { ...none, error: TOKEN_REJECTED };
  }

  if (fetched.kind === "transient" || fetched.kind === "fatal") {
    // Status and lastSyncAt stay untouched so the next cron tick retries the
    // same window; just record what happened and release the lease.
    await db
      .update(storeConnections)
      .set({ lastError: fetched.detail, runningUntil: 0 })
      .where(eq(storeConnections.workspaceId, workspaceId));
    if (fetched.kind === "fatal") {
      await db.insert(events).values({
        id: crypto.randomUUID(),
        workspaceId,
        orderId: null,
        type: "sync_error",
        text: fetched.detail.slice(0, SYNC_ERROR_TEXT_MAX),
        createdAt: now,
      });
    }
    return { ...none, error: fetched.detail };
  }

  const normalized = normalizeOrders(fetched.nodes);

  const defaultStatusRows = await db
    .select({ key: statuses.key })
    .from(statuses)
    .where(eq(statuses.workspaceId, workspaceId))
    .orderBy(asc(statuses.sort))
    .limit(1);
  const defaultStatusKey = defaultStatusRows[0]?.key ?? "new";

  let added = 0;
  let updated = 0;
  const addedOrderIds: string[] = [];

  for (const order of normalized) {
    const existingRows = await db
      .select({ id: orders.id, shopify: orders.shopify })
      .from(orders)
      .where(
        and(eq(orders.workspaceId, workspaceId), eq(orders.shopifyOrderId, order.shopifyOrderId)),
      )
      .limit(1);
    const existing = existingRows[0];

    if (!existing) {
      const orderId = crypto.randomUUID();
      const insertOrder = db.insert(orders).values({
        id: orderId,
        workspaceId,
        shopifyOrderId: order.shopifyOrderId,
        name: order.name,
        shopify: order,
        statusKey: defaultStatusKey,
        createdAt: order.createdAt || now,
        syncedAt: now,
      });
      const insertEvent = db.insert(events).values({
        id: crypto.randomUUID(),
        workspaceId,
        orderId,
        type: "order_new",
        text: `New order ${order.name}${order.customerName ? " from " + order.customerName : ""}`,
        meta: { orderName: order.name },
        createdAt: now,
      });
      await applyPair(db, insertOrder, insertEvent);
      added++;
      addedOrderIds.push(orderId);
    } else if (JSON.stringify(existing.shopify) !== JSON.stringify(order)) {
      // Refresh the snapshot only. statusKey / statusSetBy / statusSetAt are
      // the team's own fields and a sync must never clobber them, and an
      // updated snapshot gets no new event (order_new is for new orders only).
      await db
        .update(orders)
        .set({ shopify: order, syncedAt: now })
        .where(eq(orders.id, existing.id));
      updated++;
    }
  }

  await db
    .update(storeConnections)
    .set({ lastSyncAt: now, runningUntil: 0, status: "ok", lastError: null })
    .where(eq(storeConnections.workspaceId, workspaceId));

  return { added, updated, addedOrderIds };
}
