import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createProofSigner, type SessionInspectionPort } from '@khala/connector/bootstrap/index';
import { createProofKeyCandidateClient } from './proof-key-candidate.js';

const origin = 'https://khala.aiur.team';
const target = `${origin}/join/inv_abcdefgh`;

describe('native proof-key candidate client', () => {
  it('keeps two local agent labels and keys distinct for the same channel and operation', async () => {
    const seen: Array<{ sessionId: string; publicKey: string; operationId: string; target: string }> = [];
    const transport: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/challenge')) {
        return Response.json({ kind: 'issued', nonce: 'N'.repeat(43) });
      }
      const body = JSON.parse(String(init?.body)) as { sessionId: string; operationId: string; target: string };
      const proof = String(new Headers(init?.headers).get('dpop'));
      const header = JSON.parse(Buffer.from(proof.split('.')[0]!, 'base64url').toString()) as { jwk: { x: string } };
      seen.push({ sessionId: body.sessionId, publicKey: header.jwk.x, operationId: body.operationId, target: body.target });
      return Response.json({ kind: 'pending_owner', operationId: body.operationId,
        candidateId: 'A'.repeat(43), approveUrl: `${origin}/api/human/channel-discovery/authority/approve?candidate=${'A'.repeat(43)}` },
      { status: 202 });
    };
    for (const [harness, sessionId] of [['codex', 'thread-one'], ['claude', 'session-two']] as const) {
      const signer = createProofSigner(generateKeyPairSync('ed25519').privateKey);
      const sessions = { async inspect() { return { kind: 'verified', session: { harness, sessionId, generation: 0 },
        capabilities: {} }; } } as unknown as SessionInspectionPort;
      const client = createProofKeyCandidateClient({ signer, sessions, origin, fetch: transport });
      expect(await client({ target, operationId: 'same-operation', session: { harness, sessionId, workdir: '/workspace' } }))
        .toMatchObject({ kind: 'pending_owner' });
    }
    expect(seen).toMatchObject([
      { sessionId: 'thread-one', operationId: 'same-operation', target },
      { sessionId: 'session-two', operationId: 'same-operation', target },
    ]);
    expect(seen[0]!.publicKey).not.toBe(seen[1]!.publicKey);
  });
});
