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
(plus this handoff commit). The sync repair commits after that (84b3266,
7dade33 and the round 2 repair) are committed locally and not pushed yet.

## Build state (what is DONE and verified)

- Phase 0 scaffold, Phase 1 data layer, Phase 2 auth/workspaces/invites,
  Phase 3 sync engine: implemented, each through a two-gate review
  (spec compliance, then code quality), all requested fixes applied.
- 173 tests green (`npm run test` = drizzle-kit check + vitest), tsc clean.
- Migrations 0000-0003 applied BOTH locally and to remote D1, and they are
  the whole schema: migration 0004 was withdrawn before it was applied
  anywhere (see "Sync review repairs, round 2" below).
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
   cursor chain anchors at the now of the tick that OPENED the chain. Cost:
   at most one bounded re-scan after a dense burst, then one request per
   tick. Do not "simplify" this back to the finishing tick's now or to the
   chain watermark. (Round 1 stored the chain start in a new column and let
   a truncation without a cursor anchor on a watermark; round 2 below
   replaced both.)

## Sync review repairs, round 2 (supersedes parts of round 1)

A third adversarial review found three issues. All three are repaired
test-first.

1. No anchor is derived from fetched nodes any more. Shopify sorts by a
   lagging search index but hydrates nodes fresh, so an order edited seconds
   ago can still sort at its old position while its node says "updated just
   now". The old rule for a truncation without a cursor (anchor at the newest
   updatedAt gathered) then jumped lastSyncAt to about now and silently
   skipped every older order the run had not reached. Now every truncation
   is resumable: the client (src/server/shopify/client.ts) always returns
   the cursor to resume from. "More pages but no cursor" on the first request
   of a run is a transient error (nothing moves, lastError says so); on a
   later request the run keeps what it read and resumes from the cursor that
   request was sent with. run.ts has two anchors left, both clock values:
   this run's now (plain window) and the chain start (cursor chain).
2. The orders query asked for 50 orders x 50 line items, about 7,953 cost
   points. Shopify refuses any query above 1,000 requested points before
   running it, on every plan, so by the documented rules no order would ever
   have synced. The page is now 5 orders x 50 line items (about 798 points;
   the line item cap is unchanged so no order loses items) and a run reads
   up to 100 pages, which keeps the 500 orders per run ceiling. Because a
   run is now many small requests, a retryable failure part-way (throttle,
   5xx, timeout, garbled body) no longer throws away the pages already
   read: the run ends as a truncation and the next tick resumes from the
   last cursor. A failure on the first request is still reported as before.
   client.test.ts prices the query that is actually sent and fails above
   800 points.
   NOT VERIFIED LIVE: the 798 is computed from Shopify's documented rules
   (object 1, connection 2 + page size x node cost, limit 1,000), not read
   from a shop. On the first real sync, check it: either the sync works, or
   lastError / the sync_error event shows Shopify's "Query cost is N, which
   exceeds the single query max cost limit (1000)", in which case lower
   ORDERS_PER_PAGE in client.ts (and raise MAX_PAGES to match). To read the
   exact number, POST the query with the shop token and look at
   extensions.cost.requestedQueryCost in the response (the request header
   Shopify-GraphQL-Cost-Debug: 1 adds a per-field breakdown).
3. Migration 0004 is gone. The chain start now rides inside sync_cursor as
   "<chain start ms>|<Shopify cursor>" (resumeToken / parseResumeToken in
   run.ts), so the engine needs nothing beyond migration 0003, the round 1
   deploy blocker no longer exists, and cursor and chain start can never be
   written or cleared apart. A bare cursor (no prefix) or a chain start
   later than the run's own clock reads as "start unknown" and degrades to
   one re-scan from the untouched lastSyncAt. run.test.ts pins this with a
   test that runs a whole chain on a database migrated only through 0003:
   if a later phase adds a column to a table the engine reads or writes,
   that test fails until the number is raised, which is the reminder that
   the migration has to be applied before that code is deployed.

Also new in run.test.ts: the simulators serve the page size the query asks
for, and a seeded fuzz drives the whole engine against a shop whose index
lags (fresh nodes at stale sort positions, cursorless pages, throttles,
5xx, timeouts, rejected cursors) and checks that every order and every
latest snapshot arrives. `SYNC_FUZZ_SEEDS=3000 npx vitest run
src/server/sync/run.test.ts -t "seeded fuzz"` soaks it (about 90 seconds).
The fuzz keeps index lag under the 5 minute overlap on purpose: an order
that takes longer than the overlap to become searchable is outside what
this design promises.

Known limits, not fixed here (decide before relying on them):
- Line items beyond 49 per order are not fetched, but no longer silently:
  the order is marked itemsTruncated (see the line item state update at the
  end of this file).
- On plans with a small rate bucket, Shopify's throttle (not MAX_PAGES) is
  expected to end a backlog run early, by a rough estimate after a hundred
  orders or so; a 60 day first sync of a busy shop then drains over several
  ticks through the cursor chain. That is by design, and untested live. If
  it proves too slow, pace the page loop against
  extensions.cost.throttleStatus instead of raising the page size.
- While a cursor chain is draining, lastSyncAt stays at its old value on
  purpose (0 during a first sync). The Phase 5 connection card should show
  a "catching up" state whenever sync_cursor is set, not a stale "last
  synced" time.
