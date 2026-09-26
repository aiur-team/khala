import { describe, expect, it } from 'vitest';
import { modeExitCode, parseModeArguments, renderModeOutput } from './mode.js';

describe('mode arguments', () => {
  it('parses exactly get and set <mode> --expected-version <n>', () => {
    expect(parseModeArguments(['get'])).toEqual({ action: 'get' });
    expect(parseModeArguments(['set', 'async', '--expected-version', '0'])).toEqual({
      action: 'set', request: { requested: 'async', expectedVersion: 0 },
    });
    expect(parseModeArguments(['set', 'steer', '--expected-version', '42'])).toEqual({
      action: 'set', request: { requested: 'steer', expectedVersion: 42 },
    });
  });

  it('rejects missing, malformed, duplicated, reordered, and target-shaped arguments', () => {
    for (const args of [
      [], ['get', 'extra'], ['get', '--binding', 'binding-2'], ['set'], ['set', 'sync'],
      ['set', 'sync', '--expected-version'], ['set', 'fast', '--expected-version', '1'],
      ['set', 'sync', '--expected-version', '-1'], ['set', 'sync', '--expected-version', '1.5'],
      ['set', 'sync', '--expected-version', '01'], ['set', 'sync', '--expected-version', '1e3'],
      ['set', 'sync', '--expected-version', '9007199254740993'],
      ['set', '--expected-version', '1', 'sync'],
      ['set', 'sync', '--expected-version', '1', '--expected-version', '2'],
      ['set', 'sync', '--expected-version', '1', '--binding', 'binding-2'],
      ['set', 'sync', '--expected-version', '1', '--generation', '0'],
      ['set', 'sync', '--expected-version', '1', '--grant', 'hard_cancel'],
      ['grant', 'hard_cancel'],
    ]) {
      expect(() => parseModeArguments(args), args.join(' ')).toThrow(expect.objectContaining({ code: 'invalid_arguments' }));
    }
  });

  it('renders ok only for view and applied and maps conflict and refusal to the refusal exit code', () => {
    const conflict = {
      kind: 'conflict', reason: 'stale_version',
      current: { requested: 'sync', effective: 'sync', effectiveReason: null, version: 2 },
    } as const;
    const refused = { kind: 'refused', reason: 'binding_revoked' } as const;
    const applied = { kind: 'applied', requested: 'sync', effective: null, effectiveReason: 'sync_unknown', version: 3 } as const;

    expect(JSON.parse(renderModeOutput(applied))).toEqual({ ok: true, ...applied });
    expect(JSON.parse(renderModeOutput(conflict))).toEqual({ ok: false, ...conflict });
    expect(JSON.parse(renderModeOutput(refused))).toEqual({ ok: false, ...refused });
    expect([applied, conflict, refused].map(modeExitCode)).toEqual([0, 3, 3]);
  });
});
