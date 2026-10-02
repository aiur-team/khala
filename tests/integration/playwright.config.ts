import { defineConfig } from '@playwright/test';

if (process.env.KHALA_E2E_LIVE !== '1' || !process.env.KHALA_E2E_DISPOSABLE_ENV) {
  throw new Error('Live integration requires KHALA_E2E_LIVE=1 and KHALA_E2E_DISPOSABLE_ENV identifying a disposable environment.');
}
if (process.env.KHALA_E2E_CERT_SPKI) {
  const descriptor = JSON.parse((await import('node:fs')).readFileSync(process.env.KHALA_E2E_DISPOSABLE_ENV, 'utf8')) as { appOrigin?: string };
  if (!/^https:\/\/127\.0\.0\.1:\d+$/u.test(descriptor.appOrigin ?? '')) {
    throw new Error('A local certificate pin requires a loopback HTTPS app origin.');
  }
}
export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  timeout: 120_000,
  reporter: 'list',
  use: process.env.KHALA_E2E_CERT_SPKI ? {
    launchOptions: { args: [`--ignore-certificate-errors-spki-list=${process.env.KHALA_E2E_CERT_SPKI}`] },
  } : {},
});
