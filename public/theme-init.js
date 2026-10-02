// Applies the stored theme before first paint. Light is the default and is
// the bare :root, so only the other two values ever set data-theme. Keep the
// key and values in step with src/lib/theme.ts (src/lib/theme.test.ts
// checks them).
(function () {
  try {
    var stored = window.localStorage.getItem("ordering-desk-theme");
    if (stored === "dark" || stored === "system") {
      document.documentElement.setAttribute("data-theme", stored);
    }
  } catch (e) {
    // Storage blocked: stay on the light default.
  }
})();
