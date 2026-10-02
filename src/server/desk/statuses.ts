// Workspace status list: replaced as a whole, in display order.
//
// The lowest-sort status is the default for new synced orders (runSync picks
// it), so the first entry of the list an admin saves becomes the status every
// newly synced order starts in.

import { and, asc, count, eq, inArray, notExists, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { applyBatch } from "@/db/batch";
import { orders, statuses } from "@/db/schema";
import { isRecord, statusView, type StatusView } from "./shapes";

// Design token names; Phase 5 defines a light and a dark value for each. The
// seeded defaults (POST /api/workspaces) use lime, blue, amber, green,
// violet, slate and red.
export const STATUS_COLORS = [
  "lime",
  "blue",
  "amber",
  "green",
  "teal",
  "violet",
  "red",
  "slate",
  "pink",
] as const;
export const STATUS_LIST_MAX = 20;
const LABEL_MAX = 40;

export type InUseStatus = { key: string; label: string; count: number };

export type ReplaceStatusesResult =
  | { kind: "invalid"; error: string }
  | { kind: "in-use"; error: string; inUse: InUseStatus[] }
  | { kind: "ok"; statuses: StatusView[] };

type Entry = { key: string | null; label: string; color: string; triggersPo: boolean };

function parseEntries(body: unknown): Entry[] | string {
  if (!Array.isArray(body)) {
    return "Send the full status list as a JSON array";
  }
  if (body.length === 0 || body.length > STATUS_LIST_MAX) {
    return `Keep between 1 and ${STATUS_LIST_MAX} statuses`;
  }
  const entries: Entry[] = [];
  for (let i = 0; i < body.length; i++) {
    const raw: unknown = body[i];
    const position = `Status ${i + 1}`;
    if (!isRecord(raw)) {
      return `${position} must be an object`;
    }
    const label = typeof raw.label === "string" ? raw.label.trim() : "";
    if (label.length === 0 || label.length > LABEL_MAX) {
      return `${position}: the label must be 1 to ${LABEL_MAX} characters`;
    }
    const color = raw.color;
    if (typeof color !== "string" || !(STATUS_COLORS as readonly string[]).includes(color)) {
      return `${position}: the color must be one of ${STATUS_COLORS.join(", ")}`;
    }
    if (typeof raw.triggersPo !== "boolean") {
      return `${position}: triggersPo must be true or false`;
    }
    let key: string | null = null;
    if (raw.key !== undefined && raw.key !== null) {
      if (typeof raw.key !== "string") {
        return `${position}: the key must be a string`;
      }
      key = raw.key;
    }
    entries.push({ key, label, color, triggersPo: raw.triggersPo });
  }
  return entries;
}

// "Out for Delivery!!" becomes "out_for_delivery"; accented letters fold to
// their base letter first, and a label with nothing usable becomes "status".
function keyBase(label: string): string {
  const base = label
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return base.length > 0 ? base : "status";
}

function claimKey(label: string, taken: Set<string>): string {
  const base = keyBase(label);
  let key = base;
  for (let n = 2; taken.has(key); n++) {
    key = `${base}_${n}`;
  }
  taken.add(key);
  return key;
}

function listStatuses(db: Db, workspaceId: string) {
  return db
    .select()
    .from(statuses)
    .where(eq(statuses.workspaceId, workspaceId))
    .orderBy(asc(statuses.sort), asc(statuses.key));
}

// Replaces the workspace's statuses with the given ordered list. Entries
// with a key update that existing status (keys are immutable and identify
// statuses; an unknown key is refused); entries without one are new and get
// a key slugified from the label. Statuses left out are removed, unless an
// order still uses one: then nothing changes and the answer lists them with
// their order counts. Deletes, updates and inserts go out in one batch.
export async function replaceStatuses(
  db: Db,
  workspaceId: string,
  body: unknown,
): Promise<ReplaceStatusesResult> {
  const entries = parseEntries(body);
  if (typeof entries === "string") {
    return { kind: "invalid", error: entries };
  }

  const existing = await listStatuses(db, workspaceId);
  const existingKeys = new Set(existing.map((row) => row.key));
  const kept = new Set<string>();
  for (const entry of entries) {
    if (entry.key === null) {
      continue;
    }
    if (!existingKeys.has(entry.key)) {
      return { kind: "invalid", error: `Unknown status key "${entry.key}"` };
    }
    if (kept.has(entry.key)) {
      return { kind: "invalid", error: `Status key "${entry.key}" appears more than once` };
    }
    kept.add(entry.key);
  }
  const removed = existing.filter((row) => !kept.has(row.key));
  const removedKeys = removed.map((row) => row.key);

  if (removedKeys.length > 0) {
    const usage = await db
      .select({ statusKey: orders.statusKey, count: count() })
      .from(orders)
      .where(and(eq(orders.workspaceId, workspaceId), inArray(orders.statusKey, removedKeys)))
      .groupBy(orders.statusKey);
    const counts = new Map(usage.map((row) => [row.statusKey, Number(row.count)]));
    const inUse = removed
      .map((row) => ({ key: row.key, label: row.label, count: counts.get(row.key) ?? 0 }))
      .filter((status) => status.count > 0);
    if (inUse.length > 0) {
      return {
        kind: "in-use",
        error: "Statuses that orders still use cannot be removed. Move those orders first.",
        inUse,
      };
    }
  }

  // New keys never reuse a key the workspace has right now, including one
  // removed in this same save, so no statement below can trip the
  // (workspace, key) unique index whatever happens to the delete.
  const taken = new Set(existingKeys);
  const statements: PromiseLike<unknown>[] = [];
  if (removedKeys.length > 0) {
    // Guarded in SQL as well: an order assigned to one of these statuses
    // after the check above keeps its status instead of being orphaned (that
    // status then simply stays in the list).
    statements.push(
      db.delete(statuses).where(
        and(
          eq(statuses.workspaceId, workspaceId),
          inArray(statuses.key, removedKeys),
          notExists(
            db
              .select({ one: sql`1` })
              .from(orders)
              .where(and(eq(orders.workspaceId, workspaceId), eq(orders.statusKey, statuses.key))),
          ),
        ),
      ),
    );
  }
  entries.forEach((entry, sort) => {
    const fields = { label: entry.label, color: entry.color, sort, triggersPo: entry.triggersPo };
    if (entry.key !== null) {
      statements.push(
        db
          .update(statuses)
          .set(fields)
          .where(and(eq(statuses.workspaceId, workspaceId), eq(statuses.key, entry.key))),
      );
    } else {
      // One row per statement: a 20 row insert would bind 140 parameters,
      // over D1's limit of 100 per statement.
      statements.push(
        db.insert(statuses).values({
          id: crypto.randomUUID(),
          workspaceId,
          key: claimKey(entry.label, taken),
          ...fields,
        }),
      );
    }
  });
  await applyBatch(db, statements);

  const rows = await listStatuses(db, workspaceId);
  return { kind: "ok", statuses: rows.map(statusView) };
}
