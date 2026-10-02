// What the top bar's sync chip says, from GET /api/workspaces/[id]/sync.
// Pure so every state is tested; the chip and the problem banner both read
// it.

import type { SyncConnectionView } from "@/server/desk/sync";
import { relativeTime } from "./format";

export type SyncLoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; connection: SyncConnectionView | null };

export type ChipTone = "good" | "warn" | "bad" | "info" | "neutral";

export type SyncChipState =
  | { kind: "loading" }
  | {
      kind: "ready";
      tone: ChipTone;
      label: string;
      // Problem text for the banner under the top bar (the last error).
      detail: string | null;
    };

// Status tone names in globals.css for each chip tone.
export const CHIP_TONE_COLOR: Record<ChipTone, string> = {
  good: "green",
  warn: "amber",
  bad: "red",
  info: "blue",
  neutral: "slate",
};

export function syncChipState(state: SyncLoadState, now: number): SyncChipState {
  if (state.status === "loading") {
    return { kind: "loading" };
  }
  if (state.status === "error") {
    return { kind: "ready", tone: "warn", label: "Sync status unavailable", detail: null };
  }
  const connection = state.connection;
  if (!connection) {
    return { kind: "ready", tone: "neutral", label: "Store not connected", detail: null };
  }
  if (connection.status === "disabled") {
    return { kind: "ready", tone: "neutral", label: "Sync paused", detail: null };
  }
  if (connection.status === "error") {
    return { kind: "ready", tone: "bad", label: "Sync error", detail: connection.lastError };
  }
  if (connection.lastError) {
    return { kind: "ready", tone: "warn", label: "Last sync failed", detail: connection.lastError };
  }
  if (connection.catchingUp) {
    return { kind: "ready", tone: "info", label: "Catching up", detail: null };
  }
  if (connection.lastSyncAt === 0) {
    return { kind: "ready", tone: "neutral", label: "Not synced yet", detail: null };
  }
  return {
    kind: "ready",
    tone: "good",
    label: `Synced ${relativeTime(connection.lastSyncAt, now)}`,
    detail: null,
  };
}
