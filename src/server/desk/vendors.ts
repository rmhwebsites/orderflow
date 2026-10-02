// Workspace vendors (purchase order recipients). Never hard-deleted: Phase 7
// purchase orders reference vendors, so removal archives the row, and an
// archived vendor is treated as gone by every function here.

import { and, asc, eq, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { vendors } from "@/db/schema";
import { isRecord } from "./shapes";
import { normalizeEmail, normalizeEmailList } from "./validate";

export const VENDOR_NAME_MAX = 120;
export const VENDOR_CC_MAX = 10;
export const VENDOR_NOTES_MAX = 2000;

export type VendorView = {
  id: string;
  name: string;
  email: string;
  cc: string[];
  notes: string | null;
};

export type CreateVendorResult =
  | { kind: "invalid"; error: string }
  | { kind: "created"; vendor: VendorView };

export type UpdateVendorResult =
  | { kind: "invalid"; error: string }
  | { kind: "not-found" }
  | { kind: "updated"; vendor: VendorView };

export type ArchiveVendorResult = { kind: "not-found" } | { kind: "archived" };

type VendorFields = { name?: string; email?: string; cc?: string[]; notes?: string | null };

function vendorView(row: typeof vendors.$inferSelect): VendorView {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    cc: Array.isArray(row.cc) ? row.cc : [],
    notes: row.notes ?? null,
  };
}

// Validates the fields present in body; with required set, name and email
// must be present too. Emails are stored trimmed and lowercased, cc deduped,
// notes trimmed (blank notes become null).
function parseFields(body: unknown, required: boolean): VendorFields | string {
  if (!isRecord(body)) {
    return "Send the vendor as a JSON object";
  }
  const fields: VendorFields = {};
  if (required || body.name !== undefined) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (name.length === 0 || name.length > VENDOR_NAME_MAX) {
      return `The vendor name must be 1 to ${VENDOR_NAME_MAX} characters`;
    }
    fields.name = name;
  }
  if (required || body.email !== undefined) {
    const email = normalizeEmail(body.email);
    if (email === null) {
      return "A valid vendor email address is required";
    }
    fields.email = email;
  }
  if (body.cc !== undefined) {
    const cc = body.cc === null ? [] : normalizeEmailList(body.cc, VENDOR_CC_MAX);
    if (cc === null) {
      return `CC takes a list of up to ${VENDOR_CC_MAX} valid email addresses`;
    }
    fields.cc = cc;
  }
  if (body.notes !== undefined) {
    if (body.notes !== null && typeof body.notes !== "string") {
      return "Notes must be text";
    }
    const notes = typeof body.notes === "string" ? body.notes.trim() : "";
    if (notes.length > VENDOR_NOTES_MAX) {
      return `Notes must be ${VENDOR_NOTES_MAX} characters or fewer`;
    }
    fields.notes = notes.length > 0 ? notes : null;
  }
  return fields;
}

function activeVendor(workspaceId: string, vendorId: string) {
  return and(
    eq(vendors.id, vendorId),
    eq(vendors.workspaceId, workspaceId),
    eq(vendors.archived, false),
  );
}

export async function listVendors(db: Db, workspaceId: string): Promise<VendorView[]> {
  const rows = await db
    .select()
    .from(vendors)
    .where(and(eq(vendors.workspaceId, workspaceId), eq(vendors.archived, false)))
    .orderBy(sql`${vendors.name} collate nocase`, asc(vendors.id));
  return rows.map(vendorView);
}

export async function createVendor(
  db: Db,
  workspaceId: string,
  body: unknown,
): Promise<CreateVendorResult> {
  const fields = parseFields(body, true);
  if (typeof fields === "string") {
    return { kind: "invalid", error: fields };
  }
  if (fields.name === undefined || fields.email === undefined) {
    return { kind: "invalid", error: "A vendor needs a name and an email address" };
  }
  const row = {
    id: crypto.randomUUID(),
    workspaceId,
    name: fields.name,
    email: fields.email,
    cc: fields.cc ?? [],
    notes: fields.notes ?? null,
    archived: false,
  };
  await db.insert(vendors).values(row);
  return { kind: "created", vendor: vendorView(row) };
}

// Partial update of an active vendor in this workspace; another workspace's
// vendor, an unknown id and an archived vendor are all not-found.
export async function updateVendor(
  db: Db,
  workspaceId: string,
  vendorId: string,
  body: unknown,
): Promise<UpdateVendorResult> {
  const fields = parseFields(body, false);
  if (typeof fields === "string") {
    return { kind: "invalid", error: fields };
  }
  if (Object.keys(fields).length === 0) {
    return { kind: "invalid", error: "Nothing to update: send name, email, cc or notes" };
  }
  const rows = await db
    .update(vendors)
    .set(fields)
    .where(activeVendor(workspaceId, vendorId))
    .returning();
  const row = rows[0];
  return row ? { kind: "updated", vendor: vendorView(row) } : { kind: "not-found" };
}

export async function archiveVendor(
  db: Db,
  workspaceId: string,
  vendorId: string,
): Promise<ArchiveVendorResult> {
  const rows = await db
    .update(vendors)
    .set({ archived: true })
    .where(activeVendor(workspaceId, vendorId))
    .returning({ id: vendors.id });
  return rows.length > 0 ? { kind: "archived" } : { kind: "not-found" };
}
