import { defineConfig } from "vitest/config";

export default defineConfig({
  // Relative asset URLs: the build works from any static host path.
  base: "./",
  build: { target: "es2023" },
  test: {
    projects: [
      {
        test: { name: "unit", include: ["test/**/*.test.ts"], exclude: ["test/**/*.sandbox.test.ts"] },
      },
      {
        test: {
          name: "sandbox",
          include: ["test/**/*.sandbox.test.ts"],
          // Builds the contracts once, like packages/sandbox does.
          globalSetup: ["./test/build-contracts.ts"],
          testTimeout: 180_000,
          hookTimeout: 180_000,
        },
      },
    ],
  },
});
