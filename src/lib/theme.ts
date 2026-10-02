// Theme preference: light (the default, no attribute on <html>), dark, or
// system (follows prefers-color-scheme). Stored per browser in localStorage
// and applied before first paint by public/theme-init.js, which repeats the
// key and values below because a static file cannot import them
// (src/lib/theme.test.ts pins the two together).

export const THEMES = ["light", "dark", "system"] as const;
export type Theme = (typeof THEMES)[number];

export const THEME_STORAGE_KEY = "ordering-desk-theme";

export function parseTheme(value: unknown): Theme {
  return typeof value === "string" && (THEMES as readonly string[]).includes(value)
    ? (value as Theme)
    : "light";
}

// Light is the bare :root, so it removes the attribute instead of setting it.
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === "light") {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", theme);
  }
}

export function readStoredTheme(): Theme {
  try {
    return parseTheme(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return "light";
  }
}

export function storeTheme(theme: Theme): void {
  try {
    if (theme === "light") {
      window.localStorage.removeItem(THEME_STORAGE_KEY);
    } else {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    }
  } catch {
    // Storage blocked (private mode, policy): the choice lasts for this page.
  }
}
