import { expect, test } from '@playwright/test';
import { readLiveHumanEnvironment } from './fixtures';

const environment = readLiveHumanEnvironment();

test('production bundle boots standalone and keeps reserved APIs out of the SPA', async ({ page, request }) => {
  await page.goto(environment.appOrigin, { waitUntil: 'networkidle' });
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
  await expect(page.getByRole('alert')).not.toContainText(/fixture|demo|sample/iu);

  const response = await request.get(`${environment.appOrigin}/api/human/unknown`);
  expect(response.status()).toBe(404);
  expect(response.headers()['content-type']).toContain('application/json');
  expect(await response.json()).toMatchObject({ code: 'not_found' });
});

test('host-content mount does not add a second navigation landmark', async ({ page }) => {
  await page.goto(`${environment.appOrigin}/?mount=hosted-content`, { waitUntil: 'networkidle' });
  await expect(page.getByRole('navigation')).toHaveCount(0);
  await expect(page.getByRole('main')).toHaveCount(1);
});
