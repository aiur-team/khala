import * as fs from 'node:fs/promises';
import { expect, it } from 'vitest';
import * as shared from './index';
it('exports the composition-safe wake helpers', () => {
  expect(shared.wakeLine('12345678')).toContain('(k-12345678)');
  expect(shared.recordAttempt).toBeTypeOf('function');
  expect(shared.driverAllowed).toBeTypeOf('function');
});
it('depends only on shared modules, Node built-ins and contracts', async () => {
  for (const name of ['index', 'rules', 'settings', 'nonce', 'lock']) {
    const source = await fs.readFile(new URL(`./${name}.ts`, import.meta.url), 'utf8');
    const imports = [...source.matchAll(/(?:from\s+|import\s*)['"]([^'"]+)['"]/g)].map(match => match[1]);
    for (const specifier of imports) expect(specifier).toMatch(/^(node:|@khala\/contracts$|\.\/(rules|settings|nonce|lock)$)/);
  }
});
