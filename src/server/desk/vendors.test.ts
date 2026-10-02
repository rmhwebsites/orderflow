import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { archiveVendor, createVendor, listVendors, updateVendor } from "./vendors";
import { openTestDb, seedWorkspace } from "./test-helpers";

const WS = "ws_impact";
const OTHER = "ws_other";

async function setup() {
  const { db } = openTestDb();
  await seedWorkspace(db, WS);
  await seedWorkspace(db, OTHER);
  return db;
}

async function vendorRow(db: Db, id: string) {
  const rows = await db.select().from(schema.vendors).where(eq(schema.vendors.id, id));
  return rows[0];
}

function allVendorRows(db: Db) {
  return db.select().from(schema.vendors);
}

async function created(db: Db, workspaceId: string, body: Record<string, unknown>) {
  const result = await createVendor(db, workspaceId, body);
  if (result.kind !== "created") {
    throw new Error("expected a created vendor, got " + JSON.stringify(result));
  }
  return result.vendor;
}

describe("createVendor", () => {
  it("stores a vendor with emails trimmed and lowercased, cc deduped, notes trimmed", async () => {
    const db = await setup();
    const result = await createVendor(db, WS, {
      name: "  Acme Supply  ",
      email: "  Orders@Acme.Example ",
      cc: ["Ap@Acme.Example", " ap@acme.example", "sales@acme.example"],
      notes: "  Net 30. Call before 3pm.  ",
    });

    expect(result.kind).toBe("created");
    if (result.kind !== "created") return;
    expect(result.vendor).toEqual({
      id: expect.any(String),
      name: "Acme Supply",
      email: "orders@acme.example",
      cc: ["ap@acme.example", "sales@acme.example"],
      notes: "Net 30. Call before 3pm.",
    });
    const row = await vendorRow(db, result.vendor.id);
    expect(row).toMatchObject({
      workspaceId: WS,
      name: "Acme Supply",
      email: "orders@acme.example",
      cc: ["ap@acme.example", "sales@acme.example"],
      notes: "Net 30. Call before 3pm.",
      archived: false,
    });
  });

  it("defaults cc to an empty list and notes to null", async () => {
    const db = await setup();
    const vendor = await created(db, WS, { name: "Bolt Co", email: "bolt@example.com" });
    expect(vendor.cc).toEqual([]);
    expect(vendor.notes).toBeNull();
    const blankNotes = await created(db, WS, {
      name: "Blank Notes Co",
      email: "blank@example.com",
      cc: null,
      notes: "   ",
    });
    expect(blankNotes.cc).toEqual([]);
    expect(blankNotes.notes).toBeNull();
  });

  it("accepts the documented maximums", async () => {
    const db = await setup();
    const domain = "@example.com";
    const vendor = await created(db, WS, {
      name: "n".repeat(120),
      email: "e".repeat(254 - domain.length) + domain,
      cc: Array.from({ length: 10 }, (_, i) => `cc${i}@example.com`),
      notes: "z".repeat(2000),
    });
    expect(vendor.cc).toHaveLength(10);
  });

  it("rejects invalid input and stores nothing", async () => {
    const db = await setup();
    const valid = { name: "Acme", email: "orders@acme.example" };
    const bodies: unknown[] = [
      null,
      "Acme",
      {},
      { email: valid.email },
      { name: valid.name },
      { ...valid, name: "" },
      { ...valid, name: "   " },
      { ...valid, name: "n".repeat(121) },
      { ...valid, name: 5 },
      { ...valid, email: "not an email" },
      { ...valid, email: "a,b@acme.example" },
      { ...valid, email: "e".repeat(250) + "@acme.example" },
      { ...valid, cc: "ap@acme.example" },
      { ...valid, cc: ["ap@acme.example", "nope"] },
      { ...valid, cc: Array.from({ length: 11 }, (_, i) => `cc${i}@example.com`) },
      { ...valid, notes: "z".repeat(2001) },
      { ...valid, notes: 12 },
    ];
    for (const body of bodies) {
      const result = await createVendor(db, WS, body);
      expect(result.kind, JSON.stringify(body)?.slice(0, 80)).toBe("invalid");
    }
    expect(await allVendorRows(db)).toEqual([]);
  });
});

