import { expect, test, type Page, type Response } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { freshPage, rawRoomMessages, readLiveHumanEnvironment, signIn, syntheticCanary } from '../human/fixtures.js';
import { ExternalNativeDriver, encryptedEventIds } from './external-browser-driver.js';
import { verifyExternalConversation, type Actor, type BrowserFact } from './external-witness.js';
import { validateJournal, type Receipt } from '../../../scripts/acceptance/candidate.js';

const environment = readLiveHumanEnvironment();
const helper = resolve(import.meta.dirname, '../../../scripts/external-native-sessions.mjs');
const actors = ['codex', 'claude'] as const;

/** Raw Matrix events are the ciphertext oracle; an accepted send or UI echo alone is insufficient. */
async function ciphertextIds(roomId: string, accessToken: string): Promise<string[]> {
  const events = await rawRoomMessages(environment, roomId, accessToken);
  return events.filter(event => event.type === 'm.room.encrypted' && typeof event.event_id === 'string')
    .map(event => event.event_id as string);
}

async function requireCiphertext(roomId: string, accessToken: string, eventId: string): Promise<void> {
  await expect.poll(async () => (await ciphertextIds(roomId, accessToken)).includes(eventId), { timeout: 30_000 }).toBe(true);
}

async function newEncryptedMessage(owner: Page, roomId: string, accessToken: string, before: readonly string[]): Promise<{ eventId: string; text: string }> {
  let fresh: string[] = [];
  await expect.poll(async () => {
    fresh = (await ciphertextIds(roomId, accessToken)).filter(id => !before.includes(id));
    return fresh.length;
  }, { timeout: 60_000 }).toBe(1);
  const eventId = fresh[0]!;
  const row = owner.locator(`.timeline__row:not(.timeline__row--pending)[data-event-id="${eventId}"]`);
  await expect(row).toBeVisible({ timeout: 30_000 });
  const text = (await row.locator('.conversation-message__content').innerText()).trim();
  if (text.length < 8) throw new Error('external_browser_agent_message_not_useful');
  return { eventId, text };
}

async function approveExactRequest(owner: Page, fingerprint: string, channelTitle: string, roomId: string): Promise<void> {
  await owner.goto(`${environment.appOrigin}/channel-requests`);
  const pending = owner.getByRole('list', { name: 'Requests waiting for you' });
  const row = pending.locator('.channel-requests__row', { hasText: fingerprint });
  await expect(row).toHaveCount(1, { timeout: 30_000 });
  await expect(row).toContainText('Channel access request');
  await expect(row).toContainText(channelTitle);
  await expect(row).toContainText('Waiting for you');
  await row.getByRole('button', { name: 'Review request' }).click();
  const dialog = owner.getByRole('dialog');
  await expect(dialog).toContainText(fingerprint);
  await expect(dialog).toContainText(channelTitle);
  await dialog.getByRole('button', { name: 'Approve access' }).click();
  await expect(owner.getByRole('list', { name: 'Requests waiting for you' }).locator('.channel-requests__row', { hasText: fingerprint }))
    .toHaveCount(0, { timeout: 30_000 });
  const recent = owner.getByRole('list', { name: 'Recent requests' }).locator('.channel-requests__row', { hasText: fingerprint });
  await expect(recent).toContainText('Approved', { timeout: 30_000 });
  await expect(recent).toContainText('Connected', { timeout: 60_000 });
  await owner.goto(`${environment.appOrigin}/channels/${encodeURIComponent(roomId)}`);
}

async function sendChallenge(owner: Page, actor: Actor, roomId: string, accessToken: string): Promise<{ eventId: string; text: string }> {
  const challenge = syntheticCanary(`challenge-${actor}`);
  const text = `Please read this ${actor} challenge and send a useful reply: ${challenge}`;
  await owner.getByLabel('Message', { exact: true }).fill(text);
  await owner.getByRole('button', { name: 'Send message', exact: true }).click();
  const eventId = await encryptedEventIds(owner, challenge);
  await requireCiphertext(roomId, accessToken, eventId);
  return { eventId, text };
}

