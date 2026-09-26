import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BindingId } from '@khala/contracts/delivery/index';
import { CliError } from '../cli/errors.js';
import type { InboxBatch } from '../cli/inbox.js';
import {
  OPENCODE_BATCH_READ_BYTES, OPENCODE_ENVELOPE_MAX_BYTES, encodeOpenCodeEnvelope, parseOpenCodeEnvelope,
} from './envelope.js';
import { initialBridgeState, openOpenCodeBridgeStore } from './store.js';

const bindingId = 'binding-oc' as BindingId;
const digest = `sha256:${'a'.repeat(64)}`;

function batch(bodies: readonly string[], token = 'token-1'): InboxBatch {
  return {
    token,
    items: bodies.map((body, index) => ({
      record: {
        v: 1, releaseId: `release-${index + 1}`, bindingId, generation: 3, events: [], payloadDigest: digest,
        payloadBase64: '', receivedAt: '2026-09-25T12:00:00Z',
      },
      payload: new TextEncoder().encode(body),
      nextOffset: index + 1,
    })),
  };
}

describe('OpenCode envelope', () => {
  it('round-trips the token and release IDs through the length-delimited outer structure', () => {
    const encoded = encodeOpenCodeEnvelope(batch(['{"body":"a"}', '{"body":"b"}']));
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    expect(encoded.envelope.text.startsWith('khala-channel-envelope-v1 ')).toBe(true);
    expect(parseOpenCodeEnvelope(encoded.envelope.text)).toEqual({ token: 'token-1', releaseIds: ['release-1', 'release-2'] });
  });

  it('rejects anything that is not exactly one envelope', () => {
    const encoded = encodeOpenCodeEnvelope(batch(['{}']));
    if (!encoded.ok) throw new Error('encode');
    const text = encoded.envelope.text;
    expect(parseOpenCodeEnvelope(`${text} `)).toBeNull();
    expect(parseOpenCodeEnvelope(`quoted: ${text}`)).toBeNull();
    expect(parseOpenCodeEnvelope(text.replace('untrusted', 'trusted!!'))).toBeNull();
    expect(parseOpenCodeEnvelope('khala-channel-envelope-v1 2\n{}')).toBeNull();
  });

  it('keeps every envelope within the shared ceiling and refuses one that would exceed it', () => {
    const worst = encodeOpenCodeEnvelope(batch(Array.from({ length: 8 }, () => '\u0001'.repeat(OPENCODE_BATCH_READ_BYTES / 8))));
    expect(worst.ok).toBe(true);
    const over = encodeOpenCodeEnvelope(batch(['\u0001'.repeat(OPENCODE_BATCH_READ_BYTES * 2)]));
    expect(over).toEqual({ ok: false, code: 'envelope_too_large' });
    expect(OPENCODE_ENVELOPE_MAX_BYTES).toBe(128 * 1024);
  });
});

describe('OpenCode bridge store', () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

  function stateDirectory(): string {
    const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'khala-oc-store-'));
    roots.push(root);
    return path.join(root, 'state');
  }

  it('persists a private per-generation record that a second open reads back', async () => {
    const state = stateDirectory();
    const store = await openOpenCodeBridgeStore({ stateDirectory: state, bindingId, generation: 3 });
    expect(await store.read()).toEqual(initialBridgeState(bindingId, 3));
    const encoded = encodeOpenCodeEnvelope(batch(['{}']));
    if (!encoded.ok) throw new Error('encode');
    const next = {
      ...initialBridgeState(bindingId, 3),
      request: { token: 'token-1', route: 'steer', phase: 'delivered', messageID: null },
      steer: [{ token: 'token-1', anchorMessageID: 'msg_1', envelope: encoded.envelope.text }],
    } as const;
    await store.write(next);
    const reopened = await openOpenCodeBridgeStore({ stateDirectory: state, bindingId, generation: 3 });
    expect(await reopened.read()).toEqual(next);
    const other = await openOpenCodeBridgeStore({ stateDirectory: state, bindingId, generation: 4 });
    expect((await other.read()).request).toBeNull();
    const [file] = fs.readdirSync(path.join(state, 'opencode'));
    expect(fs.statSync(path.join(state, 'opencode', file!)).mode & 0o777).toBe(0o600);
  });

  it('fails closed on a corrupted record', async () => {
    const state = stateDirectory();
    const store = await openOpenCodeBridgeStore({ stateDirectory: state, bindingId, generation: 3 });
    await store.write(initialBridgeState(bindingId, 3));
    const [file] = fs.readdirSync(path.join(state, 'opencode'));
    fs.writeFileSync(path.join(state, 'opencode', file!), '{"v":1}', { mode: 0o600 });
    await expect(store.read()).rejects.toEqual(new CliError('storage_failed'));
  });
});
