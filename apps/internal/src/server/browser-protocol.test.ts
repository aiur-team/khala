import { describe, expect, it } from 'vitest';
import { REQUEST_SECRET_HEADER as BROWSER_HEADER, REQUEST_SECRET_STORAGE_KEY as BROWSER_KEY } from '@khala/messaging/local/http/index';
import { REQUEST_SECRET_HEADER, REQUEST_SECRET_STORAGE_KEY } from './bootstrap';

// The browser substrate cannot import server code, so it restates these names.
describe('browser protocol names', () => {
  it('match what the bootstrap script stores and the server authenticates', () => {
    expect(BROWSER_HEADER).toBe(REQUEST_SECRET_HEADER);
    expect(BROWSER_KEY).toBe(REQUEST_SECRET_STORAGE_KEY);
  });
});
