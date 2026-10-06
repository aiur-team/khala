import { describe, expect, it } from 'vitest';
import { HARNESS_REGISTRY } from '@khala/contracts/m1/harness';
import { ADAPTERS, adapterFor, createAdapterRegistry } from './index';
import { CURSOR_DEFAULT_SESSION, cursorSessionId } from '../cursor';
import { resolveHarness, resolveSessionId } from '../mcp/session-id';

describe('harness adapters', () => {
  it('registers the native and generic harnesses, all with metadata', () => {
    expect(ADAPTERS.map(adapter => adapter.id)).toEqual(['claude', 'codex', 'cursor', 'opencode', 'gemini', 'copilot', 'qwen', 'generic']);
    for (const adapter of ADAPTERS) {
      expect(HARNESS_REGISTRY.some(row => row.id === adapter.id)).toBe(true);
      expect(adapterFor(adapter.id)).toBe(adapter);
      if (adapter.id === 'generic') expect(adapter.codec).toBeUndefined();
      else expect(adapter.codec?.parse).toBeTypeOf('function');
      expect(adapter.restoreAtStartup).toBe(!['cursor', 'opencode', 'gemini'].includes(adapter.id));
    }
    expect(adapterFor('gemini')?.id).toBe('gemini');
    expect(adapterFor('toString')).toBeUndefined();
    expect(resolveHarness(['--harness', 'gemini'], {})).toBe('gemini');
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
  it('retains Codex precedence even for invalid string metadata', async () => {
    for (const threadId of ['', '../unsafe', 'a\n']) {
      expect(await resolveSessionId('codex', { threadId }, { CODEX_THREAD_ID: 'valid' })).toBeNull();
    }
    expect(await resolveSessionId('codex', { threadId: 123 }, { CODEX_THREAD_ID: 'valid' })).toBe('valid');
  });
  it('keeps shared Cursor identities non-rejoinable and workspace identities rejoinable', () => {
    expect(adapterFor('cursor')!.sessionSources[0]!.rejoinable(CURSOR_DEFAULT_SESSION)).toBe(false);
    expect(adapterFor('cursor')!.sessionSources[0]!.rejoinable(cursorSessionId('/work/project'))).toBe(true);
    expect(adapterFor('claude')!.sessionSources[0]!.rejoinable('session')).toBe(true);
    expect(adapterFor('codex')!.sessionSources[0]!.rejoinable('session')).toBe(true);
  });
  it('exposes terminal wake guards alongside native wake and watcher capabilities', () => {
    expect(adapterFor('codex')!.wakeLadder?.map(driver => driver.rung)).toEqual([1, 4]);
    expect(adapterFor('codex')!.wakeWarningName).toBe('codex');
    expect(adapterFor('claude')!.wakeLadder?.map(driver => driver.rung)).toEqual([2, 4]);
    for (const id of ['claude', 'codex']) {
      expect(adapterFor(id)!.emptyPrompt?.cursorColumn).toBe(2);
    }
    expect(adapterFor('cursor')!.emptyPrompt).toBeUndefined();
    expect(adapterFor('cursor')!.wakeLadder).toBeUndefined();
    expect(adapterFor('claude')!.watcherStatus).toBe(true);
    expect(adapterFor('claude')!.install).toBeUndefined();
    for (const id of ['codex', 'cursor']) {
      expect(adapterFor(id)!.install).toBeTypeOf('function');
      expect(adapterFor(id)!.uninstall).toBeTypeOf('function');
    }
  });
});
