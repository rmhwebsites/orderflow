import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Mirrors the tsconfig "@/*" path alias so tests can import source modules
// that use it.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
