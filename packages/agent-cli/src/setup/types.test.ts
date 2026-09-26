/* eslint-disable @typescript-eslint/no-explicit-any -- tests mutate decoded JSON to build invalid inputs */
import { describe, expect, it } from 'vitest';
import { AGENT_ROUTES } from '../cli/types.js';
import {
  COMPONENT_STATES, HARNESS_IDS, SETUP_COMMANDS, SETUP_EXIT_CODES, SETUP_OPERATION_TYPES, SETUP_STATES,
  SetupSchemaError, decodeSetupResult, setupExitCode, type SetupResult,
} from './types.js';

const digest = (char: string) => `sha256:${char.repeat(64)}`;
const clone = <T>(value: T): T => structuredClone(value);

const harness = {
  harness: 'codex',
  executable: { present: true, path: '/usr/bin/codex' },
  version: { detected: '0.154.0', supported: true },
  components: [{ component: 'hooks', state: 'awaiting_hook_review' }],
  route: 'native_cli_queue',
};
const operation = { id: 'op1', harness: 'codex', component: 'skill', path: '/home/u/.codex/skills/khala/SKILL.md', status: 'planned' };
const valid = {
  v: 1, command: 'setup', ok: false, changed: false, state: 'confirmation_required', planDigest: digest('a'),
  confirmation: {
    required: true, confirmed: false, command: 'setup', harnesses: ['codex'],
    actions: [{ harness: 'codex', component: 'skill', action: 'create' }],
    paths: ['/home/u/.codex/skills/khala/SKILL.md'], backup: 'Foreign files are backed up byte-for-byte.',
    sessionEffect: 'restart_required', fallbackRoute: 'khala send', planDigest: digest('a'),
    request: 'Approve installing Khala for Codex?',
  },
  harnesses: [harness],
  operations: [{ ...operation, type: 'file_create', postimage: digest('b') }],
  diagnostics: [{ code: 'hooks_pending', severity: 'warning', harness: 'codex', component: 'hooks', message: 'Review hooks.' }],
};

const rejects = (value: unknown, path?: string) => {
  try { decodeSetupResult(value); } catch (error) {
    expect(error).toBeInstanceOf(SetupSchemaError);
    if (path !== undefined) expect((error as SetupSchemaError).path).toBe(path);
    return;
  }
  throw new Error('expected decode to fail');
};

describe('frozen vocabulary', () => {
  it('is frozen and matches the documented sets', () => {
    for (const set of [SETUP_COMMANDS, HARNESS_IDS, COMPONENT_STATES, SETUP_STATES, SETUP_OPERATION_TYPES, SETUP_EXIT_CODES]) {
      expect(Object.isFrozen(set)).toBe(true);
    }
    expect(SETUP_COMMANDS).toEqual(['setup', 'remove', 'status']);
    expect(COMPONENT_STATES).toEqual(['absent', 'ready', 'awaiting_hook_review', 'drifted', 'conflict', 'unsupported']);
    expect(SETUP_EXIT_CODES).toEqual({ ok: 0, invalid: 2, refused: 3, indeterminate: 4, confirmationRequired: 5 });
    expect(SETUP_OPERATION_TYPES).toEqual([
      'file_create', 'file_replace', 'file_delete', 'file_restore', 'config_entry_set', 'config_entry_remove', 'vendor_command',
    ]);
  });
});

describe('setupExitCode', () => {
  const bareAndCheck: Record<string, [number, number]> = {
    no_harness: [0, 0], ready: [0, 0], awaiting_hook_review: [0, 3], configured_restart_required: [0, 3],
    configured_effect_unknown: [0, 3], drifted: [0, 3], conflict: [0, 3], unsupported: [0, 3], recovery_required: [0, 4],
  };
  it.each(Object.entries(bareAndCheck))('status %s → bare/--check', (state, [bare, check]) => {
    expect(setupExitCode('status', state as never)).toBe(bare);
    expect(setupExitCode('status', state as never, { check: true })).toBe(check);
  });

  it('gives confirmation_required exit 5 for every command and refusals exit 3 for mutations', () => {
    for (const command of SETUP_COMMANDS) expect(setupExitCode(command, 'confirmation_required')).toBe(5);
    for (const command of ['setup', 'remove'] as const) {
      expect(setupExitCode(command, 'ready')).toBe(0);
      expect(setupExitCode(command, 'no_harness')).toBe(0);
      expect(setupExitCode(command, 'configured_restart_required')).toBe(0);
      expect(setupExitCode(command, 'conflict')).toBe(3);
      expect(setupExitCode(command, 'drifted')).toBe(3);
      expect(setupExitCode(command, 'unsupported')).toBe(3);
      expect(setupExitCode(command, 'recovery_required')).toBe(4);
    }
  });

  it('covers every state', () => {
    for (const state of SETUP_STATES) expect([0, 3, 4, 5]).toContain(setupExitCode('setup', state));
  });
});

