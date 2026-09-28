import { expect, test } from '@playwright/test';
import { readLiveControlsEnvironment } from '../controls/fixtures';
import { readReviewNativeConfig } from './native-witness';
import { prepareRoute, releaseOnlyB, signedIn } from './selected-only-flow';

const { human, controls } = readLiveControlsEnvironment();
const native = readReviewNativeConfig();

test('two humans: owner releases only B to one existing native Sol agent while A stays pending', async ({ browser }) => {
  test.setTimeout(180_000);
  const owner = await signedIn(browser, human, 0);
  const sender = await signedIn(browser, human, 1);
  try {
    const route = await prepareRoute(owner.page, controls, native);
    await sender.page.goto(`${human.appOrigin}/channels/${encodeURIComponent(controls.roomId)}`);
    await expect(sender.page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
    await releaseOnlyB(owner.page, sender.page, route);
  } finally {
    await Promise.all([owner.context.close(), sender.context.close()]);
  }
});
