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

// Rows affected by a write, across drivers: D1 reports meta.changes, the
// better-sqlite3 test driver reports changes at the top level. An unknown
// shape counts as 1 and is logged under the caller's label: a double-run is
// idempotent, a never-run is an outage.
export function rowsAffected(result: unknown, label: string): number {
  if (typeof result === "object" && result !== null) {
    const direct = (result as { changes?: unknown }).changes;
    if (typeof direct === "number") {
      return direct;
    }
    const meta = (result as { meta?: { changes?: unknown } }).meta;
    if (meta && typeof meta.changes === "number") {
      return meta.changes;
    }
  }
  let shape = "unserializable";
  try {
    shape = JSON.stringify(result) ?? String(result);
  } catch {
    // keep the fallback label
  }
  console.warn(`[${label}] unknown write result shape, assuming one row affected: ` + shape);
  return 1;
}
