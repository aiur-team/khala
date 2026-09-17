import { defineConfig } from '@playwright/test';

if (process.env.KHALA_E2E_LIVE !== '1' || !process.env.KHALA_E2E_DISPOSABLE_ENV) {
  throw new Error('Live integration requires KHALA_E2E_LIVE=1 and KHALA_E2E_DISPOSABLE_ENV identifying a disposable environment.');
}
export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  reporter: 'list',
});
