import { defineConfig } from "vitest/config";

// Separate from vite.config.js so unit tests do not load the React Router /
// Shopify dev-server plugins.
export default defineConfig({
  esbuild: { jsx: "automatic" },
  test: {
    environment: "node",
    include: ["test/**/*.test.{js,jsx}"],
    testTimeout: 20000,
    // Tests are hermetic: real credentials in .env must never reach them, and
    // test/setup.js blocks network access so no real AI or Shopify call can run.
    env: { GEMINI_API_KEY: "", GEMINI_MODEL: "", AI_PROVIDER: "", THEME_WRITES_ENABLED: "false" },
    setupFiles: ["test/setup.js"],
  },
});
