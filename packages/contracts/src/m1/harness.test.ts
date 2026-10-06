import { describe, expect, it } from 'vitest';
import { validateAgentName } from '../messaging/agent-names';
import { AGENT_NAME_MAX, checkName } from './names';
import { HARNESS_ID, HARNESS_REGISTRY, LEGACY_HARNESSES, harnessInfo, isHarnessId } from './harness';

describe('harness ids', () => {
  it.each(['opencode', 'copilot-x', 'ab', 'a'.repeat(24)])('accepts %s', id => {
    expect(isHarnessId(id)).toBe(true);
  });
  it.each(['A', 'x', '9abc', '-ab', 'a'.repeat(25), 'a/../b', 'ab\n', '', null, 42])('rejects %s', id => {
    expect(isHarnessId(id)).toBe(false);
  });
  it('keeps the legacy ids independent of the open registry', () => {
    expect(LEGACY_HARNESSES).toEqual(['claude', 'codex', 'cursor']);
  });
});

describe('harness registry', () => {
  it('contains the eleven planned rows with unique valid ids', () => {
    const ids = HARNESS_REGISTRY.map(row => row.id);
    expect(ids).toEqual(['claude', 'codex', 'cursor', 'opencode', 'copilot', 'vscode', 'gemini', 'antigravity', 'qwen', 'muse', 'generic']);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(HARNESS_ID.test(id)).toBe(true);
  });
  it('returns the registered Gemini row', () => {
    expect(harnessInfo('gemini')).toEqual({ id: 'gemini', displayName: 'Gemini CLI', modelName: 'Gemini', logoKey: 'gemini',
      steer: true, sync: true, idleWake: 'opt-in', registered: true });
  });
  it.each(['antigravity', 'generic'])('starts %s with capabilities off', id => {
    expect(harnessInfo(id)).toMatchObject({ steer: false, sync: false, idleWake: 'none', registered: true });
  });
  it('falls back safely for unregistered ids, including object property names', () => {
    expect(harnessInfo('cline')).toEqual({ id: 'cline', displayName: 'Cline', registered: false, modelName: 'Agent',
      logoKey: null, steer: false, sync: false, idleWake: 'none' });
    expect(harnessInfo('copilot-x').displayName).toBe('Copilot X');
    expect(harnessInfo('constructor').registered).toBe(false);
  });
  it('fits every generated agent name into the existing limit', () => {
    for (const row of HARNESS_REGISTRY) {
      expect(row.modelName.length).toBeLessThanOrEqual(12);
      const name = `${'a'.repeat(24)}-${row.modelName}-99`;
      expect(name.length).toBeLessThanOrEqual(AGENT_NAME_MAX);
      expect(validateAgentName(name)).toEqual({ ok: true, name });
      expect(checkName(name, 'agent')).toEqual({ ok: true, name });
    }
  });
});
