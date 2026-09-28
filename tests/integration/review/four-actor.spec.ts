import { expect, test } from '@playwright/test';
import { readLiveControlsEnvironment } from '../controls/fixtures';
import { distinctNativeAgents, readReviewPeerControls } from './four-actor-config';
import { readReviewNativeConfig } from './native-witness';
import { assertForeignWithheld, prepareRoute, releaseOnlyB, signedIn } from './selected-only-flow';

const { human, controls } = readLiveControlsEnvironment();
const native = readReviewNativeConfig();
const peerControls = readReviewPeerControls(controls);
const peerNative = readReviewNativeConfig('reviewPeerNative');

test('two owners independently release B to their own existing native Sol agents while A stays withheld', async ({ browser }) => {
  test.setTimeout(300_000);
  const first = await signedIn(browser, human, 0);
  const second = await signedIn(browser, human, 1);
  try {
    // Both baselines predate either owner's messages. A later event for the
    // other agent therefore cannot hide outside that agent's observed interval.
    const firstRoute = await prepareRoute(first.page, controls, native);
    const secondRoute = await prepareRoute(second.page, peerControls, peerNative);
    expect(distinctNativeAgents(native, peerNative,
      firstRoute.connector, secondRoute.connector)).toBe(true);
    await expect(first.page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
    await expect(second.page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();

    const firstRelease = await releaseOnlyB(first.page, second.page, firstRoute);
    const secondRelease = await releaseOnlyB(second.page, first.page, secondRoute);

    // Each owner independently selects its own B. No other owner's A or B
    // may be present in this agent's model interval or durable inbox.
    await assertForeignWithheld(firstRoute, firstRelease,
      { canary: secondRelease.withheld, eventId: secondRelease.withheldEventId });
    await assertForeignWithheld(firstRoute, firstRelease,
      { canary: secondRelease.released, eventId: secondRelease.releasedEventId });
    await assertForeignWithheld(secondRoute, secondRelease,
      { canary: firstRelease.withheld, eventId: firstRelease.withheldEventId });
    await assertForeignWithheld(secondRoute, secondRelease,
      { canary: firstRelease.released, eventId: firstRelease.releasedEventId });
  } finally {
    await Promise.all([first.context.close(), second.context.close()]);
  }
});
