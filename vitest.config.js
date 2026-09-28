import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // `vitest run tests/unit` is a path *substring* filter, so a local core
    // checkout at `.core/` (CI checks one out for the MCP-contract step) would
    // also match `.core/tests/unit/*` and fail on core's own tests. Keep the
    // sibling checkout out of this repo's test scan.
    exclude: ['**/node_modules/**', '**/.core/**', '**/.git/**', '**/dist/**', '**/coverage/**'],
  },
});
