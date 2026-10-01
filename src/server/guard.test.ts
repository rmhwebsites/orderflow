import { describe, it, expect } from "vitest";
import { roleAtLeast } from "./guard";

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
