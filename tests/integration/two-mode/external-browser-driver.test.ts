import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeNativeSnapshot } from './external-browser-driver.js';

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
  assert.throws(() => decodeNativeSnapshot({ sessions: [{ ...sessions[0], generation: 0 }, sessions[1]] }),
    /generation_invalid/);
});
