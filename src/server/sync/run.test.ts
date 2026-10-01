import { describe, it, expect, vi } from "vitest";
import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { and, eq } from "drizzle-orm";
import type { Db } from "../../db";
import * as schema from "../../db/schema";
import { encryptSecret } from "../crypto";
import fixture from "../shopify/__fixtures__/orders-graphql.json";
import { runSync } from "./run";
import { runAllSyncs } from "./cron";

// runSync against a real migrated SQLite database. @cloudflare/vitest-pool-workers
// peer-requires vitest 4 and this repo is on vitest 5, so the D1 in these tests
// is played by better-sqlite3-backed drizzle injected as Db (same migrations,
// same schema SQL; run.ts falls back from db.batch to sequential awaits).

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../../../drizzle");

const TEST_KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const FAKE_TOKEN = "shpat_fake_token_for_tests_0001";
const WS = "ws_impact";
const NOW = Date.parse("2026-10-01T12:00:00.000Z");
const LATER = NOW + 600000;
const SIXTY_DAYS_MS = 60 * 24 * 60 * 60 * 1000;

const TOKEN_UNREADABLE = "Token unreadable, re-enter it in Settings";
const TOKEN_REJECTED = "Shopify rejected the token. Update the connection in Settings.";

const fixtureNodes = (fixture as { data: { orders: { nodes: unknown[] } } }).data.orders.nodes;

const rileyNode = {
  id: "gid://shopify/Order/6101",
  legacyResourceId: "6101",
  name: "#1101",
  createdAt: "2026-09-20T10:00:00Z",
  email: "riley.oakes@example.com",
  customer: { displayName: "Riley Oakes" },
  note: "original note",
  displayFinancialStatus: "PAID",
  displayFulfillmentStatus: "UNFULFILLED",
  currentTotalPriceSet: { shopMoney: { amount: "120.00", currencyCode: "CAD" } },
  tags: [],
  lineItems: { nodes: [] },
};

function openDb() {
  const raw = new Database(":memory:");
  raw.pragma("foreign_keys = ON");
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed.length > 0) {
        raw.prepare(trimmed).run();
      }
    }
  }
  const db = drizzle(raw, { schema }) as unknown as Db;
  const env = { ENCRYPTION_KEY: TEST_KEY } as CloudflareEnv;
  return { db, raw, env };
}

async function seedWorkspace(
  db: Db,
  wsId: string,
  opts?: {
    statuses?: boolean;
    connection?: boolean;
    connectionStatus?: "ok" | "error" | "disabled";
    encryptedToken?: string;
  },
) {
  await db.insert(schema.workspaces).values({
    id: wsId,
    name: "Impact " + wsId,
    slug: wsId,
    createdBy: "user_admin",
    createdAt: 1,
  });
  if (opts?.statuses !== false) {
    await db.insert(schema.statuses).values([
      {
        id: wsId + "_st_received",
        workspaceId: wsId,
        key: "received",
        label: "Received",
        color: "#91d500",
        sort: 0,
      },
      {
        id: wsId + "_st_progress",
        workspaceId: wsId,
        key: "in_progress",
        label: "In progress",
        color: "#101820",
        sort: 10,
      },
    ]);
  }
  if (opts?.connection !== false) {
    await db.insert(schema.storeConnections).values({
      workspaceId: wsId,
      shopDomain: "impact-rentals.myshopify.com",
      encryptedToken: opts?.encryptedToken ?? (await encryptSecret(FAKE_TOKEN, TEST_KEY, wsId)),
      status: opts?.connectionStatus ?? "ok",
    });
  }
}

async function makeDb(opts?: Parameters<typeof seedWorkspace>[2] & { seed?: boolean }) {
  const ctx = openDb();
  if (opts?.seed !== false) {
    await seedWorkspace(ctx.db, WS, opts);
  }
  return ctx;
}

type RecordedCall = { url: string; body: { query?: string } };

