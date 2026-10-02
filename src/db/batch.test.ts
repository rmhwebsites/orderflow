import { describe, it, expect, vi } from "vitest";
import type { Db } from "./index";
import { applyBatch, rowsAffected } from "./batch";

describe("rowsAffected", () => {
  it("reads the better-sqlite3 and the D1 result shapes", () => {
    expect(rowsAffected({ changes: 2, lastInsertRowid: 9 }, "desk")).toBe(2);
    expect(rowsAffected({ success: true, meta: { changes: 0 } }, "desk")).toBe(0);
  });

  it("counts an unknown shape as one row and logs it under the caller's label", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(rowsAffected({ rows: [] }, "desk")).toBe(1);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain(
        "[desk] unknown write result shape, assuming one row affected",
      );
    } finally {
      warn.mockRestore();
    }
  });
});

describe("applyBatch", () => {
  it("routes every statement through one db.batch call without awaiting them individually", async () => {
    const batch = vi.fn(async () => ["r1", "r2", "r3"]);
    const statements = [{ then: vi.fn() }, { then: vi.fn() }, { then: vi.fn() }];
    const results = await applyBatch(
      { batch } as unknown as Db,
      statements as unknown as PromiseLike<unknown>[],
    );
    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch).toHaveBeenCalledWith(statements);
    for (const statement of statements) {
      expect(statement.then).not.toHaveBeenCalled();
    }
    expect(results).toEqual(["r1", "r2", "r3"]);
  });

  it("awaits the statements in order and returns their results when batch is unavailable", async () => {
    const executed: string[] = [];
    const statement = (name: string) =>
      ({
        then: (resolve: (value: unknown) => void) => {
          executed.push(name);
          resolve(`${name}-result`);
        },
      }) as PromiseLike<unknown>;
    const results = await applyBatch({} as Db, [statement("a"), statement("b"), statement("c")]);
    expect(executed).toEqual(["a", "b", "c"]);
    expect(results).toEqual(["a-result", "b-result", "c-result"]);
  });

  it("stops at the first failing statement on the sequential path", async () => {
    const executed: string[] = [];
    const ok = (name: string) =>
      ({
        then: (resolve: (value: unknown) => void) => {
          executed.push(name);
          resolve(name);
        },
      }) as PromiseLike<unknown>;
    const failing = {
      then: (_resolve: (value: unknown) => void, reject: (reason: unknown) => void) => {
        executed.push("bad");
        reject(new Error("constraint failed"));
      },
    } as PromiseLike<unknown>;
    await expect(applyBatch({} as Db, [ok("a"), failing, ok("c")])).rejects.toThrow(
      "constraint failed",
    );
    expect(executed).toEqual(["a", "bad"]);
  });

  it("returns an empty list without calling batch when there is nothing to run", async () => {
    const batch = vi.fn(async () => []);
    expect(await applyBatch({ batch } as unknown as Db, [])).toEqual([]);
    expect(batch).not.toHaveBeenCalled();
  });
});
