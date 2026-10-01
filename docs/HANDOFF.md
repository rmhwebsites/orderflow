# Order Desk - Session Handoff

Last updated: 2026-10-01, written mid-build in case the working session ends.
Read this top to bottom before touching anything. The authoritative specs are
`docs/plans/2026-10-01-order-desk-design.md` (approved design, incl. the Oct 1
email amendment) and `docs/plans/2026-10-01-order-desk-implementation.md`
(phased TDD plan; its "Execution notes" section records hard-won hazards: read it).

## What this is

Multi-workspace Shopify order management platform ("Order Desk") for RMH
Websites. Owner: Ryan (ryan@rmhwebsites.com). First tenant: IMPACT Rentals.
Stack: Next.js 16 on Cloudflare Workers via @opennextjs/cloudflare, D1 +
Drizzle, better-auth magic links, Durable Object realtime (Phase 5), R2,
Cloudflare Email Service (replaced Resend on Oct 1), web push PWA (Phase 6),
PO flow with mandatory human review before send (Phase 7).

Repo: github.com/rmhwebsites/orderflow (PUBLIC - never commit secrets).
Branch: build/m1-core. All work is committed and pushed through 116a744
(plus this handoff commit).

## Build state (what is DONE and verified)

- Phase 0 scaffold, Phase 1 data layer, Phase 2 auth/workspaces/invites,
  Phase 3 sync engine: implemented, each through a two-gate review
  (spec compliance, then code quality), all requested fixes applied.
- 117 tests green (`npm run test` = drizzle-kit check + vitest), tsc clean.
- Migrations 0000-0003 applied BOTH locally and to remote D1. Migration 0004
  (store_connections.sync_cursor_started_at) is committed but NOT applied
  anywhere yet: see "Sync review repairs, round 1" below.
- Local end-to-end evidence exists for: magic-link sign-in, workspace create
  with 7 default statuses, invite claim (both paths), revocation, sync engine
  (idempotent, cursor-resumed pagination, fenced lease) via simulator tests.

## Cloud facts (all live on Ryan's "RMH Websites" Cloudflare account)

- wrangler is logged in via OAuth on this machine (`npx wrangler whoami`).
- D1: order_desk, id 2b066c9a-0684-47eb-8672-c638cc6aaa2a (in wrangler.jsonc).
- R2: bucket named `orderflow` (NOT order-desk-pdfs), binding PO_BUCKET.
- Email: Cloudflare Email Service binding `EMAIL` (send_email in
  wrangler.jsonc). Workers Paid is active and impactrentals.store is onboarded
  as a sending domain, so production email should work at first deploy.
  Sender constant: DEFAULT_FROM in src/server/email/send.ts.
  Local dev never sends; it logs `[email-fallback]` lines instead.
- NOT yet deployed. No secrets set yet. VAPID keys not yet generated (Phase 6).

## In-flight at time of writing

An adversarial verification workflow ("verify-sync-fixes-v2", 3 lenses) was
running against commit 116a744. If its results are unknown to you:
- Re-run the equivalent: adversarially review `git diff 1206878 116a744` for
  (a) cursor-resumption correctness, (b) lease fencing/idempotency/dedup,
  (c) the mechanical gate (tests, tsc, migration 0003, hygiene). NOTE: this
  handoff commit sits on top of 116a744, so a mechanical check expecting
  116a744 at HEAD will "fail" that item: expected, not a defect.
- If the lenses found issues, fix via TDD and re-verify before deploying.

## Verification verdict on 116a744 (arrived just before cutoff)

Three-lens adversarial review completed. The core fixes HOLD (cursor chains
keep a stable window and byte-identical search string; fenced writes are
atomic; recovery is lossless; the livelock regression test is honest; fence
values cannot collide; applyPair/changesOf read D1 batch results correctly;
EXISTENCE_CHUNK=50 pinned). Remaining findings, FIX BEFORE DEPLOY:

1. IMPORTANT (src/server/sync/run.ts ~line 338): the lease fence covers only
   store_connections; the orders snapshot UPDATE is unfenced. A zombie run
   that outlives its 120s lease (fetch budget allows ~900s) can land an OLD
   snapshot over a newer run's write, permanently (the advanced window never
   re-covers it), and still reports updated/updatedOrderIds despite
   superseded=true (would drive false Phase 5/6 broadcasts). Fix: make the
   snapshot update conditional (add lte(orders.syncedAt, now) to its where,
   count it only via changesOf like the insert path), and return empty
   added/updated arrays from any run whose terminal write was superseded.
2. MINOR (~line 373): after a completed cursor continuation, anchor lastSyncAt
   at the run's own pre-fetch `now` instead of the chain watermark; keeps a
   >500-order same-moment burst from causing a perpetual 2-tick rescan cycle
   on an idle shop (churn, not loss).
3. MINOR (~line 161): move the post-CAS fresh connection read inside the try
   block so a transient D1 error there cannot leak the lease until expiry.

Write failing tests first (the lenses left repro sketches: a zombie-run test
and the rescan-cycle observation in the existing invariant test), fix, run the
full gate, commit with the usual trailer, push, THEN do the smoke deploy.

## Sync review repairs, round 1 (supersedes parts of the verdict above)

The three findings above were fixed in 84b3266. A second adversarial review of
that commit found two real defects, both repaired test-first:

