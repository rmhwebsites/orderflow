import { describe, it, expect, vi } from "vitest";
import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../../db";
import * as schema from "../../db/schema";
import { encryptSecret } from "../crypto";
import fixture from "../shopify/__fixtures__/orders-graphql.json";
import { runSync, applyPair, EXISTENCE_CHUNK, type SyncResult } from "./run";
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
const OVERLAP_MS = 300000;

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

async function makeDb(opts?: Parameters<typeof seedWorkspace>[2]) {
  const ctx = openDb();
  await seedWorkspace(ctx.db, WS, opts);
  return ctx;
}

type RecordedCall = {
  url: string;
  body: { query?: string; variables?: { cursor?: unknown; search?: unknown } };
};

type ScriptedPage = { nodes: unknown[]; hasNextPage: boolean; endCursor?: string | null };

// Returns one scripted page per call; the last page repeats if calls overrun.
function scriptedFetch(script: ScriptedPage[]) {
  const calls: RecordedCall[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) });
    const page = script[Math.min(calls.length - 1, script.length - 1)];
    return new Response(
      JSON.stringify({
        data: {
          orders: {
            nodes: page.nodes,
            pageInfo: { hasNextPage: page.hasNextPage, endCursor: page.endCursor ?? null },
          },
        },
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  return { impl, calls };
}

function pageFetch(nodes: unknown[]) {
  return scriptedFetch([{ nodes, hasNextPage: false }]);
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
  const impl = (async () =>
    new Response(JSON.stringify({ errors }), { status: 200 })) as typeof fetch;
  return { impl };
}

type SimOrder = { idNum: number; updatedAtMs: number };

// Window-honoring Shopify simulator (adapted from the review repro harness):
// filters the dataset by the updated_at search window, sorts ascending by
// (updated_at, id) like the Admin API's stable tie-break, pages 50 at a time,
// and optionally rejects any cursor to simulate staleness.
function shopifySim(dataset: SimOrder[], opts?: { rejectCursors?: boolean }) {
  let requests = 0;
  const impl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    requests++;
    const vars = (JSON.parse(String(init?.body ?? "{}")) as {
      variables: { cursor: string | null; search: string };
    }).variables;
    if (vars.cursor !== null && opts?.rejectCursors) {
      return new Response(
        JSON.stringify({ errors: [{ message: `cursor ${vars.cursor} is invalid` }] }),
        { status: 200 },
      );
    }
    const sinceMs = Date.parse(vars.search.match(/'(.*)'/)![1]);
    const windowed = dataset
      .filter((o) => o.updatedAtMs >= sinceMs)
      .sort((a, b) => a.updatedAtMs - b.updatedAtMs || a.idNum - b.idNum);
    const start = vars.cursor ? parseInt(vars.cursor.slice(4), 10) : 0;
    const page = windowed.slice(start, start + 50);
    const end = start + page.length;
    const nodes = page.map((o) => ({
      id: `gid://shopify/Order/${o.idNum}`,
      legacyResourceId: String(o.idNum),
      name: `#${o.idNum}`,
      createdAt: new Date(o.updatedAtMs - 1000).toISOString(),
      updatedAt: new Date(o.updatedAtMs).toISOString(),
      tags: [],
      lineItems: { nodes: [] },
    }));
    return new Response(
      JSON.stringify({
        data: {
          orders: {
            nodes,
            pageInfo: { hasNextPage: end < windowed.length, endCursor: `idx:${end}` },
          },
        },
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  return { impl, count: () => requests };
}

// Proxy whose existence query sees nothing, simulating a racing run that
// inserted the same orders after this run built its existence map.
function withBlindExistenceCheck(db: Db): Db {
  return new Proxy(db as object, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (prop === "select") {
        return (...args: unknown[]) => {
          const fields = args[0] as Record<string, unknown> | undefined;
          if (fields && "shopifyOrderId" in fields) {
            return { from: () => ({ where: async () => [] }) };
          }
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  }) as unknown as Db;
}

// Proxy that adds a D1-style batch to the better-sqlite3 Db so the batch
// branch of applyPair runs in-flow.
function withBatch(db: Db, record: unknown[][]): Db {
  const batch = async (statements: PromiseLike<unknown>[]) => {
    record.push([...statements]);
    const out: unknown[] = [];
    for (const statement of statements) {
      out.push(await statement);
    }
    return out;
  };
  return new Proxy(db as object, {
    get(target, prop) {
      if (prop === "batch") {
        return batch;
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  }) as unknown as Db;
}

// Proxy that rewraps every update result into the D1 shape ({meta: {changes}}),
// to prove the lease CAS reads rows-affected from both driver shapes.
function d1Wrap(builder: unknown): unknown {
  return new Proxy(builder as object, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (prop === "then") {
        return (onFulfilled?: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
          (target as PromiseLike<{ changes?: number }>).then(
            (res) => onFulfilled?.({ success: true, meta: { changes: res?.changes } }),
            onRejected,
          );
      }
      if (typeof value === "function") {
        return (...args: unknown[]) =>
          d1Wrap((value as (...a: unknown[]) => unknown).apply(target, args));
      }
      return value;
    },
  });
}

function withD1UpdateResults(db: Db): Db {
  return new Proxy(db as object, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (prop === "update" && typeof value === "function") {
        return (...args: unknown[]) =>
          d1Wrap((value as (...a: unknown[]) => unknown).apply(target, args));
      }
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  }) as unknown as Db;
}

// Proxy whose Nth bare db.select() (no field list: the two whole-row
// connection reads in runSync) rejects, simulating a transient database error
// on exactly that statement. Every other statement passes through untouched.
function withFailingBareSelect(db: Db, failOnCall: number, message: string): Db {
  let bareSelects = 0;
  return new Proxy(db as object, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (prop === "select") {
        return (...args: unknown[]) => {
          if (args.length === 0) {
            bareSelects++;
            if (bareSelects === failOnCall) {
              return {
                from: () => ({
                  where: () => ({
                    limit: async () => {
                      throw new Error(message);
                    },
                  }),
                }),
              };
            }
          }
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  }) as unknown as Db;
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
    expect(result.updatedOrderIds).toEqual([]);
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
    expect(result.updatedOrderIds).toEqual([rows[0].id]);
    expect(rows[0].statusKey).toBe("in_progress");
    expect(rows[0].statusSetBy).toBe("user_marta");
    expect(rows[0].statusSetAt).toBe(777);
    expect((rows[0].shopify as { note: string }).note).toBe("updated note");
    expect(rows[0].syncedAt).toBe(LATER);
    expect(rows[0].name).toBe("#1101");
    expect(await eventsIn(db, WS, "order_new")).toHaveLength(1);
  });

  it("gives the order_new event a cross-run deterministic id", async () => {
    const { db, env } = await makeDb();
    await runSync(db, env, WS, { fetchImpl: pageFetch([rileyNode]).impl, now: () => NOW });
    const [event] = await eventsIn(db, WS, "order_new");
    expect(event.id).toBe(`evt-order-new-${WS}-6101`);
  });

  it("handles the same order twice in one batch: one row, one event, no throw", async () => {
    const { db, env } = await makeDb();
    const result = await runSync(db, env, WS, {
      fetchImpl: pageFetch([rileyNode, { ...rileyNode }]).impl,
      now: () => NOW,
    });
    expect(result.added).toBe(1);
    expect(result.updated).toBe(0);
    expect(result.error).toBeUndefined();
    expect(await ordersIn(db, WS)).toHaveLength(1);
    expect(await eventsIn(db, WS, "order_new")).toHaveLength(1);
  });

  it("counts an intra-batch duplicate with a changed snapshot as added only", async () => {
    const { db, env } = await makeDb();
    const changed = { ...rileyNode, note: "second copy" };
    const result = await runSync(db, env, WS, {
      fetchImpl: pageFetch([rileyNode, changed]).impl,
      now: () => NOW,
    });
    expect(result.added).toBe(1);
    expect(result.updated).toBe(0);
    expect(result.addedOrderIds).toHaveLength(1);
    expect(result.updatedOrderIds).toEqual([]);
    const rows = await ordersIn(db, WS);
    expect(rows).toHaveLength(1);
    // The newest snapshot in the batch still wins.
    expect((rows[0].shopify as { note: string }).note).toBe("second copy");
    expect(await eventsIn(db, WS, "order_new")).toHaveLength(1);
  });

  it("a losing racer neither double-counts nor double-events a new order", async () => {
    const { db, env } = await makeDb();
    // Winner lands the order and its event first.
    await runSync(db, env, WS, { fetchImpl: pageFetch([rileyNode]).impl, now: () => NOW });
    // The loser's existence map was built before the winner's insert.
    const result = await runSync(withBlindExistenceCheck(db), env, WS, {
      fetchImpl: pageFetch([rileyNode]).impl,
      now: () => LATER,
    });
    expect(result.error).toBeUndefined();
    expect(result.added).toBe(0);
    expect(result.addedOrderIds).toEqual([]);
    expect(await ordersIn(db, WS)).toHaveLength(1);
    expect(await eventsIn(db, WS, "order_new")).toHaveLength(1);
  });

  it("a superseded run cannot clobber connection state or release the new lease", async () => {
    const { db, raw, env } = await makeDb();
    const hijackedLease = NOW + 999999;
    // Mid-run (after the CAS, before any terminal write) another run takes
    // over the lease; this run's terminal auth-failure write must not land.
    const impl = (async () => {
      raw
        .prepare("UPDATE store_connections SET running_until = ? WHERE workspace_id = ?")
        .run(hijackedLease, WS);
      return new Response("{}", { status: 401 });
    }) as typeof fetch;

    const result = await runSync(db, env, WS, { fetchImpl: impl, now: () => NOW });
    expect(result.superseded).toBe(true);

    const connection = await connectionOf(db, WS);
    expect(connection.status).toBe("ok");
    expect(connection.lastError).toBeNull();
    expect(connection.runningUntil).toBe(hijackedLease);
  });

  it("a zombie run cannot regress a snapshot written by a newer run", async () => {
    const { db, env } = await makeDb();
    await runSync(db, env, WS, {
      fetchImpl: pageFetch([rileyNode]).impl,
      now: () => NOW - 600000,
    });

    // Run A starts at NOW and its fetch hangs past the 120 second lease.
    // While it hangs, run B (started at LATER) takes the expired lease, writes
    // a newer snapshot of the same order and finishes. Only then does A's
    // fetch return, carrying the older snapshot.
    const stale = { ...rileyNode, note: "stale note from zombie run A" };
    const fresh = { ...rileyNode, note: "fresh note from run B" };
    const stalePage = pageFetch([stale]);
    let runB: SyncResult | undefined;
    const zombieFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      runB = await runSync(db, env, WS, { fetchImpl: pageFetch([fresh]).impl, now: () => LATER });
      return stalePage.impl(input, init);
    }) as typeof fetch;

    const runA = await runSync(db, env, WS, { fetchImpl: zombieFetch, now: () => NOW });

    const rows = await ordersIn(db, WS);
    expect(rows).toHaveLength(1);
    expect(runB?.updated).toBe(1);
    expect(runB?.updatedOrderIds).toEqual([rows[0].id]);
    expect(runB?.superseded).toBeUndefined();

    // A's stale update changed nothing and is not reported.
    expect((rows[0].shopify as { note: string }).note).toBe("fresh note from run B");
    expect(rows[0].syncedAt).toBe(LATER);
    expect(runA.updated).toBe(0);
    expect(runA.updatedOrderIds).toEqual([]);
    expect(runA.added).toBe(0);
    expect(runA.addedOrderIds).toEqual([]);
    expect(runA.superseded).toBe(true);

    // B's terminal connection state stands.
    const connection = await connectionOf(db, WS);
    expect(connection.lastSyncAt).toBe(LATER);
    expect(connection.runningUntil).toBe(0);
  });

  it("a superseded run still reports the rows that landed, and only those", async () => {
    const { db, env } = await makeDb();
    await runSync(db, env, WS, {
      fetchImpl: pageFetch([rileyNode]).impl,
      now: () => NOW - 600000,
    });

    // Zombie run A carries a stale snapshot of the existing order plus an
    // order nobody has seen yet. B refreshes the existing order meanwhile.
    const stale = { ...rileyNode, note: "stale note from zombie run A" };
    const fresh = { ...rileyNode, note: "fresh note from run B" };
    const unseen = {
      ...rileyNode,
      id: "gid://shopify/Order/6102",
      legacyResourceId: "6102",
      name: "#1102",
    };
    const zombiePage = pageFetch([stale, unseen]);
    const zombieFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      await runSync(db, env, WS, { fetchImpl: pageFetch([fresh]).impl, now: () => LATER });
      return zombiePage.impl(input, init);
    }) as typeof fetch;

    const runA = await runSync(db, env, WS, { fetchImpl: zombieFetch, now: () => NOW });
    expect(runA.superseded).toBe(true);

    const rows = await ordersIn(db, WS);
    expect(rows).toHaveLength(2);
    const existing = rows.find((o) => o.shopifyOrderId === "6101");
    const inserted = rows.find((o) => o.shopifyOrderId === "6102");

    // The insert genuinely landed, so it is reported even though A was
    // superseded; the guarded-away update is not.
    expect(runA.added).toBe(1);
    expect(runA.addedOrderIds).toEqual([inserted?.id]);
    expect(runA.updated).toBe(0);
    expect(runA.updatedOrderIds).toEqual([]);
    expect((existing?.shopify as { note: string }).note).toBe("fresh note from run B");
    expect(existing?.syncedAt).toBe(LATER);
    expect(await eventsIn(db, WS, "order_new")).toHaveLength(2);
  });

  it("counts a landed snapshot update from the D1 result shape", async () => {
    const { db, env } = await makeDb();
    const d1ish = withD1UpdateResults(db);
    await runSync(d1ish, env, WS, { fetchImpl: pageFetch([rileyNode]).impl, now: () => NOW });

    const changed = { ...rileyNode, note: "updated note" };
    const result = await runSync(d1ish, env, WS, {
      fetchImpl: pageFetch([changed]).impl,
      now: () => LATER,
    });
    const rows = await ordersIn(db, WS);
    expect(result.updated).toBe(1);
    expect(result.updatedOrderIds).toEqual([rows[0].id]);
    expect((rows[0].shopify as { note: string }).note).toBe("updated note");
  });

  it("releases the lease and records lastError when the post-lease connection re-read throws", async () => {
    const { db, env } = await makeDb();
    const { impl, calls } = pageFetch([rileyNode]);
    // Bare select 1 is the pre-lease read; bare select 2 is the fresh re-read
    // taken right after the lease compare-and-swap succeeds.
    const flaky = withFailingBareSelect(db, 2, "D1_ERROR: transient read failure");

    const result = await runSync(flaky, env, WS, { fetchImpl: impl, now: () => NOW });
    expect(result.error).toBe("D1_ERROR: transient read failure");
    expect(result.added).toBe(0);
    expect(result.updated).toBe(0);
    expect(result.superseded).toBeUndefined();
    expect(calls).toHaveLength(0);

    const connection = await connectionOf(db, WS);
    expect(connection.runningUntil).toBe(0);
    expect(connection.lastError).toBe("D1_ERROR: transient read failure");
    expect(connection.status).toBe("ok");
    expect(connection.lastSyncAt).toBe(0);

    // The lease is free again: the very next tick runs normally.
    const next = await runSync(db, env, WS, {
      fetchImpl: pageFetch([rileyNode]).impl,
      now: () => NOW + 1000,
    });
    expect(next.skipped).toBeUndefined();
    expect(next.added).toBe(1);
  });

  it("clears the lease and records lastError when the write loop throws", async () => {
    const { db, raw, env } = openDb();
    await seedWorkspace(db, WS);
    // Remove the workspace row behind the foreign key's back so the order
    // insert throws mid-loop.
    raw.pragma("foreign_keys = OFF");
    raw.prepare("DELETE FROM workspaces WHERE id = ?").run(WS);
    raw.pragma("foreign_keys = ON");

    const result = await runSync(db, env, WS, {
      fetchImpl: pageFetch([rileyNode]).impl,
      now: () => NOW,
    });
    expect(result.error).toBeTruthy();
    expect(result.added).toBe(0);

    const connection = await connectionOf(db, WS);
    expect(connection.runningUntil).toBe(0);
    expect(connection.lastError).toContain("FOREIGN KEY");
    expect(connection.lastSyncAt).toBe(0);
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

  it("reads the lease CAS rows-affected from the D1 result shape too", async () => {
    const { db, env } = await makeDb();
    const d1ish = withD1UpdateResults(db);

    const free = pageFetch([rileyNode]);
    const first = await runSync(d1ish, env, WS, { fetchImpl: free.impl, now: () => NOW });
    expect(first.added).toBe(1);

    await db
      .update(schema.storeConnections)
      .set({ runningUntil: LATER + 60000 })
      .where(eq(schema.storeConnections.workspaceId, WS));
    const blocked = pageFetch([rileyNode]);
    const second = await runSync(d1ish, env, WS, { fetchImpl: blocked.impl, now: () => LATER });
    expect(second.skipped).toBe("running");
    expect(blocked.calls).toHaveLength(0);
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

  it("treats an unexpected 2xx response shape as transient and keeps lastSyncAt", async () => {
    const { db, env } = await makeDb();
    const previousSync = NOW - 3600000;
    await db
      .update(schema.storeConnections)
      .set({ lastSyncAt: previousSync })
      .where(eq(schema.storeConnections.workspaceId, WS));

    // statusFetch(200) returns a bare {} body: no data.orders object.
    const { impl } = statusFetch(200);
    const result = await runSync(db, env, WS, { fetchImpl: impl, now: () => NOW });
    expect(result.error).toBe("unexpected response shape");

    const connection = await connectionOf(db, WS);
    expect(connection.status).toBe("ok");
    expect(connection.lastSyncAt).toBe(previousSync);
    expect(connection.runningUntil).toBe(0);
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
    expect(connection.lastError).toBe("Z".repeat(300));
    expect(connection.lastSyncAt).toBe(0);
    expect(connection.runningUntil).toBe(0);
  });

  it("writes a sync_error event only when the fatal detail changes", async () => {
    const { db, env } = await makeDb();
    await runSync(db, env, WS, {
      fetchImpl: errorsFetch([{ message: "schema mismatch" }]).impl,
      now: () => NOW,
    });
    await runSync(db, env, WS, {
      fetchImpl: errorsFetch([{ message: "schema mismatch" }]).impl,
      now: () => NOW + 1000,
    });
    expect(await eventsIn(db, WS, "sync_error")).toHaveLength(1);

    await runSync(db, env, WS, {
      fetchImpl: errorsFetch([{ message: "different failure" }]).impl,
      now: () => NOW + 2000,
    });
    expect(await eventsIn(db, WS, "sync_error")).toHaveLength(2);
  });

  it("does not repeat a sync_error event when the same fatal recurs after transient blips", async () => {
    const { db, env } = await makeDb();
    await runSync(db, env, WS, {
      fetchImpl: errorsFetch([{ message: "schema mismatch" }]).impl,
      now: () => NOW,
    });
    // A transient blip rewrites lastError in between.
    await runSync(db, env, WS, { fetchImpl: statusFetch(503).impl, now: () => NOW + 600000 });
    await runSync(db, env, WS, {
      fetchImpl: errorsFetch([{ message: "schema mismatch" }]).impl,
      now: () => NOW + 1200000,
    });
    expect(await eventsIn(db, WS, "sync_error")).toHaveLength(1);
  });

  it("caps alternating fatal texts at one event each per hour", async () => {
    const { db, env } = await makeDb();
    const failWith = (message: string, at: number) =>
      runSync(db, env, WS, { fetchImpl: errorsFetch([{ message }]).impl, now: () => at });

    await failWith("failure alpha", NOW);
    await failWith("failure beta", NOW + 600000);
    await failWith("failure alpha", NOW + 1200000);
    await failWith("failure beta", NOW + 1800000);
    expect(await eventsIn(db, WS, "sync_error")).toHaveLength(2);

    // Over an hour after the first alpha event, alpha may be recorded again.
    await failWith("failure alpha", NOW + 3700000);
    expect(await eventsIn(db, WS, "sync_error")).toHaveLength(3);
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
    expect(first.calls[0].body.variables?.search).toBe(`updated_at:>='${firstWindow}'`);

    const second = pageFetch([]);
    await runSync(db, env, WS, { fetchImpl: second.impl, now: () => LATER });
    const overlapWindow = new Date(NOW - OVERLAP_MS).toISOString();
    expect(second.calls[0].body.variables?.search).toBe(`updated_at:>='${overlapWindow}'`);
  });

  it("drains a dense same-second cluster past the page cap via cursor resumption", async () => {
    const { db, env } = await makeDb();
    const T = Date.parse("2026-09-25T12:00:00.000Z");
    // 600 orders bulk-updated on the same second, plus one genuinely new
    // order ten minutes later. The watermark approach livelocks here.
    const dataset: SimOrder[] = [];
    for (let i = 1; i <= 600; i++) {
      dataset.push({ idNum: i, updatedAtMs: T });
    }
    dataset.push({ idNum: 9999, updatedAtMs: T + 600000 });
    await db
      .update(schema.storeConnections)
      .set({ lastSyncAt: T - 3600000 })
      .where(eq(schema.storeConnections.workspaceId, WS));

    const sim = shopifySim(dataset);
    let totalAdded = 0;
    for (let tick = 1; tick <= 3; tick++) {
      const result = await runSync(db, env, WS, {
        fetchImpl: sim.impl,
        now: () => T + (10 + tick * 10) * 60000,
      });
      expect(result.error).toBeUndefined();
      totalAdded += result.added;
    }

    expect(totalAdded).toBe(601);
    const rows = await ordersIn(db, WS);
    expect(rows).toHaveLength(601);
    expect(rows.some((o) => o.shopifyOrderId === "9999")).toBe(true);
    const connection = await connectionOf(db, WS);
    expect(connection.status).toBe("ok");
    expect(connection.syncCursor).toBeNull();
    expect(connection.syncCursorSince).toBeNull();
  });

  it("persists the cursor on truncation and leaves lastSyncAt untouched", async () => {
    const { db, env } = await makeDb();
    const T = Date.parse("2026-09-25T12:00:00.000Z");
    const previousSync = T - 3600000;
    const dataset: SimOrder[] = Array.from({ length: 620 }, (_, i) => ({
      idNum: i + 1,
      updatedAtMs: T + (i + 1) * 60000,
    }));
    await db
      .update(schema.storeConnections)
      .set({ lastSyncAt: previousSync })
      .where(eq(schema.storeConnections.workspaceId, WS));

    const sim = shopifySim(dataset);
    const r1 = await runSync(db, env, WS, { fetchImpl: sim.impl, now: () => T + 700 * 60000 });
    expect(r1.added).toBe(500);
    const afterTruncated = await connectionOf(db, WS);
    expect(afterTruncated.syncCursor).toBe("idx:500");
    expect(afterTruncated.syncCursorSince).toBe(previousSync - OVERLAP_MS);
    expect(afterTruncated.lastSyncAt).toBe(previousSync);
    expect(afterTruncated.status).toBe("ok");

    // The continuation reuses the persisted window, not a fresh one.
    const r2 = await runSync(db, env, WS, { fetchImpl: sim.impl, now: () => T + 701 * 60000 });
    expect(r2.added).toBe(120);
    const afterComplete = await connectionOf(db, WS);
    expect(afterComplete.syncCursor).toBeNull();
    expect(afterComplete.syncCursorSince).toBeNull();
    // A completed continuation anchors at its own run's now (the cursor chain
    // has drained everything up to that moment), not at the chain watermark.
    expect(afterComplete.lastSyncAt).toBe(T + 701 * 60000);
    expect(await ordersIn(db, WS)).toHaveLength(620);
  });

  it("never regresses lastSyncAt by more than the overlap and keeps every order", async () => {
    const { db, env } = await makeDb();
    const T = Date.parse("2026-09-25T12:00:00.000Z");
    // A burst of 550 orders inside the overlap window just behind lastSyncAt.
    const dataset: SimOrder[] = Array.from({ length: 550 }, (_, i) => ({
      idNum: i + 1,
      updatedAtMs: T - 240000 + Math.floor((i + 1) / 3) * 1000,
    }));
    await db
      .update(schema.storeConnections)
      .set({ lastSyncAt: T })
      .where(eq(schema.storeConnections.workspaceId, WS));

    const sim = shopifySim(dataset);
    let lastResult;
    for (let tick = 1; tick <= 4; tick++) {
      const before = (await connectionOf(db, WS)).lastSyncAt;
      lastResult = await runSync(db, env, WS, { fetchImpl: sim.impl, now: () => T + tick * 600000 });
      expect(lastResult.error).toBeUndefined();
      const after = (await connectionOf(db, WS)).lastSyncAt;
      expect(after).toBeGreaterThanOrEqual(before - OVERLAP_MS);
    }
    expect(await ordersIn(db, WS)).toHaveLength(550);
    expect(lastResult?.added).toBe(0);
  });

  it("settles to one cheap fetch per tick on an idle shop after draining a dense burst", async () => {
    const { db, env } = await makeDb();
    const T = Date.parse("2026-09-25T12:00:00.000Z");
    // 550 orders bulk-updated in the same moment: more than one run's page cap.
    const dataset: SimOrder[] = Array.from({ length: 550 }, (_, i) => ({
      idNum: i + 1,
      updatedAtMs: T,
    }));
    await db
      .update(schema.storeConnections)
      .set({ lastSyncAt: T - 3600000 })
      .where(eq(schema.storeConnections.workspaceId, WS));

    const sim = shopifySim(dataset);
    const tickAt = (tick: number) => T + tick * 600000;

    // Tick 1 stops at the page cap and persists the cursor; tick 2 resumes
    // from it and completes the window.
    const r1 = await runSync(db, env, WS, { fetchImpl: sim.impl, now: () => tickAt(1) });
    expect(r1.added).toBe(500);
    expect((await connectionOf(db, WS)).syncCursor).toBe("idx:500");
    const r2 = await runSync(db, env, WS, { fetchImpl: sim.impl, now: () => tickAt(2) });
    expect(r2.added).toBe(50);
    expect(await ordersIn(db, WS)).toHaveLength(550);

    // The shop is now idle. Every further tick must be a single non-truncated
    // request that adds nothing and persists no cursor, never a re-fetch of
    // the burst.
    for (let tick = 3; tick <= 7; tick++) {
      const requestsBefore = sim.count();
      const result = await runSync(db, env, WS, { fetchImpl: sim.impl, now: () => tickAt(tick) });
      expect(result.error).toBeUndefined();
      expect(sim.count() - requestsBefore).toBe(1);
      expect(result.added).toBe(0);
      expect(result.updated).toBe(0);
      const connection = await connectionOf(db, WS);
      expect(connection.syncCursor).toBeNull();
      expect(connection.syncCursorSince).toBeNull();
      expect(connection.lastSyncAt).toBe(tickAt(tick));
    }
    expect(await ordersIn(db, WS)).toHaveLength(550);
  });

  it("recovers when Shopify rejects a persisted cursor", async () => {
    const { db, env } = await makeDb();
    const T = Date.parse("2026-09-25T12:00:00.000Z");
    const previousSync = T - 3600000;
    const dataset: SimOrder[] = Array.from({ length: 620 }, (_, i) => ({
      idNum: i + 1,
      updatedAtMs: T + (i + 1) * 60000,
    }));
    await db
      .update(schema.storeConnections)
      .set({ lastSyncAt: previousSync })
      .where(eq(schema.storeConnections.workspaceId, WS));

    const honest = shopifySim(dataset);
    const r1 = await runSync(db, env, WS, { fetchImpl: honest.impl, now: () => T + 700 * 60000 });
    expect(r1.added).toBe(500);
    expect((await connectionOf(db, WS)).syncCursor).toBe("idx:500");

    // The persisted cursor has gone stale: Shopify rejects it (fatal).
    const rejecting = shopifySim(dataset, { rejectCursors: true });
    const r2 = await runSync(db, env, WS, { fetchImpl: rejecting.impl, now: () => T + 701 * 60000 });
    expect(r2.error).toContain("cursor");
    const afterReject = await connectionOf(db, WS);
    expect(afterReject.syncCursor).toBeNull();
    expect(afterReject.syncCursorSince).toBeNull();
    expect(afterReject.lastError).toContain("cursor");
    expect(afterReject.lastSyncAt).toBe(previousSync);

    // Next ticks fall back to the plain window path and still drain the rest.
    await runSync(db, env, WS, { fetchImpl: honest.impl, now: () => T + 702 * 60000 });
    await runSync(db, env, WS, { fetchImpl: honest.impl, now: () => T + 703 * 60000 });
    expect(await ordersIn(db, WS)).toHaveLength(620);
    expect((await connectionOf(db, WS)).syncCursor).toBeNull();
  });

  it("keeps a full existence chunk within the D1 bound-parameter limit", () => {
    const { db } = openDb();
    expect(EXISTENCE_CHUNK).toBe(50);
    const chunk = Array.from({ length: EXISTENCE_CHUNK }, (_, i) => String(9000 + i));
    const query = db
      .select({
        id: schema.orders.id,
        shopifyOrderId: schema.orders.shopifyOrderId,
        shopify: schema.orders.shopify,
      })
      .from(schema.orders)
      .where(
        and(eq(schema.orders.workspaceId, WS), inArray(schema.orders.shopifyOrderId, chunk)),
      );
    const bound = query.toSQL().params.length;
    expect(bound).toBe(EXISTENCE_CHUNK + 1);
    expect(bound).toBeLessThanOrEqual(100);
  });

  it("falls back to status key new when the workspace has no statuses", async () => {
    const { db, env } = await makeDb({ statuses: false });
    await runSync(db, env, WS, { fetchImpl: pageFetch([rileyNode]).impl, now: () => NOW });
    const rows = await ordersIn(db, WS);
    expect(rows).toHaveLength(1);
    expect(rows[0].statusKey).toBe("new");
  });

  it("handles batches larger than one existence-query chunk", async () => {
    const { db, env } = await makeDb();
    const nodes = Array.from({ length: 120 }, (_, i) => ({
      id: `gid://shopify/Order/${8000 + i}`,
      legacyResourceId: String(8000 + i),
      name: `#8${String(i).padStart(3, "0")}`,
      tags: [],
      lineItems: { nodes: [] },
    }));

    const r1 = await runSync(db, env, WS, { fetchImpl: pageFetch(nodes).impl, now: () => NOW });
    expect(r1.added).toBe(120);
    const r2 = await runSync(db, env, WS, { fetchImpl: pageFetch(nodes).impl, now: () => LATER });
    expect(r2.added).toBe(0);
    expect(r2.updated).toBe(0);
    expect(await ordersIn(db, WS)).toHaveLength(120);
    expect(await eventsIn(db, WS, "order_new")).toHaveLength(120);
  });

  it("runs the insert pair through a shimmed db.batch in-flow", async () => {
    const { db, env } = await makeDb();
    const batched: unknown[][] = [];
    const result = await runSync(withBatch(db, batched), env, WS, {
      fetchImpl: pageFetch([rileyNode]).impl,
      now: () => NOW,
    });
    expect(result.added).toBe(1);
    expect(batched).toHaveLength(1);
    expect(batched[0]).toHaveLength(2);
    expect(await ordersIn(db, WS)).toHaveLength(1);
    expect(await eventsIn(db, WS, "order_new")).toHaveLength(1);
  });
});

describe("applyPair", () => {
  it("routes both statements through db.batch without awaiting them individually", async () => {
    const batch = vi.fn(async () => ["order-result", "event-result"]);
    const a = { then: vi.fn() };
    const b = { then: vi.fn() };
    const results = await applyPair(
      { batch } as unknown as Db,
      a as unknown as PromiseLike<unknown>,
      b as unknown as PromiseLike<unknown>,
    );
    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch).toHaveBeenCalledWith([a, b]);
    expect(a.then).not.toHaveBeenCalled();
    expect(b.then).not.toHaveBeenCalled();
    expect(results).toEqual(["order-result", "event-result"]);
  });

  it("awaits the statements in order and returns their results when batch is unavailable", async () => {
    const executed: string[] = [];
    const statement = (name: string) =>
      ({
        then: (resolve: (value: unknown) => void) => {
          executed.push(name);
          resolve(`${name}-result`);
        },
      }) as PromiseLike<unknown>;
    const results = await applyPair({} as Db, statement("order"), statement("event"));
    expect(executed).toEqual(["order", "event"]);
    expect(results).toEqual(["order-result", "event-result"]);
  });
});

describe("runAllSyncs", () => {
  it("syncs every enabled connection and isolates one workspace's failure", async () => {
    const { db, raw, env } = openDb();
    await seedWorkspace(db, "ws_a");
    await seedWorkspace(db, "ws_b");
    await seedWorkspace(db, "ws_c", { connectionStatus: "disabled" });

    // Break ws_a behind the foreign key's back: deleting its workspace row
    // makes the order insert inside runSync fail, which must not stop ws_b.
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
