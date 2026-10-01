import { expect, test } from '@playwright/test';
import { freshPage, rawRoomMessages, readLiveHumanEnvironment, signIn, syntheticCanary, verifyMatrixObserver } from './fixtures';

const environment = readLiveHumanEnvironment();

test('two OAuth humans create, share, join, and exchange encrypted attributed messages', async ({ browser }) => {
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  try {
    const alice = await freshPage(aliceContext, environment);
    // The control runtime issues the creator's Matrix session to this browser.
    // Capture it only in test memory; a room outsider cannot read joined history.
    const creatorSessionResponse = alice.waitForResponse(response =>
      new URL(response.url()).pathname === '/api/human/messaging/session' && response.status() === 200,
    );
    await signIn(alice, environment, environment.users[0]);
    const creatorSession = await (await creatorSessionResponse).json() as { session?: { accessToken?: unknown } };
    const creatorAccessToken = creatorSession.session?.accessToken;
    expect(typeof creatorAccessToken).toBe('string');

    const intro = syntheticCanary('intro');
    await alice.getByRole('button', { name: 'Create channel' }).last().click();
    await alice.getByLabel('Channel name (optional)').fill(`Live ${environment.environmentId}`);
    await alice.getByRole('button', { name: 'Create channel' }).last().click();
    await expect(alice).toHaveURL(/\/channels\//u);
    await alice.getByLabel('Message', { exact: true }).fill(intro);
    await alice.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(alice.getByRole('list', { name: 'Messages' }).getByText(intro)).toBeVisible();
    await aliceContext.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: environment.appOrigin });
    await alice.getByRole('button', { name: 'Copy my channel link' }).click();
    await expect(alice.getByText('Copied', { exact: true })).toBeVisible();
    const shareUrl = await alice.evaluate(() => navigator.clipboard.readText());
    expect(shareUrl).toMatch(/\/join\/[^/?#]+$/u);

    const bob = await bobContext.newPage();
    await bob.goto(shareUrl, { waitUntil: 'networkidle' });
    await signIn(bob, environment, environment.users[1]);
    await expect(bob.getByText("You're in.")).toBeVisible();
    const roomText = await bob.locator('.join-joined__room-id').innerText();
    const roomId = roomText.replace(/^Channel:\s*/u, '');
    expect(roomId).not.toBe('');

    // The disposable observer has not been admitted. A 403 proves private
    // history is inaccessible; it is not a source of ciphertext evidence.
    await verifyMatrixObserver(environment);
    await expect(rawRoomMessages(environment, roomId, environment.observer.accessToken))
      .rejects.toThrow('Matrix event request failed with 403');

    await bob.getByRole('button', { name: 'Open channel' }).click();
    await expect(bob).toHaveURL(`${environment.appOrigin}/channels/${encodeURIComponent(roomId)}`);
    // The current product default is link admission with no earlier history.
    await expect(bob.getByRole('list', { name: 'Messages' }).getByText(intro)).toHaveCount(0);
    const reply = syntheticCanary('reply');
    await bob.getByLabel('Message', { exact: true }).fill(reply);
    await bob.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(bob.getByRole('list', { name: 'Messages' }).getByText(reply)).toBeVisible();

    await expect(alice).toHaveURL(`${environment.appOrigin}/channels/${encodeURIComponent(roomId)}`);
    await alice.reload({ waitUntil: 'networkidle' });
    await expect(alice.getByRole('list', { name: 'Messages' }).getByText(reply)).toBeVisible({ timeout: 30_000 });
    await expect(alice.getByRole('list', { name: 'Messages' }).getByText(intro)).toBeVisible();

    const rawEvents = await rawRoomMessages(environment, roomId, creatorAccessToken as string);
    expect(rawEvents.filter(event => event.type === 'm.room.encrypted').length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(rawEvents)).not.toContain(intro);
    expect(JSON.stringify(rawEvents)).not.toContain(reply);

    await bob.reload({ waitUntil: 'networkidle' });
    await expect(bob.getByRole('list', { name: 'Messages' }).getByText(intro)).toHaveCount(0);
    await expect(bob.getByRole('list', { name: 'Messages' }).getByText(reply)).toBeVisible();
  } finally {
    await Promise.all([aliceContext.close(), bobContext.close()]);
  }
});

test('an account without admission cannot read a protected room', async ({ browser }) => {
  const ownerContext = await browser.newContext();
  const outsiderContext = await browser.newContext();
  try {
    const owner = await freshPage(ownerContext, environment);
    await signIn(owner, environment, environment.users[0]);
    await owner.getByRole('button', { name: 'Create channel' }).last().click();
    const canary = syntheticCanary('protected');
    await owner.getByRole('button', { name: 'Create channel' }).last().click();
    await expect(owner).toHaveURL(/\/channels\//u);
    const roomId = decodeURIComponent(new URL(owner.url()).pathname.slice('/channels/'.length));
    expect(roomId).not.toBe('');
    await owner.getByLabel('Message', { exact: true }).fill(canary);
    await owner.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(owner.getByRole('list', { name: 'Messages' }).getByText(canary)).toBeVisible();

    const outsider = await freshPage(outsiderContext, environment);
    const outsiderSessionResponse = outsider.waitForResponse(response =>
      new URL(response.url()).pathname === '/api/human/messaging/session' && response.status() === 200,
    );
    await signIn(outsider, environment, environment.users[1]);
    const outsiderSession = await (await outsiderSessionResponse).json() as { session?: { accessToken?: unknown } };
    expect(typeof outsiderSession.session?.accessToken).toBe('string');
    await expect(rawRoomMessages(environment, roomId, outsiderSession.session!.accessToken as string))
      .rejects.toThrow('Matrix event request failed with 403');
    await outsider.goto(`${environment.appOrigin}/channels/${encodeURIComponent(roomId)}`);
    await expect(outsider.getByRole('list', { name: 'Messages' }).getByText(canary)).toHaveCount(0);
    await expect(outsider.getByRole('alert')).toBeVisible();
  } finally {
    await Promise.all([ownerContext.close(), outsiderContext.close()]);
  }
});