type Release = Readonly<{ operationId: string; releaseId: string; bindingId: string; generation: number }>;

async function releaseExactMessage(owner: Page, eventId: string, agentParticipantId: string): Promise<Release> {
  const disclosure = owner.locator('.recipient-review-disclosure');
  await expect(disclosure).toHaveCount(1, { timeout: 40_000 });
  if ((await disclosure.getAttribute('open')) === null) await disclosure.locator('summary').click();
  const panel = disclosure.locator('section.review').filter({ has: owner.locator('.review__recipient', { hasText: `To: ${agentParticipantId}` }) });
  await expect(panel).toHaveCount(1, { timeout: 30_000 });
  const item = panel.locator(`.review-item[data-event-id="${eventId}"]`);
  await expect(item).toHaveCount(1, { timeout: 30_000 });
  await item.getByRole('checkbox').check();
  const outcomes = new Map<string, readonly string[]>();
  const onResponse = async (response: Response) => {
    const path = new URL(response.url()).pathname;
    if (path !== '/api/human/owner-mailbox/submit' && path !== '/api/human/owner-mailbox/result') return;
    try {
      const body = await response.json() as { operationId?: unknown; outcome?: { ok?: unknown; releaseIds?: unknown } };
      if (typeof body.operationId === 'string' && body.outcome?.ok === true && Array.isArray(body.outcome.releaseIds))
        outcomes.set(body.operationId, body.outcome.releaseIds.filter((id): id is string => typeof id === 'string'));
    } catch { /* Failed outcome stays unproven below. */ }
  };
  owner.on('response', onResponse);
  try {
    const submitted = owner.waitForRequest(request => {
      if (new URL(request.url()).pathname !== '/api/human/owner-mailbox/submit') return false;
      try { return (request.postDataJSON() as { kind?: unknown }).kind === 'review_approve'; }
      catch { return false; }
    });
    await panel.getByRole('button', { name: 'Release 1 selected' }).click();
    const envelope = (await submitted).postDataJSON() as { bindingId?: unknown; operationId?: unknown;
      body?: { expectedBindingGeneration?: unknown; selection?: readonly { eventId?: unknown }[] } };
    if (typeof envelope.bindingId !== 'string' || typeof envelope.operationId !== 'string'
      || !Number.isSafeInteger(envelope.body?.expectedBindingGeneration)
      || Number(envelope.body?.expectedBindingGeneration) < 1
      || envelope.body?.selection?.length !== 1 || envelope.body.selection[0]?.eventId !== eventId)
      throw new Error('external_browser_release_identity_mismatch');
    await expect(panel.locator('.review__submission-status')).toContainText('Released', { timeout: 30_000 });
    await expect.poll(() => outcomes.get(envelope.operationId as string)?.length ?? 0, { timeout: 15_000 }).toBe(1);
    return { operationId: envelope.operationId, releaseId: outcomes.get(envelope.operationId)![0]!,
      bindingId: envelope.bindingId, generation: envelope.body.expectedBindingGeneration as number };
  } finally { owner.off('response', onResponse); }
}

async function requireOwnerAck(owner: Page, release: Release): Promise<void> {
  await expect.poll(() => owner.evaluate(async ({ bindingId, releaseId, generation }) => {
    const response = await fetch(`/api/human/owner-mailbox/review-status?binding_id=${encodeURIComponent(bindingId)}`,
      { credentials: 'same-origin', headers: { accept: 'application/json' } });
    if (!response.ok) return false;
    const body = await response.json() as { generation?: unknown; preview?: { receipts?: readonly {
      releaseId?: unknown; bindingId?: unknown; generation?: unknown; kind?: unknown; source?: unknown }[] } };
    return body.generation === generation && body.preview?.receipts?.some(receipt =>
      receipt.releaseId === releaseId && receipt.bindingId === bindingId && receipt.generation === generation
      && receipt.kind === 'agent_acknowledged' && receipt.source === 'agent') === true;
  }, release), { timeout: 60_000, intervals: [1_000, 2_000] }).toBe(true);
}

