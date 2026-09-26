import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readRuntimeDescriptor } from './claude-descriptor.js';

const CREDENTIAL = 'Q'.repeat(43);
const roots: string[] = [];
function file(content: string | null, mode = 0o600): string {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'khala-descriptor-'));
  roots.push(dir);
  const target = path.join(dir, 'active.json');
  if (content !== null) {
    fs.writeFileSync(target, content, { mode });
    fs.chmodSync(target, mode);
  }
  return target;
}
afterEach(() => { for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

const valid = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  v: 1, channelId: 'channel-1', origin: 'http://127.0.0.1:4870', transportCapability: CREDENTIAL, ...overrides,
});

describe('runtime descriptor', () => {
  it('resolves the loopback origin and credential from an owner-only descriptor', async () => {
    await expect(readRuntimeDescriptor(file(valid({ bindingId: 'later-field' })))).resolves.toEqual({
      ok: true, target: { origin: 'http://127.0.0.1:4870', credential: CREDENTIAL },
    });
  });

  it('re-reads on every call so rotation takes effect immediately', async () => {
    const target = file(valid());
    await readRuntimeDescriptor(target);
    fs.writeFileSync(target, valid({ origin: 'http://127.0.0.1:4871', transportCapability: 'R'.repeat(43) }));
    await expect(readRuntimeDescriptor(target)).resolves.toEqual({
      ok: true, target: { origin: 'http://127.0.0.1:4871', credential: 'R'.repeat(43) },
    });
  });

  it.each([
    ['missing', null, 0o600, 'descriptor_missing'],
    ['group-readable', valid(), 0o640, 'descriptor_insecure'],
    ['world-readable', valid(), 0o644, 'descriptor_insecure'],
    ['owner-executable', valid(), 0o700, 'descriptor_insecure'],
    ['not JSON', '{', 0o600, 'descriptor_malformed'],
    ['wrong version', valid({ v: 2 }), 0o600, 'descriptor_malformed'],
    ['non-loopback origin', valid({ origin: 'http://192.168.1.2:4870' }), 0o600, 'descriptor_malformed'],
    ['https origin', valid({ origin: 'https://127.0.0.1:4870' }), 0o600, 'descriptor_malformed'],
    ['origin with path', valid({ origin: 'http://127.0.0.1:4870/x' }), 0o600, 'descriptor_malformed'],
    ['portless origin', valid({ origin: 'http://127.0.0.1' }), 0o600, 'descriptor_malformed'],
    ['short credential', valid({ transportCapability: 'short' }), 0o600, 'descriptor_malformed'],
    ['oversized', valid({ padding: 'x'.repeat(5000) }), 0o600, 'descriptor_malformed'],
  ] as const)('fails closed on a %s descriptor without echoing it', async (_name, content, mode, code) => {
    const target = file(content, mode);
    const result = await readRuntimeDescriptor(target);
    expect(result).toEqual({ ok: false, code });
    expect(JSON.stringify(result)).not.toContain(CREDENTIAL);
    expect(JSON.stringify(result)).not.toContain('4870');
    expect(JSON.stringify(result)).not.toContain(target);
  });

  it('refuses a symlinked descriptor', async () => {
    const real = file(valid());
    const link = path.join(path.dirname(real), 'link.json');
    fs.symlinkSync(real, link);
    await expect(readRuntimeDescriptor(link)).resolves.toEqual({ ok: false, code: 'descriptor_insecure' });
  });

  it('refuses a directory in place of the descriptor', async () => {
    const target = file(null);
    fs.mkdirSync(target, { mode: 0o700 });
    await expect(readRuntimeDescriptor(target)).resolves.toEqual({ ok: false, code: 'descriptor_insecure' });
  });
});
