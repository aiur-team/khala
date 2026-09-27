import { describe, expect, it } from 'vitest';
import { openDefaultBrowser } from './default-browser.js';

describe('owner browser launch boundary', () => {
  it('refuses a foreign origin, downgrade, or embedded credentials before launching', async () => {
    for (const target of [
      'https://other.example/approve',
      'http://khala.aiur.team/approve',
      'https://user@khala.aiur.team/approve',
      'not a URL',
    ]) {
      await expect(openDefaultBrowser(target, 'https://khala.aiur.team')).rejects.toThrow();
    }
  });
});
