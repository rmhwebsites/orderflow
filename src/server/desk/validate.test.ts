import { describe, it, expect } from "vitest";
import { EMAIL_MAX, normalizeEmail, normalizeEmailList } from "./validate";

describe("normalizeEmail", () => {
  it("trims and lowercases valid addresses", () => {
    expect(normalizeEmail("  Riley.Oakes+PO@Example.COM ")).toBe("riley.oakes+po@example.com");
    expect(normalizeEmail("o'brien@example.ie")).toBe("o'brien@example.ie");
    expect(normalizeEmail("ops@mail.impact-rentals.store")).toBe("ops@mail.impact-rentals.store");
  });

  // These addresses end up in outbound mail headers (vendor To/CC, reply-to,
  // notification lists), so anything that could split or extend a header is
  // refused, not just obviously malformed input.
  it("rejects malformed and header-unsafe input", () => {
    const bad: unknown[] = [
      "",
      "   ",
      "no-at-sign",
      "a@b",
      "a b@example.com",
      "a,b@example.com",
      "a@example.com,c@example.com",
      "a;b@example.com",
      "<a@example.com>",
      "Name <a@example.com>",
      '"a"@example.com',
      "a@example.com\r\nBcc: x@example.com",
      "a@exa mple.com",
      "a@example..com",
      "a@-example.com",
      "a@example-.com",
      "a@@example.com",
      42,
      null,
      undefined,
      ["a@example.com"],
    ];
    for (const value of bad) {
      expect(normalizeEmail(value), JSON.stringify(value)).toBeNull();
    }
  });

  it("caps addresses at 254 characters", () => {
    expect(EMAIL_MAX).toBe(254);
    const domain = "@example.com";
    const fits = "a".repeat(EMAIL_MAX - domain.length) + domain;
    expect(normalizeEmail(fits)).toBe(fits);
    expect(normalizeEmail("a" + fits)).toBeNull();
  });
});

describe("normalizeEmailList", () => {
  it("normalizes and dedupes, keeping first-seen order", () => {
    expect(
      normalizeEmailList([" B@example.com", "a@example.com", "b@EXAMPLE.com"], 10),
    ).toEqual(["b@example.com", "a@example.com"]);
    expect(normalizeEmailList([], 10)).toEqual([]);
  });

  it("rejects a non-array, an invalid entry, or more entries than the cap", () => {
    expect(normalizeEmailList("a@example.com", 10)).toBeNull();
    expect(normalizeEmailList(null, 10)).toBeNull();
    expect(normalizeEmailList(["a@example.com", "nope"], 10)).toBeNull();
    const eleven = Array.from({ length: 11 }, (_, i) => `u${i}@example.com`);
    expect(normalizeEmailList(eleven, 10)).toBeNull();
    expect(normalizeEmailList(eleven.slice(0, 10), 10)).toHaveLength(10);
  });
});
