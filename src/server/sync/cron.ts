import { ne } from "drizzle-orm";
import { getDbFromEnv, type Db } from "../../db";
import { storeConnections } from "../../db/schema";
import { broadcastSync } from "../broadcast";
import { runSync, type SyncOptions } from "./run";

// Sequential on purpose: one shop at a time keeps D1 contention and Shopify
// rate pressure low, and a cron tick has ample wall clock for a handful of
// workspaces. Exported separately from runScheduledSync so tests can inject
// a Db and a fetch implementation.
export async function runAllSyncs(db: Db, env: CloudflareEnv, opts?: SyncOptions): Promise<void> {
  const rows = await db
    .select({ workspaceId: storeConnections.workspaceId })
    .from(storeConnections)
    .where(ne(storeConnections.status, "disabled"));

  for (const { workspaceId } of rows) {
    // One workspace blowing up must not take down the rest of the tick.
    try {
      const result = await runSync(db, env, workspaceId, opts);
      // Open desks refresh from the landed ids (never throws). Phase 6 hook
      // point: notify from result.addedOrderIds here.
      await broadcastSync(env, workspaceId, result);
      console.log(
        "[sync] " +
          JSON.stringify({
            workspaceId,
            added: result.added,
            updated: result.updated,
            skipped: result.skipped,
            error: result.error,
          }),
      );
    } catch (e) {
      console.log(
        "[sync] " +
          JSON.stringify({
            workspaceId,
            error: e instanceof Error ? e.message : "unexpected failure",
          }),
      );
    }
  }
}

export async function runScheduledSync(env: CloudflareEnv): Promise<void> {
  // scheduled() has no request context, so build the db straight from env;
  // getCloudflareContext() does not exist on this path.
  await runAllSyncs(getDbFromEnv(env), env);
}
