import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getDb } from "@/db";
import { receiveShopifyWebhook } from "@/server/shopify/webhooks";

type RouteContext = { params: Promise<{ workspaceId: string }> };

// Shopify webhook deliveries for one workspace. NO SESSION: the delivery is
// verified by its HMAC against the workspace's client secret, its shop
// domain and its webhook id (see receiveShopifyWebhook). The raw body is
// read once, as bytes, and the signature is checked over exactly those
// bytes. 200 at once for anything verified (the work runs after the
// response); 401 for anything that fails verification; 400 without a
// webhook id; 413 for an oversized body. Never log the body or headers:
// payloads carry customer data.
export async function POST(request: Request, context: RouteContext) {
  const { workspaceId } = await context.params;
  try {
    const rawBody = new Uint8Array(await request.arrayBuffer());
    const { env, ctx } = getCloudflareContext();
    const receipt = await receiveShopifyWebhook(getDb(), env, { workspaceId, rawBody, headers: request.headers });
    if (receipt.work) {
      ctx.waitUntil(receipt.work());
    }
    return new Response(null, { status: receipt.status });
  } catch (e) {
    // A 5xx makes Shopify retry later. The name only: no message, which
    // could carry query params.
    console.error("[webhook] " + JSON.stringify({ workspaceId, error: e instanceof Error ? e.name : "failed" }));
    return new Response(null, { status: 500 });
  }
}
