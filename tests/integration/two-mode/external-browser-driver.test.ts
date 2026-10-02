import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExternalNativeDriver, assertWitnessMatches, decodeNativeSnapshot, type ObservedExchange } from './external-browser-driver.js';
import type { NativeFact } from './external-witness.js';

const sessions = [
  { actor: 'codex', sessionId: 'codex_session', pid: 124, processStartTicks: '123456', cliVersion: '0.160.0',
    sessionFingerprint: 'codex_jkt', bindingId: 'binding_codex', generation: 1, agentParticipantId: 'agent_codex' },
  { actor: 'claude', sessionId: 'claude_session', pid: 125, processStartTicks: '123457', cliVersion: '2.1.0' },
];

test('external browser accepts a pending native session but cannot invent its proof key', () => {
  const snapshot = decodeNativeSnapshot({ sessions });
  assert.equal(snapshot.sessions[0]?.sessionFingerprint, 'codex_jkt');
  assert.equal(snapshot.sessions[1]?.sessionFingerprint, undefined);
  assert.equal(snapshot.sessions[0]?.bindingId, 'binding_codex');
});

test('external browser refuses a reused native identity or proof key', () => {
  assert.throws(() => decodeNativeSnapshot({ sessions: [sessions[0], { ...sessions[1], sessionId: 'codex_session' }] }),
    /distinct_sessions/);
  assert.throws(() => decodeNativeSnapshot({ sessions: [sessions[0], { ...sessions[1], sessionFingerprint: 'codex_jkt' }] }),
    /distinct_sessions/);
});

test('external browser rejects invalid binding generation before review', () => {
  assert.equal(decodeNativeSnapshot({ sessions: [{ ...sessions[0], generation: 0 }, sessions[1]] }).sessions[0]?.generation, 0);
  assert.throws(() => decodeNativeSnapshot({ sessions: [{ ...sessions[0], generation: -1 }, sessions[1]] }),
    /generation_invalid/);
});

const observed: ObservedExchange[] = (['codex', 'claude'] as const).map((actor, index) => ({
  actor, sessionId: `${actor}_session`, bindingId: `binding_${actor}`, generation: 0,
  operationId: `operation_${index}`, challengeEventId: `challenge_${index}`,
  releaseId: `release_${index}`, replyEventId: `reply_${index}`,
}));
const native: NativeFact[] = observed.map(row => ({ ...row, modelReadEventId: row.challengeEventId,
  observedReadEventIds: [row.challengeEventId], readBindingId: row.bindingId, readGeneration: row.generation,
  ackReleaseId: row.releaseId, ackBindingId: row.bindingId, ackGeneration: row.generation, replyOrigin: 'model' }));
const peer = { from: 'codex', to: 'claude', eventId: 'peer_event', readEventId: 'peer_event', replyEventId: 'peer_reply' } as const;
const snapshot = { sessions: observed.map(row => ({ actor: row.actor, sessionId: row.sessionId,
  bindingId: row.bindingId, generation: row.generation, pid: 123, processStartTicks: '123456', cliVersion: '0.160.0' })),
  native, peer };

test('external browser rejects a native witness for another owner release or browser reply', () => {
  assert.doesNotThrow(() => assertWitnessMatches(snapshot, observed, peer));
  for (const field of ['sessionId', 'bindingId', 'generation', 'operationId', 'challengeEventId', 'releaseId', 'replyEventId'] as const) {
    const changed = [{ ...native[0]!, [field]: field === 'generation' ? 1 : 'other_identity' }, native[1]!];
    assert.throws(() => assertWitnessMatches({ ...snapshot, native: changed }, observed, peer), /witness_identity_mismatch/);
  }
  assert.throws(() => assertWitnessMatches({ ...snapshot, peer: { ...peer, eventId: 'other_event' } }, observed, peer),
    /peer_witness_identity_mismatch/);
  assert.throws(() => assertWitnessMatches({ ...snapshot, peer: { ...peer, readEventId: 'other_event' } }, observed, peer),
    /peer_witness_identity_mismatch/);
  assert.throws(() => assertWitnessMatches({ ...snapshot, peer: { ...peer, replyEventId: 'other_reply' } }, observed, peer),
    /peer_witness_identity_mismatch/);
});

test('external browser removes private prompt and witness inputs after helper failures', () => {
  const directory = mkdtempSync(join(tmpdir(), 'khala-browser-driver-test-'));
  const script = join(directory, 'fail.mjs');
  writeFileSync(script, 'process.exitCode = 2;\n', { mode: 0o600 });
  const driver = new ExternalNativeDriver(directory, script);
  assert.throws(() => driver.prompt('codex', 'private invitation'), /Command failed/);
  assert.throws(() => driver.witness({ private: 'message text' }), /Command failed/);
  assert.deepEqual(readdirSync(directory), ['fail.mjs']);
});
