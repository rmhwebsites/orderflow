import { describe, it, expect, vi, beforeEach } from "vitest";
import * as schema from "../../db/schema";
import { openTestDb, seedWorkspace } from "../desk/test-helpers";
import type { SyncResult } from "./run";

vi.mock("./run", () => ({ runSync: vi.fn() }));
vi.mock("../broadcast", () => ({ broadcastSync: vi.fn(async () => undefined) }));

const { runSync } = await import("./run");
const { broadcastSync } = await import("../broadcast");
const { runAllSyncs } = await import("./cron");

const env = { ENCRYPTION_KEY: "unused" } as CloudflareEnv;

function result(overrides: Partial<SyncResult> = {}): SyncResult {
  return { added: 0, updated: 0, addedOrderIds: [], updatedOrderIds: [], ...overrides };
}

async function setup() {
  const { db } = openTestDb();
  for (const id of ["ws_a", "ws_b", "ws_off"]) {
    await seedWorkspace(db, id);
    await db.insert(schema.storeConnections).values({
      workspaceId: id,
      shopDomain: `${id}.myshopify.com`,
      encryptedToken: "v1.x",
      status: id === "ws_off" ? "disabled" : "ok",
    });
  }
  return db;
}

beforeEach(() => {
  vi.mocked(runSync).mockReset();
  vi.mocked(broadcastSync).mockClear();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

describe("runAllSyncs broadcasting", () => {
  it("broadcasts each workspace's landed ids after its run", async () => {
    const db = await setup();
    const a = result({ added: 1, addedOrderIds: ["o1"] });
    const b = result({ updated: 1, updatedOrderIds: ["o2"] });
    vi.mocked(runSync).mockImplementation(async (_db, _env, workspaceId) =>
      workspaceId === "ws_a" ? a : b,
    );
    await runAllSyncs(db, env);
    expect(vi.mocked(runSync).mock.calls.map((call) => call[2]).sort()).toEqual(["ws_a", "ws_b"]);
    expect(vi.mocked(broadcastSync).mock.calls).toEqual(
      expect.arrayContaining([
        [env, "ws_a", a],
        [env, "ws_b", b],
      ]),
    );
    expect(vi.mocked(broadcastSync)).toHaveBeenCalledTimes(2);
  });

  it("keeps going after one workspace's run throws", async () => {
    const db = await setup();
    const b = result({ added: 2, addedOrderIds: ["x", "y"] });
    vi.mocked(runSync).mockImplementation(async (_db, _env, workspaceId) => {
      if (workspaceId === "ws_a") {
        throw new Error("boom");
      }
      return b;
    });
    await runAllSyncs(db, env);
    expect(vi.mocked(broadcastSync).mock.calls).toEqual([[env, "ws_b", b]]);
  });
});
