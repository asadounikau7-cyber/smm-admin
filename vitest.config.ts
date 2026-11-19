import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  // Tests share the dev database and its settings rows: run files one after another.
  test: { include: ["src/**/*.test.ts"], fileParallelism: false },
});
