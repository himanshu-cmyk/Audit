/* eslint-env node, es2020 */
// Any accidental network call in a test fails loudly instead of reaching a real
// service. Tests that exercise HTTP code inject their own fetch implementation.
globalThis.fetch = async (url) => {
  throw new Error(`Network access is disabled in tests (attempted: ${String(url).slice(0, 80)})`);
};
