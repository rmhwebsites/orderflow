"use client";

import Link from "next/link";
import { ListMagnifyingGlassIcon } from "@phosphor-icons/react/ListMagnifyingGlass";
import { StorefrontIcon } from "@phosphor-icons/react/Storefront";
import { WarningCircleIcon } from "@phosphor-icons/react/WarningCircle";
import { ui } from "@/components/ui";

function Frame({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-panel border border-line bg-surface px-6 py-10 shadow-panel sm:items-center sm:px-10 sm:py-14 sm:text-center">
      <span className="grid size-12 place-items-center rounded-full bg-surface-2 text-ink-2">{icon}</span>
      <h2 className="font-display text-lg font-semibold text-ink">{title}</h2>
      {children}
    </div>
  );
}

// No orders at all yet: say exactly how to get some.
export function EmptyDesk({ slug }: { slug: string }) {
  return (
    <Frame icon={<StorefrontIcon size={24} aria-hidden />} title="No orders yet">
      <p className="max-w-[46ch] text-sm text-ink-2">
        Connect your Shopify store in Settings, then press Sync.
      </p>
      <Link href={`/w/${slug}/settings`} className={`${ui.buttonSecondary} mt-1`}>
        Open Settings
      </Link>
    </Frame>
  );
}

export function NoMatches({ query, onClear }: { query: string; onClear: () => void }) {
  return (
    <Frame icon={<ListMagnifyingGlassIcon size={24} aria-hidden />} title="No orders match">
      <p className="max-w-[46ch] break-words text-sm text-ink-2">
        {query.trim().length > 0
          ? `Nothing matches "${query.trim()}" with the current status filter.`
          : "No loaded orders have this status."}
      </p>
      <button type="button" onClick={onClear} className={`${ui.buttonSecondary} mt-1`}>
        Clear filters
      </button>
    </Frame>
  );
}

export function DeskLoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert">
      <Frame icon={<WarningCircleIcon size={24} aria-hidden />} title="Orders did not load">
        <p className="max-w-[46ch] text-sm text-ink-2">{message}</p>
        <button type="button" onClick={onRetry} className={`${ui.buttonSecondary} mt-1`}>
          Try again
        </button>
      </Frame>
    </div>
  );
}
