import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { decryptSecret, encryptSecret } from "@/server/crypto";
import {
  TOKEN_MAX,
  deleteConnection,
  normalizeShopDomain,
  normalizeToken,
  saveConnection,
} from "./connection";
import { openTestDb, seedOrder, seedWorkspace } from "./test-helpers";

const WS = "ws_impact";
const OTHER = "ws_other";
const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const TOKEN = "shpat_connection_test_token_7c1d";
const NEW_TOKEN = "shpat_rotated_token_value_9e2f";

async function setup() {
  const { db } = openTestDb();
  await seedWorkspace(db, WS);
  await seedWorkspace(db, OTHER);
  return db;
}

type Call = { url: string; init: RequestInit };

// Answers every request with the given status and JSON body, recording calls.
function shopFetch(status: number, body: unknown) {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { impl, calls };
}

const okShop = () => shopFetch(200, { data: { shop: { name: "IMPACT Rentals" } } });

async function connectionRow(db: Db, workspaceId = WS) {
  const rows = await db
    .select()
    .from(schema.storeConnections)
    .where(eq(schema.storeConnections.workspaceId, workspaceId));
  return rows[0];
}

async function seedConnection(db: Db, overrides: Partial<typeof schema.storeConnections.$inferInsert> = {}) {
  await db.insert(schema.storeConnections).values({
    workspaceId: WS,
    shopDomain: "impactrentals.myshopify.com",
    encryptedToken: await encryptSecret(TOKEN, KEY, WS),
    status: "error",
    lastError: "Shopify rejected the token. Update the connection in Settings.",
    lastSyncAt: 1_759_000_000_000,
    lastManualSyncAt: 1_759_000_100_000,
    runningUntil: 9_999_999_999_999,
    syncCursor: "1759000000000|cursor-abc",
    syncCursorSince: 1_758_000_000_000,
    ...overrides,
  });
}

const ctx = (fetchImpl: typeof fetch) => ({ workspaceId: WS, encryptionKey: KEY, fetchImpl });

describe("normalizeShopDomain", () => {
  it("normalizes handles, mixed case, schemes, paths and queries to the myshopify host", () => {
    const table: Array<[string, string]> = [
      ["impactrentals", "impactrentals.myshopify.com"],
      ["ImpactRentals.myshopify.com ", "impactrentals.myshopify.com"],
      ["https://impactrentals.myshopify.com/admin/orders", "impactrentals.myshopify.com"],
      ["http://impactrentals.myshopify.com/", "impactrentals.myshopify.com"],
      ["HTTPS://IMPACT-RENTALS.MYSHOPIFY.COM?ref=admin", "impact-rentals.myshopify.com"],
      ["impactrentals.myshopify.com#orders", "impactrentals.myshopify.com"],
      ["  impact-rentals-2  ", "impact-rentals-2.myshopify.com"],
      // A store handle is one DNS label: at most 63 characters.
      ["a".repeat(63), "a".repeat(63) + ".myshopify.com"],
    ];
    for (const [input, expected] of table) {
      expect(normalizeShopDomain(input), input).toBe(expected);
    }
  });

  it("rejects anything that is not a myshopify.com store address", () => {
    const rejected: unknown[] = [
      "example.com",
      "evil.myshopify.com.attacker.io",
      "https://evil.example/impactrentals.myshopify.com",
      "impactrentals.myshopify.com.evil.example/",
      "admin.shopify.com/store/impactrentals",
      "user@impactrentals.myshopify.com",
      "impactrentals.myshopify.com:443",
      "ftp://impactrentals.myshopify.com",
      "https://https://impactrentals.myshopify.com",
      "-impact",
      "impact rentals",
      "impact_rentals",
      "a".repeat(64),
      "a".repeat(64) + ".myshopify.com",
      "",
      "   ",
      "x".repeat(3000),
      42,
      null,
      undefined,
    ];
    for (const input of rejected) {
      expect(normalizeShopDomain(input), JSON.stringify(input)?.slice(0, 60)).toBeNull();
    }
  });
});

describe("normalizeToken", () => {
  it("trims and accepts up to 255 non-whitespace characters", () => {
    expect(TOKEN_MAX).toBe(255);
    expect(normalizeToken(`  ${TOKEN}  `)).toBe(TOKEN);
    expect(normalizeToken("t".repeat(TOKEN_MAX))).toBe("t".repeat(TOKEN_MAX));
  });

  // The token travels in an HTTP header, which only carries visible ASCII.
  it("rejects empty, too long, whitespace, control, non-ASCII and non-string tokens", () => {
    for (const input of [
      "",
      "   ",
      "t".repeat(TOKEN_MAX + 1),
      "shpat_abc def",
      "shpat_\tabc",
      "a\nb",
      "shpat_\u0000abc",
      "shpat_tök",
      "shpat_ abc",
      7,
      null,
    ]) {
      expect(normalizeToken(input), JSON.stringify(input)?.slice(0, 40)).toBeNull();
    }
  });
});