- A slow shop can keep a full 100 request run going past the 120 second
  lease. That is safe (fenced writes, claim-then-read) but wasteful; a wall
  clock budget in the page loop would be a one-line stop now that every
  truncation is resumable.

## Immediate next steps, in order

1. Nothing to migrate: 0000-0003 are applied locally and remotely and
   `npx drizzle-kit generate` reports no schema changes. Re-run npm run
   test + tsc.
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
   e. Once the store connection exists, watch the first real sync for the
      query cost check described under round 2, item 2. The query also
      selects customer fields; if Shopify answers "Access denied for
      customer field", the token needs read_customers next to read_orders
      (not verified live either). Both failures are loud: lastError on the
      connection card and a sync_error event.
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

## STATE UPDATE, 2026-10-01 evening (supersedes anything above that conflicts)

- HEAD is 658c193 plus this handoff commit, all pushed. Commits 84b3266,
  7dade33 and 658c193 are the pre-deploy sync fixes plus two repair rounds.
  Gates at HEAD: 173 tests green, tsc clean, working tree clean.
- The round 2 repair (658c193) has NOT been independently reviewed. The
  verification workflow was stopped on purpose to save usage. Ultracode is OFF
  and Ryan questioned the value of repeated repair loops: from here on do ONE
  review pass per phase, and reserve heavy review for sign-in, store tokens and
  PO sending. Do NOT restart sync hardening loops.
- First thing next session: read `git diff f4ffaf8 HEAD -- src/` once yourself.
  Check two things in particular: (1) the Shopify orders query page sizes. A
  reviewer found orders(first 50) with lineItems(first 50) exceeds Shopify's
  1,000 point single-query cost limit, which would make every real sync fail
  loudly; confirm round 2 shrank the page sizes, and when the real store token
  exists read extensions.cost.requestedQueryCost from one live request.
  (2) the truncation and lastSyncAt anchoring rules still read coherently.
- Migrations: drizzle/ holds 0000-0003 only at HEAD (a 0004 added in round 1
  appears to have been removed again in round 2). drizzle-kit check and the
  drift test are green, and local plus remote D1 are both at 0003. Run
  `npm run db:generate` to confirm it reports no changes before deploying.
- Commit trailer is now: Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
- Next steps are otherwise unchanged: the smoke deploy sequence above, then
  Phase 4 (desk APIs), Phase 5 (screens), 6, 7, 8.
- Ryan is creating a Shopify custom app token (read orders) for the IMPACT
  store. He enters it himself in workspace settings once that screen exists;
  it must never be pasted into chat or committed.

## STATE UPDATE, 2026-10-02 (supersedes conflicting notes above)

- Sync repair round 2 (658c193) was reviewed once by the main session and
  accepted: query priced at 798 of Shopify's 1,000 point cap (pinned by a
  test), truncated runs always resume from Shopify's own cursor, lastSyncAt
  only moves forward. No further sync hardening loops.
- DEPLOYED: https://order-desk.restless-fog-f3c0.workers.dev (cron */10 live).
  Secrets set on the Worker: BETTER_AUTH_SECRET, ENCRYPTION_KEY, CRON_SECRET.
  APP_URL in wrangler.jsonc now points at that URL. Remote D1 at 0003.
  Smoke checks passed: signed-out redirect, sign-in page, session endpoint,
  401 on the API, magic-link validation (no email sent by the agent).
- Build fix: the home page is force-dynamic. Any future page that reads the
  session must be dynamic too, or `next build` prerenders it and fails.
- Pending on Ryan: open the URL, sign in with his email (first real email from
  orders@impactrentals.store), create the IMPACT Rentals workspace.
- Next: Phase 4 (desk APIs). One implementer, one review pass; heavy review
  only for the store-token connection route.
- Commit trailer is now: Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
- Redeploy after code changes: `npm run deploy`. Config-only change:
  `npx opennextjs-cloudflare deploy`. Apply new migrations remotely first:
  `npm run db:migrate:remote`.

## STATE UPDATE, 2026-10-02, line item truncation marker (962766f)

Supersedes the 798 point figure and the old line item limit above.

- The orders query asks for lineItems(first: 49) with pageInfo { hasNextPage }
  and prices at 788 points by the client.test.ts estimator (budget 800). The
  marker costs one object per order; with 50 slots it would price at 803,
  which is why the cap went from 50 to 49. The live cost check under round 2,
  item 2 still applies, with 788 as the expected figure.
- Every stored orders.shopify snapshot carries itemsTruncated. It is false
  only when Shopify said the order has no line items beyond `items`; a
  missing or malformed answer counts as truncated. Consumers must read it as
  `snapshot.itemsTruncated !== false`, so a snapshot stored before this
  change (no key) also counts as unconfirmed. No migration: the column is
  untyped JSON.
- The sync does not fetch the remaining line items. A follow-up request in
  the page loop would need its own throttle handling: on a small rate bucket
  a page of large orders can throttle the follow-up on every tick, and ending
  the run there would pin the cursor chain to that page.
- Phase 5 (desk): when the flag is set, say the order has more line items in
  Shopify than shown.
- Phase 7 (PO modal), required: when the flag is set, fetch that one order's
  full line item list on demand before prefilling (order(id:) with
  lineItems(first: 250, after:) paged, about 754 points per request by the
  same estimator), and if that fetch fails, block "Send to vendor" with a
  visible warning. Never prefill a PO from a list whose flag is set.
- Not deployed yet: the live Worker still runs the old query until the next
  `npm run deploy`. No store is connected, so nothing has synced with it.
