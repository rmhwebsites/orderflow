import { describe, it, expect } from "vitest";
import { fetchOrdersUpdatedSince, SHOPIFY_API_VERSION } from "./client";

const DOMAIN = "impact-rentals.myshopify.com";
const TOKEN = "shpat_super_secret_value_9f3a";
const SINCE = "2026-08-01T00:00:00.000Z";

type RecordedCall = { url: string; init: RequestInit; body: Record<string, unknown> };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function ordersPage(
  nodes: unknown[],
  pageInfo: { hasNextPage: boolean; endCursor: string | null },
): Response {
  return jsonResponse({ data: { orders: { nodes, pageInfo } } });
}

// Sequential stub: each call consumes the next scripted response (a Response,
// an Error to throw, or a factory). Records every call for assertions.
function stubFetch(script: Array<Response | Error | (() => Response)>) {
  const calls: RecordedCall[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const parsedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ url: String(input), init: init ?? {}, body: parsedBody });
    const next = script.shift();
    if (!next) {
      throw new Error("fetch stub script exhausted");
    }
    if (next instanceof Error) {
      throw next;
    }
    return typeof next === "function" ? next() : next;
  }) as typeof fetch;
  return { impl, calls };
}

describe("fetchOrdersUpdatedSince", () => {
  it("fetches a single page of orders", async () => {
    const nodes = [{ id: "gid://shopify/Order/1", name: "#1001" }];
    const { impl, calls } = stubFetch([ordersPage(nodes, { hasNextPage: false, endCursor: null })]);

    const result = await fetchOrdersUpdatedSince(DOMAIN, TOKEN, SINCE, impl);

    expect(result).toEqual({ kind: "ok", nodes });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`https://${DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`);
    expect(calls[0].init.method).toBe("POST");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["X-Shopify-Access-Token"]).toBe(TOKEN);
    expect(headers["content-type"]).toBe("application/json");
    const query = String(calls[0].body.query);
    expect(query).toContain("first: 50");
    expect(query).toContain("sortKey: UPDATED_AT");
    expect(query).toContain(`updated_at:>='${SINCE}'`);
    expect(query).toContain("legacyResourceId");
    expect(query).toContain("lineItems(first: 50)");
    expect((calls[0].body.variables as Record<string, unknown>).cursor).toBeNull();
  });

  it("paginates and passes the cursor on the second call", async () => {
    const first = [{ id: "gid://shopify/Order/1" }];
    const second = [{ id: "gid://shopify/Order/2" }];
    const { impl, calls } = stubFetch([
      ordersPage(first, { hasNextPage: true, endCursor: "cursor-page-2" }),
      ordersPage(second, { hasNextPage: false, endCursor: null }),
    ]);

    const result = await fetchOrdersUpdatedSince(DOMAIN, TOKEN, SINCE, impl);

    expect(result).toEqual({ kind: "ok", nodes: [...first, ...second] });
    expect(calls).toHaveLength(2);
    expect((calls[0].body.variables as Record<string, unknown>).cursor).toBeNull();
    expect((calls[1].body.variables as Record<string, unknown>).cursor).toBe("cursor-page-2");
  });

  it("stops at the hard cap of 10 pages and returns what was gathered", async () => {
    const script = Array.from({ length: 12 }, (_, i) =>
      ordersPage([{ id: `gid://shopify/Order/${i}` }], {
        hasNextPage: true,
        endCursor: `cursor-${i}`,
      }),
    );
    const { impl, calls } = stubFetch(script);

    const result = await fetchOrdersUpdatedSince(DOMAIN, TOKEN, SINCE, impl);

    expect(calls).toHaveLength(10);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.nodes).toHaveLength(10);
    }
  });

  it("classifies 401 and 403 as auth", async () => {
    for (const status of [401, 403]) {
      const { impl } = stubFetch([jsonResponse({ errors: "unauthorized" }, status)]);
      expect(await fetchOrdersUpdatedSince(DOMAIN, TOKEN, SINCE, impl)).toEqual({ kind: "auth" });
    }
  });

  it("classifies 429 and 5xx as transient with the status in the detail", async () => {
    for (const status of [429, 500, 503]) {
      const { impl } = stubFetch([jsonResponse({}, status)]);
      const result = await fetchOrdersUpdatedSince(DOMAIN, TOKEN, SINCE, impl);
      expect(result.kind).toBe("transient");
      if (result.kind === "transient") {
        expect(result.detail).toContain(String(status));
        expect(result.detail).not.toContain(TOKEN);
      }
    }
  });

  it("classifies a THROTTLED GraphQL error as transient", async () => {
    const { impl } = stubFetch([
      jsonResponse({
        errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
      }),
    ]);
    const result = await fetchOrdersUpdatedSince(DOMAIN, TOKEN, SINCE, impl);
    expect(result.kind).toBe("transient");
  });

  it("classifies other GraphQL errors as fatal with the first message", async () => {
    const { impl } = stubFetch([
      jsonResponse({
        errors: [
          { message: "Field 'bogus' doesn't exist on type 'Order'" },
          { message: "second error" },
        ],
      }),
    ]);
    const result = await fetchOrdersUpdatedSince(DOMAIN, TOKEN, SINCE, impl);
    expect(result).toEqual({ kind: "fatal", detail: "Field 'bogus' doesn't exist on type 'Order'" });
  });

  it("classifies a network throw as transient", async () => {
    const { impl } = stubFetch([new Error("socket hang up")]);
    const result = await fetchOrdersUpdatedSince(DOMAIN, TOKEN, SINCE, impl);
    expect(result.kind).toBe("transient");
    if (result.kind === "transient") {
      expect(result.detail).not.toContain(TOKEN);
    }
  });

  it("classifies invalid JSON as transient", async () => {
    const { impl } = stubFetch([
      new Response("<html>bad gateway page</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    ]);
    const result = await fetchOrdersUpdatedSince(DOMAIN, TOKEN, SINCE, impl);
    expect(result.kind).toBe("transient");
  });

  it("rejects an invalid shop domain without ever calling fetch", async () => {
    const badDomains = [
      "evil.example.com",
      "impact.myshopify.com.evil.com",
      "Impact-Rentals.myshopify.com",
      "-leading-dash.myshopify.com",
      "spaces here.myshopify.com",
      "",
    ];
    for (const domain of badDomains) {
      const { impl, calls } = stubFetch([]);
      const result = await fetchOrdersUpdatedSince(domain, TOKEN, SINCE, impl);
      expect(result).toEqual({ kind: "fatal", detail: "invalid shop domain" });
      expect(calls).toHaveLength(0);
    }
  });

  it("never leaks the token into a detail string, even when the response echoes it", async () => {
    const { impl } = stubFetch([
      jsonResponse({ errors: [{ message: `rejected token ${TOKEN} for shop` }] }),
    ]);
    const result = await fetchOrdersUpdatedSince(DOMAIN, TOKEN, SINCE, impl);
    expect(result.kind).toBe("fatal");
    if (result.kind === "fatal") {
      expect(result.detail).not.toContain(TOKEN);
      expect(result.detail).toContain("rejected token");
    }
  });
});
