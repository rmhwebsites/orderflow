"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  applyLiveEvent,
  optimisticStatus,
  rollbackStatus,
  selectOrders,
  statusChips,
  totalOrders,
  type DeskFilter,
  type DeskState,
  type LiveEffects,
} from "@/lib/desk-state";
import { formatMoney } from "@/lib/format";
import type { LiveEvent } from "@/lib/live-events";
import type { OrderSummary } from "@/server/desk/read";
import type { EventView, StatusView } from "@/server/desk/shapes";
import { useWorkspace } from "@/components/shell/workspace-provider";
import { useToast } from "@/components/toasts";
import { DeskSkeleton } from "./desk-skeleton";
import { DeskLoadError, EmptyDesk, NoMatches } from "./empty-states";
import { OrderCards, OrderTable } from "./order-list";
import { StatusStrip } from "./status-strip";
import { Toolbar } from "./toolbar";

type DeskPayload = {
  statuses: StatusView[];
  statusCounts: Record<string, number>;
  orders: OrderSummary[];
  hasMore: boolean;
};

type LoadState = { status: "loading" } | { status: "error"; message: string } | { status: "ready" };

const FLASH_MS = 1800;

function announcement(orders: OrderSummary[]): { title: string; body?: string } {
  if (orders.length === 1) {
    const [order] = orders;
    const who = order.customerName ? ` from ${order.customerName}` : "";
    return { title: `New order ${order.name}${who}`, body: formatMoney(order.total, order.currency) || undefined };
  }
  const names = orders.slice(0, 3).map((order) => order.name);
  const rest = orders.length - names.length;
  return {
    title: `${orders.length} new orders`,
    body: rest > 0 ? `${names.join(", ")} and ${rest} more` : names.join(", "),
  };
}

