import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Db } from "../../db";
import * as schema from "../../db/schema";
import { encryptSecret } from "../crypto";
import { normalizeOrders } from "../shopify/normalize";
import { openTestDb, seedWorkspace } from "../desk/test-helpers";
import { runSync, upsertFetchedOrder } from "./run";

// The sync applies the Shopify -> app status rules (platform amendment
// section 4) to the orders it writes. Stubbed fetch only.

const WS = "ws_impact";
const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const env = { ENCRYPTION_KEY: KEY } as CloudflareEnv;
const NOW = Date.parse("2026-10-02T12:00:00.000Z");

function node(overrides: Record<string, unknown> = {}) {
  return {
    id: "gid://shopify/Order/7001",
    legacyResourceId: "7001",
    name: "#7001",
    createdAt: "2026-10-01T10:00:00Z",
    updatedAt: "2026-10-02T11:00:00Z",
    displayFulfillmentStatus: "UNFULFILLED",
    tags: [],
    fulfillments: [],
    lineItems: { nodes: [], pageInfo: { hasNextPage: false } },
    ...overrides,
  };
}

function pageFetch(nodes: unknown[]) {
  const impl = (async () =>
    new Response(
      JSON.stringify({ data: { orders: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } }),
      { status: 200 },
    )) as typeof fetch;
  return impl;
}

async function setup() {
  const { db } = openTestDb();
  await seedWorkspace(db, WS);
  await db.insert(schema.statuses).values({
    id: `${WS}_st_delivered`,
    workspaceId: WS,
    key: "delivered",
    label: "Delivered",
    color: "green",
    sort: 4,
    shopifyLink: "delivered",
  });
  await db.insert(schema.storeConnections).values({
    workspaceId: WS,
    shopDomain: "impact-rentals.myshopify.com",
    encryptedToken: await encryptSecret("shpat_status_sync_token", KEY, WS),
  });
  return db;
}

// Stores the order as the sync would have, at the given status.
async function seedSynced(db: Db, raw: Record<string, unknown>, statusKey: string, syncedAt = NOW - 600000) {
  const [snapshot] = normalizeOrders([raw]);
  await db.insert(schema.orders).values({
    id: "o1",
    workspaceId: WS,
    shopifyOrderId: snapshot.shopifyOrderId,
    name: snapshot.name,
    shopify: snapshot,
    statusKey,
    createdAt: snapshot.createdAt,
    syncedAt,
  });
}

async function order(db: Db) {
  const rows = await db.select().from(schema.orders).where(eq(schema.orders.workspaceId, WS));
  return rows[0];
}

async function statusEvents(db: Db) {
  return db
    .select()
    .from(schema.events)
    .where(and(eq(schema.events.workspaceId, WS), eq(schema.events.type, "status")));
}

