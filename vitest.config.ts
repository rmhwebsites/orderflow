import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Mirrors the tsconfig "@/*" path alias so tests can import source modules
// that use it. "cloudflare:workers" only exists inside workerd; tests get a
// minimal stand-in (see src/test/cloudflare-workers-stub.ts).
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "cloudflare:workers": fileURLToPath(
        new URL("./src/test/cloudflare-workers-stub.ts", import.meta.url),
      ),
    },
  },
});
