import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { THEMES, THEME_STORAGE_KEY, parseTheme } from "./theme";

const bootScript = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../public/theme-init.js"),
  "utf8",
);

describe("parseTheme", () => {
  it("accepts the three themes", () => {
    for (const theme of THEMES) {
      expect(parseTheme(theme)).toBe(theme);
    }
  });

  it("defaults to light for anything else", () => {
    for (const value of [null, undefined, "", "Dark", "auto", 1]) {
      expect(parseTheme(value)).toBe("light");
    }
  });
});

describe("public/theme-init.js", () => {
  // The boot script is a static file and cannot import the constants, so
  // this pins it to them.
  it("reads the same storage key the toggle writes", () => {
    expect(bootScript).toContain(JSON.stringify(THEME_STORAGE_KEY));
  });

  it("only ever applies dark or system (light is the bare :root)", () => {
    expect(bootScript).toContain('"dark"');
    expect(bootScript).toContain('"system"');
    expect(bootScript).not.toContain('"light"');
  });
});
