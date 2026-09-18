// Runner for the cross-component suites (`pnpm test:conformance`, `pnpm test:e2e`).
// The repository root is not a workspace consumer of `@khala/contracts`, so the
// alias maps each subpath onto exactly the target its package `exports` names.

import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = fileURLToPath(new URL('../../../', import.meta.url));

export default defineConfig({
  root,
  resolve: {
    alias: [{ find: /^@khala\/contracts\/(messaging|delivery)\/(.+)$/, replacement: `${root}packages/contracts/src/$1/$2.ts` }],
  },
  test: {
    environment: 'node',
    exclude: ['**/node_modules/**', '**/dist/**'],
    projects: [
      { extends: true, test: { name: 'conformance', include: ['tests/conformance/**/*.test.ts'] } },
      { extends: true, test: { name: 'e2e', include: ['tests/e2e/**/*.test.ts'] } },
    ],
  },
});