async function waitForNative(driver: ExternalNativeDriver, predicate: (snapshot: ReturnType<ExternalNativeDriver['inspect']>) => boolean): Promise<ReturnType<ExternalNativeDriver['inspect']>> {
  let current: ReturnType<ExternalNativeDriver['inspect']> | null = null;
  await expect.poll(() => {
    try { current = driver.inspect(); return predicate(current); }
    catch { return false; }
  }, { timeout: 60_000, intervals: [500, 1_000, 2_000] }).toBe(true);
  return current!;
}

test('OAuth owner approves two exact native sessions and witnesses durable encrypted three-party chat', async ({ browser }) => {
  // The disposable topology's consumer command must allow at least 900s.
  test.setTimeout(840_000);
  const ownerContext = await browser.newContext();
  const native = new ExternalNativeDriver(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'khala-external-native-')), helper);
  let launched = false;
  try {
    // Preflight precedes channel creation: unsupported or stale native routes leave no false conversation artifact.
    native.launch();
    launched = true;
    for (const actor of actors) native.prompt(actor, 'Please identify yourself and your current native session. Do not join a Khala channel yet.');
    await waitForNative(native, snapshot => snapshot.sessions.every(session => Boolean(session.sessionId && session.pid)));
    const owner = await freshPage(ownerContext, environment);
    const sessionResponse = owner.waitForResponse(response =>
      new URL(response.url()).pathname === '/api/human/messaging/session' && response.status() === 200);
    await signIn(owner, environment, environment.users[0]);
    const session = await (await sessionResponse).json() as { session?: { accessToken?: unknown } };
    if (typeof session.session?.accessToken !== 'string') throw new Error('external_browser_matrix_session_missing');
    const accessToken = session.session.accessToken;

    await owner.getByRole('button', { name: 'Create channel' }).last().click();
    const channelTitle = `E2E ${environment.environmentId}`;
    await owner.getByLabel('Channel name (optional)').fill(channelTitle);
    await owner.getByRole('button', { name: 'Create channel' }).last().click();
    await expect(owner).toHaveURL(/\/channels\//u);
    const roomId = decodeURIComponent(new URL(owner.url()).pathname.slice('/channels/'.length));
    await ownerContext.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: environment.appOrigin });
    await owner.getByRole('button', { name: 'Copy my channel link' }).click();
    const invite = await owner.evaluate(() => navigator.clipboard.readText());
    if (!invite.startsWith(`${environment.appOrigin}/join/`)) throw new Error('external_browser_invite_origin_invalid');

    for (const actor of actors) {
      native.prompt(actor, `Use the installed Khala connector in this exact native session to request access to ${invite}. Do not report success until the owner approves your exact session.`);
      const snapshot = await waitForNative(native, current => Boolean(current.sessions.find(item => item.actor === actor)?.sessionFingerprint));
      const session = snapshot.sessions.find(item => item.actor === actor)!;
      if (!session.sessionFingerprint) throw new Error(`external_browser_${actor}_proof_key_unobserved`);
      await approveExactRequest(owner, session.sessionFingerprint, channelTitle, roomId);
    }

    const bindings = native.inspect().sessions;
    if (bindings.some(item => !item.bindingId || !item.generation || !item.agentParticipantId))
      throw new Error('external_browser_bindings_unobserved');
    native.mark();
    const proof = [];
    for (const actor of actors) {
      const session = bindings.find(item => item.actor === actor)!;
      if (!session.bindingId || !session.generation || !session.agentParticipantId)
        throw new Error(`external_browser_${actor}_binding_unobserved`);
      const challenge = await sendChallenge(owner, actor, roomId, accessToken);
      const release = await releaseExactMessage(owner, challenge.eventId, session.agentParticipantId);
      if (release.bindingId !== session.bindingId || release.generation !== session.generation)
        throw new Error(`external_browser_${actor}_release_binding_mismatch`);
      const before = await ciphertextIds(roomId, accessToken);
      native.prompt(actor, `Read the freshly released ${actor} Khala message through your installed MCP route. Acknowledge its exact batch from this model session and send a useful answer in the channel. Do not use the browser or transcript to learn the message.`);
      const reply = await newEncryptedMessage(owner, roomId, accessToken, before);
      await requireOwnerAck(owner, release);
      proof.push({ actor, bindingId: release.bindingId, generation: release.generation,
        operationId: release.operationId, challengeEventId: challenge.eventId, releaseId: release.releaseId,
        replyEventId: reply.eventId, challengeText: challenge.text, replyText: reply.text, ackObserved: true });
    }
    const beforePeer = await ciphertextIds(roomId, accessToken);
    native.prompt('codex', 'Send Claude a new, specific question in this Khala channel using your installed MCP route.');
    const peerMessage = await newEncryptedMessage(owner, roomId, accessToken, beforePeer);
    const claudeBinding = bindings.find(item => item.actor === 'claude')!;
    const peerRelease = await releaseExactMessage(owner, peerMessage.eventId, claudeBinding.agentParticipantId!);
    if (peerRelease.bindingId !== claudeBinding.bindingId || peerRelease.generation !== claudeBinding.generation)
      throw new Error('external_browser_peer_release_binding_mismatch');
    const beforePeerReply = await ciphertextIds(roomId, accessToken);
    native.prompt('claude', 'Read and acknowledge the new Codex message, then answer it in this Khala channel.');
    const peerReply = await newEncryptedMessage(owner, roomId, accessToken, beforePeerReply);
    await requireOwnerAck(owner, peerRelease);

    const snapshot = native.witness({ actors: proof, peer: { from: 'codex', to: 'claude',
      eventId: peerMessage.eventId, readEventId: peerMessage.eventId, replyEventId: peerReply.eventId,
      messageText: peerMessage.text, replyText: peerReply.text } });
    if (!snapshot.native || !snapshot.peer) throw new Error('external_browser_model_witness_missing');
    for (const fact of snapshot.native) {
      if (proof.find(row => row.actor === fact.actor)?.challengeEventId !== fact.challengeEventId)
        throw new Error('external_browser_challenge_identity_mismatch');
      await requireCiphertext(roomId, accessToken, fact.replyEventId);
    }
    await requireCiphertext(roomId, accessToken, snapshot.peer.eventId);
    await requireCiphertext(roomId, accessToken, snapshot.peer.replyEventId);

    // A reload must fetch and decrypt the committed events; no optimistic send row counts.
    await owner.reload({ waitUntil: 'domcontentloaded' });
    const encrypted = await ciphertextIds(roomId, accessToken);
    const browserFacts: BrowserFact[] = [];
    for (const fact of snapshot.native) {
      const row = owner.locator(`.timeline__row:not(.timeline__row--pending)[data-event-id="${fact.replyEventId}"]`);
      await expect(row).toBeVisible({ timeout: 30_000 });
      const body = await row.locator('.conversation-message__content').innerText();
      if (body.trim().length < 8) throw new Error('external_browser_reply_not_useful');
      browserFacts.push({ challengeEventId: fact.challengeEventId, replyEventId: fact.replyEventId,
        encryptedEventIds: encrypted, reloadedEventIds: [fact.replyEventId, snapshot.peer.replyEventId] });
    }
    await expect(owner.locator(`.timeline__row:not(.timeline__row--pending)[data-event-id="${snapshot.peer.replyEventId}"]`))
      .toBeVisible({ timeout: 30_000 });
    verifyExternalConversation(snapshot.native, browserFacts, snapshot.peer);
    for (const row of proof) {
      const redacted = (value: string) => createHash('sha256').update(value).digest('hex');
      const identity = { operationId: redacted(row.operationId), eventId: redacted(row.challengeEventId),
        bindingId: redacted(row.bindingId), generation: row.generation };
      const journal: Receipt[] = [
        { ...identity, stage: 'pending', origin: 'server' },
        { ...identity, stage: 'released', origin: 'server' },
        { ...identity, stage: 'model-consumed', origin: 'model' },
        { ...identity, stage: 'acknowledged', origin: 'model' },
        { ...identity, stage: 'durable-browser-visible', origin: 'browser' },
      ];
      validateJournal(journal);
    }
  } finally {
    await ownerContext.close();
    if (launched) native.stop();
  }
});
