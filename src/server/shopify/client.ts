// Shopify Admin GraphQL client. Callers always get a typed result, never an
// exception, and the access token is never written into any detail string.

// Pinned Admin API version; bump deliberately (see docs/plans execution notes).
export const SHOPIFY_API_VERSION = "2025-07";

export type ShopifyFetchResult =
  | { kind: "ok"; nodes: unknown[]; truncated: boolean; maxUpdatedAt: string | null }
  | { kind: "auth" }
  | { kind: "transient"; detail: string }
  | { kind: "fatal"; detail: string };

// Anchored allowlist for the host that receives the token. Anything else is
// rejected before fetch, so a tampered shop_domain row cannot exfiltrate the
// token to an arbitrary host.
const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

const MAX_PAGES = 10;

// Both the cursor and the updated_at search ride as GraphQL variables, so no
// runtime value is ever spliced into the query document itself.
const ORDERS_QUERY = `
query OrdersUpdatedSince($cursor: String, $search: String) {
  orders(first: 50, after: $cursor, sortKey: UPDATED_AT, query: $search) {
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
      lineItems(first: 50) { nodes { title quantity sku variantTitle originalUnitPriceSet { shopMoney { amount } } } }
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
): Promise<ShopifyFetchResult> {
  if (!SHOP_DOMAIN.test(shopDomain)) {
    return { kind: "fatal", detail: "invalid shop domain" };
  }

  const url = `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
  const search = `updated_at:>='${sinceIso}'`;
  const nodes: unknown[] = [];
  let cursor: string | null = null;
  let maxUpdatedAt: string | null = null;
  let maxUpdatedAtMs = -Infinity;

  const ok = (truncated: boolean): ShopifyFetchResult => ({
    kind: "ok",
    nodes,
    truncated,
    maxUpdatedAt,
  });

  for (let page = 0; page < MAX_PAGES; page++) {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": token,
          "content-type": "application/json",
        },
        body: JSON.stringify({ query: ORDERS_QUERY, variables: { cursor, search } }),
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : "fetch threw";
      return { kind: "transient", detail: scrub(`network error: ${message}`, token) };
    }

    if (response.status === 401 || response.status === 403) {
      return { kind: "auth" };
    }
    // Anything else outside 2xx (429, 5xx, but also 3xx/4xx surprises) is
    // retried on the next tick rather than parsed into a false green.
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

    const orders = isRecord(body) && isRecord(body.data) ? body.data.orders : undefined;
    if (!isRecord(orders)) {
      return { kind: "transient", detail: "unexpected response shape" };
    }

    const pageNodes = Array.isArray(orders.nodes) ? orders.nodes : [];
    for (const node of pageNodes) {
      nodes.push(node);
      const updatedAt = isRecord(node) && typeof node.updatedAt === "string" ? node.updatedAt : "";
      const updatedAtMs = Date.parse(updatedAt);
      if (!Number.isNaN(updatedAtMs) && updatedAtMs > maxUpdatedAtMs) {
        maxUpdatedAtMs = updatedAtMs;
        maxUpdatedAt = updatedAt;
      }
    }

    const pageInfo = isRecord(orders.pageInfo) ? orders.pageInfo : undefined;
    if (pageInfo?.hasNextPage !== true) {
      return ok(false);
    }
    if (typeof pageInfo.endCursor !== "string") {
      // More pages exist but no cursor to reach them: report truncation so
      // the caller anchors the next window at the watermark.
      return ok(true);
    }
    cursor = pageInfo.endCursor;
  }

  // Page cap reached with more pages remaining: truncated plus the updatedAt
  // watermark lets the caller continue from here on the next tick (the query
  // sorts ascending by UPDATED_AT, so nothing before the watermark was missed).
  return ok(true);
}
