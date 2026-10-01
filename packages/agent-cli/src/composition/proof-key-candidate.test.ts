import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createProofSigner, type SessionInspectionPort } from '@khala/connector/bootstrap/index';
import { createProofKeyCandidateClient } from './proof-key-candidate.js';

const origin = 'https://khala.aiur.team';
const target = `${origin}/join/inv_abcdefgh`;

describe('native proof-key candidate client', () => {
  it('reports only a fixed stage and HTTP status when the approved-candidate retry fails', async () => {
    const signer = createProofSigner(generateKeyPairSync('ed25519').privateKey);
    const sessions = { async inspect() { return { kind: 'verified',
      session: { harness: 'claude', sessionId: 'private-session', generation: 0 }, capabilities: {} }; } } as unknown as SessionInspectionPort;
    const events: unknown[] = [];
    const paths: string[] = [];
    const client = createProofKeyCandidateClient({ signer, sessions, origin,
      diagnostic: event => events.push(event),
      fetch: (async input => {
        const pathname = new URL(String(input)).pathname;
        paths.push(pathname);
        return pathname.endsWith('/challenge')
          ? Response.json({ kind: 'issued', nonce: 'N'.repeat(43) })
          : Response.json({ kind: 'unavailable' }, { status: 503 });
      }) as typeof fetch,
    });
    expect(await client({ target, operationId: 'same-operation',
      session: { harness: 'claude', sessionId: 'private-session', workdir: '/workspace' } }))
      .toEqual({ kind: 'unavailable' });
    expect(paths).toEqual(['/api/agent/channel-discovery/authority/challenge',
      '/api/agent/channel-discovery/authority/candidate']);
    expect(events).toEqual([{ stage: 'candidate', result: 'unavailable', httpStatus: 503 }]);
    expect(JSON.stringify(events)).not.toContain('private-session');
    expect(JSON.stringify(events)).not.toContain('inv_abcdefgh');
  });

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
      const openBrowser = vi.fn(async () => undefined);
      const options = { signer, sessions, origin, fetch: transport, openBrowser };
      const client = createProofKeyCandidateClient(options);
      expect(await client({ target, operationId: 'same-operation', session: { harness, sessionId, workdir: '/workspace' } }))
        .toMatchObject({ kind: 'pending_owner', candidateId: 'A'.repeat(43) });
      expect(openBrowser).not.toHaveBeenCalled();
    }
    expect(seen).toMatchObject([
      { sessionId: 'thread-one', operationId: 'same-operation', target },
      { sessionId: 'session-two', operationId: 'same-operation', target },
    ]);
    expect(seen[0]!.publicKey).not.toBe(seen[1]!.publicKey);
  });
});
