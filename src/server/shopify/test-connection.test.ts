import { describe, it, expect } from "vitest";
import { SHOPIFY_API_VERSION, isValidShopDomain, testShopConnection } from "./client";

const DOMAIN = "impact-rentals.myshopify.com";
const TOKEN = "shpat_connection_probe_secret_41ac";

type Call = { url: string; init: RequestInit; body: Record<string, unknown> };

function stub(respond: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      init: init ?? {},
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    return respond();
  }) as typeof fetch;
  return { impl, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function detailOf(result: Awaited<ReturnType<typeof testShopConnection>>): string {
  return "detail" in result ? result.detail : "";
}

describe("testShopConnection", () => {
  it("returns the shop name from a { shop { name } } query sent with the usual protections", async () => {
    const { impl, calls } = stub(() => json({ data: { shop: { name: "IMPACT Rentals" } } }));
    const result = await testShopConnection(DOMAIN, TOKEN, impl);

    expect(result).toEqual({ kind: "ok", shopName: "IMPACT Rentals" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`https://${DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`);
    expect(calls[0].init.method).toBe("POST");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["X-Shopify-Access-Token"]).toBe(TOKEN);
    expect(headers["content-type"]).toBe("application/json");
    expect(String(calls[0].body.query).replace(/\s+/g, " ").trim()).toBe("{ shop { name } }");
    expect(calls[0].init.redirect).toBe("manual");
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it("classifies 401 and 403 as auth", async () => {
    for (const status of [401, 403]) {
      const { impl } = stub(() => json({ errors: "Invalid API key or access token" }, status));
      expect(await testShopConnection(DOMAIN, TOKEN, impl)).toEqual({ kind: "auth" });
    }
  });

  it("classifies 429, 5xx and other non-2xx answers as transient, naming the status", async () => {
    for (const status of [429, 500, 503, 302, 404]) {
      const { impl } = stub(() => json({}, status));
      const result = await testShopConnection(DOMAIN, TOKEN, impl);
      expect(result.kind, String(status)).toBe("transient");
      expect(detailOf(result)).toContain(String(status));
    }
  });

  it("classifies a network throw and a timeout as transient", async () => {
    const network = stub(() => {
      throw new Error("socket hang up");
    });
    const networkResult = await testShopConnection(DOMAIN, TOKEN, network.impl);
    expect(networkResult.kind).toBe("transient");
    expect(detailOf(networkResult)).toContain("socket hang up");

    const timeout = stub(() => {
      throw new DOMException("The operation timed out", "TimeoutError");
    });
    expect(await testShopConnection(DOMAIN, TOKEN, timeout.impl)).toEqual({
      kind: "transient",
      detail: "Shopify request timed out",
    });
  });

  it("treats THROTTLED as transient and any other GraphQL error as fatal", async () => {
    const throttled = stub(() =>
      json({ errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] }),
    );
    expect((await testShopConnection(DOMAIN, TOKEN, throttled.impl)).kind).toBe("transient");

    const denied = stub(() => json({ errors: [{ message: "Access denied for shop field." }] }));
    expect(await testShopConnection(DOMAIN, TOKEN, denied.impl)).toEqual({
      kind: "fatal",
      detail: "Access denied for shop field.",
    });
  });

  it("treats invalid JSON or a body without a shop name as transient", async () => {
    const bodies = [
      () => new Response("<html>bad gateway</html>", { status: 200 }),
      () => json({}),
      () => json({ data: {} }),
      () => json({ data: { shop: null } }),
      () => json({ data: { shop: { name: 7 } } }),
    ];
    for (const body of bodies) {
      const { impl } = stub(body);
      expect((await testShopConnection(DOMAIN, TOKEN, impl)).kind).toBe("transient");
    }
  });

  it("never calls fetch for a domain outside the myshopify.com allowlist", async () => {
    for (const domain of [
      "evil.example.com",
      "impact.myshopify.com.evil.com",
      "Impact-Rentals.myshopify.com",
      "-leading.myshopify.com",
      "",
    ]) {
      const { impl, calls } = stub(() => json({ data: { shop: { name: "x" } } }));
      expect(await testShopConnection(domain, TOKEN, impl)).toEqual({
        kind: "fatal",
        detail: "invalid shop domain",
      });
      expect(calls).toHaveLength(0);
    }
  });

  it("never puts the token in a detail, even when the failure echoes it", async () => {
    const echoes = [
      stub(() => json({ errors: [{ message: `token ${TOKEN} is not valid for this shop` }] })),
      stub(() => {
        throw new Error(`TLS failure while sending ${TOKEN}`);
      }),
    ];
    for (const { impl } of echoes) {
      const result = await testShopConnection(DOMAIN, TOKEN, impl);
      expect(result.kind).not.toBe("ok");
      expect(detailOf(result)).not.toContain(TOKEN);
      expect(detailOf(result).length).toBeGreaterThan(0);
    }
  });
});

describe("isValidShopDomain", () => {
  it("accepts only lowercase myshopify.com hosts", () => {
    expect(isValidShopDomain("impact-rentals.myshopify.com")).toBe(true);
    for (const domain of ["Impact.myshopify.com", "impact.myshopify.com.evil.com", "example.com", ""]) {
      expect(isValidShopDomain(domain), domain).toBe(false);
    }
  });
});
