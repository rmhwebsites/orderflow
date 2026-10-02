// Store connection: the workspace's Shopify domain and Admin API token.
// Security-critical. The token is verified against Shopify before anything
// is stored, stored only encrypted (AES-GCM, aad = workspaceId, so the
// ciphertext only decrypts on this workspace's row), and neither the token
// nor its ciphertext is ever returned, logged or put into an error message.

import { eq, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { storeConnections } from "@/db/schema";
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
  shopName: string;
};

export type SaveConnectionResult =
  | { kind: "invalid"; error: string }
  // Shopify answered 401/403 to the verification query.
  | { kind: "rejected" }
  // Shopify could not be reached or answered with an error.
  | { kind: "unreachable"; error: string }
  | { kind: "saved"; connection: ConnectionView };

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

// Verifies the pair with Shopify, then upserts the connection. Nothing is
// written unless Shopify accepted the token.
//
// On save the connection is marked ok with no last error. A new row, or a
// row whose shop domain changed, also starts over: lastSyncAt 0 and no sync
// cursor, so the next sync opens a fresh first-sync window for that store. A
// token-only change keeps lastSyncAt and any cursor. Either way the sync
// lease is released (runningUntil 0): a run still holding it started under
// the old credentials, and its fenced terminal write must not overwrite what
// is saved here (see fencedConnectionWrite in src/server/sync/run.ts).
//
// One statement: the "did the shop change" decision happens inside the
// upsert, against the row as it is at write time, so a concurrent save or
// delete cannot slip between a read and the write.
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

  const check = await testShopConnection(shopDomain, token, ctx.fetchImpl ?? fetch);
  if (check.kind === "auth") {
    return { kind: "rejected" };
  }
  if (check.kind !== "ok") {
    // check.detail is token-free by testShopConnection's contract.
    return { kind: "unreachable", error: `Could not verify the connection: ${check.detail}` };
  }

  let encryptedToken: string | undefined;
  try {
    encryptedToken = await encryptSecret(token, ctx.encryptionKey, ctx.workspaceId);
    const sameShop = sql`${storeConnections.shopDomain} = excluded.shop_domain`;
    const rows = await db
      .insert(storeConnections)
      .values({
        workspaceId: ctx.workspaceId,
        shopDomain,
        encryptedToken,
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
          status: "ok",
          lastError: null,
          runningUntil: 0,
          lastSyncAt: sql`case when ${sameShop} then ${storeConnections.lastSyncAt} else 0 end`,
          syncCursor: sql`case when ${sameShop} then ${storeConnections.syncCursor} else null end`,
          syncCursorSince: sql`case when ${sameShop} then ${storeConnections.syncCursorSince} else null end`,
        },
      })
      .returning({ lastSyncAt: storeConnections.lastSyncAt });
    return {
      kind: "saved",
      connection: {
        shopDomain,
        status: "ok",
        lastSyncAt: rows[0]?.lastSyncAt ?? 0,
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

// Disconnects the store. Orders and their history stay.
export async function deleteConnection(db: Db, workspaceId: string): Promise<void> {
  await db.delete(storeConnections).where(eq(storeConnections.workspaceId, workspaceId));
}
