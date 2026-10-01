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
});