describe("runSync status rules", () => {
  it("starts a new order that is already fulfilled or delivered at its linked status, quietly", async () => {
    const db = await setup();
    const result = await runSync(
      db,
      env,
      WS,
      {
        fetchImpl: pageFetch([
          node({ displayFulfillmentStatus: "FULFILLED", fulfillments: [{ displayStatus: "IN_TRANSIT" }] }),
          node({
            id: "gid://shopify/Order/7002",
            legacyResourceId: "7002",
            name: "#7002",
            displayFulfillmentStatus: "FULFILLED",
            fulfillments: [{ displayStatus: "DELIVERED" }],
          }),
          node({ id: "gid://shopify/Order/7003", legacyResourceId: "7003", name: "#7003", tags: ["Ordering Desk: Approved"] }),
          node({ id: "gid://shopify/Order/7004", legacyResourceId: "7004", name: "#7004" }),
        ]),
        now: () => NOW,
      },
    );
    expect(result.added).toBe(4);
    expect(result.statusChanges).toBeUndefined();
    const rows = await db.select().from(schema.orders).where(eq(schema.orders.workspaceId, WS));
    expect(Object.fromEntries(rows.map((row) => [row.name, row.statusKey]))).toEqual({
      "#7001": "shipped",
      "#7002": "delivered",
      "#7003": "approved",
      "#7004": "new",
    });
    expect(await statusEvents(db)).toHaveLength(0);
  });

  it("moves an order forward when Shopify newly reports it fulfilled, and reports the move", async () => {
    const db = await setup();
    await seedSynced(db, node(), "processing");
    const result = await runSync(db, env, WS, {
      fetchImpl: pageFetch([node({ displayFulfillmentStatus: "FULFILLED", fulfillments: [{ displayStatus: "FULFILLED" }] })]),
      now: () => NOW,
    });
    expect(result.updated).toBe(1);
    expect(result.statusChanges).toEqual([
      {
        event: expect.objectContaining({
          type: "status",
          source: "shopify",
          actorId: null,
          text: "Status set to Shipped: Shopify reports the order fulfilled",
          meta: { from: "processing", to: "shipped", reason: "fulfilled" },
        }),
        order: { id: "o1", statusKey: "shipped", statusSetBy: null, statusSetAt: NOW },
      },
    ]);
    expect(await order(db)).toMatchObject({ statusKey: "shipped", statusSetBy: null });
  });

  it("never moves an order back past a later status", async () => {
    const db = await setup();
    await seedSynced(db, node(), "delivered");
    const result = await runSync(db, env, WS, {
      fetchImpl: pageFetch([node({ displayFulfillmentStatus: "FULFILLED", fulfillments: [{ displayStatus: "FULFILLED" }] })]),
      now: () => NOW,
    });
    expect(result.updated).toBe(1);
    expect(result.statusChanges).toBeUndefined();
    expect((await order(db)).statusKey).toBe("delivered");
  });

  it("adopts a status a person tagged in Shopify", async () => {
    const db = await setup();
    await seedSynced(db, node({ tags: ["Ordering Desk: Shipped"] }), "shipped");
    const result = await runSync(db, env, WS, {
      fetchImpl: pageFetch([node({ tags: ["Ordering Desk: Processing"] })]),
      now: () => NOW,
    });
    expect(result.statusChanges?.map((change) => change.order.statusKey)).toEqual(["processing"]);
    expect((await order(db)).statusKey).toBe("processing");
  });

  // The app moved the order to Shipped and wrote its tag and fulfillment;
  // the sync then sees them.
  it("treats the app's own writes coming back as no change", async () => {
    const db = await setup();
    await seedSynced(db, node({ tags: ["Ordering Desk: Approved"] }), "shipped");
    const result = await runSync(db, env, WS, {
      fetchImpl: pageFetch([
        node({
          tags: ["Ordering Desk: Shipped"],
          displayFulfillmentStatus: "FULFILLED",
          fulfillments: [{ displayStatus: "FULFILLED" }],
        }),
      ]),
      now: () => NOW,
    });
    expect(result.updated).toBe(1);
    expect(result.statusChanges).toBeUndefined();
    expect(await statusEvents(db)).toHaveLength(0);
    expect((await order(db)).statusKey).toBe("shipped");
  });

  it("evaluates nothing for an unchanged snapshot", async () => {
    const db = await setup();
    const fulfilledNode = node({ displayFulfillmentStatus: "FULFILLED", fulfillments: [{ displayStatus: "FULFILLED" }] });
    // Stored fulfilled while the status was left at New: no change, no move.
    await seedSynced(db, fulfilledNode, "new");
    const result = await runSync(db, env, WS, { fetchImpl: pageFetch([fulfilledNode]), now: () => NOW });
    expect(result.updated).toBe(0);
    expect(result.statusChanges).toBeUndefined();
    expect((await order(db)).statusKey).toBe("new");
  });
});

describe("upsertFetchedOrder", () => {
  it("inserts a new order with its order_new event and initial status", async () => {
    const db = await setup();
    const [snapshot] = normalizeOrders([node({ displayFulfillmentStatus: "FULFILLED", fulfillments: [] })]);
    const outcome = await upsertFetchedOrder(db, WS, snapshot, NOW);
    expect(outcome).toEqual({ kind: "added", orderId: expect.any(String), statusChanges: [] });
    const row = await order(db);
    expect(row).toMatchObject({ statusKey: "shipped", syncedAt: NOW });
    const events = await db.select().from(schema.events).where(eq(schema.events.workspaceId, WS));
    expect(events.map((event) => [event.id, event.type])).toEqual([[`evt-order-new-${WS}-7001`, "order_new"]]);
  });

  it("updates a changed snapshot and applies the status rules to it", async () => {
    const db = await setup();
    await seedSynced(db, node(), "approved");
    const [snapshot] = normalizeOrders([node({ displayFulfillmentStatus: "FULFILLED", fulfillments: [{ displayStatus: "FULFILLED" }] })]);
    const outcome = await upsertFetchedOrder(db, WS, snapshot, NOW);
    expect(outcome).toMatchObject({ kind: "updated", orderId: "o1" });
    if (outcome.kind === "updated") {
      expect(outcome.statusChanges.map((change) => change.order.statusKey)).toEqual(["shipped"]);
    }
    expect(await order(db)).toMatchObject({ statusKey: "shipped", syncedAt: NOW });
  });

  // The claim rule: a run that started later owns the row, so an older
  // fetch (here, a webhook that started before it) writes nothing.
  it("leaves a row claimed by a later run alone", async () => {
    const db = await setup();
    await seedSynced(db, node(), "approved", NOW + 1000);
    const before = await order(db);
    const [snapshot] = normalizeOrders([node({ displayFulfillmentStatus: "FULFILLED", fulfillments: [] })]);
    expect(await upsertFetchedOrder(db, WS, snapshot, NOW)).toEqual({ kind: "unchanged" });
    expect(await order(db)).toEqual(before);
  });

  it("reports an identical snapshot as unchanged", async () => {
    const db = await setup();
    await seedSynced(db, node(), "approved");
    const [snapshot] = normalizeOrders([node()]);
    expect(await upsertFetchedOrder(db, WS, snapshot, NOW)).toEqual({ kind: "unchanged" });
  });
});