function pageFetch(nodes: unknown[]) {
  const calls: RecordedCall[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response(
      JSON.stringify({
        data: { orders: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } },
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  return { impl, calls };
}

function statusFetch(status: number) {
  const calls: RecordedCall[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response("{}", { status });
  }) as typeof fetch;
  return { impl, calls };
}

function errorsFetch(errors: unknown[]) {
  const impl = (async () => new Response(JSON.stringify({ errors }), { status: 200 })) as typeof fetch;
  return { impl };
}

function ordersIn(db: Db, wsId: string) {
  return db.select().from(schema.orders).where(eq(schema.orders.workspaceId, wsId));
}

function eventsIn(db: Db, wsId: string, type: "order_new" | "sync_error") {
  return db
    .select()
    .from(schema.events)
    .where(and(eq(schema.events.workspaceId, wsId), eq(schema.events.type, type)));
}

async function connectionOf(db: Db, wsId: string) {
  const rows = await db
    .select()
    .from(schema.storeConnections)
    .where(eq(schema.storeConnections.workspaceId, wsId));
  return rows[0];
}

describe("runSync", () => {
  it("inserts new orders with an order_new event each, idempotently", async () => {
    const { db, env } = await makeDb();

    const first = pageFetch(fixtureNodes);
    const result = await runSync(db, env, WS, { fetchImpl: first.impl, now: () => NOW });
    expect(result.added).toBe(3);
    expect(result.updated).toBe(0);
    expect(result.skipped).toBeUndefined();
    expect(result.error).toBeUndefined();

    const orderRows = await ordersIn(db, WS);
    expect(orderRows).toHaveLength(3);
    expect(new Set(result.addedOrderIds)).toEqual(new Set(orderRows.map((o) => o.id)));
    for (const row of orderRows) {
      expect(row.statusKey).toBe("received");
      expect(row.syncedAt).toBe(NOW);
    }
    const o1001 = orderRows.find((o) => o.name === "#1001");
    expect(o1001?.shopifyOrderId).toBe("6001");
    expect(o1001?.createdAt).toBe(Date.parse("2026-09-12T14:03:22Z"));

    const newEvents = await eventsIn(db, WS, "order_new");
    expect(newEvents).toHaveLength(3);
    const e1001 = newEvents.find((e) => e.orderId === o1001?.id);
    expect(e1001?.text).toBe("New order #1001 from Riley Oakes");
    expect(e1001?.meta).toEqual({ orderName: "#1001" });

    const afterFirst = await connectionOf(db, WS);
    expect(afterFirst.lastSyncAt).toBe(NOW);
    expect(afterFirst.runningUntil).toBe(0);
    expect(afterFirst.status).toBe("ok");
    expect(afterFirst.lastError).toBeNull();

    const second = pageFetch(fixtureNodes);
    const again = await runSync(db, env, WS, { fetchImpl: second.impl, now: () => LATER });
    expect(again.added).toBe(0);
    expect(again.updated).toBe(0);
    expect(again.addedOrderIds).toEqual([]);
    expect(await ordersIn(db, WS)).toHaveLength(3);
    expect(await eventsIn(db, WS, "order_new")).toHaveLength(3);
    expect((await connectionOf(db, WS)).lastSyncAt).toBe(LATER);
  });

  it("updates a changed snapshot without a second event and preserves custom status fields", async () => {
    const { db, env } = await makeDb();
    await runSync(db, env, WS, { fetchImpl: pageFetch([rileyNode]).impl, now: () => NOW });

    // A teammate moves the order to a custom status between syncs.
    await db
      .update(schema.orders)
      .set({ statusKey: "in_progress", statusSetBy: "user_marta", statusSetAt: 777 })
      .where(eq(schema.orders.workspaceId, WS));

    const changed = { ...rileyNode, note: "updated note" };
    const result = await runSync(db, env, WS, {
      fetchImpl: pageFetch([changed]).impl,
      now: () => LATER,
    });
    expect(result.added).toBe(0);
    expect(result.updated).toBe(1);

    const rows = await ordersIn(db, WS);
    expect(rows).toHaveLength(1);
    expect(rows[0].statusKey).toBe("in_progress");
    expect(rows[0].statusSetBy).toBe("user_marta");
    expect(rows[0].statusSetAt).toBe(777);
    expect((rows[0].shopify as { note: string }).note).toBe("updated note");
    expect(rows[0].syncedAt).toBe(LATER);
    expect(rows[0].name).toBe("#1101");
    expect(await eventsIn(db, WS, "order_new")).toHaveLength(1);
  });

  it("skips while another run holds the lease", async () => {
    const { db, env } = await makeDb();
    await db
      .update(schema.storeConnections)
      .set({ runningUntil: NOW + 60000 })
      .where(eq(schema.storeConnections.workspaceId, WS));

    const { impl, calls } = pageFetch([rileyNode]);
    const result = await runSync(db, env, WS, { fetchImpl: impl, now: () => NOW });
    expect(result.skipped).toBe("running");
    expect(result.added).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("skips when the workspace has no connection", async () => {
    const { db, env } = await makeDb({ connection: false });
    const { impl, calls } = pageFetch([rileyNode]);
    const result = await runSync(db, env, WS, { fetchImpl: impl, now: () => NOW });
    expect(result.skipped).toBe("no-connection");
    expect(calls).toHaveLength(0);
  });

  it("skips a disabled connection", async () => {
    const { db, env } = await makeDb({ connectionStatus: "disabled" });
    const { impl, calls } = pageFetch([rileyNode]);
    const result = await runSync(db, env, WS, { fetchImpl: impl, now: () => NOW });
    expect(result.skipped).toBe("disabled");
    expect(calls).toHaveLength(0);
  });

  it("marks the connection on auth failure and clears the lease", async () => {
    const { db, env } = await makeDb();
    const { impl } = statusFetch(401);
    const result = await runSync(db, env, WS, { fetchImpl: impl, now: () => NOW });
    expect(result.error).toBe(TOKEN_REJECTED);
    expect(result.added).toBe(0);

    const connection = await connectionOf(db, WS);
    expect(connection.status).toBe("error");
    expect(connection.lastError).toBe(TOKEN_REJECTED);
    expect(connection.runningUntil).toBe(0);
    expect(connection.lastSyncAt).toBe(0);
  });

  it("keeps status and lastSyncAt on a transient failure", async () => {
    const { db, env } = await makeDb();
    const previousSync = NOW - 3600000;
    await db
      .update(schema.storeConnections)
      .set({ lastSyncAt: previousSync })
      .where(eq(schema.storeConnections.workspaceId, WS));

    const { impl } = statusFetch(429);
    const result = await runSync(db, env, WS, { fetchImpl: impl, now: () => NOW });
    expect(result.error).toContain("429");

    const connection = await connectionOf(db, WS);
    expect(connection.status).toBe("ok");
    expect(connection.lastError).toContain("429");
    expect(connection.lastSyncAt).toBe(previousSync);
    expect(connection.runningUntil).toBe(0);
    expect(await eventsIn(db, WS, "sync_error")).toHaveLength(0);
  });

  it("writes a sync_error event on fatal failure, truncated to 300 chars", async () => {
    const { db, env } = await makeDb();
    const longMessage = "Z".repeat(400);
    const { impl } = errorsFetch([{ message: longMessage }]);
    const result = await runSync(db, env, WS, { fetchImpl: impl, now: () => NOW });
    expect(result.error).toBe(longMessage);

    const syncErrors = await eventsIn(db, WS, "sync_error");
    expect(syncErrors).toHaveLength(1);
    expect(syncErrors[0].text).toBe("Z".repeat(300));
    expect(syncErrors[0].orderId).toBeNull();
    const connection = await connectionOf(db, WS);
    expect(connection.lastSyncAt).toBe(0);
    expect(connection.runningUntil).toBe(0);
  });

  it("marks the connection when the token cannot be decrypted", async () => {
    const { db, env } = await makeDb({
      encryptedToken: await encryptSecret(FAKE_TOKEN, TEST_KEY, "ws_other"),
    });
    const { impl, calls } = pageFetch([rileyNode]);
    const result = await runSync(db, env, WS, { fetchImpl: impl, now: () => NOW });
    expect(result.error).toBe(TOKEN_UNREADABLE);
    expect(calls).toHaveLength(0);

    const connection = await connectionOf(db, WS);
    expect(connection.status).toBe("error");
    expect(connection.lastError).toBe(TOKEN_UNREADABLE);
    expect(connection.runningUntil).toBe(0);
  });

  it("uses a 60 day window on first sync and a 5 minute overlap after", async () => {
    const { db, env } = await makeDb();

    const first = pageFetch([]);
    await runSync(db, env, WS, { fetchImpl: first.impl, now: () => NOW });
    const firstWindow = new Date(NOW - SIXTY_DAYS_MS).toISOString();
    expect(first.calls[0].body.query).toContain(`updated_at:>='${firstWindow}'`);

    const second = pageFetch([]);
    await runSync(db, env, WS, { fetchImpl: second.impl, now: () => LATER });
    const overlapWindow = new Date(NOW - 300000).toISOString();
    expect(second.calls[0].body.query).toContain(`updated_at:>='${overlapWindow}'`);
  });

  it("falls back to status key new when the workspace has no statuses", async () => {
    const { db, env } = await makeDb({ statuses: false });
    await runSync(db, env, WS, { fetchImpl: pageFetch([rileyNode]).impl, now: () => NOW });
    const rows = await ordersIn(db, WS);
    expect(rows).toHaveLength(1);
    expect(rows[0].statusKey).toBe("new");
  });
});

describe("runAllSyncs", () => {
  it("syncs every enabled connection and isolates one workspace's failure", async () => {
    const { db, raw, env } = openDb();
    await seedWorkspace(db, "ws_a");
    await seedWorkspace(db, "ws_b");
    await seedWorkspace(db, "ws_c", { connectionStatus: "disabled" });

    // Break ws_a behind the foreign key's back: deleting its workspace row
    // makes the order insert inside runSync throw, which must not stop ws_b.
    raw.pragma("foreign_keys = OFF");
    raw.prepare("DELETE FROM workspaces WHERE id = 'ws_a'").run();
    raw.pragma("foreign_keys = ON");

    const { impl, calls } = pageFetch([rileyNode]);
    const logged: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });
    try {
      await runAllSyncs(db, env, { fetchImpl: impl, now: () => NOW });
    } finally {
      spy.mockRestore();
    }

    expect(await ordersIn(db, "ws_b")).toHaveLength(1);
    expect(await ordersIn(db, "ws_a")).toHaveLength(0);
    expect(calls).toHaveLength(2);

    const joined = logged.join("\n");
    expect(joined).toContain("ws_a");
    expect(joined).toContain("ws_b");
    expect(joined).not.toContain("ws_c");
    expect(joined).not.toContain(FAKE_TOKEN);
  });
});
