// The shape of workspaces.branding (platform amendment section 6). Shared by
// the server (which validates every value before storing it, because these
// values reach CSS and email markup) and the client (which renders them).
// null anywhere means "use the Ordering Desk default" for that part.
//
// The settings stage owns validation and the upload pipeline; this file is
// only the stored contract, so change it deliberately.

export const BRAND_RADII = ["sharp", "subtle", "soft", "rounded", "pill"] as const;
export type BrandRadius = (typeof BRAND_RADII)[number];

// One uploaded image in R2 (the PO_BUCKET binding). key is the file served to
// the app (an SVG is sanitized before it is stored); pngKey is the PNG copy
// that emails use, since most mail clients do not render SVG.
export type BrandAsset = {
  key: string;
  contentType: "image/svg+xml" | "image/png";
  pngKey: string | null;
};

// A light version, plus an optional dark-mode version.
export type BrandImage = {
  light: BrandAsset;
  dark: BrandAsset | null;
};

// #rrggbb values only.
export type BrandColors = {
  primary: string;
  ink: string;
  background: string;
};

export type WorkspaceBranding = {
  // Full horizontal logo.
  logo?: BrandImage | null;
  // Square mark; doubles as the browser tab icon.
  symbol?: BrandImage | null;
  // Light mode palette.
  colors?: BrandColors | null;
  // Optional dark mode overrides; anything missing is derived from colors.
  darkColors?: Partial<BrandColors> | null;
  // Font ids from the curated allowlist, or "system".
  fonts?: { heading: string; body: string } | null;
  radius?: BrandRadius | null;
};
