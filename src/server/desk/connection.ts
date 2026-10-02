// Store connection: the workspace's Shopify domain and Admin API token.
// Security-critical. The token is verified against Shopify before anything
// is stored, stored only encrypted (AES-GCM, aad = workspaceId, so the
// ciphertext only decrypts on this workspace's row), and neither the token
// nor its ciphertext is ever returned, logged or put into an error message.

import { eq, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { orders, storeConnections } from "@/db/schema";
import { encryptSecret } from "@/server/crypto";
import { isValidShopDomain, testShopConnection } from "@/server/shopify/client";
import { isRecord } from "./shapes";

export const TOKEN_MAX = 255;
// Bounds the work done on pasted input before it is parsed.
const DOMAIN_INPUT_MAX = 2048;
const MYSHOPIFY_SUFFIX = ".myshopify.com";
// A store handle is a single DNS label.
const STORE_HANDLE = /^[a-z0-9][a-z0-9-]*$/;
const HANDLE_MAX = 63;
// Visible ASCII only (so no whitespace or control characters): the token
// travels in an HTTP header, and Shopify tokens are ASCII.
const TOKEN_CHARS = /^[\x21-\x7e]+$/;

const DOMAIN_ERROR =
  "Use your store's .myshopify.com address, for example your-store.myshopify.com";

// Accepts what an owner is likely to paste: a bare store handle, the
// myshopify host in any case, or a URL on it. Trims and lowercases, strips a
// leading http:// or https://, drops any path, query or fragment, and appends
// .myshopify.com to a bare handle. The result must pass the same host
// allowlist the sync client enforces; anything else is null.
export function normalizeShopDomain(input: unknown): string | null {
  if (typeof input !== "string" || input.length > DOMAIN_INPUT_MAX) {
    return null;
  }
  let value = input.trim().toLowerCase();
  if (value.startsWith("https://")) {
    value = value.slice("https://".length);
  } else if (value.startsWith("http://")) {
    value = value.slice("http://".length);
  }
  const end = value.search(/[/?#]/);
  if (end !== -1) {
    value = value.slice(0, end);
  }
  if (STORE_HANDLE.test(value)) {
    value += MYSHOPIFY_SUFFIX;
  }
  if (!isValidShopDomain(value) || value.length - MYSHOPIFY_SUFFIX.length > HANDLE_MAX) {
    return null;
  }
  return value;
}

// Trimmed token, 1 to TOKEN_MAX visible ASCII characters (no whitespace
// inside); null otherwise.
export function normalizeToken(input: unknown): string | null {
  if (typeof input !== "string") {
    return null;
  }
  const token = input.trim();
  if (token.length === 0 || token.length > TOKEN_MAX || !TOKEN_CHARS.test(token)) {
    return null;
  }
  return token;
}

export type ConnectionView = {
  shopDomain: string;
  status: "ok";
  lastSyncAt: number;
  // Same shape as the connection in GET /api/workspaces/[id]/sync; always
  // null right after a save.
  lastError: string | null;
  shopName: string;
};

export type SaveConnectionResult =
  // Bad input, or no Shopify store at the address (400).
  | { kind: "invalid"; error: string }
  // Shopify refused the token, or the token cannot read orders (422).
  | { kind: "rejected"; error: string }
  // The workspace already has orders and the domain names another store (409).
  | { kind: "store-change"; error: string }
  // Shopify could not be reached or answered with an error (502).
  | { kind: "unreachable"; error: string }
  | { kind: "saved"; connection: ConnectionView };

const TOKEN_REJECTED = "Shopify rejected this token";
const CANNOT_READ_ORDERS =
  "This token cannot read orders. Give the Shopify app the read_orders permission and try again.";
const STORE_CHANGE_REFUSED =
  "This workspace already has orders from another store. Create a new workspace for a different store.";
// Order-reading access: read_orders, or write_orders (which implies read
// access; Shopify may list only the write handle). read_all_orders only
// widens the window past 60 days on top of one of these, so it is optional
// and does not count on its own.
const ORDER_SCOPES = ["read_orders", "write_orders"];

export type ConnectionContext = {
  workspaceId: string;
  encryptionKey: string;
  fetchImpl?: typeof fetch;
};

function redact(text: string, secrets: Array<string | undefined>): string {
  let out = text;
  for (const secret of secrets) {
    if (secret) {
      out = out.split(secret).join("[redacted]");
    }
  }
  return out;
}

// The innermost cause's message. drizzle wraps a failed query in an error
// whose message lists the bound params (the ciphertext among them); the
// driver error underneath it does not, so that is the one worth keeping.
function failureReason(e: unknown): string {
  let current = e;
  for (let depth = 0; depth < 10 && current instanceof Error && current.cause instanceof Error; depth++) {
    current = current.cause;
  }
  const message = current instanceof Error ? current.message : "";
  return message.length > 0 && !message.startsWith("Failed query:")
    ? message
    : "unexpected database error";
}

// Whether the workspace's stored connection names a different shop while
// the workspace already has orders: the one change saveConnection refuses.
async function storeChangeBlocked(db: Db, workspaceId: string, shopDomain: string) {
  const rows = await db
    .select({ shopDomain: storeConnections.shopDomain })
    .from(storeConnections)
    .where(eq(storeConnections.workspaceId, workspaceId))
    .limit(1);
  if (!rows[0] || rows[0].shopDomain === shopDomain) {
    return false;
  }
  const anyOrder = await db
    .select({ id: orders.id })
    .from(orders)
    .where(eq(orders.workspaceId, workspaceId))
    .limit(1);
  return anyOrder.length > 0;
}

// Verifies the pair with Shopify, then upserts the connection. Nothing is
// written unless Shopify accepted the token and it can read orders.
//
// A workspace is one business with one store: once it has orders, a save
// that names another shop is refused and nothing changes. A changed domain
// on a workspace with no orders, or a new token for the same domain, is
// saved. A disconnected (disabled) row counts as the workspace's store for
// this rule, and a successful save re-enables it.
//
// The save stores a legacy Admin API token (auth_mode legacy_token) with
// the verified shop name and scopes, and clears any client-credentials
// fields so the row describes one mode only.
//
// On save the connection is marked ok with no last error. A new row, or a
// row whose shop domain changed, also starts over: lastSyncAt 0 and no sync
// cursor, so the next sync opens a fresh first-sync window for that store. A
// token-only change keeps lastSyncAt and any cursor. Either way the sync
// lease is released (runningUntil 0). What that buys: a run still holding
// the lease started under the old settings, so its fenced connection writes
// (lastSyncAt, cursor, status) match nothing from here on, and it re-checks
// the lease after its fetch, between existence chunks and before its write
// loop, returning superseded without writing orders once it sees the change.
// What it does not buy: a run already inside its write loop finishes that
// loop (see the fence comment in src/server/sync/run.ts).
//
// One statement decides: whether the shop changed, and whether the
// workspace has orders, are both evaluated inside the upsert against the
// tables as they are at write time (the setWhere below), so no concurrent
// save, delete or first synced order can slip between a read and the write.
// storeChangeBlocked runs first only to refuse early, without sending the
// token to Shopify for a change that would be refused anyway.
export async function saveConnection(
  db: Db,
  ctx: ConnectionContext,
  body: unknown,
): Promise<SaveConnectionResult> {
  const fields = isRecord(body) ? body : {};
  const shopDomain = normalizeShopDomain(fields.shopDomain);
  if (shopDomain === null) {
    return { kind: "invalid", error: DOMAIN_ERROR };
  }
  const token = normalizeToken(fields.token);
  if (token === null) {
    return {
      kind: "invalid",
      error: `Paste the Admin API access token: 1 to ${TOKEN_MAX} characters, no spaces`,
    };
  }

  if (await storeChangeBlocked(db, ctx.workspaceId, shopDomain)) {
    return { kind: "store-change", error: STORE_CHANGE_REFUSED };
  }

  const check = await testShopConnection(shopDomain, token, ctx.fetchImpl ?? fetch);
  if (check.kind === "auth") {
    return { kind: "rejected", error: TOKEN_REJECTED };
  }
  if (check.kind === "no-store") {
    return { kind: "invalid", error: "No Shopify store at this address" };
  }
  if (check.kind !== "ok") {
    // check.detail is token-free by testShopConnection's contract.
    return { kind: "unreachable", error: `Could not verify the connection: ${check.detail}` };
  }
  if (!check.accessScopes.some((scope) => ORDER_SCOPES.includes(scope))) {
    return { kind: "rejected", error: CANNOT_READ_ORDERS };
  }

  let encryptedToken: string | undefined;
  try {
    encryptedToken = await encryptSecret(token, ctx.encryptionKey, ctx.workspaceId);
    const legacyFields = {
      authMode: "legacy_token" as const,
      clientId: null,
      encryptedClientSecret: null,
      encryptedAccessToken: null,
      accessTokenExpiresAt: null,
      scopes: check.accessScopes,
      shopName: check.shopName,
    };
    const sameShop = sql`${storeConnections.shopDomain} = excluded.shop_domain`;
    const noOrders = sql`not exists (select 1 from ${orders} where ${orders.workspaceId} = ${ctx.workspaceId})`;
    const rows = await db
      .insert(storeConnections)
      .values({
        workspaceId: ctx.workspaceId,
        shopDomain,
        encryptedToken,
        ...legacyFields,
        status: "ok",
        lastError: null,
        lastSyncAt: 0,
        runningUntil: 0,
        syncCursor: null,
        syncCursorSince: null,
      })
      .onConflictDoUpdate({
        target: storeConnections.workspaceId,
        // Every expression here sees the row as it was before this write.
        set: {
          shopDomain,
          encryptedToken,
          ...legacyFields,
          status: "ok",
          lastError: null,
          runningUntil: 0,
          lastSyncAt: sql`case when ${sameShop} then ${storeConnections.lastSyncAt} else 0 end`,
          syncCursor: sql`case when ${sameShop} then ${storeConnections.syncCursor} else null end`,
          syncCursorSince: sql`case when ${sameShop} then ${storeConnections.syncCursorSince} else null end`,
        },
        // An existing row is only updated for the same shop, or for another
        // shop while the workspace has no orders. Otherwise the update is
        // skipped and RETURNING yields no row. (A new row is always inserted:
        // with no stored connection there is no other store to protect.)
        setWhere: sql`${sameShop} or ${noOrders}`,
      })
      .returning({ lastSyncAt: storeConnections.lastSyncAt, lastError: storeConnections.lastError });
    const saved = rows[0];
    if (!saved) {
      return { kind: "store-change", error: STORE_CHANGE_REFUSED };
    }
    return {
      kind: "saved",
      connection: {
        shopDomain,
        status: "ok",
        lastSyncAt: saved.lastSyncAt,
        lastError: saved.lastError,
        shopName: check.shopName,
      },
    };
  } catch (e) {
    // A fresh error with no cause chain and no params: whatever the route
    // logs from here carries neither the token nor the ciphertext.
    throw new Error(
      "Saving the store connection failed: " +
        redact(failureReason(e), [token, encryptedToken]),
    );
  }
}

// Disconnects the store by disabling its row rather than deleting it, so
// the one-store-per-workspace rule (saveConnection) still knows which store
// this workspace's orders came from. Every stored secret is cleared (the
// token column cannot be null, so it becomes empty), the last error goes,
// and the sync lease is released: a run in flight sees the lease change and
// writes nothing (see runSync), and the cron skips disabled rows. Sync
// progress (lastSyncAt, cursor) stays, so reconnecting the same store
// resumes where it left off. Orders and their history stay. A no-op for a
// workspace with no connection.
export async function deleteConnection(db: Db, workspaceId: string): Promise<void> {
  await db
    .update(storeConnections)
    .set({
      status: "disabled",
      encryptedToken: "",
      encryptedClientSecret: null,
      encryptedAccessToken: null,
      accessTokenExpiresAt: null,
      lastError: null,
      runningUntil: 0,
    })
    .where(eq(storeConnections.workspaceId, workspaceId));
}
