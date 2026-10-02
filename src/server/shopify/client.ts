// Shopify Admin GraphQL client. Callers always get a typed result, never an
// exception, and the access token is never written into any detail string.

// Pinned Admin API version; bump deliberately (see docs/plans execution notes).
export const SHOPIFY_API_VERSION = "2025-07";

export type ShopifyFetchResult =
  | {
      kind: "ok";
      nodes: unknown[];
      // Every matching order from the starting point onward was gathered.
      truncated: false;
      maxUpdatedAt: string | null;
      endCursor: null;
    }
  | {
      kind: "ok";
      nodes: unknown[];
      // More matching orders exist beyond what was gathered: the run stopped
      // at the page cap, at a page that came back without a usable cursor, or
      // at a retryable failure after at least one page had been read.
      // endCursor is always the position the next tick resumes from, so a
      // truncated run never needs any other anchor.
      truncated: true;
      // The newest updatedAt among the gathered nodes. Informational only and
      // never a window anchor: nodes are hydrated fresh, so an order edited a
      // moment ago can still sit at its old place in the updated_at sort and
      // carry an updatedAt far ahead of everything the run has not reached.
      maxUpdatedAt: string;
      endCursor: string;
    }
  | { kind: "auth" }
  | { kind: "transient"; detail: string }
  | { kind: "fatal"; detail: string };

export type FetchOrdersOptions = {
  // Resume pagination from a cursor persisted by an earlier truncated run.
  startCursor?: string;
};

// Anchored allowlist for the host that receives the token. Anything else is
// rejected before fetch, so a tampered shop_domain row cannot exfiltrate the
// token to an arbitrary host.
const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

// The since window is interpolated into a search string, so only a strict
// UTC ISO timestamp is accepted.
const SINCE_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

const REQUEST_TIMEOUT_MS = 90000;

// Page shape, sized against Shopify's calculated query cost. Shopify refuses
// a query whose requested cost is above 1,000 points before running it, on
// every plan. Scalars are free, an object costs 1 point and a connection 2,
// and everything selected under a connection is multiplied by its page size.
// One order therefore costs 10 points (the order, two price sets of two
// objects each, customer, shipping address, the line item connection and its
// pageInfo) plus 3 per line item slot (the item and its price set), which
// makes orders x line items the whole budget. Five orders of up to 49 line
// items request 3 + 5 x 157 = 788; a 50th slot would make it 803.
// client.test.ts prices the query that is actually sent and fails above 800,
// and raising either number means lowering the other. An order with more
// line items keeps its first 49 and is stored with itemsTruncated set (from
// the line item pageInfo, see normalize.ts), so nothing built from the
// snapshot can mistake it for the whole order.
export const ORDERS_PER_PAGE = 5;
const LINE_ITEMS_PER_ORDER = 49;
// 100 pages of 5 keep one run's ceiling at 500 orders. A shop's rate bucket
// may well end a large run before that (see retryable below), which is fine:
// the cursor carries on next tick.
export const MAX_PAGES = 100;

