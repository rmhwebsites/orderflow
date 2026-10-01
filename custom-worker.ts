// @ts-ignore .open-next/worker.js is generated at build time; the import only
// resolves after the first opennextjs-cloudflare build, so ts-expect-error
// would flip between used and unused across builds.
import handler from "./.open-next/worker.js";
export { WorkspaceRoom } from "./src/realtime/room";
import { runScheduledSync } from "./src/server/sync/cron";

export default {
  fetch: handler.fetch,
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runScheduledSync(env));
  },
} satisfies ExportedHandler<CloudflareEnv>;