describe('decodeSetupResult', () => {
  it('accepts the confirmation-required plan and returns an equal value', () => {
    expect(decodeSetupResult(clone(valid))).toEqual(valid);
  });

  it('accepts an empty ready result without confirmation', () => {
    const ready = { ...clone(valid), state: 'ready', ok: true, planDigest: null,
      confirmation: { required: false, confirmed: false }, operations: [], diagnostics: [] };
    expect(decodeSetupResult(ready)).toEqual(ready satisfies unknown as SetupResult);
  });

  it('accepts every agent route, including the OpenCode plugin and native hooks', () => {
    for (const route of AGENT_ROUTES) {
      const result = clone(valid) as any;
      result.harnesses[0].route = route;
      expect(decodeSetupResult(result).harnesses[0]!.route).toBe(route);
    }
    expect(AGENT_ROUTES).toContain('opencode_plugin');
  });

  it('accepts every operation type', () => {
    const operations = [
      { ...operation, type: 'file_create', postimage: digest('1') },
      { ...operation, type: 'file_replace', preimage: digest('1'), postimage: digest('2') },
      { ...operation, type: 'file_delete', preimage: digest('1') },
      { ...operation, type: 'file_restore', current: digest('1'), restored: null },
      { ...operation, type: 'config_entry_set', entry: 'mcp.khala', preimage: null, postimage: digest('2') },
      { ...operation, type: 'config_entry_remove', entry: 'mcp.khala', preimage: digest('1'), postimage: digest('2') },
      { ...operation, type: 'vendor_command', executable: '/usr/bin/claude', args: ['plugin', 'add'], writablePaths: ['/home/u/.claude'] },
    ];
    expect(new Set(operations.map(entry => entry.type))).toEqual(new Set(SETUP_OPERATION_TYPES));
    expect(decodeSetupResult({ ...clone(valid), operations }).operations).toEqual(operations);
  });

  it('rejects unknown keys at every level', () => {
    const at = (mutate: (value: any) => void, path: string) => { const v = clone(valid); mutate(v); rejects(v, path); };
    at(v => { v.extra = 1; }, '$.extra');
    at(v => { v.confirmation.contents = 'secret'; }, '$.confirmation.contents');
    at(v => { v.harnesses[0].token = 't'; }, '$.harnesses[0].token');
    at(v => { v.harnesses[0].executable.env = {}; }, '$.harnesses[0].executable.env');
    at(v => { v.operations[0].contents = 'bytes'; }, '$.operations[0].contents');
    at(v => { v.diagnostics[0].detail = 'x'; }, '$.diagnostics[0].detail');
  });

  it('rejects missing required fields', () => {
    for (const key of Object.keys(valid)) {
      const v: any = clone(valid); delete v[key]; rejects(v, `$.${key}`);
    }
  });

  it('rejects out-of-vocabulary and mistyped values', () => {
    const at = (mutate: (value: any) => void, path: string) => { const v = clone(valid); mutate(v); rejects(v, path); };
    at(v => { v.v = 2; }, '$.v');
    at(v => { v.command = 'install'; }, '$.command');
    at(v => { v.state = 'done'; }, '$.state');
    at(v => { v.ok = 'yes'; }, '$.ok');
    at(v => { v.harnesses[0].harness = 'cursor'; }, '$.harnesses[0].harness');
    at(v => { v.harnesses[0].components[0].state = 'installed'; }, '$.harnesses[0].components[0].state');
    at(v => { v.harnesses[0].route = 'magic'; }, '$.harnesses[0].route');
    at(v => { v.operations[0].type = 'shell'; }, '$.operations[0].type');
    at(v => { v.operations[0].status = 'done'; }, '$.operations[0].status');
    at(v => { v.diagnostics[0].severity = 'fatal'; }, '$.diagnostics[0].severity');
    at(v => { v.confirmation.sessionEffect = 'maybe'; }, '$.confirmation.sessionEffect');
  });

  it('rejects malformed digests and non-absolute vendor executables', () => {
    for (const bad of ['a'.repeat(64), 'sha256:ABC', `sha256:${'a'.repeat(63)}`, `sha1:${'a'.repeat(64)}`, 5, null]) {
      const v: any = clone(valid); v.operations[0].postimage = bad; rejects(v, '$.operations[0].postimage');
    }
    const v: any = clone(valid);
    v.operations = [{ ...operation, type: 'vendor_command', executable: 'claude', args: [], writablePaths: [] }];
    rejects(v, '$.operations[0].executable');
  });

  it('binds a confirmation request to the exact plan and state', () => {
    const mismatched: any = clone(valid); mismatched.confirmation.planDigest = digest('c');
    rejects(mismatched, '$.confirmation.planDigest');
    const wrongState: any = clone(valid); wrongState.state = 'ready';
    rejects(wrongState, '$.confirmation.required');
    const unconfirmed: any = clone(valid); unconfirmed.confirmation = { required: false, confirmed: false };
    rejects(unconfirmed, '$.confirmation.required');
    const confirmed: any = clone(valid); confirmed.confirmation.confirmed = true;
    rejects(confirmed, '$.confirmation.confirmed');
    const extra: any = clone(valid);
    extra.state = 'ready'; extra.confirmation = { required: false, confirmed: false, planDigest: digest('a') };
    rejects(extra, '$.confirmation.planDigest');
  });

  it('rejects non-object roots, arrays, and non-plain objects', () => {
    for (const bad of [null, undefined, 'x', 1, [], [valid], new Map(), Object.create({ v: 1 })]) rejects(bad);
  });
});