// Both the cursor and the updated_at search ride as GraphQL variables, so no
// runtime value is ever spliced into the query document itself (the two page
// sizes are the module constants above).
const ORDERS_QUERY = `
query OrdersUpdatedSince($cursor: String, $search: String) {
  orders(first: ${ORDERS_PER_PAGE}, after: $cursor, sortKey: UPDATED_AT, query: $search) {
    nodes {
      id
      legacyResourceId
      name
      createdAt
      updatedAt
      email
      tags
      note
      displayFinancialStatus
      displayFulfillmentStatus
      currentTotalPriceSet { shopMoney { amount currencyCode } }
      totalPriceSet { shopMoney { amount currencyCode } }
      customer { firstName lastName displayName email }
      shippingAddress { name firstName lastName address1 address2 city provinceCode zip countryCode }
      lineItems(first: ${LINE_ITEMS_PER_ORDER}) {
        nodes { title quantity sku variantTitle originalUnitPriceSet { shopMoney { amount } } }
        pageInfo { hasNextPage }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Detail strings can carry text that originated outside this worker (error
// messages, response bodies). Strip the token in case anything echoes it.
function scrub(detail: string, token: string): string {
  return token.length > 0 ? detail.split(token).join("[redacted]") : detail;
}

// Shopify signals rate limiting as a GraphQL error carrying extensions.code
// THROTTLED; a message merely mentioning the word does not count.
function isThrottled(errors: unknown[]): boolean {
  return errors.some(
    (error) =>
      isRecord(error) && isRecord(error.extensions) && error.extensions.code === "THROTTLED",
  );
}

export async function fetchOrdersUpdatedSince(
  shopDomain: string,
  token: string,
  sinceIso: string,
  fetchImpl: typeof fetch = fetch,
  opts?: FetchOrdersOptions,
): Promise<ShopifyFetchResult> {
  if (!SHOP_DOMAIN.test(shopDomain)) {
    return { kind: "fatal", detail: "invalid shop domain" };
  }
  if (!SINCE_ISO.test(sinceIso)) {
    return { kind: "fatal", detail: "invalid since timestamp" };
  }

  const url = `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
  const search = `updated_at:>='${sinceIso}'`;
  const nodes: unknown[] = [];
  // The cursor the next request is sent with: the caller's resume point at
  // first, then the endCursor of the last page read.
  let cursor: string | null = opts?.startCursor ?? null;
  let pagesRead = 0;
  let maxUpdatedAt: string | null = null;
  let maxUpdatedAtMs = -Infinity;

  // Ends the run with more orders still to come. resumeFrom is where the
  // next tick picks up; without one the run has nothing to show that the
  // next tick could build on, so it is reported as a retryable failure.
  const truncatedAt = (resumeFrom: string | null): ShopifyFetchResult => {
    if (maxUpdatedAt === null) {
      // Every order node carries updatedAt (the query selects it). A
      // truncated run in which none parses is a malformed payload: retry the
      // window on the next tick instead of persisting a cursor past it.
      return { kind: "transient", detail: "truncated response with no usable updatedAt watermark" };
    }
    if (resumeFrom === null) {
      return { kind: "transient", detail: "Shopify reported more pages but returned no cursor" };
    }
    return { kind: "ok", nodes, truncated: true, maxUpdatedAt, endCursor: resumeFrom };
  };

  // A failure the next tick can retry (throttle, timeout, network, 5xx, a
  // garbled body). On the first request it is reported as such. Once pages
  // have been read they are kept: the run ends as a truncation at the cursor
  // the failed request was sent with, and the next tick resumes there. With
  // up to MAX_PAGES small requests per run, a throttle part-way is how a
  // large backlog normally ends a tick; throwing the pages away would fetch
  // and drop the same ones on every tick. A failure that persists shows up
  // on the next tick, where it hits the first request.
  const retryable = (detail: string): ShopifyFetchResult =>
    pagesRead > 0 && cursor !== null && maxUpdatedAt !== null
      ? truncatedAt(cursor)
      : { kind: "transient", detail };

  while (pagesRead < MAX_PAGES) {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": token,
          "content-type": "application/json",
        },
        body: JSON.stringify({ query: ORDERS_QUERY, variables: { cursor, search } }),
        // Never follow a redirect: the default would re-send the access token
        // to whatever host the redirect names.
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      const name = typeof e === "object" && e !== null ? (e as { name?: unknown }).name : undefined;
      if (name === "TimeoutError" || name === "AbortError") {
        return retryable("Shopify request timed out");
      }
      const message = e instanceof Error ? e.message : "fetch threw";
      return retryable(scrub(`network error: ${message}`, token));
    }

    if (response.status === 401 || response.status === 403) {
      return { kind: "auth" };
    }
    // Anything else outside 2xx (429, 5xx, but also 3xx/4xx surprises) is
    // retried on the next tick rather than parsed into a false green.
    if (response.status < 200 || response.status >= 300) {
      return retryable(`Shopify responded with HTTP ${response.status}`);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return retryable("Shopify returned invalid JSON");
    }

    const errors = isRecord(body) ? body.errors : undefined;
    if (Array.isArray(errors) && errors.length > 0) {
      if (isThrottled(errors)) {
        return retryable("Shopify throttled the request");
      }
      // Everything else is fatal and loud, including MAX_COST_EXCEEDED (the
      // query asked for more than Shopify's single query limit): the detail
      // is Shopify's own message, which names the cost and the limit.
      const first = errors[0] as { message?: unknown } | null;
      const message =
        typeof first?.message === "string" ? first.message : "Shopify returned a GraphQL error";
      return { kind: "fatal", detail: scrub(message, token) };
    }

    const orders = isRecord(body) && isRecord(body.data) ? body.data.orders : undefined;
    if (
      !isRecord(orders) ||
      !Array.isArray(orders.nodes) ||
      !isRecord(orders.pageInfo) ||
      typeof orders.pageInfo.hasNextPage !== "boolean"
    ) {
      return retryable("unexpected response shape");
    }

    for (const node of orders.nodes) {
      nodes.push(node);
      const updatedAt = isRecord(node) && typeof node.updatedAt === "string" ? node.updatedAt : "";
      const updatedAtMs = Date.parse(updatedAt);
      if (!Number.isNaN(updatedAtMs) && updatedAtMs > maxUpdatedAtMs) {
        maxUpdatedAtMs = updatedAtMs;
        maxUpdatedAt = updatedAt;
      }
    }

    const pageInfo = orders.pageInfo;
    if (pageInfo.hasNextPage !== true) {
      return { kind: "ok", nodes, truncated: false, maxUpdatedAt, endCursor: null };
    }
    if (typeof pageInfo.endCursor !== "string" || pageInfo.endCursor.length === 0) {
      // More pages exist but Shopify handed back no cursor to reach them.
      // Nothing read so far says where the unread orders begin (a node's
      // updatedAt is not its sort position), so the only safe resume point
      // is the cursor this request was sent with: the next tick asks for
      // this page again. On the first request that would be no progress at
      // all, and reporting it as progress would stall without a trace if
      // Shopify kept answering like this, so that case is a failure.
      return truncatedAt(pagesRead > 0 ? cursor : null);
    }
    cursor = pageInfo.endCursor;
    pagesRead++;
  }

  // Page cap reached with more pages remaining: the caller persists endCursor
  // and resumes this exact window next tick, so dense updatedAt clusters
  // (hundreds of orders sharing one second) cannot livelock the sync.
  return truncatedAt(cursor);
}

