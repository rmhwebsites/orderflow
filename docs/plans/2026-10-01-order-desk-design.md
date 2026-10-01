# Order Desk - Design

Date: 2026-10-01
Status: Approved by Ryan (brainstorm session, section-by-section)
Owner: RMH Websites (Ryan). First tenant: IMPACT Rentals employee store (impactrentals.store).

## What this is

A multi-workspace order management platform. Each workspace is one business attached
to one Shopify store. Teams sign in with email magic links (no Claude, no Shopify
staff seats needed), see live orders, set custom statuses, leave notes, get phone
push and branded email notifications, and send reviewed purchase orders to vendors.

## Decisions log (from the brainstorm)

- Team has no Claude access: standalone hosted app, own auth. Artifact route rejected.
- Multi-workspace from day one: Ryan will attach future businesses/stores.
- Host on Cloudflare (Ryan's call), not Vercel.
- Backend research verdict (Ryan delegated final call): all-Cloudflare beats
  Supabase ($25/mo cliff, idle pausing) and Firebase (Blaze pay-as-you-go required
  for App Hosting + Functions + storage buckets as of Feb 2026, unbounded metered
  billing, NoSQL misfit). Cloudflare free tier covers everything; $5/mo ceiling.
- Light mode is the default for every workspace; dark mode is a toggle.
- A PO is NEVER sent automatically. Review modal plus an explicit send button, always.
- Notifications: phone push (PWA) + branded email on new orders and PO sends;
  status changes and notes are in-app by default with per-user opt-in to push.
- PO vendor is picked per order from the workspace vendor list.

## Architecture

- **App**: Next.js (App Router, TypeScript) deployed to Cloudflare Workers via
  @opennextjs/cloudflare (Pages path is deprecated for Next.js). Tailwind v4.
- **Data**: Cloudflare D1 (SQLite) through Drizzle ORM with migrations.
- **Auth**: better-auth with the D1 adapter and magic-link plugin (links delivered
  through Resend). Sessions in D1, optional KV session cache later.
- **Realtime**: one Durable Object class, `WorkspaceRoom`. Each open client holds a
  WebSocket to its workspace's room (hibernation API). Server mutations broadcast
  compact events; clients patch their local state. Free-plan eligible.
- **Storage**: R2 bucket for generated PO PDFs (zero egress fees).
- **Scheduled sync**: Workers cron trigger every 10 minutes hits the same sync code
  path as the manual Sync button. 5 crons free per account; we use 1.
- **Push**: standard Web Push (VAPID) via a webcrypto-compatible library
  (PushForge or @block65/webcrypto-web-push; the Node `web-push` package does not
  run on Workers). The app is an installable PWA (manifest + service worker), which
  is what enables push on iPhone (add to home screen) and Android.
- **Email**: Resend. Magic links, new-order notifications, PO emails. IMPACT already
  has impactrentals.store verified in Resend; future workspaces verify their domain
  or use a shared RMH sender.
- **PDF**: pdf-lib (pure JS, Workers-compatible) renders the branded PO.
- **Shopify**: per-workspace custom app Admin API token (read_orders scope), pasted
  into workspace settings by the owner, AES-GCM encrypted at rest with a Worker
  secret, decrypted server-side only. Sync queries the GraphQL Admin API for orders
  updated since last sync (with overlap buffer), paginated.
- **Security model**: no RLS; every data access goes through server routes that
  check workspace membership and role. Shopify tokens, Resend key, VAPID private
  key, and the encryption secret live in Worker secrets and never reach the client.

## Data model (approved)

- `workspaces`: id, name, slug, accent_color, logo_url, created_by, created_at
- `workspace_members`: workspace_id, user_id, role (owner | admin | member)
- `store_connections`: workspace_id (1:1), shop_domain, encrypted_token, status,
  last_sync_at, last_error
- `statuses`: id, workspace_id, key, label, color, sort, triggers_po (bool)
- `orders`: id, workspace_id, shopify_order_id (unique per workspace), name,
  shopify jsonb snapshot (customer, items, totals, shipping, financial/fulfillment
  state, tags, note), status_key, status_set_by/at, created_at (Shopify), synced_at
- `events`: id, workspace_id, order_id, type (order_new | status | note | po_sent |
  po_draft | sync_error), text, actor_id (null = system), meta jsonb, created_at.
  This is the activity feed, the notification source, and the per-order timeline.
- `vendors`: id, workspace_id, name, email, cc jsonb, notes, archived
- `purchase_orders`: id, workspace_id, order_id, vendor_id, po_number (sequential
  per workspace, prefix from settings, e.g. IMP-2026-0041), line_items jsonb
  (editable copy), status (draft | sent | failed), pdf_key (R2), sent_at, created_by
- `workspace_settings`: workspace_id, notification_emails jsonb, po_prefix,
  reply_to, from_name
- `notification_prefs`: user_id, workspace_id, push_new_orders, email_new_orders,
  push_all_activity (defaults: on, on, off)
- `push_subscriptions`: user_id, endpoint (unique), keys jsonb, user_agent, created_at
- `members.last_seen_at` per workspace for unread badge math

## Screens (approved; light default + dark toggle)

1. Sign-in: email field, magic link sent, done.
2. Workspace home: card per business (logo, accent, open-order count). Create
   workspace (owner only).
3. Order Desk (the main screen): status-count strip doubling as filters, search,
   sort, order list (table on desktop, cards on phones), live updates, sync button
   with last-synced time, bell with unread badge.
4. Order detail drawer: customer, line items, totals, shipping, Shopify
   payment/fulfillment chips, open-in-Shopify link, status control, notes composer,
   full activity timeline, PO history with PDF links, Approve action.
5. PO review modal: vendor select (inline add), editable line items/costs/notes,
   ship-to, PO number preview, explicit "Send to vendor" button. Mandatory stop.
6. Vendors: list, add, edit, archive.
7. Status editor: reorder, rename, recolor, add, delete, triggers_po flag (admin+).
8. Workspace settings: store connection (token paste + test), notification emails,
   PO prefix, team invites with roles (owner/admin).
9. Notification preferences (per user): push toggle per device, email toggle,
   all-activity opt-in. Install-app hint for iPhone.

## Design language (approved, taste-skill applied to a dashboard)

- Light default, dark toggle, both complete; tokens defined once, components use
  tokens only. Workspace accent drives highlights (IMPACT: #91D500 on #101820 ink).
- Type: Sora (display), Red Hat Display (UI), Red Hat Mono (order numbers, money,
  tabular numerals everywhere data aligns).
- One radius system: pill interactive controls, 12px panels/cards. One accent;
  semantic status colors are separate from the accent and always carry text labels.
- Loading skeletons shaped like the final layout; designed empty states; inline
  errors; toasts only for transient events. Tactile :active states.
- Motion is motivated only (drawer slide, toast entry, row flash on live change),
  custom cubic-bezier, transform/opacity only, full prefers-reduced-motion support.
- Zero em-dashes, no emoji in UI, no decorative dots (status dots are semantic),
  AA contrast minimum everywhere including placeholders and focus rings.
- Icons: Phosphor (consistent stroke), tree-shaken imports.

## Flows

**Sync** (button + cron, same path): per active connection, pull orders updated
since last_sync_at minus 5 min, normalize, upsert; new orders write `order_new`
events; changed orders update the snapshot. Fan-out after commit: push + email per
prefs and workspace notification list; broadcast to the WorkspaceRoom. Connection
card surfaces last_error (bad token shows a fix-it banner for owners). Button is
rate-limited (one run per 30s per workspace; concurrent runs skip via lease).

**Notifications**: bell badge = events newer than member.last_seen_at. Toasts for
live events while the desk is open. Push payloads deep-link to the order. Branded
email template reuses the IMPACT email design system per workspace brand.

**PO**: moving an order to a triggers_po status (or pressing Create PO in the
drawer) opens the review modal. Nothing sends until "Send to vendor" is pressed.
Send mints po_number, renders the PDF, stores to R2, emails vendor (cc workspace
list, reply-to from settings, PDF attached), writes po_sent event. Resend failure
keeps the PO as failed-draft with a retry button; never silent.

## Error handling

- Shopify 401/403: connection status -> error, owner banner, sync paused.
- Shopify 429/5xx: backoff, retry next cron; sync_error event only after repeats.
- Push endpoint 404/410: delete the subscription.
- Resend failure on PO: failed-draft + retry (above). On notifications: log, no block.
- WebSocket drop: client reconnects with backoff; a reconnect triggers one refetch.
- All user-facing errors are inline and actionable, no bare toasts for persistent
  states.

## Testing

- Unit: Shopify payload normalizer (REST and GraphQL shapes, hostile text), PO
  numbering (sequence per workspace), role checks on every mutation route.
- Integration: sync upsert idempotency against a mocked Shopify response; PO flow
  mints number + PDF + email call with a mocked Resend.
- Local: wrangler/miniflare dev with seeded fixture workspace; manual pass of the
  test plan (sign-in, sync, status, note, push on a real phone, PO send to a test
  inbox) before first deploy.

## Milestones

- M1 Core desk: auth, workspaces, store connection, sync (button+cron), order list
  + detail, statuses, notes, activity, realtime. Deployed to workers.dev.
- M2 Notifications: PWA install, push, branded emails, prefs, bell.
- M3 PO: vendors, review modal, PDF, Resend send, timeline + retry.
- M4 Polish: dark mode QA, mobile QA, invite flow QA, custom domain.

## Prerequisites Ryan provides at implementation time

- Cloudflare account access (wrangler login) on the account holding his zones.
- Resend API key (exists; currently in Shopify Flow headers).
- Shopify custom app token for impactrentals (read_orders) pasted into settings.
- A custom domain choice later (workers.dev subdomain first).

## Amendment (Oct 1): email provider

Cloudflare Email Service (Workers `send_email` binding, bound as `EMAIL`)
replaces Resend as the email provider. Requirements: Workers Paid plan and an
onboarded sending domain in Email Service before production email works
(DEFAULT_FROM uses orders@impactrentals.store). Attachments are supported by
the binding (base64 content with filename, MIME type, disposition), so Phase 7
PO PDFs pass through unchanged. The Resend API key is no longer needed; local
dev keeps the [email-fallback] console log. Resend references in the body
above are historical.
