import { expect, test } from '@playwright/test';
import { freshPage, rawRoomMessages, readLiveHumanEnvironment, signIn, syntheticCanary } from './fixtures';

const environment = readLiveHumanEnvironment();

test('two OAuth humans create, share, join, and exchange encrypted attributed messages', async ({ browser }) => {
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  try {
    const alice = await freshPage(aliceContext, environment);
    await signIn(alice, environment, environment.users[0]);

    const intro = syntheticCanary('intro');
    await alice.getByLabel('Channel name (optional)').fill(`Live ${environment.environmentId}`);
    await alice.getByLabel('Message 1').fill(intro);
    await alice.getByRole('button', { name: 'Create channel' }).click();
    const link = alice.getByLabel('Channel link');
    await expect(link).toHaveValue(/\/join\/[^/?#]+$/u);
    const shareUrl = await link.inputValue();

    const bob = await bobContext.newPage();
    await bob.goto(shareUrl, { waitUntil: 'networkidle' });
    await signIn(bob, environment, environment.users[1]);
    await expect(bob.getByText("You're in.")).toBeVisible();
    const roomText = await bob.locator('.join-joined__room-id').innerText();
    const roomId = roomText.replace(/^Channel:\s*/u, '');
    expect(roomId).not.toBe('');

    await bob.getByRole('button', { name: 'Open channel' }).click();
    await expect(bob).toHaveURL(`${environment.appOrigin}/channels/${encodeURIComponent(roomId)}`);
    // The current product default is link admission with no earlier history.
    await expect(bob.getByText(intro)).toHaveCount(0);
    const reply = syntheticCanary('reply');
    await bob.getByLabel('Message').fill(reply);
    await bob.getByRole('button', { name: 'Send' }).click();
    await expect(bob.getByText(reply)).toBeVisible();

    await alice.getByRole('button', { name: 'Open channel' }).click();
    await expect(alice).toHaveURL(`${environment.appOrigin}/channels/${encodeURIComponent(roomId)}`);
    await expect(alice.getByText(reply)).toBeVisible();
    await expect(alice.getByText(intro)).toBeVisible();

    const rawEvents = await rawRoomMessages(environment, roomId);
    expect(rawEvents.some(event => event.type === 'm.room.encrypted')).toBe(true);
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
    const canary = syntheticCanary('protected');
    await owner.getByLabel('Message 1').fill(canary);
    await owner.getByRole('button', { name: 'Create channel' }).click();
    const shareUrl = await owner.getByLabel('Channel link').inputValue();
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
