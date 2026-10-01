import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { readLiveHumanEnvironment, signIn } from '../../tests/integration/human/fixtures';

const mode = process.argv[2];
const statePath = process.argv[3];
if (!['before', 'after'].includes(mode) || !statePath) throw new Error('invalid_restart_smoke_arguments');
const environment = readLiveHumanEnvironment();
const spki = process.env.KHALA_E2E_CERT_SPKI;
const diagnosticPath = process.env.KHALA_E2E_RESTART_DIAGNOSTIC;
const diagnose = (stage: string, details: Record<string, string | number | boolean> = {}) => {
  if (diagnosticPath) writeFileSync(diagnosticPath, JSON.stringify({ stage, ...details }), { mode: 0o600 });
};
if (!spki || !/^https:\/\/127\.0\.0\.1:\d+$/u.test(environment.appOrigin)) throw new Error('local_tls_pin_required');

diagnose('browser_launch');
const browser = await chromium.launch({ args: [`--ignore-certificate-errors-spki-list=${spki}`] });
try {
  const context = await browser.newContext(mode === 'after' ? { storageState: statePath } : {});
  const page = await context.newPage();
  diagnose('page_load');
  const navigation = await page.goto(`${environment.appOrigin}/new`, { waitUntil: 'networkidle' });
  if (mode === 'before') await signIn(page, environment, environment.users[0]);
  diagnose('session_check', { navigationStatus: navigation?.status() ?? 0,
    sessionCookiePresent: (await context.cookies()).some(cookie => cookie.name.startsWith('khala')) });
  const status = await page.evaluate(async () => (await fetch('/api/human/me')).status);
  diagnose('session_result', { meStatus: status });
  if (status !== 200) throw new Error('durable_session_unavailable');
  if (mode === 'before') await context.storageState({ path: statePath });
  await context.close();
} finally {
  await browser.close();
}
