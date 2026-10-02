import { expect, test, type Page, type Response } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { freshPage, rawRoomMessages, readLiveHumanEnvironment, signIn, syntheticCanary } from '../human/fixtures.js';
import { ExternalNativeDriver, assertWitnessMatches, encryptedEventIds, exactOwnerAccessRequest,
  type NativeSession } from './external-browser-driver.js';
import { verifyExternalConversation, type Actor, type BrowserFact } from './external-witness.js';

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

async function newEncryptedMessage(owner: Page, native: ExternalNativeDriver, roomId: string, accessToken: string,
  before: readonly string[]): Promise<{ eventId: string; text: string }> {
  let fresh: string[] = [];
  await expect.poll(async () => {
    native.service();
    fresh = (await ciphertextIds(roomId, accessToken)).filter(id => !before.includes(id));
    return fresh.length;
  }, { timeout: 60_000, intervals: [500, 1_000, 2_000] }).toBe(1);
  const eventId = fresh[0]!;
  const row = owner.locator(`.timeline__row:not(.timeline__row--pending)[data-event-id="${eventId}"]`);
  await expect(row).toBeVisible({ timeout: 30_000 });
  const text = (await row.locator('.conversation-message__content').innerText()).trim();
  if (text.length < 8) throw new Error('external_browser_agent_message_not_useful');
  return { eventId, text };
}

async function approveExactRequest(owner: Page, actor: Actor, roomId: string): Promise<void> {
  await owner.goto(`${environment.appOrigin}/channel-requests`);
  const pending = owner.getByRole('list', { name: 'Requests waiting for you' });
  let access: ReturnType<typeof exactOwnerAccessRequest> = null;
  await expect.poll(async () => {
    const body = await owner.evaluate(async () => {
      const response = await fetch('/api/human/channel-access/inbox', { credentials: 'same-origin' });
      if (response.status !== 200) throw new Error('external_browser_owner_inbox_unavailable');
      return response.json() as Promise<unknown>;
    });
    access = exactOwnerAccessRequest(body, actor);
    return Boolean(access);
  }, { timeout: 90_000, intervals: [1_000, 2_000] }).toBe(true);
  await owner.reload({ waitUntil: 'domcontentloaded' });
  if (!access) throw new Error('external_browser_owner_request_unobserved');
  const { fingerprint, title } = access;
  const row = pending.locator('.channel-requests__row', { hasText: fingerprint });
  await expect(row).toHaveCount(1, { timeout: 30_000 });
  await expect(row).toContainText('Channel access request');
  // This digest attests the approved context; signer JKT was checked separately
  // on the proof-key and discovery-consent pages.
  await expect(row).toContainText(title);
  await expect(row).toContainText(actor);
  await expect(row).toContainText('Waiting for you');
  await row.getByRole('button', { name: 'Review request' }).click();
  const dialog = owner.getByRole('dialog');
  await expect(dialog).toContainText(fingerprint);
  await expect(dialog).toContainText(title);
  await dialog.getByRole('button', { name: 'Approve access' }).click();
  await expect(owner.getByRole('list', { name: 'Requests waiting for you' }).locator('.channel-requests__row', { hasText: fingerprint }))
    .toHaveCount(0, { timeout: 30_000 });
  const recent = owner.getByRole('list', { name: 'Recent requests' }).locator('.channel-requests__row', { hasText: fingerprint });
  await expect(recent).toContainText('Approved', { timeout: 30_000 });
  await expect(recent).toContainText('Connected', { timeout: 60_000 });
  await owner.goto(`${environment.appOrigin}/channels/${encodeURIComponent(roomId)}`);
}

async function approveProofCandidate(owner: Page, actor: Actor, session: NativeSession, invite: string): Promise<void> {
  if (!session.candidate || !session.sessionFingerprint) throw new Error(`external_browser_${actor}_candidate_missing`);
  const url = new URL('/api/human/channel-discovery/authority/approve', environment.appOrigin);
  url.searchParams.set('candidate', session.candidate.candidateId);
  await owner.goto(url.href);
  await expect(owner.getByRole('heading', { name: 'Approve this proof key?' })).toBeVisible();
  const details = owner.locator('dl');
  await expect(details).toContainText(session.sessionFingerprint);
  await expect(details).toContainText(session.sessionId);
  await expect(details).toContainText(invite);
  await expect(details).toContainText(actor);
  await owner.getByRole('button', { name: 'Approve key' }).click();
  const response = JSON.parse(await owner.locator('body').innerText()) as { kind?: unknown };
  if (response.kind !== 'approved') throw new Error(`external_browser_${actor}_candidate_approval_failed`);
}

