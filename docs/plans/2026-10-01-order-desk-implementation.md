# Order Desk Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Multi-workspace Shopify order management platform (statuses, notes, realtime, push + email notifications, reviewed POs) running entirely on Cloudflare.

**Architecture:** Next.js App Router compiled to a single Cloudflare Worker via @opennextjs/cloudflare. D1 (Drizzle) for data, better-auth magic links for sign-in, a WorkspaceRoom Durable Object for realtime, R2 for PO PDFs, cron trigger for sync, webcrypto web push, Resend for all email. All Shopify/Resend/VAPID secrets are Worker secrets; every data route checks workspace membership. Design doc: `docs/plans/2026-10-01-order-desk-design.md` (read it first; its Screens + Design language sections govern all UI work).

**Tech Stack:** Next.js 15+, TypeScript, Tailwind v4, Drizzle ORM + drizzle-kit, better-auth (+magic-link plugin), @opennextjs/cloudflare + wrangler, @block65/webcrypto-web-push, pdf-lib, Resend REST API, vitest (+ @cloudflare/vitest-pool-workers for D1-backed tests), Phosphor icons (@phosphor-icons/react).

**Conventions for every task:** work from repo root `order-desk/`. Run `npm run test` before every commit. Never put a secret in a committed file; secrets go through `wrangler secret put` (prod) and `.dev.vars` (local, gitignored). No em-dashes or emoji in any UI string. All money/order numbers render in Red Hat Mono with tabular numerals.

---

## Phase 0: Scaffold and toolchain

### Task 0.1: Node project + Next.js skeleton

**Files:** Create `package.json`, `tsconfig.json`, `next.config.ts`, `open-next.config.ts`, `postcss.config.mjs`, `.gitignore`, `.dev.vars.example`, `src/app/layout.tsx`, `src/app/page.tsx`, `src/app/globals.css`

**Step 1:** `npm init -y`, then install:
```bash
npm i next@latest react@latest react-dom@latest
npm i -D typescript @types/node @types/react @types/react-dom tailwindcss @tailwindcss/postcss wrangler @opennextjs/cloudflare vitest
```

**Step 2:** Write configs.

`next.config.ts`:
```ts
import type { NextConfig } from "next";
const nextConfig: NextConfig = {};
export default nextConfig;

import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
initOpenNextCloudflareForDev();
```

`open-next.config.ts`:
```ts
import { defineCloudflareConfig } from "@opennextjs/cloudflare";
export default defineCloudflareConfig({});
```

`postcss.config.mjs`:
```js
export default { plugins: { "@tailwindcss/postcss": {} } };
```

`src/app/globals.css` starts with `@import "tailwindcss";` followed by the design-token block (see Task 5.1; a minimal `:root` is fine for now).

`.gitignore`: `node_modules`, `.next`, `.open-next`, `.wrangler`, `.dev.vars`, `*.env*`, `drizzle/meta` stays committed (keep migrations), `.DS_Store`.

`.dev.vars.example` (committed template):
```
BETTER_AUTH_SECRET=generate-with-openssl-rand-base64-32
ENCRYPTION_KEY=generate-with-openssl-rand-base64-32
RESEND_API_KEY=re_xxx
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
VAPID_SUBJECT=mailto:ryan@rmhwebsites.com
CRON_SECRET=generate-with-openssl-rand-hex-16
APP_URL=http://localhost:3000
```

Minimal `layout.tsx` (html/body, globals.css import, Google Fonts links for Sora + Red Hat Display + Red Hat Mono via `next/font/google`) and `page.tsx` rendering "Order Desk".

**Step 3:** `package.json` scripts:
```json
{
  "dev": "next dev",
  "build": "next build",
  "preview": "opennextjs-cloudflare build && opennextjs-cloudflare preview",
  "deploy": "opennextjs-cloudflare build && opennextjs-cloudflare deploy",
  "test": "vitest run",
  "db:generate": "drizzle-kit generate",
  "db:migrate:local": "wrangler d1 migrations apply order_desk --local",
  "db:migrate:remote": "wrangler d1 migrations apply order_desk --remote",
  "cf-typegen": "wrangler types --env-interface CloudflareEnv cloudflare-env.d.ts"
}
```

**Step 4:** Verify: `npm run dev` serves the page at localhost:3000.

**Step 5:** Commit `chore: scaffold Next.js app for Cloudflare Workers`.

### Task 0.2: wrangler.jsonc with all bindings

**Files:** Create `wrangler.jsonc`

