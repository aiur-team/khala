import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { verifyExternalConversation, type NativeFact, type BrowserFact } from './external-witness.js';

const native: NativeFact[] = (['codex', 'claude'] as const).map((actor, index) => ({
  actor, sessionId: `session_${index}`, bindingId: `binding_${index}`, generation: 1,
  operationId: `operation_${index}`, challengeEventId: `challenge_${index}`, releaseId: `release_${index}`,
  modelReadEventId: `challenge_${index}`, observedReadEventIds: [`challenge_${index}`],
  readBindingId: `binding_${index}`, readGeneration: 1,
  ackReleaseId: `release_${index}`, ackBindingId: `binding_${index}`, ackGeneration: 1,
  replyEventId: `reply_${index}`, replyOrigin: 'model',
}));
const browser: BrowserFact[] = native.map(row => ({ challengeEventId: row.challengeEventId,
  replyEventId: row.replyEventId, encryptedEventIds: [row.challengeEventId, row.replyEventId, 'peer_event', 'peer_reply'],
  reloadedEventIds: [row.replyEventId, 'peer_reply'] }));
const peer = { from: 'codex', to: 'claude', eventId: 'peer_event', readEventId: 'peer_event', replyEventId: 'peer_reply' } as const;

describe('external conversation witness', () => {
  it('requires distinct model sessions, exact reads and ACKs, durable encrypted browser replies and peer exchange', () => {
    assert.doesNotThrow(() => verifyExternalConversation(native, browser, peer));
    assert.throws(() => verifyExternalConversation(native.slice(0, 1), browser, peer), /distinct_actors/);
    assert.throws(() => verifyExternalConversation([native[0]!, { ...native[1]!, sessionId: native[0]!.sessionId }], browser, peer), /distinct_sessions/);
    assert.throws(() => verifyExternalConversation([{ ...native[0]!, modelReadEventId: 'other_event' }, native[1]!], browser, peer), /model_read_or_ack/);
    assert.throws(() => verifyExternalConversation([{ ...native[0]!, ackReleaseId: 'other_release' }, native[1]!], browser, peer), /model_read_or_ack/);
    assert.throws(() => verifyExternalConversation([{ ...native[0]!, readGeneration: 2 }, native[1]!], browser, peer), /model_read_or_ack/);
    assert.throws(() => verifyExternalConversation([{ ...native[0]!, observedReadEventIds: ['challenge_0', 'challenge_1'] }, native[1]!], browser, peer), /cross_binding_read_leak/);
    assert.throws(() => verifyExternalConversation([{ ...native[0]!, replyOrigin: 'connector' }, native[1]!], browser, peer), /model_reply/);
    assert.throws(() => verifyExternalConversation(native, [{ ...browser[0]!, reloadedEventIds: [] }, browser[1]!], peer), /durable_encrypted/);
    assert.throws(() => verifyExternalConversation(native, browser, { ...peer, readEventId: 'other_event' }), /peer_exchange/);
  });
});
