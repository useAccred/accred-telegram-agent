import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@lib": fileURLToPath(new URL("./vendor/accred-automation/src/lib", import.meta.url)),
      "@": fileURLToPath(new URL("./vendor/accred-automation/src", import.meta.url)),
    },
  },
  test: { include: ["src/**/*.test.ts"], fileParallelism: false },
});
