// Statements that must land together. db.batch is the atomic path on D1 (one
// implicit transaction: if any statement fails, none apply). The
// better-sqlite3-backed Db that tests inject has no batch method, so this
// falls back to sequential awaits in list order (drizzle builders are
// thenables that run on await); that path is NOT atomic and stops at the
// first failure. Returns the per-statement results so callers can read
// rows-affected or RETURNING rows.
//
// Relative, type-only import on purpose: src/server/sync/run.ts uses this and
// is bundled into the custom worker entrypoint (cron), not only the Next.js
// build.

import type { Db } from "./index";

export async function applyBatch(
  db: Db,
  statements: readonly PromiseLike<unknown>[],
): Promise<unknown[]> {
  // D1 rejects an empty batch; there is nothing to run anyway.
  if (statements.length === 0) {
    return [];
  }
  const batchable = db as unknown as {
    batch?: (statements: readonly PromiseLike<unknown>[]) => Promise<unknown[]>;
  };
  if (typeof batchable.batch === "function") {
    return await batchable.batch(statements);
  }
  const results: unknown[] = [];
  for (const statement of statements) {
    results.push(await statement);
  }
  return results;
}
