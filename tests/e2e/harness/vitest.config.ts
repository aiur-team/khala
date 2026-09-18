// Runner for the cross-component suites (`pnpm test:conformance`, `pnpm test:e2e`).
// The repository root is not a workspace consumer of the `@khala/*` packages, so each
// alias maps a subpath onto exactly the target its package `exports` names. Subpaths a
// package withholds (`null` targets) resolve to nothing, as they would for a consumer.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = fileURLToPath(new URL('../../../', import.meta.url));

/** Packages the suites grade through their public exports. */
const GRADED_PACKAGES = ['contracts', 'harnesses', 'connector', 'policy'] as const;

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function exportAliases(name: string): { find: RegExp; replacement: string }[] {
  const directory = `${root}packages/${name}/`;
  const { exports } = JSON.parse(readFileSync(`${directory}package.json`, 'utf8')) as { exports: Record<string, string | null> };
  // Withheld subpaths first, so a broader wildcard cannot expose them.
  const entries = Object.entries(exports).sort(([, a], [, b]) => Number(a !== null) - Number(b !== null));
  return entries.map(([key, target]) => {
    const [prefix = '', suffix = ''] = key.slice(2).split('*');
    const wildcard = key.includes('*');
    const find = new RegExp(`^@khala/${name}/${escape(prefix)}${wildcard ? `(.+)${escape(suffix)}` : ''}$`);
    const replacement = target === null
      ? `${directory}__withheld_export__`
      : `${directory}${target.slice(2).replace('*', '$1')}`;
    return { find, replacement };
  });
}

export default defineConfig({
  root,
  resolve: { alias: GRADED_PACKAGES.flatMap(exportAliases) },
  test: {
    environment: 'node',
    exclude: ['**/node_modules/**', '**/dist/**'],
    projects: [
      { extends: true, test: { name: 'conformance', include: ['tests/conformance/**/*.test.ts'] } },
      { extends: true, test: { name: 'e2e', include: ['tests/e2e/**/*.test.ts'] } },
      // Fixture runs for the live gate's own tests (`live-gate.test.ts`); never part of a suite.
      { extends: true, test: { name: 'live-gate', include: ['tests/e2e/harness/fixtures/live-gate/*.fixture.ts'] } },
    ],
  },
});