describe("saveConnection", () => {
  it("verifies, then stores a new connection encrypted with aad = workspaceId", async () => {
    const db = await setup();
    const shop = okShop();
    const result = await saveConnection(db, ctx(shop.impl), {
      shopDomain: "https://ImpactRentals.myshopify.com/admin",
      token: `  ${TOKEN} `,
    });

    expect(result).toEqual({
      kind: "saved",
      connection: {
        shopDomain: "impactrentals.myshopify.com",
        status: "ok",
        lastSyncAt: 0,
        shopName: "IMPACT Rentals",
      },
    });
    // The verification call went to the normalized host with the trimmed token.
    expect(shop.calls).toHaveLength(1);
    expect(shop.calls[0].url.startsWith("https://impactrentals.myshopify.com/admin/api/")).toBe(true);
    expect((shop.calls[0].init.headers as Record<string, string>)["X-Shopify-Access-Token"]).toBe(TOKEN);

    const row = await connectionRow(db);
    expect(row).toMatchObject({
      shopDomain: "impactrentals.myshopify.com",
      status: "ok",
      lastError: null,
      lastSyncAt: 0,
      runningUntil: 0,
      syncCursor: null,
      syncCursorSince: null,
    });
    expect(row.encryptedToken).not.toContain(TOKEN);
    expect(await decryptSecret(row.encryptedToken, KEY, WS)).toBe(TOKEN);
    await expect(decryptSecret(row.encryptedToken, KEY, OTHER)).rejects.toThrow();
    await expect(decryptSecret(row.encryptedToken, KEY)).rejects.toThrow();
  });

  it("resets the sync state and the lease when the shop domain changes", async () => {
    const db = await setup();
    await seedConnection(db);
    const result = await saveConnection(db, ctx(okShop().impl), {
      shopDomain: "impact-two",
      token: NEW_TOKEN,
    });
    expect(result).toMatchObject({
      kind: "saved",
      connection: { shopDomain: "impact-two.myshopify.com", status: "ok", lastSyncAt: 0 },
    });

    const row = await connectionRow(db);
    expect(row).toMatchObject({
      shopDomain: "impact-two.myshopify.com",
      status: "ok",
      lastError: null,
      lastSyncAt: 0,
      syncCursor: null,
      syncCursorSince: null,
      runningUntil: 0,
    });
    expect(await decryptSecret(row.encryptedToken, KEY, WS)).toBe(NEW_TOKEN);
  });

  it("keeps lastSyncAt and the cursor when only the token changes", async () => {
    const db = await setup();
    await seedConnection(db);
    const result = await saveConnection(db, ctx(okShop().impl), {
      shopDomain: "impactrentals.myshopify.com",
      token: NEW_TOKEN,
    });
    expect(result).toMatchObject({
      kind: "saved",
      connection: { shopDomain: "impactrentals.myshopify.com", lastSyncAt: 1_759_000_000_000 },
    });

    const row = await connectionRow(db);
    expect(row).toMatchObject({
      status: "ok",
      lastError: null,
      lastSyncAt: 1_759_000_000_000,
      lastManualSyncAt: 1_759_000_100_000,
      syncCursor: "1759000000000|cursor-abc",
      syncCursorSince: 1_758_000_000_000,
      // A run still holding the lease used the old credentials; its terminal
      // write must not overwrite the state saved here.
      runningUntil: 0,
    });
    expect(await decryptSecret(row.encryptedToken, KEY, WS)).toBe(NEW_TOKEN);
  });

  it("saves nothing when Shopify rejects the token", async () => {
    const db = await setup();
    await seedConnection(db);
    const before = await connectionRow(db);
    for (const status of [401, 403]) {
      const result = await saveConnection(db, ctx(shopFetch(status, {}).impl), {
        shopDomain: "impact-two",
        token: NEW_TOKEN,
      });
      expect(result).toEqual({ kind: "rejected" });
    }
    expect(await connectionRow(db)).toEqual(before);

    // And no row appears for a workspace that had none.
    const fresh = await saveConnection(
      db,
      { workspaceId: OTHER, encryptionKey: KEY, fetchImpl: shopFetch(401, {}).impl },
      { shopDomain: "other-shop", token: NEW_TOKEN },
    );
    expect(fresh).toEqual({ kind: "rejected" });
    expect(await connectionRow(db, OTHER)).toBeUndefined();
  });

  it("saves nothing when Shopify cannot be reached or answers with an error", async () => {
    const db = await setup();
    await seedConnection(db);
    const before = await connectionRow(db);
    const throwing = (async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    }) as typeof fetch;
    const failures: typeof fetch[] = [
      shopFetch(429, {}).impl,
      shopFetch(503, {}).impl,
      shopFetch(200, { errors: [{ message: "Internal error" }] }).impl,
      throwing,
    ];
    for (const fetchImpl of failures) {
      const result = await saveConnection(db, ctx(fetchImpl), {
        shopDomain: "impactrentals",
        token: NEW_TOKEN,
      });
      expect(result.kind).toBe("unreachable");
      if (result.kind === "unreachable") {
        expect(result.error.length).toBeGreaterThan(0);
      }
    }
    expect(await connectionRow(db)).toEqual(before);
  });

  it("rejects a bad domain or token before any request is made", async () => {
    const db = await setup();
    const shop = okShop();
    const bodies: unknown[] = [
      null,
      { token: TOKEN },
      { shopDomain: "impactrentals" },
      { shopDomain: "example.com", token: TOKEN },
      { shopDomain: "evil.myshopify.com.attacker.io", token: TOKEN },
      { shopDomain: "impactrentals", token: "" },
      { shopDomain: "impactrentals", token: "has space" },
      { shopDomain: "impactrentals", token: "t".repeat(TOKEN_MAX + 1) },
    ];
    for (const body of bodies) {
      const result = await saveConnection(db, ctx(shop.impl), body);
      expect(result.kind, JSON.stringify(body)?.slice(0, 80)).toBe("invalid");
    }
    expect(shop.calls).toHaveLength(0);
    expect(await connectionRow(db)).toBeUndefined();
    const domainError = await saveConnection(db, ctx(shop.impl), {
      shopDomain: "example.com",
      token: TOKEN,
    });
    expect(domainError).toMatchObject({ kind: "invalid", error: expect.stringContaining(".myshopify.com") });
  });

  it("never returns the token or the ciphertext, whatever the outcome", async () => {
    const db = await setup();
    const echo = (async () =>
      new Response(JSON.stringify({ errors: [{ message: `bad token ${TOKEN}` }] }), {
        status: 200,
      })) as typeof fetch;
    const echoThrow = (async () => {
      throw new Error(`connect failed for ${TOKEN}`);
    }) as typeof fetch;
    const outcomes = [
      await saveConnection(db, ctx(echo), { shopDomain: "impactrentals", token: TOKEN }),
      await saveConnection(db, ctx(echoThrow), { shopDomain: "impactrentals", token: TOKEN }),
      await saveConnection(db, ctx(shopFetch(401, {}).impl), { shopDomain: "impactrentals", token: TOKEN }),
      await saveConnection(db, ctx(okShop().impl), { shopDomain: "impactrentals", token: TOKEN }),
    ];
    const row = await connectionRow(db);
    for (const outcome of outcomes) {
      const serialized = JSON.stringify(outcome);
      expect(serialized).not.toContain(TOKEN);
      expect(serialized).not.toContain(row.encryptedToken);
      expect(serialized).not.toContain("encryptedToken");
    }
  });

  // drizzle wraps a failed query in an error whose message lists the bound
  // params (here: the ciphertext), and route errors are logged. The service
  // must throw a fresh error that carries neither the token nor the
  // ciphertext, and no cause chain back to the original.
  it("throws a redacted error when the write fails", async () => {
    const { db, raw } = openTestDb();
    await seedWorkspace(db, WS);
    // Remove the workspace behind the foreign key's back so the insert fails.
    raw.pragma("foreign_keys = OFF");
    raw.prepare("DELETE FROM workspaces WHERE id = ?").run(WS);
    raw.pragma("foreign_keys = ON");

    let thrown: unknown;
    try {
      await saveConnection(db, ctx(okShop().impl), { shopDomain: "impactrentals", token: TOKEN });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    const error = thrown as Error & { cause?: unknown; params?: unknown };
    expect(error.message).toContain("FOREIGN KEY");
    expect(error.message).not.toContain(TOKEN);
    expect(error.message).not.toContain("v1.");
    expect(error.message).not.toContain("params");
    expect(error.cause).toBeUndefined();
    expect(error.params).toBeUndefined();
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain("v1.");
  });
});

describe("deleteConnection", () => {
  it("removes the connection row and keeps the orders", async () => {
    const db = await setup();
    await seedConnection(db);
    await seedOrder(db, WS, { id: "o1" });

    await deleteConnection(db, WS);
    expect(await connectionRow(db)).toBeUndefined();
    const orders = await db.select().from(schema.orders).where(eq(schema.orders.workspaceId, WS));
    expect(orders.map((o) => o.id)).toEqual(["o1"]);

    // Idempotent.
    await expect(deleteConnection(db, WS)).resolves.toBeUndefined();
  });

  it("only touches its own workspace", async () => {
    const db = await setup();
    await seedConnection(db);
    await deleteConnection(db, OTHER);
    expect(await connectionRow(db)).toBeDefined();
  });
});
