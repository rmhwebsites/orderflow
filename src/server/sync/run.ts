// One workspace's Shopify sync pass: lease, fetch, normalize, upsert, record.
// Relative imports on purpose: this module is bundled into the custom worker
// entrypoint (cron), not only the Next.js build.

import { and, asc, eq, inArray, lte } from "drizzle-orm";
import type { Db } from "../../db";
import { events, orders, statuses, storeConnections } from "../../db/schema";
import { decryptSecret } from "../crypto";
import { fetchOrdersUpdatedSince } from "../shopify/client";
import { normalizeOrders } from "../shopify/normalize";

export type SyncResult = {
  added: number;
  updated: number;
  // Order row ids inserted / snapshot-updated this run. Phase 5/6 call sites
  // broadcast to the workspace room and fan out notifications from these.
  addedOrderIds: string[];
  updatedOrderIds: string[];
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
const LAST_ERROR_MAX = 300;
const EXISTENCE_CHUNK = 100;

const TOKEN_UNREADABLE = "Token unreadable, re-enter it in Settings";
const TOKEN_REJECTED = "Shopify rejected the token. Update the connection in Settings.";

function clip(text: string): string {
  return text.slice(0, LAST_ERROR_MAX);
}

// Rows affected by a write, across drivers: D1 reports meta.changes, the
// better-sqlite3 test driver reports changes at the top level. An unknown
// shape counts as 1: a double-run is idempotent, a never-run is an outage.
function changesOf(result: unknown): number {
  if (typeof result === "object" && result !== null) {
    const direct = (result as { changes?: unknown }).changes;
    if (typeof direct === "number") {
      return direct;
    }
    const meta = (result as { meta?: { changes?: unknown } }).meta;
    if (meta && typeof meta.changes === "number") {
      return meta.changes;
    }
  }
  return 1;
}

// Two statements that must land together. db.batch is the atomic path on D1;
// the better-sqlite3-backed Db injected by tests has no batch method, so fall
// back to sequential awaits (drizzle builders are thenables that run on await).
// Exported for its own unit tests.
export async function applyPair(
  db: Db,
  a: PromiseLike<unknown>,
  b: PromiseLike<unknown>,
): Promise<void> {
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
  const empty = (): SyncResult => ({ added: 0, updated: 0, addedOrderIds: [], updatedOrderIds: [] });

  const connectionRows = await db
    .select()
    .from(storeConnections)
    .where(eq(storeConnections.workspaceId, workspaceId))
    .limit(1);
  const connection = connectionRows[0];
  if (!connection) {
    return { ...empty(), skipped: "no-connection" };
  }
  if (connection.status === "disabled") {
    return { ...empty(), skipped: "disabled" };
  }

  // Lease CAS: only a run that finds the lease free (or expired) moves
  // running_until forward; a concurrent run matches zero rows and skips.
  // Should a run die mid-way, the lease expires after LEASE_MS and the
  // conflict-safe insert pairs below make the replay a no-op.
  const leaseResult = await db
    .update(storeConnections)
    .set({ runningUntil: now + LEASE_MS })
    .where(
      and(eq(storeConnections.workspaceId, workspaceId), lte(storeConnections.runningUntil, now)),
    );
  if (changesOf(leaseResult) === 0) {
    return { ...empty(), skipped: "running" };
  }

  let added = 0;
  let updated = 0;
  const addedOrderIds: string[] = [];
  const updatedOrderIds: string[] = [];

  try {
    let token: string;
    try {
      token = await decryptSecret(connection.encryptedToken, env.ENCRYPTION_KEY, workspaceId);
    } catch {
      await db
        .update(storeConnections)
        .set({ status: "error", lastError: TOKEN_UNREADABLE, runningUntil: 0 })
        .where(eq(storeConnections.workspaceId, workspaceId));
      return { ...empty(), error: TOKEN_UNREADABLE };
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
      return { ...empty(), error: TOKEN_REJECTED };
    }

    if (fetched.kind === "transient" || fetched.kind === "fatal") {
      // Status and lastSyncAt stay untouched so the next cron tick retries the
      // same window; just record what happened and release the lease.
      const detail = clip(fetched.detail);
      if (fetched.kind === "fatal" && detail !== connection.lastError) {
        // Only the first occurrence of a given failure gets an activity event;
        // a cron retrying every tick must not spam the feed.
        await db.insert(events).values({
          id: crypto.randomUUID(),
          workspaceId,
          orderId: null,
          type: "sync_error",
          text: detail,
          createdAt: now,
        });
      }
      await db
        .update(storeConnections)
        .set({ lastError: detail, runningUntil: 0 })
        .where(eq(storeConnections.workspaceId, workspaceId));
      return { ...empty(), error: fetched.detail };
    }

    const normalized = normalizeOrders(fetched.nodes);

    const defaultStatusRows = await db
      .select({ key: statuses.key })
      .from(statuses)
      .where(eq(statuses.workspaceId, workspaceId))
      .orderBy(asc(statuses.sort))
      .limit(1);
    const defaultStatusKey = defaultStatusRows[0]?.key ?? "new";

    // Existence map in chunks instead of one SELECT per order; maintained
    // inside the loop so a duplicate within the batch takes the update path.
    const existingByShopifyId = new Map<string, { id: string; shopify: unknown }>();
    const shopifyIds = normalized.map((order) => order.shopifyOrderId);
    for (let i = 0; i < shopifyIds.length; i += EXISTENCE_CHUNK) {
      const chunk = shopifyIds.slice(i, i + EXISTENCE_CHUNK);
      const rows = await db
        .select({ id: orders.id, shopifyOrderId: orders.shopifyOrderId, shopify: orders.shopify })
        .from(orders)
        .where(
          and(eq(orders.workspaceId, workspaceId), inArray(orders.shopifyOrderId, chunk)),
        );
      for (const row of rows) {
        existingByShopifyId.set(row.shopifyOrderId, { id: row.id, shopify: row.shopify });
      }
    }

    for (const order of normalized) {
      const existing = existingByShopifyId.get(order.shopifyOrderId);

      if (!existing) {
        const orderId = crypto.randomUUID();
        // Both inserts are conflict no-ops and the event id is deterministic,
        // so a replay of this pair cannot double-insert anything.
        const insertOrder = db
          .insert(orders)
          .values({
            id: orderId,
            workspaceId,
            shopifyOrderId: order.shopifyOrderId,
            name: order.name,
            shopify: order,
            statusKey: defaultStatusKey,
            createdAt: order.createdAt || now,
            syncedAt: now,
          })
          .onConflictDoNothing();
        const insertEvent = db
          .insert(events)
          .values({
            id: `evt-order-new-${orderId}`,
            workspaceId,
            orderId,
            type: "order_new",
            text: `New order ${order.name}${order.customerName ? " from " + order.customerName : ""}`,
            meta: { orderName: order.name },
            createdAt: now,
          })
          .onConflictDoNothing();
        await applyPair(db, insertOrder, insertEvent);
        added++;
        addedOrderIds.push(orderId);
        existingByShopifyId.set(order.shopifyOrderId, { id: orderId, shopify: order });
      } else if (JSON.stringify(existing.shopify) !== JSON.stringify(order)) {
        // Stable diff: normalizeOrders builds keys in one fixed order and JSON
        // parse/stringify round-trips preserve it, so equal snapshots always
        // stringify identically.
        // Refresh the snapshot only. statusKey / statusSetBy / statusSetAt are
        // the team's own fields and a sync must never clobber them, and an
        // updated snapshot gets no new event (order_new is for new orders only).
        await db
          .update(orders)
          .set({ shopify: order, syncedAt: now })
          .where(eq(orders.id, existing.id));
        updated++;
        updatedOrderIds.push(existing.id);
        existingByShopifyId.set(order.shopifyOrderId, { id: existing.id, shopify: order });
      }
    }

    // A truncated fetch stops at the page cap, so anchor lastSyncAt at the
    // newest updatedAt actually gathered: ascending UPDATED_AT sort means the
    // next tick's window picks up exactly where this one stopped, and nothing
    // between watermark and now is silently skipped.
    const watermarkMs =
      fetched.truncated && fetched.maxUpdatedAt ? Date.parse(fetched.maxUpdatedAt) : NaN;
    await db
      .update(storeConnections)
      .set({
        lastSyncAt: Number.isNaN(watermarkMs) ? now : watermarkMs,
        runningUntil: 0,
        status: "ok",
        lastError: null,
      })
      .where(eq(storeConnections.workspaceId, workspaceId));

    return { added, updated, addedOrderIds, updatedOrderIds };
  } catch (e) {
    // Unexpected throw: release the lease and surface the message; the counts
    // so far go back so callers can still broadcast what landed.
    const message = clip(e instanceof Error ? e.message : "sync failed unexpectedly");
    await db
      .update(storeConnections)
      .set({ lastError: message, runningUntil: 0 })
      .where(eq(storeConnections.workspaceId, workspaceId));
    return { added, updated, addedOrderIds, updatedOrderIds, error: message };
  }
}
