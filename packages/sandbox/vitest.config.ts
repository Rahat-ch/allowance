import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./test/build-contracts.ts"],
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
