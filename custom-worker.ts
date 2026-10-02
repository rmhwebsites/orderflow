// @ts-ignore .open-next/worker.js is generated at build time; the import only
// resolves after the first opennextjs-cloudflare build, so ts-expect-error
// would flip between used and unused across builds.
import handler from "./.open-next/worker.js";
export { WorkspaceRoom } from "./src/realtime/room";
import { LIVE_PATH, handleLiveRequest } from "./src/realtime/live";
import { runScheduledSync } from "./src/server/sync/cron";

export default {
  async fetch(request, env, ctx) {
    // The realtime socket is answered here, before OpenNext: a Next.js route
    // handler cannot reliably hand back a WebSocket upgrade. Everything else
    // is the Next.js app.
    if (new URL(request.url).pathname === LIVE_PATH) {
      return handleLiveRequest(request, env);
    }
    return handler.fetch(request, env, ctx);
  },
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runScheduledSync(env));
  },
} satisfies ExportedHandler<CloudflareEnv>;
