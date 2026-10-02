import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ClaudeProcessScope } from './process-proof';
import { claudeProcessProofMessage, createClaudeProcessProof } from './process-proof';

const scope = (sessionId: string, generation = 1): ClaudeProcessScope => ({
  harness: 'claude', sessionId, bindingId: `binding-${sessionId}` as ClaudeProcessScope['bindingId'],
  generation, ownerId: 'owner-1' as ClaudeProcessScope['ownerId'],
  agentParticipantId: `participant-${sessionId}` as ClaudeProcessScope['agentParticipantId'],
  deviceId: `device-${sessionId}` as ClaudeProcessScope['deviceId'],
});
const keyPair = () => {
  const pair = generateKeyPairSync('ed25519');
  const publicKey = pair.publicKey.export({ format: 'jwk' }).x!;
  return { ...pair, publicKey };
};
const bodyHash = createHash('sha256').update('human-message').digest('base64url');

describe('Claude MCP process proof', () => {
  it('binds two approved keys to separate sessions and consumes a signed challenge once', () => {
    const proof = createClaudeProcessProof();
    const a = scope('session-a');
    const b = scope('session-b');
    const keyA = keyPair();
    const keyB = keyPair();
    const candidateA = proof.begin(a, keyA.publicKey)!;
    const candidateB = proof.begin(b, keyB.publicKey)!;
    expect(proof.approve(a, candidateA.candidateId, candidateA.code)).toBe(true);
    expect(proof.approve(b, candidateB.candidateId, candidateB.code)).toBe(true);
    const challenge = proof.challenge(b, candidateB.keyId, 'read', bodyHash)!;
    const signed = (target: ClaudeProcessScope, privateKey: typeof keyA.privateKey) => sign(null,
      claudeProcessProofMessage({ scope: target, operation: 'read', bodyHash, challenge }), privateKey).toString('base64url');
    const request = { scope: b, keyId: candidateB.keyId, operation: 'read' as const, bodyHash, challenge };
    expect(proof.authorize({ ...request, signature: signed(b, keyA.privateKey) })).toBe(false);
    expect(proof.authorize({ ...request, signature: signed(a, keyB.privateKey) })).toBe(false);
    expect(proof.authorize({ ...request, signature: signed(b, keyB.privateKey) })).toBe(true);
    expect(proof.authorize({ ...request, signature: signed(b, keyB.privateKey) })).toBe(false);
    expect(proof.challenge(a, candidateB.keyId, 'read', bodyHash)).toBeNull();
  });

  it('requires owner comparison and exact generation, then revokes a replaced process key', () => {
    let now = 1_000;
    const proof = createClaudeProcessProof(() => now);
    const bound = scope('session-a');
    const first = keyPair();
    const pending = proof.begin(bound, first.publicKey)!;
    expect(proof.approve(bound, pending.candidateId, 'wrong-code')).toBe(false);
    expect(proof.challenge(bound, pending.keyId, 'read', bodyHash)).toBeNull();
    expect(proof.approve(scope('session-a', 2), pending.candidateId, pending.code)).toBe(false);
    expect(proof.approve(bound, pending.candidateId, pending.code)).toBe(true);
    const second = keyPair();
    const replacement = proof.begin(bound, second.publicKey)!;
    expect(proof.challenge(bound, pending.keyId, 'read', bodyHash)).not.toBeNull();
    expect(proof.approve(bound, replacement.candidateId, replacement.code)).toBe(true);
    expect(proof.challenge(bound, pending.keyId, 'read', bodyHash)).toBeNull();
    expect(proof.challenge(bound, replacement.keyId, 'read', bodyHash)).not.toBeNull();
    proof.revoke(bound);
    expect(proof.challenge(bound, replacement.keyId, 'read', bodyHash)).toBeNull();
    const expiring = proof.begin(bound, first.publicKey)!;
    now += 5 * 60_000;
    expect(proof.approve(bound, expiring.candidateId, expiring.code)).toBe(false);
    const live = proof.begin(bound, first.publicKey)!;
    expect(proof.approve(bound, live.candidateId, live.code)).toBe(true);
    now += 29 * 60_000;
    expect(proof.challenge(bound, live.keyId, 'read', bodyHash)).not.toBeNull();
    now += 60_000;
    expect(proof.challenge(bound, live.keyId, 'read', bodyHash)).toBeNull();
  });
});
