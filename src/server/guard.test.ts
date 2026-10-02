import { describe, it, expect } from "vitest";
import * as schema from "@/db/schema";
import { AuthError, resolveOrderAccess, roleAtLeast } from "./guard";
import { openTestDb, seedOrder, seedWorkspace } from "./desk/test-helpers";

describe("roleAtLeast", () => {
  it("admin satisfies member", () => {
    expect(roleAtLeast("admin", "member")).toBe(true);
  });

  it("member does not satisfy admin", () => {
    expect(roleAtLeast("member", "admin")).toBe(false);
  });

  it("owner satisfies owner", () => {
    expect(roleAtLeast("owner", "owner")).toBe(true);
  });

  it("member satisfies member", () => {
    expect(roleAtLeast("member", "member")).toBe(true);
  });

  it("owner satisfies admin", () => {
    expect(roleAtLeast("owner", "admin")).toBe(true);
  });

  it("admin does not satisfy owner", () => {
    expect(roleAtLeast("admin", "owner")).toBe(false);
  });
});

// The db-taking core of requireMemberByOrder (which adds only the session).
describe("resolveOrderAccess", () => {
  async function setup() {
    const { db } = openTestDb();
    await seedWorkspace(db, "ws_impact");
    await seedWorkspace(db, "ws_other");
    await db.insert(schema.workspaceMembers).values([
      { id: "m1", workspaceId: "ws_impact", userId: "user_member", role: "member" },
      { id: "m2", workspaceId: "ws_impact", userId: "user_admin", role: "admin" },
      { id: "m3", workspaceId: "ws_other", userId: "user_outsider", role: "owner" },
    ]);
    await seedOrder(db, "ws_impact", { id: "o1" });
    return db;
  }

  async function failureOf(promise: Promise<unknown>) {
    try {
      await promise;
    } catch (e) {
      return e;
    }
    throw new Error("expected a rejection");
  }

  it("answers a missing order, a non-member and an under-ranked member with the same 404", async () => {
    const db = await setup();
    const failures = [
      await failureOf(resolveOrderAccess(db, "missing", "user_member", "member")),
      await failureOf(resolveOrderAccess(db, "o1", "user_outsider", "member")),
      await failureOf(resolveOrderAccess(db, "o1", "user_member", "admin")),
    ];
    for (const failure of failures) {
      expect(failure).toBeInstanceOf(AuthError);
      expect((failure as AuthError).status).toBe(404);
    }
    const messages = failures.map((failure) => (failure as AuthError).message);
    expect(new Set(messages).size).toBe(1);
    expect(messages[0]).toBe("Not found");
  });

  it("returns the member's role and the order's workspace", async () => {
    const db = await setup();
    expect(await resolveOrderAccess(db, "o1", "user_member", "member")).toEqual({
      role: "member",
      workspaceId: "ws_impact",
    });
    expect(await resolveOrderAccess(db, "o1", "user_admin", "admin")).toEqual({
      role: "admin",
      workspaceId: "ws_impact",
    });
  });
});
