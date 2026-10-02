// Loading placeholders shaped like the real desk: the count strip, the
// toolbar, then table rows (880px and up) or cards (below).

const ROWS = [0, 1, 2, 3, 4, 5, 6, 7];

function Bar({ className }: { className: string }) {
  return <span aria-hidden className={`od-skeleton block ${className}`} />;
}

export function DeskSkeleton() {
  return (
    <div role="status" aria-label="Loading orders" className="flex flex-col gap-4">
      <div className="flex gap-1.5 overflow-hidden">
        {["w-20", "w-24", "w-32", "w-28", "w-24", "w-28", "w-24"].map((width, i) => (
          <Bar key={i} className={`h-9 shrink-0 ${width}`} />
        ))}
      </div>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Bar className="h-10 w-full sm:max-w-md" />
        <Bar className="h-10 w-36 sm:ml-auto" />
      </div>

      <div className="hidden overflow-hidden rounded-panel border border-line bg-surface desk:block">
        <div className="flex gap-6 px-4 py-3.5">
          {["w-12", "w-10", "w-16", "w-12"].map((width, i) => (
            <Bar key={i} className={`h-3 ${width}`} />
          ))}
        </div>
        {ROWS.map((row) => (
          <div
            key={row}
            className="grid grid-cols-[6.5rem_7.5rem_22%_1fr_8rem_11.5rem] items-start border-t border-line py-3.5"
          >
            <div className="px-4">
              <Bar className="h-4 w-14" />
            </div>
            <div className="flex flex-col gap-1.5 px-3">
              <Bar className="h-3.5 w-20" />
              <Bar className="h-3 w-12" />
            </div>
            <div className="flex flex-col gap-1.5 px-3">
              <Bar className="h-3.5 w-32" />
              <Bar className="h-3 w-40" />
            </div>
            <div className="flex flex-col gap-1.5 px-3">
              <Bar className="h-3.5 w-11/12" />
              <Bar className="h-3.5 w-2/3" />
            </div>
            <div className="flex justify-end px-3">
              <Bar className="h-4 w-16" />
            </div>
            <div className="px-4">
              <Bar className="h-8 w-28" />
            </div>
          </div>
        ))}
      </div>

      <ul className="flex flex-col gap-2 desk:hidden">
        {ROWS.slice(0, 5).map((row) => (
          <li key={row} className="rounded-panel border border-line bg-surface p-4">
            <div className="flex justify-between">
              <Bar className="h-4 w-16" />
              <Bar className="h-4 w-20" />
            </div>
            <Bar className="mt-3 h-3.5 w-36" />
            <Bar className="mt-1.5 h-3 w-48" />
            <Bar className="mt-3 h-3.5 w-full" />
            <div className="mt-4 flex items-center justify-between">
              <Bar className="h-3 w-28" />
              <Bar className="h-8 w-28" />
            </div>
          </li>
        ))}
      </ul>
      <span className="sr-only">Loading orders</span>
    </div>
  );
}
