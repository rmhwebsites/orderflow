# Ordering Desk - Platform Amendment (Oct 2, 2026)

Approved by Ryan in conversation on Oct 2. Supersedes the original design doc
wherever they conflict. Original: `2026-10-01-order-desk-design.md`.

## 1. Name and domains

- Product name: **Ordering Desk** (APP_NAME). Management hub:
  https://orderingdesk.com (Worker `orderingdesk`, custom domain).
- Each client workspace can have its own host, `orders.<client domain>`
  (IMPACT: orders.impactrentals.store). Visiting a client host opens that
  workspace directly, branded with its logo; orderingdesk.com stays the hub
  that lists every workspace a person belongs to.
- Infra: a client domain whose zone is in Ryan's Cloudflare account is
  attached as a Worker custom domain. A client domain elsewhere uses
  Cloudflare for SaaS custom hostnames on the orderingdesk.com zone (the
  client adds one CNAME). Either way the app resolves host -> workspace.
- Auth cookies are per host, so people sign in on the host they use.
  better-auth must accept every allowed host: the APP_URL host plus every
  workspace's verified custom domain (per-request baseURL and trustedOrigins
  derived from the request host, never from a client-supplied value).

## 2. Access model

- **Platform admins**: Ryan (ryan@rmhwebsites.com, bootstrapped through the
  PLATFORM_ADMIN_EMAILS Worker secret) and anyone a platform admin promotes.
  They see and manage every workspace, create workspaces, connect stores,
  manage branding, domains and email senders, set anyone's role, and invite
  or remove other platform admins.
- **Workspace roles**: `manager` and `staff` (replace owner/admin/member).
  - Staff: view orders, change statuses, add notes.
  - Manager: everything Staff can, plus team invites and removals within the
    workspace, statuses, vendors, notification settings, purchase orders.
  - Store connection, branding, custom domain and email sender: platform
    admins only.
- Clients only ever see workspaces they are members of. Workspace creation is
  platform-admin only.
- **Who can have an account** (sign-up is closed otherwise):
  1. platform admins (bootstrap list or promoted);
  2. anyone with a pending manual invite (managers and platform admins can
     invite);
  3. **tagged Shopify customers**: customers of a workspace's connected store
     carrying the tag `Ordering Desk Manager` or `Ordering Desk Staff` get
     that role in that workspace. Adding or removing the tag in Shopify
     grants or revokes access automatically (customer webhooks plus the
     periodic sync). Memberships record their source (`manual` or
     `shopify`); Shopify sync only ever adds or removes `shopify`-sourced
     memberships, never manual ones. Tag names are per-workspace settings
     with those defaults.
- An email with no route to an account gets the same "check your email"
  response as everyone else (no account enumeration), and no email is sent.

## 3. Shopify connection

- New Shopify custom apps (since Jan 1, 2026) are Dev Dashboard apps with a
  **Client ID and Client secret**, not a long-lived token. Access tokens come
  from the client credentials grant: POST
  https://{shop}/admin/oauth/access_token, form-encoded
  grant_type=client_credentials, client_id, client_secret; tokens expire in
  about 24 hours. The app caches the token encrypted with its expiry and
  renews it shortly before it lapses. The app must be installed on the store.
- Per workspace, stored encrypted with aad = workspaceId: client ID, client
  secret, cached access token. A legacy Admin API token (shpat_) remains a
  supported alternative for stores whose apps predate 2026.
- Credentials are entered only by a platform admin in Settings > Store
  connection. They never appear in chat, logs, responses or the repo.
- Required scopes (Ryan granted broad access): read_orders, write_orders,
  read_customers, read_merchant_managed_fulfillment_orders,
  write_merchant_managed_fulfillment_orders. The connect step verifies them
  and names any that are missing.

## 4. Two-way status sync

- **Shopify -> app, live**: on connect the app registers webhooks
  (orders/create, orders/updated, orders/cancelled, orders/fulfilled,
  orders/partially_fulfilled, fulfillments/create, fulfillments/update,
  customers/create, customers/update, customers/delete) pointing at
  https://orderingdesk.com/api/webhooks/shopify/<workspaceId>. Each delivery
  is verified with HMAC-SHA256 over the raw body using that workspace's client
  secret (constant-time compare), deduplicated by X-Shopify-Webhook-Id, and
  applied idempotently. The 10 minute cron sync stays as the safety net.
- **Status links**: each workspace status may link to a Shopify state:
  `fulfilled` or `delivered` (or nothing). Defaults: Shipped -> fulfilled,
  Delivered -> delivered. No cancel link (Ryan chose not to mirror cancels:
  cancelling in Shopify can refund and email the customer).
  - App -> Shopify: moving an order into a status linked to `fulfilled`
    creates a fulfillment for its open fulfillment orders with
    notifyCustomer: false (Ryan: never email customers from a status change).
  - Shopify -> app: when Shopify reports the order fulfilled or delivered,
    the app moves it to the linked status, but never backward past a later
    status (status sort order defines "later").
- **Status tag**: every app status is written to the Shopify order as one
  tag `Ordering Desk: <Status label>` (replacing any previous Ordering Desk
  tag), so staff see it in Shopify. Editing that tag in Shopify moves the app
  status to the matching label, which is how statuses with no Shopify state
  stay two-way.
- Echo safety: the app's own Shopify writes come back as webhooks; applying
  them must be a no-op when the state already matches. Every change, from
  either side, lands in the order's activity timeline with its source.

## 5. Email

- Default platform sender: `Ordering Desk <orders@orderingdesk.com>`.
- Per workspace, a platform admin sets the sending address, normally
  `orders@<client domain>`. That domain must be onboarded under Email
  Service > Email Sending in Ryan's Cloudflare account (possible only when
  the client's zone is in that account). Until a test send succeeds, the
  workspace falls back to the platform sender with the workspace name as the
  display name and the workspace reply-to.
- Sign-in emails requested on a client host come from that workspace's
  sender; sign-in emails on orderingdesk.com come from the platform sender.

## 6. Carried over from the original Phase 5 part B

- Settings screens for every section above, branding uploads (symbol and full
  logo, each with an optional dark version; SVG sanitized, PNG copies stored
  for email), statuses with the Shopify link field, vendors, notification
  settings, team management with roles, and disconnect-as-disable so the
  one-store-per-workspace rule survives a disconnect.
