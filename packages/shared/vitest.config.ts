import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Node environment: this package is framework-free and is imported by apps/api too, so
    // nothing here may depend on a DOM.
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
