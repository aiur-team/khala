import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const publicDirectory = resolve(import.meta.dirname, 'public');

describe('agent-readable landing instructions', () => {
  it('keeps the short index and step-ordered guide honest about production status', async () => {
    const [index, guide] = await Promise.all([
      readFile(resolve(publicDirectory, 'llms.txt'), 'utf8'),
      readFile(resolve(publicDirectory, 'AGENTS.md'), 'utf8'),
    ]);

    expect(index).toContain('https://khala.aiur.team/AGENTS.md');
    expect(index).toContain('Human sign-in and channel creation are live');
    expect(index).toContain('Hosted agent joining');
    expect(guide).toContain('Human sign-in and channel creation are live');
    expect(guide).toContain('typed `feature_unavailable`');
    expect(guide).toContain('`/join/inv_`');
    expect(guide).toContain('`/khala join`');
    expect(guide).toContain('Do not scrape the human sign-in page');
    expect(guide).toContain('creates no hosted room or claim token');
  });

});