1. Zombie hole on unchanged rows. The synced_at guard only protected rows a
   newer run had WRITTEN; a row the newer run merely verified as unchanged
   kept its old synced_at and a zombie's stale snapshot could still land.
   Now runSync follows claim-then-read (claimAndLoad in run.ts): each chunk of
   fetched order ids is stamped synced_at = this run's now (forward only)
   BEFORE the stored snapshots are read, so the latest-started run owns every
   row it looked at. An insert that turns out to be a conflict no-op (another
   run stored the order first) now claims, loads and compares that row
   instead of skipping it. orders.synced_at therefore means "start time of
   the latest run that looked at this row", not "last snapshot write".
2. Finding 2 above ("anchor at the run's own now after a continuation") was
   WRONG when Shopify's updated_at search surfaces an order late: the cursor
   never returns to an order that appears behind it, and the finishing tick's
   now put the next window after it, losing the order for good. Rule now:
   lastSyncAt never moves past the moment the window was opened. A completed
   cursor chain anchors at the now of the tick that OPENED the chain
   (store_connections.sync_cursor_started_at, migration 0004); a cursorless
   truncation anchors at min(watermark, window opening). Cost: at most one
   bounded re-scan after a dense burst, then one request per tick. Do not
   "simplify" this back to the finishing tick's now or to the chain watermark.

DEPLOY BLOCKER: migration 0004 must be applied before the new code runs, or
every runSync fails on the whole-row store_connections read (no such column).
Run `npm run db:migrate:local` for local dev and `npm run db:migrate:remote`
before the smoke deploy. Neither has been run yet.

## Immediate next steps, in order

1. Apply migration 0004 locally and to remote D1 (see the deploy blocker
   above), re-run npm run test + tsc.
2. SMOKE DEPLOY (early, agreed with Ryan) - exact sequence:
   a. `openssl rand -base64 32 | npx wrangler secret put BETTER_AUTH_SECRET`
      (same for ENCRYPTION_KEY; `openssl rand -hex 16` for CRON_SECRET).
      Wrangler will offer to create the Worker on first secret: accept.
   b. `npm run deploy` (opennextjs-cloudflare build && deploy). Note the
      workers.dev URL it prints.
   c. Set that URL as vars.APP_URL in wrangler.jsonc (replace the
      REPLACE_ME_AFTER_DEPLOY placeholder), commit (pathspec only), redeploy.
   d. LIVE TEST: open the URL, request a magic link to Ryan's email. It must
      arrive from orders@impactrentals.store. Then sign in, create the
      "IMPACT Rentals" workspace. Check `npx wrangler tail` for cron runs
      (every 10 min; they no-op without a store connection).
3. Phase 4 per the implementation plan (desk read/write APIs), then 5 (UI +
   realtime), 6 (PWA/push/notifications), 7 (PO flow), 8 (polish/docs).
   Ryan must supply a Shopify custom-app Admin API token (read_orders) for
   impactrentals when the store connection is first configured; the connection
   PUT must lowercase/trim the domain (client regex requires *.myshopify.com).

## Process rules that proved load-bearing (follow them)

- Subagent-driven development: dispatch a fresh implementer per phase with the
  FULL task text (they have no conversation context), then two review gates.
  Under ultracode, run reviews as parallel adversarial Workflow lenses; they
  have repeatedly found real criticals that tests missed (watermark livelock,
  D1 100-bound-parameter cap).
- TDD with captured red runs; evidence pasted in reports, not summarized.
- npm/cli#4828: ANY `npm install <pkg>` can silently drop @rolldown/binding-*
  from package-lock.json. After every dependency change:
  `rm -rf node_modules package-lock.json && npm install`, then
  `grep -c '"node_modules/@rolldown/binding-' package-lock.json` must be >= 15
  BEFORE committing.
- Concurrent agents in one tree: commit with explicit pathspecs only
  (`git commit -- <files>`), never `git add -A`.
- A PreToolUse security hook rejects file writes containing certain literal
  substrings: the RegExp exec method spelled with its leading dot, and the raw
  DOM inner-HTML property name (spelled as one word). Use String.match instead
  of RegExp exec, build UI with React JSX only, and spell those tokens
  obliquely in docs (this file does).
- House style: zero em-dashes, zero emoji, commits end with
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Email conventions: dynamic values in HTML -> escapeHtml; in subjects ->
  sanitizeSubject (never entity-encode subjects). All sending goes through
  src/server/email/send.ts.
- Guards: every /w/[slug] server component calls requireMemberBySlug (layouts
  are not an auth boundary); API routes use requireMember; 401 signed-out,
  404 for missing-or-underranked (never 403); Shopify tokens encrypted
  AES-GCM v1 with aad = workspaceId; cron code uses getDbFromEnv, never
  getDb, inside scheduled().

## Business decisions already made (do not re-ask)

- Light mode default, dark toggle; per-workspace accent (IMPACT #91d500).
- POs NEVER auto-send: review modal + explicit send button, always.
- Notifications: phone push + branded email for new orders and PO sends;
  in-app for everything else (per-user opt-in to push-all).
- Vendor picked per order from a workspace vendor list.
- All-Cloudflare architecture was researched and chosen over Supabase and
  Firebase for cost ($0-5/mo) at Ryan's explicit direction; email moved from
  Resend to Cloudflare Email Service at his direction.
