import { defineConfig } from "vitest/config";

// Separate from vite.config.js so unit tests do not load the React Router /
// Shopify dev-server plugins.
export default defineConfig({
  esbuild: { jsx: "automatic" },
  test: {
    environment: "node",
    include: ["test/**/*.test.{js,jsx}"],
    testTimeout: 20000,
  },
});
