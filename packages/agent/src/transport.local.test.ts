import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { startChannelSession } from './transport';
import { createLocalSession } from './local/session';
const mocks = vi.hoisted(() => ({ matrixModule: vi.fn(() => ({ createAgentMatrixSession: vi.fn() })), local: vi.fn(async () => ({ userId: 'local' })) }));
vi.mock('./matrix/session', () => mocks.matrixModule());
vi.mock('./local/session', () => ({ createLocalSession: mocks.local }));
const creds = { homeserver: 'http://127.0.0.1:47830', userId: '@a:local', accessToken: 'secret', deviceId: 'd', roomId: '!r:local', transport: 'local' as const };
it('loads only the local module for local credentials', async () => {
  expect(await startChannelSession(creds)).toEqual({ userId: 'local' });
  expect(createLocalSession).toHaveBeenCalledExactlyOnceWith(creds);
  expect(mocks.matrixModule).not.toHaveBeenCalled();
});
it('has no eager matrix session edges, including inline type imports', async () => {
  const src = fileURLToPath(new URL('.', import.meta.url));
  async function inspect(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { await inspect(file); continue; }
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
      const text = await readFile(file, 'utf8');
      if (entry.name === 'client-impl.ts') expect(text).not.toContain('matrix/session');
      for (const line of text.split('\n').filter(line => /matrix\/session['"]/.test(line))) {
        expect(/^\s*(?:import type |export type )/.test(line)
          || file === path.join(src, 'transport.ts') && line.includes("await import('./matrix/session')"), `${file}: ${line}`).toBe(true);
      }
    }
  }
  await inspect(src);
  await inspect(fileURLToPath(new URL('../hooks/', import.meta.url)));
});
