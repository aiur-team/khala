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

const SCOPE = { principalId: 'principal-a', bindingId: 'binding-1' as BindingId };
const token = (value: string, generation = 1) => ({ generation, token: value });
const keep = (value: unknown = null) => ({ value, committed: [], retain: null });
const deliver = (value: string, generation = 1) => ({ value: null, committed: [], retain: token(value, generation) });

describe('durable Claude session state port', () => {
  it('keeps retained tokens across a server restart until a call reports them committed', async () => {
    const directory = root();
    const before = await openClaudeSessionState(directory);
    await before.envelope(SCOPE, async () => deliver('durable-token'));

    const after = await openClaudeSessionState(directory);
    const seen: Array<readonly unknown[]> = [];
    await after.envelope(SCOPE, async retained => { seen.push(retained); return keep(); });
    await after.envelope(SCOPE, async retained => { seen.push(retained); return { value: null, committed: retained, retain: null }; });
    await after.envelope(SCOPE, async retained => { seen.push(retained); return keep(); });
    expect(seen).toEqual([[token('durable-token')], [token('durable-token')], []]);
    expect(fs.readdirSync(directory)).toEqual([]);
  });

  it('keeps every token when the call fails, so the next agent call carries them again', async () => {
    const state = await openClaudeSessionState(root());
    await state.envelope(SCOPE, async () => deliver('kept'));
    await expect(state.envelope(SCOPE, async () => { throw new Error('call failed'); })).rejects.toThrow('call failed');
    const seen: Array<readonly unknown[]> = [];
    await state.envelope(SCOPE, async retained => { seen.push(retained); return keep(); });
    expect(seen).toEqual([[token('kept')]]);
  });

  it('holds one token per generation: a delivery replaces its own generation only', async () => {
    const state = await openClaudeSessionState(root());
    await state.envelope(SCOPE, async () => deliver('g1-a', 1));
    await state.envelope(SCOPE, async () => deliver('g2', 2));
    await state.envelope(SCOPE, async () => deliver('g1-b', 1));
    let seen: readonly unknown[] = [];
    await state.envelope(SCOPE, async retained => { seen = retained; return keep(); });
    expect(seen).toEqual([token('g1-b', 1), token('g2', 2)]);
  });

  it('returns a completed call’s result even when its token cannot be persisted', async () => {
    const directory = root();
    const state = await openClaudeSessionState(directory);
    fs.chmodSync(directory, 0o500);
    try {
      await expect(state.envelope(SCOPE, async () => ({ ...deliver('unpersisted'), value: 'accepted' }))).resolves.toBe('accepted');
    } finally {
      fs.chmodSync(directory, 0o700);
    }
    await state.envelope(SCOPE, async retained => { expect(retained).toEqual([]); return keep(); });
  });

  it('linearizes concurrent calls so each sees the previous call’s token', async () => {
    const state = await openClaudeSessionState(root());
    const seen: Array<readonly unknown[]> = [];
    await Promise.all(['t1', 't2', 't3', 't4'].map(next => state.envelope(SCOPE, async retained => {
      seen.push(retained);
      await new Promise(resolve => setTimeout(resolve, 5));
      return deliver(next);
    })));
    expect(seen).toEqual([[], [token('t1')], [token('t2')], [token('t3')]]);
  });

  it('isolates principal and binding, and stores owner-only files', async () => {
    const directory = root();
    const state = await openClaudeSessionState(directory);
    await state.envelope(SCOPE, async () => deliver('scoped'));
    for (const other of [{ ...SCOPE, principalId: 'principal-b' }, { ...SCOPE, bindingId: 'binding-2' as BindingId }]) {
      await state.envelope(other, async retained => { expect(retained).toEqual([]); return keep(); });
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
    await state.envelope(SCOPE, async () => deliver('mine'));
    const [file] = fs.readdirSync(directory);
    const record = JSON.parse(fs.readFileSync(path.join(directory, file!), 'utf8'));
    fs.writeFileSync(path.join(directory, file!), JSON.stringify({ ...record, principalId: 'principal-b' }), { mode: 0o600 });
    await state.envelope(SCOPE, async retained => { expect(retained).toEqual([]); return keep(); });
  });
});
