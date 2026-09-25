import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BindingId } from '@khala/contracts/delivery/index';
import { openClaudeSessionState } from './claude-session-state.js';

const roots: string[] = [];
function root(): string {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'khala-claude-state-'));
  roots.push(dir);
  return path.join(dir, 'state');
}
afterEach(() => { for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

const SCOPE = { principalId: 'principal-a', bindingId: 'binding-1' as BindingId, generation: 1 };

describe('durable Claude session state port', () => {
  it('retains a token across a server restart and attaches it to exactly one next call', async () => {
    const directory = root();
    const before = await openClaudeSessionState(directory);
    await before.envelope(SCOPE, async () => ({ value: null, batchToken: 'durable-token' }));

    const after = await openClaudeSessionState(directory);
    const seen: Array<string | undefined> = [];
    await after.envelope(SCOPE, async retained => { seen.push(retained); return { value: null, batchToken: null }; });
    await after.envelope(SCOPE, async retained => { seen.push(retained); return { value: null, batchToken: null }; });
    expect(seen).toEqual(['durable-token', undefined]);
  });

  it('consumes the token even when the call fails, and never replays it', async () => {
    const state = await openClaudeSessionState(root());
    await state.envelope(SCOPE, async () => ({ value: null, batchToken: 'once' }));
    await expect(state.envelope(SCOPE, async () => { throw new Error('call failed'); })).rejects.toThrow('call failed');
    const seen: Array<string | undefined> = [];
    await state.envelope(SCOPE, async retained => { seen.push(retained); return { value: null, batchToken: null }; });
    expect(seen).toEqual([undefined]);
  });

  it('linearizes concurrent calls so each sees the previous call’s token', async () => {
    const state = await openClaudeSessionState(root());
    const seen: Array<string | undefined> = [];
    await Promise.all(['t1', 't2', 't3', 't4'].map(next => state.envelope(SCOPE, async retained => {
      seen.push(retained);
      await new Promise(resolve => setTimeout(resolve, 5));
      return { value: null, batchToken: next };
    })));
    expect(seen).toEqual([undefined, 't1', 't2', 't3']);
  });

  it('isolates principal, binding, and generation, and stores owner-only files', async () => {
    const directory = root();
    const state = await openClaudeSessionState(directory);
    await state.envelope(SCOPE, async () => ({ value: null, batchToken: 'scoped' }));
    for (const other of [
      { ...SCOPE, principalId: 'principal-b' },
      { ...SCOPE, bindingId: 'binding-2' as BindingId },
      { ...SCOPE, generation: 2 },
    ]) {
      await state.envelope(other, async retained => { expect(retained).toBeUndefined(); return { value: null, batchToken: null }; });
    }
    expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
    const files = fs.readdirSync(directory);
    expect(files).toHaveLength(1);
    expect(fs.statSync(path.join(directory, files[0]!)).mode & 0o777).toBe(0o600);
    expect(files[0]).not.toContain('binding-1');
  });

  it('treats a record for another scope as no token', async () => {
    const directory = root();
    const state = await openClaudeSessionState(directory);
    await state.envelope(SCOPE, async () => ({ value: null, batchToken: 'mine' }));
    const [file] = fs.readdirSync(directory);
    const record = JSON.parse(fs.readFileSync(path.join(directory, file!), 'utf8'));
    fs.writeFileSync(path.join(directory, file!), JSON.stringify({ ...record, principalId: 'principal-b' }), { mode: 0o600 });
    await state.envelope(SCOPE, async retained => { expect(retained).toBeUndefined(); return { value: null, batchToken: null }; });
  });
});