describe("listVendors", () => {
  it("lists this workspace's active vendors by name, case-insensitively", async () => {
    const db = await setup();
    const zed = await created(db, WS, { name: "zed Parts", email: "z@example.com" });
    const acme = await created(db, WS, { name: "Acme", email: "a@example.com" });
    const gone = await created(db, WS, { name: "Bygone", email: "b@example.com" });
    await created(db, OTHER, { name: "Other Co", email: "o@example.com" });
    await archiveVendor(db, WS, gone.id);

    expect(await listVendors(db, WS)).toEqual([acme, zed]);
  });
});

describe("updateVendor", () => {
  it("changes only the provided fields, with the same normalization", async () => {
    const db = await setup();
    const vendor = await created(db, WS, {
      name: "Acme",
      email: "orders@acme.example",
      cc: ["ap@acme.example"],
      notes: "Net 30",
    });

    const renamed = await updateVendor(db, WS, vendor.id, { name: " Acme Supply " });
    expect(renamed).toEqual({ kind: "updated", vendor: { ...vendor, name: "Acme Supply" } });

    const rest = await updateVendor(db, WS, vendor.id, {
      email: " NEW@Acme.Example ",
      cc: [],
      notes: null,
    });
    expect(rest).toEqual({
      kind: "updated",
      vendor: { ...vendor, name: "Acme Supply", email: "new@acme.example", cc: [], notes: null },
    });
    expect(await vendorRow(db, vendor.id)).toMatchObject({
      name: "Acme Supply",
      email: "new@acme.example",
      cc: [],
      notes: null,
      archived: false,
    });
  });

  it("rejects invalid fields and an empty patch, changing nothing", async () => {
    const db = await setup();
    const vendor = await created(db, WS, { name: "Acme", email: "orders@acme.example" });
    const before = await vendorRow(db, vendor.id);
    for (const body of [
      {},
      null,
      { name: "" },
      { name: "ok", email: "broken" },
      { cc: ["x"] },
      { notes: "z".repeat(2001) },
      { unknownField: true },
    ]) {
      const result = await updateVendor(db, WS, vendor.id, body);
      expect(result.kind, JSON.stringify(body)).toBe("invalid");
    }
    expect(await vendorRow(db, vendor.id)).toEqual(before);
  });

  it("is not-found for another workspace's vendor, an unknown id, or an archived vendor", async () => {
    const db = await setup();
    const theirs = await created(db, OTHER, { name: "Other Co", email: "o@example.com" });
    const before = await vendorRow(db, theirs.id);
    expect(await updateVendor(db, WS, theirs.id, { name: "Hijacked" })).toEqual({
      kind: "not-found",
    });
    expect(await vendorRow(db, theirs.id)).toEqual(before);

    expect(await updateVendor(db, WS, "missing", { name: "Ghost" })).toEqual({
      kind: "not-found",
    });

    const archived = await created(db, WS, { name: "Old Co", email: "old@example.com" });
    await archiveVendor(db, WS, archived.id);
    expect(await updateVendor(db, WS, archived.id, { name: "Revived" })).toEqual({
      kind: "not-found",
    });
  });
});

describe("archiveVendor", () => {
  it("archives instead of deleting, so purchase orders can keep referencing it", async () => {
    const db = await setup();
    const vendor = await created(db, WS, { name: "Acme", email: "orders@acme.example" });

    expect(await archiveVendor(db, WS, vendor.id)).toEqual({ kind: "archived" });
    expect(await vendorRow(db, vendor.id)).toMatchObject({
      id: vendor.id,
      name: "Acme",
      archived: true,
    });
    expect(await listVendors(db, WS)).toEqual([]);
    // Already archived: gone as far as the API is concerned.
    expect(await archiveVendor(db, WS, vendor.id)).toEqual({ kind: "not-found" });
  });

  it("is not-found for another workspace's vendor and leaves it active", async () => {
    const db = await setup();
    const theirs = await created(db, OTHER, { name: "Other Co", email: "o@example.com" });
    expect(await archiveVendor(db, WS, theirs.id)).toEqual({ kind: "not-found" });
    expect((await vendorRow(db, theirs.id)).archived).toBe(false);
  });
});
