"use client";

import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/MagnifyingGlass";
import type { SortKey } from "@/lib/desk-state";
import { ui } from "@/components/ui";

const SORTS: { value: SortKey; label: string }[] = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "total", label: "Highest total" },
];

export function Toolbar({
  query,
  onQuery,
  sort,
  onSort,
  shown,
  loaded,
}: {
  query: string;
  onQuery: (query: string) => void;
  sort: SortKey;
  onSort: (sort: SortKey) => void;
  shown: number;
  loaded: number;
}) {
  const filtered = shown !== loaded;
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
      <div className="relative min-w-0 flex-1 sm:max-w-md">
        <label htmlFor="desk-search" className="sr-only">
          Search orders
        </label>
        <MagnifyingGlassIcon
          size={16}
          aria-hidden
          className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-3"
        />
        <input
          id="desk-search"
          type="search"
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          placeholder="Search order, customer, email or item"
          autoComplete="off"
          spellCheck={false}
          className={`${ui.input} pl-10`}
        />
      </div>
      <div className="flex items-center justify-between gap-3 sm:ml-auto sm:justify-end">
        <p className="text-sm tabular-nums text-ink-2" aria-live="polite">
          {filtered
            ? `${shown.toLocaleString("en-US")} of ${loaded.toLocaleString("en-US")} orders`
            : `${loaded.toLocaleString("en-US")} ${loaded === 1 ? "order" : "orders"}`}
        </p>
        <div className="relative">
          <label htmlFor="desk-sort" className="sr-only">
            Sort orders
          </label>
          <select
            id="desk-sort"
            value={sort}
            onChange={(event) => onSort(event.target.value as SortKey)}
            className={`${ui.input} w-auto cursor-pointer appearance-none pr-9 font-medium`}
          >
            {SORTS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <CaretDownIcon
            size={12}
            aria-hidden
            className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-ink-2"
          />
        </div>
      </div>
    </div>
  );
}