**Step 1:** First create the real resources (one-time, needs `wrangler login` on Ryan's account):
```bash
npx wrangler d1 create order_desk        # copy database_id into wrangler.jsonc
npx wrangler r2 bucket create order-desk-pdfs
```
If not logged in yet, pause and ask Ryan to run `npx wrangler login` (his Cloudflare account).

**Step 2:** `wrangler.jsonc`:
```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "order-desk",
  "main": ".open-next/worker.js",
  "compatibility_date": "2026-09-01",
  "compatibility_flags": ["nodejs_compat", "global_fetch_strictly_public"],
  "assets": { "directory": ".open-next/assets", "binding": "ASSETS" },
  "d1_databases": [{ "binding": "DB", "database_name": "order_desk", "database_id": "REPLACE_ME", "migrations_dir": "drizzle" }],
  "r2_buckets": [{ "binding": "PO_BUCKET", "bucket_name": "order-desk-pdfs" }],
  "durable_objects": { "bindings": [{ "name": "ROOM", "class_name": "WorkspaceRoom" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["WorkspaceRoom"] }],
  "triggers": { "crons": ["*/10 * * * *"] },
  "vars": { "APP_URL": "https://order-desk.REPLACE.workers.dev" }
}
```

**Step 3:** `npm run cf-typegen` generates `cloudflare-env.d.ts`. Verify it contains `DB: D1Database`, `PO_BUCKET: R2Bucket`, `ROOM: DurableObjectNamespace`.

**Step 4:** Commit `chore: wrangler config with D1, R2, DO, cron bindings`.

### Task 0.3: Custom worker entrypoint (DO export + cron handler)

OpenNext generates `.open-next/worker.js`. Durable Objects and the `scheduled` handler must be exported from the main module. OpenNext supports this via a custom entrypoint referenced from `open-next.config.ts` docs pattern; implement as a wrapper module.

**Files:** Create `src/worker/index.ts`; Modify `wrangler.jsonc` (`"main": "src/worker/index.ts"` is NOT used; keep `.open-next/worker.js`) and instead follow the documented OpenNext override: create `custom-worker.ts` at repo root, set `"main": "custom-worker.ts"` only if the OpenNext docs version in use supports it; otherwise use the officially supported approach for the installed version. Check https://opennext.js.org/cloudflare (howtos on custom worker/Durable Objects) during execution and pin whichever mechanism the installed @opennextjs/cloudflare documents.

`custom-worker.ts` (target shape):
```ts
// @ts-expect-error generated at build time
import handler from "./.open-next/worker.js";
export { WorkspaceRoom } from "./src/realtime/room";
import { runScheduledSync } from "./src/server/sync/cron";

export default {
  fetch: handler.fetch,
  async scheduled(controller: ScheduledController, env: CloudflareEnv, ctx: ExecutionContext) {
    ctx.waitUntil(runScheduledSync(env));
  },
} satisfies ExportedHandler<CloudflareEnv>;
```
Stub `src/realtime/room.ts` (empty DO class extending `DurableObject` that 404s) and `src/server/sync/cron.ts` (no-op) so the build passes; both get real bodies later.

**Verify:** `npm run preview` boots and serves the app under workerd. **Commit** `chore: custom worker entrypoint exporting DO and cron`.

---

## Phase 1: Data layer

### Task 1.1: Drizzle schema + migrations

**Files:** Create `drizzle.config.ts`, `src/db/schema.ts`, `src/db/index.ts`; Test `src/db/schema.test.ts`

**Step 1:** `npm i drizzle-orm && npm i -D drizzle-kit better-sqlite3`

**Step 2:** `drizzle.config.ts`:
```ts
import { defineConfig } from "drizzle-kit";
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
});
```

**Step 3:** `src/db/schema.ts`, complete. Conventions: text ids (`crypto.randomUUID()` defaults in app code), epoch-ms integers for timestamps, JSON as `text({ mode: "json" })`.

Tables (translate the design doc 1:1):
```ts
import { sqliteTable, text, integer, uniqueIndex, index } from "drizzle-orm/sqlite-core";

export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  accentColor: text("accent_color").notNull().default("#91d500"),
  logoUrl: text("logo_url"),
  createdBy: text("created_by").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const workspaceMembers = sqliteTable("workspace_members", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  userId: text("user_id").notNull(),
  role: text("role", { enum: ["owner", "admin", "member"] }).notNull(),
  lastSeenAt: integer("last_seen_at").notNull().default(0),
}, (t) => [uniqueIndex("member_unique").on(t.workspaceId, t.userId)]);

export const storeConnections = sqliteTable("store_connections", {
  workspaceId: text("workspace_id").primaryKey().references(() => workspaces.id),
  shopDomain: text("shop_domain").notNull(),
  encryptedToken: text("encrypted_token").notNull(),
  status: text("status", { enum: ["ok", "error", "disabled"] }).notNull().default("ok"),
  lastSyncAt: integer("last_sync_at").notNull().default(0),
  lastError: text("last_error"),
});

export const statuses = sqliteTable("statuses", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  key: text("key").notNull(),
  label: text("label").notNull(),
  color: text("color").notNull(),
  sort: integer("sort").notNull(),
  triggersPo: integer("triggers_po", { mode: "boolean" }).notNull().default(false),
}, (t) => [uniqueIndex("status_key_unique").on(t.workspaceId, t.key)]);

export const orders = sqliteTable("orders", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  shopifyOrderId: text("shopify_order_id").notNull(),
  name: text("name").notNull(),
  shopify: text("shopify", { mode: "json" }).notNull(),
  statusKey: text("status_key").notNull(),
  statusSetBy: text("status_set_by"),
  statusSetAt: integer("status_set_at"),
  createdAt: integer("created_at").notNull(),
  syncedAt: integer("synced_at").notNull(),
}, (t) => [
  uniqueIndex("order_unique").on(t.workspaceId, t.shopifyOrderId),
  index("order_ws_created").on(t.workspaceId, t.createdAt),
]);

export const events = sqliteTable("events", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  orderId: text("order_id"),
  type: text("type", { enum: ["order_new", "status", "note", "po_sent", "po_draft", "sync_error"] }).notNull(),
  text: text("text").notNull(),
  actorId: text("actor_id"),
  meta: text("meta", { mode: "json" }),
  createdAt: integer("created_at").notNull(),
}, (t) => [index("events_ws_created").on(t.workspaceId, t.createdAt), index("events_order").on(t.orderId)]);

export const vendors = sqliteTable("vendors", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  name: text("name").notNull(),
  email: text("email").notNull(),
  cc: text("cc", { mode: "json" }),
  notes: text("notes"),
  archived: integer("archived", { mode: "boolean" }).notNull().default(false),
});

export const purchaseOrders = sqliteTable("purchase_orders", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  orderId: text("order_id").notNull(),
  vendorId: text("vendor_id").notNull(),
  poNumber: text("po_number").notNull(),
  lineItems: text("line_items", { mode: "json" }).notNull(),
  shipTo: text("ship_to", { mode: "json" }),
  notes: text("notes"),
  status: text("status", { enum: ["draft", "sent", "failed"] }).notNull().default("draft"),
  pdfKey: text("pdf_key"),
  sentAt: integer("sent_at"),
  createdBy: text("created_by").notNull(),
  createdAt: integer("created_at").notNull(),
}, (t) => [uniqueIndex("po_number_unique").on(t.workspaceId, t.poNumber)]);

export const workspaceSettings = sqliteTable("workspace_settings", {
  workspaceId: text("workspace_id").primaryKey().references(() => workspaces.id),
  notificationEmails: text("notification_emails", { mode: "json" }).notNull().default("[]"),
  poPrefix: text("po_prefix").notNull().default("PO"),
  replyTo: text("reply_to"),
  fromName: text("from_name"),
});

export const notificationPrefs = sqliteTable("notification_prefs", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  workspaceId: text("workspace_id").notNull(),
  pushNewOrders: integer("push_new_orders", { mode: "boolean" }).notNull().default(true),
  emailNewOrders: integer("email_new_orders", { mode: "boolean" }).notNull().default(true),
  pushAllActivity: integer("push_all_activity", { mode: "boolean" }).notNull().default(false),
}, (t) => [uniqueIndex("prefs_unique").on(t.userId, t.workspaceId)]);

export const pushSubscriptions = sqliteTable("push_subscriptions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  endpoint: text("endpoint").notNull().unique(),
  keys: text("keys", { mode: "json" }).notNull(),
  userAgent: text("user_agent"),
  createdAt: integer("created_at").notNull(),
});
```

`src/db/index.ts`:
```ts
import { drizzle } from "drizzle-orm/d1";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import * as schema from "./schema";

export function getDb() {
  const { env } = getCloudflareContext();
  return drizzle(env.DB, { schema });
}
export type Db = ReturnType<typeof getDb>;
export * as schema from "./schema";
```

**Step 4:** `npm run db:generate` then `npm run db:migrate:local`. Expected: migration SQL file in `drizzle/`, applies cleanly.

**Step 5:** Commit `feat: D1 schema for workspaces, orders, events, vendors, POs`.

### Task 1.2: Token crypto (AES-GCM) with tests, TDD

**Files:** Create `src/server/crypto.ts`; Test `src/server/crypto.test.ts`

**Step 1 (failing test first):**
```ts
import { describe, it, expect } from "vitest";
import { encryptSecret, decryptSecret } from "./crypto";

const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));

describe("token crypto", () => {
  it("round-trips", async () => {
    const out = await encryptSecret("shpat_example_123", KEY);
    expect(out).not.toContain("shpat");
    expect(await decryptSecret(out, KEY)).toBe("shpat_example_123");
  });
  it("unique ciphertext per call (random IV)", async () => {
    expect(await encryptSecret("a", KEY)).not.toBe(await encryptSecret("a", KEY));
  });
  it("rejects tampered payload", async () => {
    const out = await encryptSecret("a", KEY);
    const bad = out.slice(0, -4) + "AAAA";
    await expect(decryptSecret(bad, KEY)).rejects.toThrow();
  });
});
```
**Step 2:** `npx vitest run src/server/crypto.test.ts` fails (module missing).
**Step 3:** Implement with WebCrypto: import key (raw base64, AES-GCM), 12-byte random IV, output `base64(iv) + "." + base64(cipher)`. No Node Buffer; use `atob/btoa` + Uint8Array helpers so it runs on workerd.
**Step 4:** Test passes. **Step 5:** Commit `feat: AES-GCM secret encryption for store tokens`.

---

## Phase 2: Auth and membership

### Task 2.1: better-auth with magic links on D1

**Files:** Create `src/server/auth.ts`, `src/app/api/auth/[...all]/route.ts`, `src/lib/auth-client.ts`; Modify `src/db/schema.ts` (auth tables), `.dev.vars`

**Step 1:** `npm i better-auth`

**Step 2:** Add better-auth's required sqlite tables to `schema.ts` exactly as the better-auth Drizzle docs specify for v1.5+: `user`, `session`, `account`, `verification` (copy field-for-field from the installed version's docs; run `npx @better-auth/cli generate` and reconcile). Generate + apply migration.

