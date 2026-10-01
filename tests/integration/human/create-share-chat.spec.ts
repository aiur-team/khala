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
    await alice.getByLabel('Message').fill(intro);
    await alice.getByRole('button', { name: 'Send' }).click();
    await expect(alice.getByText(intro)).toBeVisible();
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
    await expect(bob.getByText(intro)).toHaveCount(0);
    const reply = syntheticCanary('reply');
    await bob.getByLabel('Message').fill(reply);
    await bob.getByRole('button', { name: 'Send' }).click();
    await expect(bob.getByText(reply)).toBeVisible();

    await expect(alice).toHaveURL(`${environment.appOrigin}/channels/${encodeURIComponent(roomId)}`);
    await expect(alice.getByText(reply)).toBeVisible();
    await expect(alice.getByText(intro)).toBeVisible();

    const rawEvents = await rawRoomMessages(environment, roomId, creatorAccessToken as string);
    expect(rawEvents.filter(event => event.type === 'm.room.encrypted').length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(rawEvents)).not.toContain(intro);
    expect(JSON.stringify(rawEvents)).not.toContain(reply);

    await bob.reload({ waitUntil: 'networkidle' });
    await expect(bob.getByText(intro)).toHaveCount(0);
    await expect(bob.getByText(reply)).toBeVisible();
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
    await owner.getByLabel('Message').fill(canary);
    await owner.getByRole('button', { name: 'Send' }).click();
    await expect(owner.getByText(canary)).toBeVisible();
    await ownerContext.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: environment.appOrigin });
    await owner.getByRole('button', { name: 'Copy my channel link' }).click();
    await expect(owner.getByText('Copied', { exact: true })).toBeVisible();
    const shareUrl = await owner.evaluate(() => navigator.clipboard.readText());
    const inviteRef = new URL(shareUrl).pathname.match(/^\/join\/([^/]+)$/u)?.[1] ?? null;
    expect(inviteRef).not.toBeNull();

    const outsider = await freshPage(outsiderContext, environment);
    await signIn(outsider, environment, environment.users[1]);
    await outsider.goto(`${environment.appOrigin}/channels/${encodeURIComponent(`!not-admitted:${inviteRef}`)}`);
    await expect(outsider.getByText(canary)).toHaveCount(0);
    await expect(outsider.getByRole('alert')).toBeVisible();
  } finally {
    await Promise.all([ownerContext.close(), outsiderContext.close()]);
  }
});
