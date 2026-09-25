import { defineConfig } from 'vitest/config';

// `khala-source` resolves workspace-only source exports (for example
// `@aiur/khala/cli/*`); a published tarball never answers to it.
const sourceCondition = 'khala-source';

export default defineConfig({
  resolve: { conditions: [sourceCondition, 'module', 'browser', 'development|production'] },
  ssr: { resolve: { conditions: [sourceCondition, 'module', 'node', 'development|production'] } },
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    environment: 'node',
  },
});
