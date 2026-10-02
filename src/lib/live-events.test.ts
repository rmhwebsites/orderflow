import { describe, it, expect } from "vitest";
import { parseLiveEvent } from "./live-events";

const event = {
  id: "e1",
  orderId: "o1",
  type: "status",
  text: "Status set to Processing",
  actorId: "u1",
  meta: { from: "new", to: "processing" },
  createdAt: 1700000000000,
};

describe("parseLiveEvent", () => {
  it("accepts the three event kinds the server broadcasts", () => {
    const synced = { kind: "orders.synced", addedOrderIds: ["a"], updatedOrderIds: [] };
    const status = {
      kind: "order.status",
      event,
      order: { id: "o1", statusKey: "processing", statusSetBy: "u1", statusSetAt: 1700000000000 },
    };
    const note = { kind: "order.note", event: { ...event, type: "note", meta: null } };
    expect(parseLiveEvent(JSON.stringify(synced))).toEqual(synced);
    expect(parseLiveEvent(JSON.stringify(status))).toEqual(status);
    expect(parseLiveEvent(JSON.stringify(note))).toEqual(note);
  });

  it("returns null for pongs, garbage and unknown kinds", () => {
    for (const raw of ["pong", "", "{", "null", "[]", '{"kind":"order.deleted"}', "42"]) {
      expect(parseLiveEvent(raw)).toBeNull();
    }
  });

  it("returns null when required fields are missing or mistyped", () => {
    expect(parseLiveEvent(JSON.stringify({ kind: "orders.synced", addedOrderIds: "a" }))).toBeNull();
    expect(
      parseLiveEvent(JSON.stringify({ kind: "orders.synced", addedOrderIds: [1], updatedOrderIds: [] })),
    ).toBeNull();
    expect(parseLiveEvent(JSON.stringify({ kind: "order.note", event: { ...event, id: 5 } }))).toBeNull();
    expect(
      parseLiveEvent(JSON.stringify({ kind: "order.status", event, order: { id: "o1", statusKey: 3 } })),
    ).toBeNull();
    expect(parseLiveEvent(JSON.stringify({ kind: "order.note", event: { ...event, orderId: null } }))).toBeNull();
  });
});
