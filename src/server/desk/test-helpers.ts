// Test-only support for the desk service tests; never import this from app
// code. Same approach as src/server/sync/run.test.ts: the real drizzle/*.sql
// migrations are applied to an in-memory better-sqlite3 database, which is
// injected as Db (it has no batch method, so applyBatch takes its sequential
// path).

import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { Db } from "@/db";
import * as schema from "@/db/schema";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../../../drizzle");

export function openTestDb() {
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
  return { db, raw };
}

export const TEST_STATUSES = [
  { key: "new", label: "New", color: "lime", triggersPo: false },
  { key: "processing", label: "Processing", color: "blue", triggersPo: false },
  { key: "approved", label: "Approved", color: "green", triggersPo: true },
  { key: "shipped", label: "Shipped", color: "violet", triggersPo: false },
];

// A workspace with its settings row and TEST_STATUSES (sort = list position),
// the way POST /api/workspaces creates one.
export async function seedWorkspace(db: Db, id: string) {
  await db.insert(schema.workspaces).values({
    id,
    name: "Workspace " + id,
    slug: id,
    createdBy: "user_owner",
    createdAt: 1,
  });
  await db.insert(schema.workspaceSettings).values({ workspaceId: id });
  await db.insert(schema.statuses).values(
    TEST_STATUSES.map((status, sort) => ({
      id: `${id}_st_${status.key}`,
      workspaceId: id,
      sort,
      ...status,
    })),
  );
}

// Snapshots are plain records on purpose (not NormalizedOrder literals), so
// these tests do not break when the normalizer gains a field.
export function snapshotOf(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    shopifyOrderId: "5001",
    name: "#1001",
    createdAt: 1000,
    customerName: "Riley Oakes",
    email: "riley.oakes@example.com",
    total: "120.00",
    currency: "CAD",
    financialStatus: "paid",
    fulfillmentStatus: "unfulfilled",
    items: [{ title: "Hard Hat", qty: 2, price: "10.00", sku: "HH-1", variant: "White" }],
    itemsTruncated: false,
    shipping: null,
    tags: "",
    note: "",
    ...overrides,
  };
}

export async function seedOrder(
  db: Db,
  workspaceId: string,
  opts: {
    id: string;
    name?: string;
    statusKey?: string;
    createdAt?: number;
    syncedAt?: number;
    shopify?: unknown;
  },
) {
  await db.insert(schema.orders).values({
    id: opts.id,
    workspaceId,
    shopifyOrderId: "shop-" + opts.id,
    name: opts.name ?? "#" + opts.id,
    shopify: "shopify" in opts ? opts.shopify : snapshotOf(),
    statusKey: opts.statusKey ?? "new",
    createdAt: opts.createdAt ?? 1000,
    syncedAt: opts.syncedAt ?? 2000,
  });
}
