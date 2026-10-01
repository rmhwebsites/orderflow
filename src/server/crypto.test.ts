import { describe, it, expect } from "vitest";
import { encryptSecret, decryptSecret } from "./crypto";

const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));

describe("token crypto", () => {
  it("round-trips", async () => {
    const out = await encryptSecret("shpat_example_123", KEY);
    expect(out).not.toContain("shpat");
    expect(await decryptSecret(out, KEY)).toBe("shpat_example_123");
  });
  it("unique ciphertext per call (random IV)", async () => {
    expect(await encryptSecret("a", KEY)).not.toBe(await encryptSecret("a", KEY));
  });
  it("rejects tampered payload", async () => {
    const out = await encryptSecret("a", KEY);
    const bad = out.slice(0, -4) + "AAAA";
    await expect(decryptSecret(bad, KEY)).rejects.toThrow();
  });
  it("handles unicode", async () => {
    const s = "tok Łödz 24\" × emoji-free";
    expect(await decryptSecret(await encryptSecret(s, KEY), KEY)).toBe(s);
  });
  it("rejects wrong key", async () => {
    const otherKey = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
    const out = await encryptSecret("a", KEY);
    await expect(decryptSecret(out, otherKey)).rejects.toThrow();
  });
  it("rejects aad mismatch", async () => {
    const out = await encryptSecret("a", KEY, "ws_a");
    await expect(decryptSecret(out, KEY, "ws_b")).rejects.toThrow();
  });
  it("round-trips with matching aad", async () => {
    const out = await encryptSecret("shpat_example_123", KEY, "ws_a");
    expect(await decryptSecret(out, KEY, "ws_a")).toBe("shpat_example_123");
  });
  it("rejects malformed payloads", async () => {
    const valid = await encryptSecret("a", KEY);
    // Fixture sanity: the fixtures below only mean something if a real payload
    // is a three-part string with a v1 prefix.
    expect(valid.startsWith("v1.")).toBe(true);
    expect(valid.split(".").length).toBe(3);
    const tail = valid.slice(3);
    const cipherPart = valid.split(".")[2];
    const eightByteIv = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(8))));
    const bad = [
      "",
      "no-dot",
      "a.b",
      "a.b.c.d",
      "v1.!!!.???",
      "v2." + tail,
      "v1." + eightByteIv + "." + cipherPart,
    ];
    for (const payload of bad) {
      await expect(decryptSecret(payload, KEY), JSON.stringify(payload)).rejects.toThrow();
    }
  });
  it("rejects a key that is not 32 bytes", async () => {
    const shortKey = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
    await expect(encryptSecret("a", shortKey)).rejects.toThrow(/32/);
  });
});
