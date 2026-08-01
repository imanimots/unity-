import { defineConfig } from 'vitest/config'
import path from 'path'

// Minimal config — only resolves the existing `@/*` tsconfig path alias so
// pure-logic unit tests (src/lib/listings/*, src/lib/risk/*) can import
// the same way app code does. No test-runner existed before Phase 2A;
// added specifically to unit-test validation/completeness logic that
// can't be verified against a live Supabase project this session.
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    // tests/e2e is the Playwright browser suite (Step 10) — a separate
    // runner (npm run test:e2e), never collected by vitest.
    exclude: ['**/node_modules/**', '**/tests/e2e/**'],
  },
})
