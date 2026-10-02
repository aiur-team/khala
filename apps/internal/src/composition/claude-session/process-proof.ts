import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify } from 'node:crypto';
import { claudeProcessProofMessage, type ClaudeProcessScope, type ClaudeProofOperation } from '@aiur/khala/composition/claude-process-proof';

/** Owner confirmation binds a fresh MCP-process key, not a caller-supplied session ID. */
const CANDIDATE_MS = 5 * 60_000;
const CHALLENGE_MS = 30_000;
const APPROVED_IDLE_MS = 30 * 60_000;
const MAX_PENDING = 32;
const MAX_CHALLENGES = 64;
const KEY = /^[A-Za-z0-9_-]{43}$/u;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/u;
const CODE = /^[A-Za-z0-9_-]{12}$/u;

export { claudeProcessProofMessage, type ClaudeProcessScope, type ClaudeProofOperation } from '@aiur/khala/composition/claude-process-proof';

type Candidate = Readonly<{
  scope: string; key: string; keyId: string; codeDigest: Buffer; expiresAt: number;
}>;
type Approved = Readonly<{ scope: string; key: string; keyId: string; expiresAt: number }>;
type Challenge = Readonly<{ scope: string; keyId: string; expiresAt: number }>;

const digest = (value: string): Buffer => createHash('sha256').update(value).digest();
const scopeKey = (scope: ClaudeProcessScope): string => JSON.stringify([
  scope.harness, scope.sessionId, scope.bindingId, scope.generation, scope.ownerId,
  scope.agentParticipantId, scope.deviceId,
]);
const canonical = (value: string, bytes: number): boolean => {
  const decoded = Buffer.from(value, 'base64url');
  return decoded.length === bytes && decoded.toString('base64url') === value;
};

/** All authority is launcher-local. A restart, Stop, or key replacement drops it. */
export function createClaudeProcessProof(clock: () => number = Date.now) {
  const candidates = new Map<string, Candidate>();
  const approved = new Map<string, Approved>();
  const challenges = new Map<string, Challenge>();

  function prune(): void {
    for (const [id, candidate] of candidates) if (candidate.expiresAt <= clock()) candidates.delete(id);
    for (const [nonce, challenge] of challenges) if (challenge.expiresAt <= clock()) challenges.delete(nonce);
    for (const [scope, key] of approved) if (key.expiresAt <= clock()) approved.delete(scope);
  }

  function begin(scope: ClaudeProcessScope, publicKey: string) {
    prune();
    if (candidates.size >= MAX_PENDING) return null;
    if (scope.harness !== 'claude' || !KEY.test(publicKey) || !canonical(publicKey, 32)) return null;
    try { createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: publicKey }, format: 'jwk' }); }
    catch { return null; }
    const candidateId = randomBytes(24).toString('base64url');
    const code = randomBytes(9).toString('base64url');
    const keyId = digest(`khala.claude.process-key.v1\0${publicKey}`).toString('base64url');
    candidates.set(candidateId, { scope: scopeKey(scope), key: publicKey, keyId,
      codeDigest: digest(code), expiresAt: clock() + CANDIDATE_MS });
    return { candidateId, code, keyId };
  }

  function approve(scope: ClaudeProcessScope, candidateId: string, code: string): boolean {
    const candidate = candidates.get(candidateId);
    if (candidate === undefined || candidate.expiresAt <= clock() || candidate.scope !== scopeKey(scope)
      || !CODE.test(code) || !timingSafeEqual(candidate.codeDigest, digest(code))) return false;
    candidates.delete(candidateId);
    approved.set(candidate.scope, { scope: candidate.scope, key: candidate.key, keyId: candidate.keyId,
      expiresAt: clock() + APPROVED_IDLE_MS });
    for (const [nonce, challenge] of challenges) {
      if (challenge.scope === candidate.scope) challenges.delete(nonce);
    }
    return true;
  }

  function challenge(scope: ClaudeProcessScope, keyId: string): string | null {
    prune();
    if (challenges.size >= MAX_CHALLENGES) return null;
    const current = approved.get(scopeKey(scope));
    if (current?.keyId !== keyId) return null;
    approved.set(current.scope, { ...current, expiresAt: clock() + APPROVED_IDLE_MS });
    const nonce = randomBytes(32).toString('base64url');
    challenges.set(nonce, { scope: current.scope, keyId, expiresAt: clock() + CHALLENGE_MS });
    return nonce;
  }

  function authorize(input: Readonly<{
    scope: ClaudeProcessScope; keyId: string; operation: ClaudeProofOperation;
    bodyHash: string; challenge: string; signature: string;
  }>): boolean {
    const current = approved.get(scopeKey(input.scope));
    const issued = challenges.get(input.challenge);
    if (current?.keyId !== input.keyId || current.expiresAt <= clock()
      || issued?.scope !== current.scope || issued.keyId !== current.keyId
      || issued.expiresAt <= clock() || !KEY.test(input.challenge) || !canonical(input.challenge, 32)
      || !SIGNATURE.test(input.signature) || !canonical(input.signature, 64)
      || !KEY.test(input.bodyHash) || !canonical(input.bodyHash, 32)) return false;
    let valid = false;
    try {
      valid = verify(null, claudeProcessProofMessage(input),
        createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: current.key }, format: 'jwk' }),
        Buffer.from(input.signature, 'base64url'));
    } catch { return false; }
    if (!valid) return false;
    challenges.delete(input.challenge);
    return true;
  }

  function revoke(scope: ClaudeProcessScope): void {
    const key = scopeKey(scope);
    approved.delete(key);
    for (const [id, candidate] of candidates) if (candidate.scope === key) candidates.delete(id);
    for (const [nonce, challenge] of challenges) if (challenge.scope === key) challenges.delete(nonce);
  }

  function clear(): void {
    candidates.clear();
    approved.clear();
    challenges.clear();
  }

  return { begin, approve, challenge, authorize, revoke, clear };
}
