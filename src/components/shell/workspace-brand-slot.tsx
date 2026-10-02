// WORKSPACE BRAND SLOT (Phase 5 part B fills this).
//
// The one place the top bar shows a workspace's mark. Today it renders a
// monogram tile in the workspace accent. Part B adds two uploads in
// workspace settings and renders them here:
// - the symbol (a square mark, e.g. IMPACT's "Favicon B/W" artwork) replaces
//   the monogram tile at every width;
// - the full logo (a wide lockup, e.g. "Store Long B/W") replaces tile plus
//   name from the sm breakpoint up, with the light or dark variant chosen
//   by the active theme.
// Keep the 32px height so the top bar does not shift when a logo loads.
// logoUrl is the existing workspaces.logo_url column; part B decides the
// storage (R2) and adds the symbol field.
export function WorkspaceBrandSlot({ name }: { name: string; logoUrl?: string | null }) {
  const initial = name.trim().charAt(0).toUpperCase() || "W";
  return (
    <span
      aria-hidden
      className="grid size-8 shrink-0 place-items-center rounded-full bg-accent font-display text-sm font-semibold text-accent-ink"
    >
      {initial}
    </span>
  );
}