export function Desk() {
  const { workspace, userId, subscribe } = useWorkspace();
  const toast = useToast();

  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [statuses, setStatuses] = useState<StatusView[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [desk, setDesk] = useState<DeskState>({ orders: [], statusCounts: {}, timeline: null });
  const deskRef = useRef(desk);
  const [filter, setFilter] = useState<DeskFilter>({ query: "", statusKey: null, sort: "newest" });
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [flashing, setFlashing] = useState<Set<string>>(() => new Set());

  // Status changes still waiting for the server, re-applied over any reload
  // that lands meanwhile so the row does not flick back.
  const pendingStatus = useRef(new Map<string, string>());
  const pendingAnnounce = useRef<string[]>([]);
  const pendingFlash = useRef<string[]>([]);
  const announced = useRef(new Set<string>());
  const inFlight = useRef<Promise<void> | null>(null);
  const reloadAgain = useRef(false);

  const commit = useCallback((next: DeskState) => {
    deskRef.current = next;
    setDesk(next);
  }, []);

  const flash = useCallback((ids: string[]) => {
    if (ids.length === 0) {
      return;
    }
    setFlashing((current) => new Set([...current, ...ids]));
    setTimeout(() => {
      setFlashing((current) => {
        const next = new Set(current);
        for (const id of ids) {
          next.delete(id);
        }
        return next;
      });
    }, FLASH_MS);
  }, []);

  const fetchDesk = useCallback(async () => {
    try {
      const response = await fetch(`/api/workspaces/${encodeURIComponent(workspace.id)}/orders`, {
        cache: "no-store",
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `The server answered ${response.status}.`);
      }
      const payload = (await response.json()) as DeskPayload;
      let next: DeskState = { ...deskRef.current, orders: payload.orders, statusCounts: payload.statusCounts };
      for (const [orderId, key] of pendingStatus.current) {
        next = optimisticStatus(next, orderId, key)?.state ?? next;
      }
      commit(next);
      setStatuses(payload.statuses);
      setHasMore(payload.hasMore);
      setLoad({ status: "ready" });

      const loadedIds = new Set(payload.orders.map((order) => order.id));
      const toAnnounce = pendingAnnounce.current.filter((id) => !announced.current.has(id));
      pendingAnnounce.current = [];
      if (toAnnounce.length > 0) {
        for (const id of toAnnounce) {
          announced.current.add(id);
        }
        const found = payload.orders.filter((order) => toAnnounce.includes(order.id));
        toast(
          found.length > 0
            ? { ...announcement(found), tone: "good" }
            : { title: `${toAnnounce.length} new ${toAnnounce.length === 1 ? "order" : "orders"}`, tone: "good" },
        );
      }
      flash(pendingFlash.current.filter((id) => loadedIds.has(id)));
      pendingFlash.current = [];
    } catch (e) {
      const message = e instanceof Error ? e.message : "Check your connection and try again.";
      // A failed refresh keeps what is on screen; only a first load fails.
      setLoad((current) => (current.status === "ready" ? current : { status: "error", message }));
    }
  }, [workspace.id, commit, flash, toast]);

  // One reload at a time; requests that arrive meanwhile fold into one more.
  const reload = useCallback(() => {
    if (inFlight.current) {
      reloadAgain.current = true;
      return inFlight.current;
    }
    const run = async () => {
      do {
        reloadAgain.current = false;
        await fetchDesk();
      } while (reloadAgain.current);
    };
    inFlight.current = run().finally(() => {
      inFlight.current = null;
    });
    return inFlight.current;
  }, [fetchDesk]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const handleEffects = useCallback(
    (effects: LiveEffects) => {
      if (effects.refetch) {
        pendingAnnounce.current.push(...effects.announceOrderIds);
        pendingFlash.current.push(...effects.flashOrderIds);
        void reload();
      } else {
        flash(effects.flashOrderIds);
      }
    },
    [reload, flash],
  );

  const applyEvent = useCallback(
    (event: LiveEvent) => {
      const { state, effects } = applyLiveEvent(deskRef.current, event, userId);
      if (state !== deskRef.current) {
        commit(state);
      }
      handleEffects(effects);
    },
    [userId, commit, handleEffects],
  );

  useEffect(
    () =>
      subscribe((message) => {
        if (message.type === "resync") {
          void reload();
        } else {
          applyEvent(message.event);
        }
      }),
    [subscribe, reload, applyEvent],
  );

  const changeStatus = useCallback(
    async (orderId: string, nextKey: string) => {
      setRowErrors((current) => {
        if (!(orderId in current)) {
          return current;
        }
        const next = { ...current };
        delete next[orderId];
        return next;
      });
      const optimistic = optimisticStatus(deskRef.current, orderId, nextKey);
      if (optimistic) {
        commit(optimistic.state);
      }
      pendingStatus.current.set(orderId, nextKey);
      try {
        const response = await fetch(`/api/orders/${encodeURIComponent(orderId)}/status`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ statusKey: nextKey }),
        });
        const body = (await response.json().catch(() => null)) as
          | { error?: string; unchanged?: boolean; event?: EventView; order?: { id: string; statusKey: string; statusSetBy: string; statusSetAt: number }; triggersPo?: boolean }
          | null;
        if (!response.ok || !body) {
          throw new Error(body?.error ?? "Not saved");
        }
        pendingStatus.current.delete(orderId);
        if (body.unchanged || !body.event || !body.order) {
          return;
        }
        applyEvent({ kind: "order.status", event: body.event, order: body.order });
        if (body.triggersPo) {
          const label = statuses.find((status) => status.key === nextKey)?.label ?? "This status";
          toast({
            title: "Purchase orders are coming soon",
            body: `${label} will open a purchase order here once that feature ships. The status change is saved.`,
            tone: "info",
          });
        }
      } catch {
        pendingStatus.current.delete(orderId);
        if (optimistic) {
          commit(rollbackStatus(deskRef.current, orderId, nextKey, optimistic.previousKey));
        }
        setRowErrors((current) => ({ ...current, [orderId]: "Not saved. Try again." }));
      }
    },
    [commit, applyEvent, statuses, toast],
  );

  const openOrder = useCallback((orderId: string) => {
    const params = new URLSearchParams(window.location.search);
    params.set("order", orderId);
    window.history.pushState(null, "", `${window.location.pathname}?${params.toString()}`);
  }, []);

  const chips = useMemo(() => statusChips(statuses, desk.statusCounts), [statuses, desk.statusCounts]);
  const visible = useMemo(() => selectOrders(desk.orders, filter), [desk.orders, filter]);
  const total = totalOrders(desk.statusCounts);

  return (
    <main className="mx-auto flex w-full max-w-[1400px] flex-col gap-4 px-4 py-6 sm:px-6 sm:py-8">
      <h1 id="desk-heading" tabIndex={-1} className="font-display text-2xl font-semibold tracking-tight focus:outline-none">
        Orders
      </h1>

      {load.status === "loading" ? <DeskSkeleton /> : null}

      {load.status === "error" ? (
        <DeskLoadError
          message={load.message}
          onRetry={() => {
            setLoad({ status: "loading" });
            void reload();
          }}
        />
      ) : null}

      {load.status === "ready" ? (
        total === 0 && desk.orders.length === 0 ? (
          <EmptyDesk slug={workspace.slug} />
        ) : (
          <>
            <StatusStrip
              chips={chips}
              total={total}
              active={filter.statusKey}
              onSelect={(statusKey) => setFilter((current) => ({ ...current, statusKey }))}
            />
            <Toolbar
              query={filter.query}
              onQuery={(query) => setFilter((current) => ({ ...current, query }))}
              sort={filter.sort}
              onSort={(sort) => setFilter((current) => ({ ...current, sort }))}
              shown={visible.length}
              loaded={desk.orders.length}
            />
            {visible.length === 0 ? (
              <NoMatches
                query={filter.query}
                onClear={() => setFilter((current) => ({ ...current, query: "", statusKey: null }))}
              />
            ) : (
              <>
                <OrderTable
                  orders={visible}
                  statuses={statuses}
                  flashing={flashing}
                  rowErrors={rowErrors}
                  onOpen={openOrder}
                  onChangeStatus={changeStatus}
                />
                <OrderCards
                  orders={visible}
                  statuses={statuses}
                  flashing={flashing}
                  rowErrors={rowErrors}
                  onOpen={openOrder}
                  onChangeStatus={changeStatus}
                />
              </>
            )}
            {hasMore ? (
              <p className="text-xs text-ink-2">
                Showing the newest 1,000 orders. Older orders are still in Shopify, and the counts above include them.
              </p>
            ) : null}
          </>
        )
      ) : null}
    </main>
  );
}
