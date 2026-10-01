import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { is } from "drizzle-orm";
import { SQLiteTable } from "drizzle-orm/sqlite-core";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";

// Applies the real generated migrations to an in-memory SQLite database and
// asserts the constraints the app relies on, so schema drift breaks the suite.
// Each drizzle migration chunk between statement-breakpoint markers is a single
// statement, so prepare().run() applies it.

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../../drizzle");

const APP_TABLES = [
  "events",
  "notification_prefs",
  "orders",
  "purchase_orders",
  "push_subscriptions",
  "statuses",
  "store_connections",
  "vendors",
  "workspace_members",
  "workspace_settings",
  "workspaces",
];

describe("schema migrations", () => {
  let db: Database;

  beforeAll(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const sql = readFileSync(join(migrationsDir, file), "utf8");
      for (const statement of sql.split("--> statement-breakpoint")) {
        const trimmed = statement.trim();
        if (trimmed.length > 0) {
          db.prepare(trimmed).run();
        }
      }
    }
    db.prepare(
      "INSERT INTO workspaces (id, name, slug, created_by, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run("ws1", "Impact", "impact", "user1", 1);
  });

  afterAll(() => {
    db.close();
  });

  it("rejects an order whose workspace does not exist", () => {
    expect(() =>
      db
        .prepare(
          "INSERT INTO orders (id, workspace_id, shopify_order_id, name, shopify, status_key, created_at, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run("o_fk", "ws_missing", "900", "#900", "{}", "new", 1, 1),
    ).toThrow(/FOREIGN KEY/);
  });

  it("rejects a duplicate status key within a workspace", () => {
    const insert = db.prepare(
      "INSERT INTO statuses (id, workspace_id, key, label, color, sort) VALUES (?, ?, ?, ?, ?, ?)",
    );
    insert.run("st1", "ws1", "new", "New", "#91d500", 0);
    expect(() => insert.run("st2", "ws1", "new", "New again", "#000000", 1)).toThrow(/UNIQUE/);
  });

  it("rejects a duplicate shopify order within a workspace", () => {
    const insert = db.prepare(
      "INSERT INTO orders (id, workspace_id, shopify_order_id, name, shopify, status_key, created_at, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    insert.run("o1", "ws1", "1001", "#1001", "{}", "new", 1, 1);
    expect(() => insert.run("o2", "ws1", "1001", "#1001 dup", "{}", "new", 2, 2)).toThrow(/UNIQUE/);
  });

  it("creates all 11 app tables", () => {
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all();
    const names = rows.map((r) => (r as { name: string }).name);
    for (const table of APP_TABLES) {
      expect(names).toContain(table);
    }
  });

  // Schema-vs-migration drift guard: selects every column of every exported
  // table (app + auth + pending_invites) through drizzle against the migrated
  // database. A column that exists in schema.ts but not in the migrations
  // throws "no such column"; a table missing from the migrations throws
  // "no such table".
  it("matches every exported table and column to the migrations", () => {
    const tables = (Object.values(schema) as unknown[]).filter(
      (value): value is SQLiteTable => is(value, SQLiteTable),
    );
    // 11 app tables + pending_invites + user/session/account/verification
    // + rate_limit.
    expect(tables.length).toBe(17);
    const orm = drizzle(db);
    for (const table of tables) {
      expect(() => orm.select().from(table).all()).not.toThrow();
    }
  });
});