**Step 3:** `src/server/auth.ts`:
```ts
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { magicLink } from "better-auth/plugins";
import { getDb } from "@/db";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { sendMagicLinkEmail } from "./email/magic-link";

export function getAuth() {
  const { env } = getCloudflareContext();
  return betterAuth({
    baseURL: env.APP_URL,
    secret: env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(getDb(), { provider: "sqlite" }),
    emailAndPassword: { enabled: false },
    plugins: [
      magicLink({
        async sendMagicLink({ email, url }) {
          await sendMagicLinkEmail(env, email, url);
        },
      }),
    ],
  });
}
```
Route handler `src/app/api/auth/[...all]/route.ts` per better-auth Next.js docs (`toNextJsHandler(getAuth().handler)` pattern, instantiated per request). `src/lib/auth-client.ts` with `createAuthClient` + `magicLinkClient` plugin.

**Step 4:** `src/server/email/resend.ts`: tiny fetch wrapper `sendEmail(env, {from, to, subject, html, attachments?, cc?, replyTo?})` POSTing to `https://api.resend.com/emails` with `Authorization: Bearer ${env.RESEND_API_KEY}`; throws on non-2xx with body text. `magic-link.ts` uses it with a minimal branded template (shared base template arrives in Task 6.2).

**Step 5:** Manual verify locally: `npm run dev`, request a magic link to your own address, complete sign-in, session cookie set. (Local uses real Resend; acceptable, it is Ryan's key and his inbox.)

**Step 6:** Commit `feat: magic-link auth via better-auth on D1`.

### Task 2.2: Membership guards, TDD on the pure part

**Files:** Create `src/server/guard.ts`; Test `src/server/guard.test.ts`

**Step 1 (failing test):** `roleAtLeast("admin", "member") === true`, `roleAtLeast("member", "admin") === false`, `roleAtLeast("owner", "owner") === true`.
**Step 2-4:** Implement `const RANK = { member: 0, admin: 1, owner: 2 }` + `roleAtLeast(actual, required)`; plus `requireMember(workspaceId, required)` which: reads session via `getAuth().api.getSession({ headers })`, 401s without session, loads membership row, 404s (not 403, avoid existence leaks) when absent or under-ranked, returns `{ userId, role, db }`. Every API route calls it first.
**Step 5:** Commit `feat: workspace membership guard`.

### Task 2.3: Workspaces + invites API and pages

**Files:** Create `src/app/api/workspaces/route.ts` (GET list, POST create), `src/app/api/workspaces/[id]/members/route.ts` (POST invite by email, owner/admin), `src/app/(auth)/sign-in/page.tsx`, `src/app/page.tsx` (workspace home), `src/app/w/[slug]/layout.tsx` (workspace shell: resolves slug, checks membership, provides context)

Behavior: creating a workspace seeds default statuses (New/lime, Processing/blue, On Hold/amber, Approved/green + triggersPo, Shipped/violet, Delivered/slate, Issue/red), a `workspace_settings` row, and an owner membership. Invite inserts/updates membership for the email's user (creating a placeholder user row via better-auth admin API or storing pending-invite keyed by email claimed at first sign-in; implement pending_invites table if better-auth lacks a clean pre-create, simplest: `pending_invites(email, workspaceId, role)` claimed in a post-sign-in hook).

Verify manually: create workspace, second browser signs in with invited email, sees it. Commit `feat: workspaces, default statuses, email invites`.

---

## Phase 3: Shopify sync

### Task 3.1: Normalizer, TDD (pure function, no network)

**Files:** Create `src/server/shopify/normalize.ts`; Test with fixtures `src/server/shopify/__fixtures__/orders-graphql.json`, `normalize.test.ts`

Failing tests cover: GraphQL nodes shape (id `gid://shopify/Order/123`, `legacyResourceId`), money sets, lineItems nodes, missing customer, missing shipping, tags array vs string, quote/newline hostile text passes through untouched (storage is JSON, not HTML). Output type:
```ts
export type NormalizedOrder = {
  shopifyOrderId: string; name: string; createdAt: number;
  customerName: string; email: string; total: string; currency: string;
  financialStatus: string; fulfillmentStatus: string;
  items: { title: string; qty: number; price: string | null; sku: string; variant: string }[];
  shipping: { name: string; a1: string; a2: string; city: string; prov: string; zip: string; country: string } | null;
  tags: string; note: string;
};
```
Implement minimal, tests green, commit `feat: Shopify order normalizer`.

### Task 3.2: Shopify GraphQL client

**Files:** Create `src/server/shopify/client.ts`; Test `client.test.ts` (mock fetch)

`fetchOrdersUpdatedSince(shopDomain, token, sinceIso)`: POST `https://{shopDomain}/admin/api/2025-07/graphql.json`, header `X-Shopify-Access-Token`, query orders `(first: 50, after: $cursor, sortKey: UPDATED_AT, query: "updated_at:>='${sinceIso}'")` selecting the fields the normalizer consumes; paginate via `pageInfo { hasNextPage endCursor }`; classify errors: 401/403 -> `{kind:"auth"}`, 429/5xx -> `{kind:"transient"}`, else `{kind:"fatal", message}`. Tests: pagination loop, auth classification. Commit `feat: Shopify Admin GraphQL client`.

### Task 3.3: Sync service + cron + API route

**Files:** Create `src/server/sync/run.ts`, `src/server/sync/cron.ts` (real body), `src/app/api/workspaces/[id]/sync/route.ts`; Test `src/server/sync/run.test.ts` using @cloudflare/vitest-pool-workers (D1 in miniflare)

`runSync(env, workspaceId)`:
1. Lease: `UPDATE store_connections SET last_sync_at = last_sync_at WHERE workspaceId=? AND (strftime now - running flag)`; simplest: a `sync_runs` KV-free approach, store `running_until` column on store_connections; skip if `running_until > now`. Set `running_until = now + 120s`.
2. Decrypt token, pull orders updated since `last_sync_at - 5min` (first run: last 60 days).
3. For each normalized order upsert by `(workspaceId, shopifyOrderId)`; INSERT -> also insert `order_new` event (text: `New order {name} from {customerName}`), default statusKey = first status by sort; UPDATE only when the JSON snapshot changed.
4. Update `last_sync_at`, clear `running_until`, set status ok / error + lastError on auth failures.
5. Return `{ added, updated }`; caller fans out notifications (Task 6.3) for added orders and broadcasts to the room (Task 5.4).

`cron.ts`: iterate all `store_connections` with status != disabled, `runSync` each, isolate failures.
Route: POST, `requireMember(id, "member")`, 30s rate limit per workspace (check last manual run timestamp column), returns counts.

Tests (pool-workers, real D1 schema loaded from `drizzle/`): inserting same fixture twice yields 1 order + 1 event (idempotent), changed snapshot updates without a second `order_new` event.

Commit `feat: sync engine with cron and manual trigger`.

---

## Phase 4: Core API for the desk

### Task 4.1: Orders + events read APIs

**Files:** `src/app/api/workspaces/[id]/orders/route.ts` (GET: all orders for workspace, newest first; includes statuses list and settings in one payload), `src/app/api/workspaces/[id]/events/route.ts` (GET: latest 300, or `?orderId=` for a full per-order timeline)

Guard everything with `requireMember(id, "member")`. Commit `feat: desk read APIs`.

### Task 4.2: Status change + notes (writes)

**Files:** `src/app/api/orders/[orderId]/status/route.ts` (POST {statusKey}), `src/app/api/orders/[orderId]/note/route.ts` (POST {text}); Test `src/server/mutations.test.ts` (pool-workers)

Both: load order, `requireMember(order.workspaceId, "member")`, write mutation + event in a `db.batch([...])` (D1 batch = atomic), broadcast, return the event. Status route also returns `triggersPo: boolean` for the status so the client knows to open the PO modal (PO itself is Phase 7). Tests: status change writes both rows atomically; note length capped at 4000; empty note rejected. Commit `feat: status and note mutations with activity events`.

### Task 4.3: Statuses, vendors, settings CRUD

**Files:** `src/app/api/workspaces/[id]/statuses/route.ts` (PUT full ordered list, admin+), `src/app/api/workspaces/[id]/vendors/route.ts` (+ `[vendorId]` route; admin+ for write, member read), `src/app/api/workspaces/[id]/settings/route.ts` (GET member / PUT admin+), `src/app/api/workspaces/[id]/connection/route.ts` (PUT {shopDomain, token} owner only: encrypts, stores, runs a test call `shop { name }`, saves status; DELETE owner)

Commit `feat: workspace configuration APIs`.

---

## Phase 5: UI (the desk) and realtime

UI tasks build to the design doc sections "Screens" and "Design language". No em-dashes, no emoji, AA contrast, pill controls + 12px panels, Sora/Red Hat Display/Red Hat Mono, light default + dark toggle.

### Task 5.1: Design tokens + app shell

**Files:** Modify `src/app/globals.css` (full token system: light `:root`, dark under `@media (prefers-color-scheme: dark)` guarded by `:root:not([data-theme="light"])` AND `:root[data-theme="dark"]`, with `color-scheme`), create `src/components/shell.tsx` (workspace top bar: brand/workspace name with accent, sync chip, bell, theme toggle, settings), `src/components/theme-toggle.tsx` (three-state: light default, dark, system; persists localStorage, sets `data-theme` on `<html>`)

Tokens: `--bg --surface --surface-2 --ink --ink-2 --ink-3 --line --accent(from workspace) --accent-ink --good --warn --bad` plus 8 named status colors (lime blue amber teal violet red slate pink) each with light/dark values. Default is LIGHT.

Verify both themes by toggling. Commit `feat: token system, shell, light-default theming`.

### Task 5.2: Order Desk screen

**Files:** `src/app/w/[slug]/page.tsx` + `src/components/desk/*` (stat strip, toolbar, order-table, order-card)

Client component fetches `/orders` payload, renders: status-count strip (filter chips, counts, accent underline on active), search (name, customer, email, item titles), sort (newest, oldest, total), table on >=880px, cards under. Row: order number (mono), date, customer (name+email), items summary (2-line clamp), total (mono), status select (inline, optimistic with rollback on error), unread-dot if events newer than lastSeen reference that order. Skeleton rows while loading (shaped like real rows), designed empty state ("No orders yet. Connect the store in Settings or press Sync."). Commit `feat: order desk list screen`.

### Task 5.3: Order detail drawer

**Files:** `src/components/desk/drawer.tsx`

Right-side drawer (full-screen on phones): header (order number mono, date, Shopify financial/fulfillment chips), status control, customer block (email as selectable text + copy button, never bare mailto reliance), items with qty/sku/variant/price, totals, ship-to, tags + checkout note, Open in Shopify (`https://admin.shopify.com/store/{handle}/orders/{legacyId}` derived from shop_domain), PO history (Phase 7 fills), activity timeline (fetch `?orderId=`), note composer (Enter sends, Shift+Enter newline), Esc/scrim closes. Commit `feat: order detail drawer with timeline and notes`.

### Task 5.4: WorkspaceRoom Durable Object + live updates

**Files:** Replace stub `src/realtime/room.ts`; Create `src/app/api/workspaces/[id]/ws/route.ts` (GET upgrade: guard, then `env.ROOM.get(env.ROOM.idFromName(workspaceId)).fetch(request)`), `src/server/broadcast.ts` (`broadcast(env, workspaceId, event)` POSTs an internal path on the DO), `src/lib/use-live.ts` (client hook: connect WS, heartbeat, exponential reconnect, refetch-on-reconnect, dispatch events)

`WorkspaceRoom` (hibernation API): `fetch` handles `/connect` (WebSocketPair, `acceptWebSocket`) and `/broadcast` (POST body JSON -> `getWebSockets().forEach(send)`). No state persisted. Wire broadcasts into sync (order_new/updated), status, note mutations. Client applies patches: new order -> prepend + toast; status/note -> update row/timeline; all gated to events not initiated by this client (echo ok but no toast for self).

Verify with two browsers: note in one appears in the other within a second. Commit `feat: realtime workspace room over Durable Object WebSockets`.

### Task 5.5: Settings screens

**Files:** `src/app/w/[slug]/settings/page.tsx` (tabs: Store connection owner-only, Statuses editor admin+, Vendors, Notifications list, Team invites, PO prefix), reusing the CRUD APIs from 4.3

Status editor: reorder (up/down), rename, 8-color select, triggersPo toggle, add/delete (delete blocked while orders use it: show count). Commit `feat: workspace settings screens`.

---

## Phase 6: Notifications (M2)

### Task 6.1: PWA (manifest + service worker)

**Files:** `public/manifest.webmanifest` (name "Order Desk", display standalone, theme/bg from tokens, icons 192/512 generated green-on-black monogram PNGs in `public/icons/`), `public/sw.js` (install/activate no-op cache shell; `push` event -> `showNotification(title, {body, data:{url}})`; `notificationclick` -> `clients.openWindow(data.url)`), registration in shell (`navigator.serviceWorker.register("/sw.js")`), `<link rel="manifest">` + iOS meta in layout.

Verify: Lighthouse installability pass locally. Commit `feat: installable PWA with push-capable service worker`.

### Task 6.2: Web push send + subscribe, TDD on payload build

**Files:** Create `src/server/push.ts`; Test `src/server/push.test.ts`; Create `src/app/api/push/subscribe/route.ts` (POST subscription JSON -> upsert by endpoint; DELETE), `scripts/generate-vapid.mjs`

`npm i @block65/webcrypto-web-push`. `sendPush(env, subscriptionRow, payload)` builds the request via the library, POSTs to the endpoint, and on 404/410 deletes the subscription row. Test: payload under 4KB, deletes on 410 (mock fetch). `generate-vapid.mjs` prints a keypair for `.dev.vars` + `wrangler secret put`. Prefs page section: enable-push button (requests permission, subscribes with `VAPID_PUBLIC_KEY`, posts), per-workspace toggles writing `notification_prefs`, iPhone hint ("Install to Home Screen to receive notifications on iOS"). Commit `feat: web push subscribe and send`.

### Task 6.3: Fan-out + branded email templates + bell

**Files:** Create `src/server/notify.ts`, `src/server/email/templates.ts`; Modify sync + PO send to call it; Create bell UI `src/components/desk/bell.tsx` + `src/app/api/workspaces/[id]/seen/route.ts` (POST updates member.lastSeenAt)

`notifyOrderNew(env, workspace, order)`: collect members with prefs, send push (pushNewOrders) linking `/w/{slug}?order={id}`, send ONE email to workspace_settings.notificationEmails + members with emailNewOrders (dedup), subject `New Order {name} from {customerName}` in Title Case. Templates: port the IMPACT email design system (Sora/Red Hat stack with system fallbacks, black header band, accent border, pill CTA "Open Order Desk", no em-dashes, all free text HTML-escaped) parameterized by workspace name/accent/logo. `notifyPoSent` analogous (Task 7.3 calls it). Bell: dropdown feed from events, badge = events newer than lastSeenAt and not actor==me, "Mark all read". Commit `feat: notification fan-out, branded emails, activity bell`.

---

## Phase 7: Purchase orders (M3)

### Task 7.1: PO numbering, TDD

**Files:** Create `src/server/po/number.ts`; Test `number.test.ts` (pool-workers, D1)

`nextPoNumber(db, workspaceId, prefix)` -> `{PREFIX}-{YYYY}-{NNNN}`: queries max existing for workspace+year inside `db.batch` with the insert (insert attempts, on unique-constraint retry with +1, max 3 retries). Tests: first is 0001, sequence increments, year rollover resets, concurrent-ish double insert yields distinct numbers (simulate by pre-inserting). Commit `feat: sequential PO numbers per workspace`.

### Task 7.2: PDF generation, TDD-light

**Files:** Create `src/server/po/pdf.ts`; Test `pdf.test.ts`

`npm i pdf-lib`. `renderPoPdf({workspace, po, vendor, order})` -> Uint8Array: letter page, workspace name + accent rule, PO number/date, vendor block, ship-to, line-item table (desc/sku/qty/unit/total), totals, notes, footer "Generated by Order Desk". Embed Helvetica (standard font; custom fonts later). Test: output starts with `%PDF`, size > 1KB, contains no thrown errors for 30-line-item orders (pagination: new page every 24 rows). Commit `feat: branded PO PDF renderer`.

### Task 7.3: PO create/send flow + review modal

**Files:** Create `src/app/api/orders/[orderId]/po/route.ts` (POST create draft {vendorId, lineItems, notes} -> number + draft row + po_draft event; POST `[poId]/send` -> render PDF, R2 `put(poKey)`, Resend email to vendor cc notificationEmails replyTo settings with attachment (base64), mark sent + po_sent event + notify; failures mark failed, keep retry), `src/app/api/pos/[poId]/pdf/route.ts` (GET guarded, streams from R2), `src/components/desk/po-modal.tsx`

Modal (opened by triggersPo status change or Create PO button): vendor select + inline add, editable line items (desc/qty/unit cost prefilled from order, rows removable/addable), ship-to editable, notes, PO number preview ("will be PO-2026-0042"), buttons: Save draft / **Send to vendor** (explicit, primary, confirm copy states the recipient). NOTHING sends without that button. Status change still applies even if modal cancelled (PO can be created later from drawer). Drawer PO history lists number, vendor, state chip, PDF link, Retry on failed. Commit `feat: reviewed purchase order flow with vendor email`.

---

## Phase 8: Ship (M4)

### Task 8.1: Seed script + full local pass

**Files:** Create `scripts/seed.sql` (fixture workspace, statuses, 6 fixture orders marked EXAMPLE, vendor "Sample Vendor <delivered@resend.dev>")

Run the manual test plan from the design doc end to end locally (`npm run preview` for workerd parity): sign-in, connect store (real IMPACT token from Ryan), Sync pulls real orders, status/note in two browsers (realtime), push on a real phone, PO send to `delivered@resend.dev`. Fix what breaks. Commit `chore: seed fixtures`.

### Task 8.2: Deploy

**Steps:** `wrangler secret put` for BETTER_AUTH_SECRET, ENCRYPTION_KEY, RESEND_API_KEY, VAPID_*, CRON_SECRET; `npm run db:migrate:remote`; `npm run deploy`; set APP_URL var to the workers.dev URL and redeploy; walk Ryan through first workspace + store connection on prod; verify cron ran within 10 min (`wrangler tail`). Commit any config deltas. Offer custom domain mapping next.

### Task 8.3: Docs

**Files:** Create `README.md` (stack, local dev, secrets table, deploy, how to add a workspace/store, troubleshooting token errors)

Commit `docs: operations README`.

---

## Execution notes

- After each phase, re-run the full test suite and do a quick phone-width visual pass on changed screens, light and dark.
- The two externally risky integrations are flagged inside their tasks: the OpenNext custom entrypoint mechanism (Task 0.3, pin to installed version docs) and better-auth's generated schema (Task 2.1, reconcile with CLI output).
- Shopify API version: pin `2025-07`; bump deliberately.
- esbuild is a direct devDependency on purpose: opennextjs-cloudflare imports it undeclared and vite 8 lists it as an optional peer; do not prune it.
- npm/cli#4828: any `npm install <pkg>` can silently drop @rolldown/binding-* (and other optional-deps matrices) from the lockfile. After EVERY dependency change: rm -rf node_modules package-lock.json, npm install, then grep -c '\"node_modules/@rolldown/binding-' package-lock.json (expect >= 15) before committing.