async function authorizeDiscovery(owner: Page, actor: Actor, session: NativeSession): Promise<void> {
  if (!session.discoveryConsentUrl || !session.sessionFingerprint) throw new Error(`external_browser_${actor}_discovery_missing`);
  const url = new URL(session.discoveryConsentUrl);
  if (url.origin !== environment.appOrigin || url.searchParams.get('harness') !== actor
    || url.searchParams.get('session_id') !== session.sessionId
    || url.searchParams.get('proof_jkt') !== session.sessionFingerprint)
    throw new Error(`external_browser_${actor}_discovery_identity_mismatch`);
  await owner.goto(url.href);
  await expect(owner.getByRole('heading', { name: 'Authorize channel discovery?' })).toBeVisible();
  const details = owner.locator('dl');
  await expect(details).toContainText(session.sessionFingerprint);
  await expect(details).toContainText(session.sessionId);
  await expect(details).toContainText(actor);
  await owner.getByRole('button', { name: 'Authorize', exact: true }).click();
  await expect(owner).toHaveURL(/^http:\/\/127\.0\.0\.1:\d+\/khala\/channel-discovery\/callback\//u);
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
      || Number(envelope.body?.expectedBindingGeneration) < 0
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

async function waitForNative(driver: ExternalNativeDriver, predicate: (snapshot: ReturnType<ExternalNativeDriver['inspect']>) => boolean,
  timeout = 90_000): Promise<ReturnType<ExternalNativeDriver['inspect']>> {
  let current: ReturnType<ExternalNativeDriver['inspect']> | null = null;
  let lastStage = 'predicate_false';
  try {
    await expect.poll(() => {
      try { current = driver.inspect(); lastStage = 'predicate_false'; return predicate(current); }
      catch (error) {
        const detail = String((error as { stderr?: Buffer })?.stderr ?? error);
        lastStage = /external_(?:native|browser)_[a-z_]+/u.exec(detail)?.[0] ?? 'unknown';
        return false;
      }
    }, { timeout, intervals: [500, 1_000, 2_000] }).toBe(true);
  } catch { throw new Error(`external_browser_native_wait_${lastStage}`); }
  return current!;
}

test('OAuth owner approves two exact native sessions and witnesses durable encrypted three-party chat', async ({ browser }) => {
  // The disposable topology's consumer command must allow at least 900s.
  test.setTimeout(840_000);
  const ownerContext = await browser.newContext();
  const native = new ExternalNativeDriver(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'khala-external-native-')), helper);
  let failure: unknown = null;
  let phase = 'launch';
  try {
    // Preflight precedes channel creation: unsupported or stale native routes leave no false conversation artifact.
    native.launch();
    phase = 'preflight';
    for (const actor of actors) native.prompt(actor, 'Reply with one short sentence confirming this fresh model session is responding. Do not call tools or join Khala yet.');
    await waitForNative(native, snapshot => snapshot.sessions.every(session => Boolean(session.sessionId && session.pid)));
    phase = 'owner_room';
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
      phase = `${actor}_candidate`;
      const operationId = `e2e-${actor}-${environment.environmentId}`;
      native.prompt(actor, `In this exact native session, invoke the installed Khala MCP tool khala_request_channel_access with operationId ${operationId} and target ${invite}. The tool is available through your MCP tools. Do not use a shell, delegate, or report success before owner approval.`);
      const snapshot = await waitForNative(native, current => Boolean(current.sessions.find(item => item.actor === actor)?.sessionFingerprint
        && current.sessions.find(item => item.actor === actor)?.candidate), 180_000);
      const session = snapshot.sessions.find(item => item.actor === actor)!;
      if (!session.sessionFingerprint || session.candidate?.operationId !== operationId)
        throw new Error(`external_browser_${actor}_proof_key_unobserved`);
      await approveProofCandidate(owner, actor, session, invite);
      phase = `${actor}_access`;
      native.prompt(actor, `Using the installed Khala connector in this same native session, call khala_request_channel_access again with the exact same operationId ${operationId} and target ${invite}. The owner approved your proof key. Do not create a new operation ID.`);
      const discovery = await waitForNative(native, current => Boolean(current.sessions.find(item => item.actor === actor)?.discoveryConsentUrl), 120_000);
      await authorizeDiscovery(owner, actor, discovery.sessions.find(item => item.actor === actor)!);
      native.clearDiscovery(actor);
      await approveExactRequest(owner, actor, roomId);
    }

    phase = 'bindings';
    const bindings = native.inspect().sessions;
    if (bindings.some(item => !item.bindingId || !Number.isSafeInteger(item.generation) || item.generation! < 0
      || !item.agentParticipantId))
      throw new Error('external_browser_bindings_unobserved');
    native.mark();
    const proof = [];
    for (const actor of actors) {
      phase = `${actor}_challenge`;
      const session = bindings.find(item => item.actor === actor)!;
      if (!session.bindingId || !Number.isSafeInteger(session.generation) || session.generation! < 0
        || !session.agentParticipantId)
        throw new Error(`external_browser_${actor}_binding_unobserved`);
      const challenge = await sendChallenge(owner, actor, roomId, accessToken);
      const release = await releaseExactMessage(owner, challenge.eventId, session.agentParticipantId);
      if (release.bindingId !== session.bindingId || release.generation !== session.generation)
        throw new Error(`external_browser_${actor}_release_binding_mismatch`);
      const before = await ciphertextIds(roomId, accessToken);
      native.prompt(actor, `Read the freshly released ${actor} Khala message through your installed MCP route. Acknowledge its exact batch from this model session and send a useful answer in the channel. Do not use the browser or transcript to learn the message.`);
      const reply = await newEncryptedMessage(owner, native, roomId, accessToken, before);
      await requireOwnerAck(owner, release);
      proof.push({ actor, sessionId: session.sessionId, bindingId: release.bindingId, generation: release.generation,
        operationId: release.operationId, challengeEventId: challenge.eventId, releaseId: release.releaseId,
        replyEventId: reply.eventId, challengeText: challenge.text, replyText: reply.text, ackObserved: true });
    }
    phase = 'peer_exchange';
    const beforePeer = await ciphertextIds(roomId, accessToken);
    native.prompt('codex', 'Send Claude a new, specific question in this Khala channel using your installed MCP route.');
    const peerMessage = await newEncryptedMessage(owner, native, roomId, accessToken, beforePeer);
    const claudeBinding = bindings.find(item => item.actor === 'claude')!;
    const peerRelease = await releaseExactMessage(owner, peerMessage.eventId, claudeBinding.agentParticipantId!);
    if (peerRelease.bindingId !== claudeBinding.bindingId || peerRelease.generation !== claudeBinding.generation)
      throw new Error('external_browser_peer_release_binding_mismatch');
    const beforePeerReply = await ciphertextIds(roomId, accessToken);
    native.prompt('claude', 'Read and acknowledge the new Codex message, then answer it in this Khala channel.');
    const peerReply = await newEncryptedMessage(owner, native, roomId, accessToken, beforePeerReply);
    await requireOwnerAck(owner, peerRelease);

    phase = 'model_witness';
    const snapshot = native.witness({ actors: proof, peer: { from: 'codex', to: 'claude',
      eventId: peerMessage.eventId, readEventId: peerMessage.eventId, replyEventId: peerReply.eventId,
      messageText: peerMessage.text, replyText: peerReply.text } });
    const observedPeer = { from: 'codex', to: 'claude', eventId: peerMessage.eventId,
      readEventId: peerMessage.eventId, replyEventId: peerReply.eventId } as const;
    assertWitnessMatches(snapshot, proof, observedPeer);
    if (!snapshot.native || !snapshot.peer) throw new Error('external_browser_model_witness_missing');
    for (const observed of proof) {
      await requireCiphertext(roomId, accessToken, observed.replyEventId);
    }
    await requireCiphertext(roomId, accessToken, observedPeer.eventId);
    await requireCiphertext(roomId, accessToken, observedPeer.replyEventId);

    // A reload must fetch and decrypt the committed events; no optimistic send row counts.
    phase = 'reload';
    await owner.reload({ waitUntil: 'domcontentloaded' });
    const encrypted = await ciphertextIds(roomId, accessToken);
    const browserFacts: BrowserFact[] = [];
    for (const fact of snapshot.native) {
      const observed = proof.find(row => row.actor === fact.actor)!;
      const row = owner.locator(`.timeline__row:not(.timeline__row--pending)[data-event-id="${observed.replyEventId}"]`);
      await expect(row).toBeVisible({ timeout: 30_000 });
      const body = await row.locator('.conversation-message__content').innerText();
      if (body.trim().length < 8) throw new Error('external_browser_reply_not_useful');
      browserFacts.push({ challengeEventId: observed.challengeEventId, replyEventId: observed.replyEventId,
        encryptedEventIds: encrypted, reloadedEventIds: [observed.replyEventId, observedPeer.replyEventId] });
    }
    await expect(owner.locator(`.timeline__row:not(.timeline__row--pending)[data-event-id="${observedPeer.replyEventId}"]`))
      .toBeVisible({ timeout: 30_000 });
    verifyExternalConversation(snapshot.native, browserFacts, snapshot.peer);
  } catch (error) {
    failure = error;
    const diagnostic = process.env.KHALA_E2E_CONSUMER_DIAGNOSTIC;
    if (diagnostic) {
      const stage = /^external_browser_[a-z_]+$/u.test((error as Error)?.message ?? '')
        ? (error as Error).message : `external_browser_${phase}`;
      try { writeFileSync(diagnostic, JSON.stringify({ stage }) + '\n', { mode: 0o600 }); }
      catch { /* The original failure remains authoritative. */ }
    }
  } finally {
    const cleanup = await Promise.allSettled([ownerContext.close(), Promise.resolve().then(() => native.stop())]);
    if (failure === null && cleanup.some(result => result.status === 'rejected'))
      failure = new Error('external_browser_cleanup_failed');
  }
  if (failure !== null) throw failure;
});