// The same host allowlist the sync uses, for callers that normalize a shop
// domain before storing it (the connection settings route).
export function isValidShopDomain(domain: string): boolean {
  return SHOP_DOMAIN.test(domain);
}

export type ShopConnectionResult =
  | { kind: "ok"; shopName: string }
  | { kind: "auth" }
  | { kind: "transient"; detail: string }
  | { kind: "fatal"; detail: string };

// An owner waits on this while saving the connection, so it gets a much
// shorter budget than the sync's page requests.
const CONNECTION_TEST_TIMEOUT_MS = 15000;

const SHOP_NAME_QUERY = "{ shop { name } }";

// Verifies a domain and token pair with the cheapest possible query before
// the token is stored. Same protections as fetchOrdersUpdatedSince: the host
// is checked against the allowlist before any request, redirects are never
// followed (they would re-send the token), the request has a timeout, and no
// detail string ever contains the token. Never throws.
export async function testShopConnection(
  shopDomain: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ShopConnectionResult> {
  if (!SHOP_DOMAIN.test(shopDomain)) {
    return { kind: "fatal", detail: "invalid shop domain" };
  }

  let response: Response;
  try {
    response = await fetchImpl(
      `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
      {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": token,
          "content-type": "application/json",
        },
        body: JSON.stringify({ query: SHOP_NAME_QUERY }),
        redirect: "manual",
        signal: AbortSignal.timeout(CONNECTION_TEST_TIMEOUT_MS),
      },
    );
  } catch (e) {
    const name = typeof e === "object" && e !== null ? (e as { name?: unknown }).name : undefined;
    if (name === "TimeoutError" || name === "AbortError") {
      return { kind: "transient", detail: "Shopify request timed out" };
    }
    const message = e instanceof Error ? e.message : "fetch threw";
    return { kind: "transient", detail: scrub(`network error: ${message}`, token) };
  }

  if (response.status === 401 || response.status === 403) {
    return { kind: "auth" };
  }
  if (response.status < 200 || response.status >= 300) {
    return { kind: "transient", detail: `Shopify responded with HTTP ${response.status}` };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { kind: "transient", detail: "Shopify returned invalid JSON" };
  }

  const errors = isRecord(body) ? body.errors : undefined;
  if (Array.isArray(errors) && errors.length > 0) {
    if (isThrottled(errors)) {
      return { kind: "transient", detail: "Shopify throttled the request" };
    }
    const first = errors[0] as { message?: unknown } | null;
    const message =
      typeof first?.message === "string" ? first.message : "Shopify returned a GraphQL error";
    return { kind: "fatal", detail: scrub(message, token) };
  }

  const shop = isRecord(body) && isRecord(body.data) ? body.data.shop : undefined;
  if (!isRecord(shop) || typeof shop.name !== "string") {
    return { kind: "transient", detail: "unexpected response shape" };
  }
  // The name goes back to the browser; scrubbed like every other string
  // that originated outside this worker.
  return { kind: "ok", shopName: scrub(shop.name, token) };
}
