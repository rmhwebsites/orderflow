import { describe, it, expect } from "vitest";
import { escapeHtml, sanitizeSubject } from "./escape";

describe("escapeHtml", () => {
  it("escapes ampersands", () => {
    expect(escapeHtml("Bob & Co")).toBe("Bob &amp; Co");
  });

  it("escapes less-than", () => {
    expect(escapeHtml("<b>Evil</b>")).toBe("&lt;b&gt;Evil&lt;/b&gt;");
  });

  it("escapes greater-than", () => {
    expect(escapeHtml("a > b")).toBe("a &gt; b");
  });

  it("escapes double quotes", () => {
    expect(escapeHtml('say "hi"')).toBe("say &quot;hi&quot;");
  });

  it("escapes single quotes", () => {
    expect(escapeHtml("it's")).toBe("it&#39;s");
  });

  it("passes plain text through unchanged", () => {
    expect(escapeHtml("Impact Rentals 2026")).toBe("Impact Rentals 2026");
  });
});

describe("sanitizeSubject", () => {
  it("leaves HTML-significant characters alone", () => {
    expect(sanitizeSubject("Bob & Co")).toBe("Bob & Co");
  });

  it("strips CRLF", () => {
    expect(sanitizeSubject("a\r\nb")).toBe("a b");
  });

  it("strips control characters and collapses whitespace", () => {
    expect(sanitizeSubject("  x\u0000y  ")).toBe("x y");
  });
});
