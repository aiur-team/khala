import { describe, expect, it } from 'vitest';
import { HARNESS_REGISTRY } from '@khala/contracts/m1/harness';
import { ADAPTERS, adapterFor, createAdapterRegistry } from './index';
import { CURSOR_DEFAULT_SESSION, cursorSessionId } from '../cursor';
import { resolveHarness, resolveSessionId } from '../mcp/session-id';

describe('harness adapters', () => {
  it('registers only the three existing harnesses, all with metadata', () => {
    expect(ADAPTERS.map(adapter => adapter.id)).toEqual(['claude', 'codex', 'cursor']);
    for (const adapter of ADAPTERS) {
      expect(HARNESS_REGISTRY.some(row => row.id === adapter.id)).toBe(true);
      expect(adapterFor(adapter.id)).toBe(adapter);
      expect(adapter.codec).toBeUndefined();
    }
    expect(adapterFor('gemini')).toBeUndefined();
    expect(adapterFor('toString')).toBeUndefined();
    expect(resolveHarness(['--harness', 'gemini'], {})).toBe('invalid');
  });
  it('fails loudly on duplicate or unregistered ids', () => {
    const claude = adapterFor('claude')!;
    expect(() => createAdapterRegistry([claude, claude])).toThrow('duplicate_adapter: claude');
    expect(() => createAdapterRegistry([{ ...claude, id: 'missing' }])).toThrow('unregistered_adapter: missing');
  });
  it('copies the registry input so later array mutations cannot replace entries', () => {
    const claude = adapterFor('claude')!;
    const entries = [claude];
    const registry = createAdapterRegistry(entries);
    entries.length = 0;
    expect(registry.resolve('claude')).toBe(claude);
  });
  it('retains Codex precedence even for invalid string metadata', () => {
    for (const threadId of ['', '../unsafe', 'a\n']) {
      expect(resolveSessionId('codex', { threadId }, { CODEX_THREAD_ID: 'valid' })).toBeNull();
    }
    expect(resolveSessionId('codex', { threadId: 123 }, { CODEX_THREAD_ID: 'valid' })).toBe('valid');
  });
  it('keeps shared Cursor identities non-rejoinable and workspace identities rejoinable', () => {
    expect(adapterFor('cursor')!.rejoinable(CURSOR_DEFAULT_SESSION)).toBe(false);
    expect(adapterFor('cursor')!.rejoinable(cursorSessionId('/work/project'))).toBe(true);
    expect(adapterFor('claude')!.rejoinable('session')).toBe(true);
    expect(adapterFor('codex')!.rejoinable('session')).toBe(true);
  });
  it('exposes only the existing waker, watcher and installer capabilities', () => {
    expect(adapterFor('codex')!.waker).toBeTypeOf('function');
    expect(adapterFor('claude')!.waker).toBeUndefined();
    expect(adapterFor('cursor')!.waker).toBeUndefined();
    expect(adapterFor('claude')!.watcherStatus).toBe(true);
    expect(adapterFor('claude')!.install).toBeUndefined();
    for (const id of ['codex', 'cursor']) {
      expect(adapterFor(id)!.install).toBeTypeOf('function');
      expect(adapterFor(id)!.uninstall).toBeTypeOf('function');
    }
  });
});
