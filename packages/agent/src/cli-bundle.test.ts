import * as fs from 'node:fs/promises';
import { expect, it } from 'vitest';

it('maps every hook module into the published bundle', async () => {
  const hooks = (await fs.readdir(new URL('../hooks', import.meta.url))).filter(file => file.endsWith('.ts')).map(file => file.slice(0, -3));
  const source = await fs.readFile(new URL('./cli-bundle.ts', import.meta.url), 'utf8');
  const mapped = [...source.matchAll(/import\('\.\.\/hooks\/([a-z0-9-]+)'\)/g)].map(match => match[1]);
  expect(mapped.sort()).toEqual(hooks.sort());
});

it('keeps the published runtime dependencies equal to the checkout and free of tsx', async () => {
  const published = JSON.parse(await fs.readFile(new URL('../npm/package.json', import.meta.url), 'utf8'));
  const workspace = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
  expect(published.private).toBeUndefined();
  expect(published.bin).toEqual({ khala: 'dist/khala.mjs' });
  expect(published.dependencies.tsx).toBeUndefined();
  for (const [name, version] of Object.entries(published.dependencies)) expect(workspace.dependencies[name]).toBe(version);
});
