import { drizzle } from "drizzle-orm/d1";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import * as schema from "./schema";

// For code paths that already hold an env, such as the cron scheduled() handler,
// where getCloudflareContext() is not available.
export function getDbFromEnv(env: CloudflareEnv) {
  return drizzle(env.DB, { schema });
}

export function getDb() {
  return getDbFromEnv(getCloudflareContext().env);
}
export type Db = ReturnType<typeof getDb>;
export * as schema from "./schema";
