// Shopify Admin GraphQL client. Callers always get a typed result, never an
// exception, and the access token is never written into any detail string.

// Pinned Admin API version; bump deliberately (see docs/plans execution notes).
export const SHOPIFY_API_VERSION = "2025-07";

export type ShopifyFetchResult =
  | { kind: "ok"; nodes: unknown[] }
  | { kind: "auth" }
  | { kind: "transient"; detail: string }
  | { kind: "fatal"; detail: string };

// Anchored allowlist for the host that receives the token. Anything else is
// rejected before fetch, so a tampered shop_domain row cannot exfiltrate the
// token to an arbitrary host.
const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

const MAX_PAGES = 10;

function ordersQuery(sinceIso: string): string {
  return `
query OrdersUpdatedSince($cursor: String) {
  orders(first: 50, after: $cursor, sortKey: UPDATED_AT, query: "updated_at:>='${sinceIso}'") {
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
}

// Detail strings can carry text that originated outside this worker (error
// messages, response bodies). Strip the token in case anything echoes it.
function scrub(detail: string, token: string): string {
  return token.length > 0 ? detail.split(token).join("[redacted]") : detail;
}

type OrdersPage = {
  data?: {
    orders?: {
      nodes?: unknown;
      pageInfo?: { hasNextPage?: unknown; endCursor?: unknown };
    };
  };
  errors?: unknown;
};

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
  const query = ordersQuery(sinceIso);
  const nodes: unknown[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": token,
          "content-type": "application/json",
        },
        body: JSON.stringify({ query, variables: { cursor } }),
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : "fetch threw";
      return { kind: "transient", detail: scrub(`network error: ${message}`, token) };
    }

    if (response.status === 401 || response.status === 403) {
      return { kind: "auth" };
    }
    if (response.status === 429 || response.status >= 500) {
      return { kind: "transient", detail: `Shopify responded with HTTP ${response.status}` };
    }

    let body: OrdersPage;
    try {
      body = (await response.json()) as OrdersPage;
    } catch {
      return { kind: "transient", detail: "Shopify returned invalid JSON" };
    }

    const errors = body?.errors;
    if (Array.isArray(errors) && errors.length > 0) {
      // Shopify signals rate limiting as a GraphQL error with code THROTTLED.
      if (JSON.stringify(errors).includes("THROTTLED")) {
        return { kind: "transient", detail: "Shopify throttled the request" };
      }
      const first = errors[0] as { message?: unknown } | null;
      const message =
        typeof first?.message === "string" ? first.message : "Shopify returned a GraphQL error";
      return { kind: "fatal", detail: scrub(message, token) };
    }

    const orders = body?.data?.orders;
    if (Array.isArray(orders?.nodes)) {
      nodes.push(...orders.nodes);
    }
    const pageInfo = orders?.pageInfo;
    if (pageInfo?.hasNextPage !== true || typeof pageInfo.endCursor !== "string") {
      return { kind: "ok", nodes };
    }
    cursor = pageInfo.endCursor;
  }

  // Page cap reached: return what was gathered; the next sync tick resumes
  // from the new lastSyncAt window.
  return { kind: "ok", nodes };
}
