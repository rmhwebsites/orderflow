import { describe, it, expect } from "vitest";
import { MAX_RECONNECT_DELAY_MS, POLL_INTERVAL_MS, liveUrl, reconnectDelay } from "./use-live";

describe("reconnectDelay", () => {
  it("doubles from one second with up to 20% jitter", () => {
    expect(reconnectDelay(0, 0)).toBe(800);
    expect(reconnectDelay(0, 1)).toBe(1200);
    expect(reconnectDelay(1, 0.5)).toBe(2000);
    expect(reconnectDelay(3, 0.5)).toBe(8000);
  });

  it("never waits longer than the cap", () => {
    for (const attempt of [5, 6, 10, 50]) {
      expect(reconnectDelay(attempt, 1)).toBeLessThanOrEqual(MAX_RECONNECT_DELAY_MS);
    }
    expect(MAX_RECONNECT_DELAY_MS).toBe(30000);
  });

  it("polls every 30 seconds while the socket is down", () => {
    expect(POLL_INTERVAL_MS).toBe(30000);
  });
});

describe("liveUrl", () => {
  it("uses wss on https and carries the workspace and ticket", () => {
    expect(liveUrl({ protocol: "https:", host: "orderingdesk.example.dev" }, "ws_1", "a.b")).toBe(
      "wss://orderingdesk.example.dev/live?workspace=ws_1&ticket=a.b",
    );
    expect(liveUrl({ protocol: "http:", host: "localhost:3000" }, "w s", "t")).toBe(
      "ws://localhost:3000/live?workspace=w+s&ticket=t",
    );
  });
});
