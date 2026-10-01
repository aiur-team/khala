import { chromium } from '@playwright/test';
import { readLiveHumanEnvironment, signIn } from '../../tests/integration/human/fixtures';

const mode = process.argv[2];
const statePath = process.argv[3];
if (!['before', 'after'].includes(mode) || !statePath) throw new Error('invalid_restart_smoke_arguments');
const environment = readLiveHumanEnvironment();
const spki = process.env.KHALA_E2E_CERT_SPKI;
if (!spki || !/^https:\/\/127\.0\.0\.1:\d+$/u.test(environment.appOrigin)) throw new Error('local_tls_pin_required');

const browser = await chromium.launch({ args: [`--ignore-certificate-errors-spki-list=${spki}`] });
try {
  const context = await browser.newContext(mode === 'after' ? { storageState: statePath } : {});
  const page = await context.newPage();
  await page.goto(`${environment.appOrigin}/new`, { waitUntil: 'networkidle' });
  if (mode === 'before') await signIn(page, environment, environment.users[0]);
  const status = await page.evaluate(async () => (await fetch('/api/human/me')).status);
  if (status !== 200) throw new Error('durable_session_unavailable');
  if (mode === 'before') await context.storageState({ path: statePath });
  await context.close();
} finally {
  await browser.close();
}
