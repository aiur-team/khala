import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AgentRoute } from '../cli/types.js';
import { createDiscoveryOnlyAdapter } from './detect.js';
import {
  createSetupService, setupResultExitCode, type SetupExecute, type SetupPayloadSource, type SetupService,
} from './plan.js';
import type { ExecutablePlan, ExecutionOutcome } from './transaction.js';
import {
  HARNESS_IDS, decodeSetupResult,
  type ComponentState, type HarnessId, type SetupAdapter, type SetupComponent, type SetupEnvironment,
  type SetupOperation, type SetupProbe, type SetupResult, type Sha256Digest,
} from './types.js';

const SECRET = 'sentinel-secret-7f3a';
const HOME = '/home/alice';
const sha = (bytes: Uint8Array | string): Sha256Digest => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

type World = { files: Map<string, string>; executables: Map<string, string>; versions: Map<string, string> };

function world(): World {
  return { files: new Map(), executables: new Map(), versions: new Map() };
}

function probe(state: World, reads: string[] = []): SetupProbe {
  return {
    async resolveExecutable(name) { return state.executables.get(name) ?? null; },
    async runVersion(executable) {
      const output = state.versions.get(executable);
      if (output === undefined) throw new Error(`probe failed ${SECRET}`);
      return output;
    },
    async readFile(path) { reads.push(path); const text = state.files.get(path); return text === undefined ? null : Buffer.from(text); },
    async listDirectory() { return null; },
  };
}

function environment(state: World): SetupEnvironment {
  return {
    home: HOME, xdgConfigHome: `${HOME}/.config`, xdgDataHome: `${HOME}/.local/share`,
    xdgStateHome: `${HOME}/.local/state`, probe: probe(state),
  };
}

type FakeAdapterOptions = {
  supported?: boolean;
  components?: readonly { component: SetupComponent; state: ComponentState }[];
  route?: AgentRoute;
  /** Present-state operations beyond the config edit; lets a test reorder adapter output. */
  reverse?: boolean;
};

/**
 * A read-only adapter over the fake world. Setup edits `<harness>.json` and adds a skill file;
 * removal restores the config. Every operation binds the observed config hash.
 */
function fakeAdapter(harness: HarnessId, options: FakeAdapterOptions = {}): SetupAdapter {
  const config = `${HOME}/.${harness}/config.json`;
  const skill = `${HOME}/.${harness}/skills/khala/SKILL.md`;
  let observedConfig: Sha256Digest | null = null;
  return {
    harness,
    async detect(env) {
      const executable = await env.probe.resolveExecutable(harness);
      if (executable === null) return { executable: null, version: null, supported: false };
      return { executable, version: (await env.probe.runVersion(executable, ['--version'])).trim(),
        supported: options.supported ?? true, extra: SECRET } as never;
    },
    async inspect(env, detection) {
      const bytes = await env.probe.readFile(config);
      observedConfig = bytes === null ? null : sha(bytes);
      return {
        detection,
        components: options.components ?? [{ component: 'mcp_entry', state: 'absent' }, { component: 'skill', state: 'absent' }],
        route: options.route ?? 'unknown',
        diagnostics: [{ code: 'observed', severity: 'info', message: 'observed config', leaked: SECRET } as never],
        raw: SECRET,
      } as never;
    },
    plan(request) {
      if (options.components !== undefined) return [];
      const operations: SetupOperation[] = request.desired === 'present'
        ? [
          { id: `${harness}-mcp`, type: 'config_entry_set', harness, component: 'mcp_entry', path: config,
            entry: 'mcp_servers.khala', preimage: observedConfig, postimage: sha(`${observedConfig}+khala`),
            contents: SECRET } as never,
          { id: `${harness}-skill`, type: 'file_create', harness, component: 'skill', path: skill, postimage: sha('skill') },
        ]
        : [{ id: `${harness}-mcp-remove`, type: 'config_entry_remove', harness, component: 'mcp_entry', path: config,
          entry: 'mcp_servers.khala', preimage: observedConfig ?? sha('none'), postimage: sha('restored') }];
      return options.reverse ? operations.reverse() : operations;
    },
  };
}

function install(state: World, harness: HarnessId, version = '1.2.3') {
  state.executables.set(harness, `/usr/bin/${harness}`);
  state.versions.set(`/usr/bin/${harness}`, `${version}\n`);
  state.files.set(`${HOME}/.${harness}/config.json`, `{"token":"${SECRET}"}`);
}

type Request = Parameters<SetupExecute>[0];

/**
 * A fake executor that honours the real contract: it replans and commits only when the fresh
 * digest still equals the confirmed one. `outcome` overrides what it returns after replanning.
 */
function countingExecutor(outcome?: (request: Request, plan: ExecutablePlan) => ExecutionOutcome | Promise<ExecutionOutcome>) {
  const executor = {
    calls: 0,
    plans: [] as ExecutablePlan[],
    execute: (async request => {
      executor.calls += 1;
      const plan = await request.replan();
      executor.plans.push(plan);
      if (outcome !== undefined) return outcome(request, plan);
      if (plan.planDigest !== request.confirmedDigest) return { kind: 'replanned', plan };
      return { kind: 'committed', changed: true, plan,
        operations: plan.operations.map(operation => ({ ...operation, status: 'applied' as const })) };
    }) as SetupExecute,
  };
  return executor;
}

function service(
  state: World, adapters: readonly SetupAdapter[], executor = countingExecutor(), payload?: SetupPayloadSource,
): SetupService {
  return createSetupService({ environment: () => environment(state), adapters, execute: executor.execute,
    ...(payload === undefined ? {} : { payload }) });
}

const allFake = (options: FakeAdapterOptions = {}) => HARNESS_IDS.map(harness => fakeAdapter(harness, options));
const noConfirm = { dryRun: false, confirm: null } as const;

describe('setup planning', () => {
  it('reports every harness absent and plans nothing on an empty machine', async () => {
    const setup = service(world(), allFake());
    const status = await setup.configuration();
    expect(status).toMatchObject({ command: 'status', ok: true, changed: false, state: 'no_harness', planDigest: null,
      confirmation: { required: false, confirmed: false }, harnesses: [], operations: [] });
    for (const command of ['setup', 'remove'] as const) {
      const result = await setup.lifecycle(command, noConfirm);
      expect(result).toMatchObject({ state: 'no_harness', ok: true, operations: [], planDigest: null,
        confirmation: { required: false } });
      expect(setupResultExitCode(result)).toBe(0);
    }
    expect(setupResultExitCode(status, true)).toBe(0);
  });

  it('produces byte-identical plans and digests regardless of adapter or operation order', async () => {
    const state = world();
    install(state, 'codex');
    install(state, 'claude');
    for (const command of ['setup', 'remove'] as const) {
      const first = JSON.stringify(await service(state, allFake()).lifecycle(command, noConfirm));
      const repeat = JSON.stringify(await service(state, allFake()).lifecycle(command, noConfirm));
      const shuffled = JSON.stringify(await service(state, allFake({ reverse: true }).reverse()).lifecycle(command, noConfirm));
      expect(repeat).toBe(first);
      expect(shuffled).toBe(first);
    }
    const setupPlan = await service(state, allFake()).lifecycle('setup', noConfirm);
    const removePlan = await service(state, allFake()).lifecycle('remove', noConfirm);
    expect(setupPlan.planDigest).not.toBe(removePlan.planDigest);
    expect(setupPlan.operations.map(operation => `${operation.harness}/${operation.component}`))
      .toEqual(['claude/skill', 'claude/mcp_entry', 'codex/skill', 'codex/mcp_entry']);
  });

  it('binds the digest to observed facts', async () => {
    const state = world();
    install(state, 'codex');
    const before = await service(state, allFake()).lifecycle('setup', noConfirm);
    state.versions.set('/usr/bin/codex', '1.2.4\n');
    const after = await service(state, allFake()).lifecycle('setup', noConfirm);
    expect(after.planDigest).not.toBe(before.planDigest);
  });

  it('returns a complete relay summary for an unconfirmed or dry-run plan without executing', async () => {
    const state = world();
    install(state, 'codex');
    const executor = countingExecutor();
    const setup = service(state, allFake(), executor);
    const unconfirmed = await setup.lifecycle('setup', noConfirm);
    const dryRun = await setup.lifecycle('setup', { dryRun: true, confirm: null });

    expect(JSON.stringify(dryRun)).toBe(JSON.stringify(unconfirmed));
    expect(decodeSetupResult(JSON.parse(JSON.stringify(unconfirmed)))).toEqual(unconfirmed);
    expect(setupResultExitCode(unconfirmed)).toBe(5);
    expect(unconfirmed).toMatchObject({ ok: false, changed: false, state: 'confirmation_required' });
    expect(unconfirmed.confirmation).toEqual({
      required: true,
      confirmed: false,
      command: 'setup',
      harnesses: ['codex'],
      actions: [
        { harness: 'codex', component: 'skill', action: 'create' },
        { harness: 'codex', component: 'mcp_entry', action: 'configure' },
      ],
      paths: [`${HOME}/.codex/config.json`, `${HOME}/.codex/skills/khala/SKILL.md`],
      backup: expect.stringContaining(`${HOME}/.local/state/khala/setup/backups`),
      sessionEffect: 'unknown',
      fallbackRoute: null,
      planDigest: unconfirmed.planDigest,
      request: expect.stringContaining(`khala setup --confirm ${unconfirmed.planDigest}`),
    });
    expect(executor.calls).toBe(0);
  });

  it('refuses a stale confirmed plan with a replacement plan and no writes', async () => {
    const state = world();
    install(state, 'codex');
    const executor = countingExecutor();
    const setup = service(state, allFake(), executor);
    const planA = await setup.lifecycle('setup', noConfirm);
    expect(planA.planDigest).not.toBeNull();

    // The person approved plan A, then the observed config changed before the confirmed call.
    state.files.set(`${HOME}/.codex/config.json`, '{"edited":true}');
    const filesBefore = new Map(state.files);
    const planB = await setup.lifecycle('setup', { dryRun: false, confirm: planA.planDigest });

    expect(planB.state).toBe('confirmation_required');
    expect(planB.planDigest).not.toBe(planA.planDigest);
    expect(planB.confirmation).toMatchObject({ required: true, confirmed: false, planDigest: planB.planDigest });
    expect(setupResultExitCode(planB)).toBe(5);
    expect(executor.calls).toBe(0);
    expect(state.files).toEqual(filesBefore);
  });

  it('hands the executor the approved digest and a fresh replan when the plan matches', async () => {
    const state = world();
    install(state, 'codex');
    const executor = countingExecutor();
    const setup = service(state, allFake(), executor);
    const planA = await setup.lifecycle('setup', noConfirm);
    const applied = await setup.lifecycle('setup', { dryRun: false, confirm: planA.planDigest });

    expect(executor.calls).toBe(1);
    expect(executor.plans[0]).toMatchObject({ command: 'setup', planDigest: planA.planDigest, unsupportedHarnesses: [] });
    expect(executor.plans[0]!.operations).toEqual(planA.operations.map(({ status: _status, ...operation }) => operation));
    expect(applied).toMatchObject({ changed: true, planDigest: planA.planDigest, confirmation: { required: false, confirmed: true },
      operations: [{ status: 'applied' }, { status: 'applied' }] });
    expect(decodeSetupResult(JSON.parse(JSON.stringify(applied)))).toEqual(applied);
  });

  it('never lets a dry run reach the executor, even with a matching digest', async () => {
    const state = world();
    install(state, 'codex');
    const executor = countingExecutor();
    const setup = service(state, allFake(), executor);
    const planA = await setup.lifecycle('setup', noConfirm);
    const dry = await setup.lifecycle('setup', { dryRun: true, confirm: planA.planDigest });
    expect(dry.state).toBe('confirmation_required');
    expect(executor.calls).toBe(0);
  });

  it('relays the fresh plan with a re-confirm diagnostic when the executor replans under its lock', async () => {
    const state = world();
    install(state, 'codex');
    // The config changes after the CLI preflight but before the executor's replan.
    const executor = countingExecutor(async request => {
      state.files.set(`${HOME}/.codex/config.json`, '{"raced":true}');
      return { kind: 'replanned', plan: await request.replan() };
    });
    const setup = service(state, allFake(), executor);
    const planA = await setup.lifecycle('setup', noConfirm);
    const result = await setup.lifecycle('setup', { dryRun: false, confirm: planA.planDigest });
    expect(result.state).toBe('confirmation_required');
    expect(result.planDigest).not.toBe(planA.planDigest);
    expect(result.diagnostics.map(diagnostic => diagnostic.code)).toContain('plan_changed');
    expect(setupResultExitCode(result)).toBe(5);
  });

  it.each([
    ['a thrown executor error', () => { throw new Error(`lock failed ${SECRET}`); }, 'recovery_required', 4, 'execution_failed'],
    ['a recovery-required outcome', () => ({ kind: 'recovery_required', operations: [],
      diagnostics: [{ code: 'journal_corrupt', severity: 'error', message: 'unknown' }] }), 'recovery_required', 4, 'journal_corrupt'],
    ['a busy lock', () => ({ kind: 'busy', diagnostics: [{ code: 'setup_busy', severity: 'error', message: 'busy' }] }),
      'conflict', 3, 'setup_busy'],
    ['a drift refusal', () => ({ kind: 'refused', state: 'drifted', diagnostics: [{ code: 'drift', severity: 'error', message: 'd' }] }),
      'drifted', 3, 'drift'],
    ['an exact rollback', () => ({ kind: 'rolled_back', operations: [],
      diagnostics: [{ code: 'apply_failed', severity: 'error', message: 'f' }] }), 'conflict', 3, 'apply_failed'],
  ] as const)('maps %s to a structured result', async (_name, outcome, state, exit, code) => {
    const machine = world();
    install(machine, 'codex');
    const setup = service(machine, allFake(), countingExecutor(outcome as never));
    const planA = await setup.lifecycle('setup', noConfirm);
    const result = await setup.lifecycle('setup', { dryRun: false, confirm: planA.planDigest });
    expect(result).toMatchObject({ state, changed: false });
    expect(result.diagnostics.map(diagnostic => diagnostic.code)).toContain(code);
    expect(setupResultExitCode(result)).toBe(exit);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(decodeSetupResult(JSON.parse(JSON.stringify(result)))).toEqual(result);
  });

  it('binds the digest to mode overrides and unsupported harnesses', async () => {
    const state = world();
    install(state, 'codex');
    const withMode = (mode: number): SetupPayloadSource => async () => ({
      contents: new Map(), modes: new Map([[`${HOME}/.local/share/khala/bin/khala`, mode]]) });
    const a = await service(state, allFake(), undefined, withMode(0o500)).lifecycle('remove', noConfirm);
    const b = await service(state, allFake(), undefined, withMode(0o400)).lifecycle('remove', noConfirm);
    expect(a.planDigest).not.toBe(b.planDigest);
    const unsupported = await service(state, allFake({ supported: false })).lifecycle('remove', noConfirm);
    const supported = await service(state, allFake()).lifecycle('remove', noConfirm);
    expect(unsupported.planDigest).not.toBe(supported.planDigest);
    const executor = countingExecutor();
    const setup = service(state, allFake({ supported: false }), executor);
    await setup.lifecycle('remove', { dryRun: false, confirm: unsupported.planDigest });
    expect(executor.plans[0]!.unsupportedHarnesses).toEqual(['codex']);
  });

  it('refuses setup on an unsupported harness but still plans removal', async () => {
    const state = world();
    install(state, 'codex');
    const setup = service(state, allFake({ supported: false }));
    const refused = await setup.lifecycle('setup', noConfirm);
    expect(refused).toMatchObject({ state: 'unsupported', ok: false, operations: [], planDigest: null });
    expect(setupResultExitCode(refused)).toBe(3);
    expect((await setup.lifecycle('remove', noConfirm)).state).toBe('confirmation_required');
  });

  it.each(['drifted', 'conflict'] as const)('refuses setup and removal when a component is %s', async state => {
    const machine = world();
    install(machine, 'codex');
    const setup = service(machine, allFake({ components: [{ component: 'skill', state }] }));
    for (const command of ['setup', 'remove'] as const) {
      const result = await setup.lifecycle(command, noConfirm);
      expect(result).toMatchObject({ state, ok: false, operations: [] });
      expect(setupResultExitCode(result)).toBe(3);
    }
  });

  it('reports recovery required when a transaction journal exists, without reading it into output', async () => {
    const state = world();
    state.files.set(`${HOME}/.local/state/khala/setup/transaction.v1.json`, SECRET);
    const setup = service(state, allFake());
    const status = await setup.configuration();
    expect(status.state).toBe('recovery_required');
    expect(setupResultExitCode(status)).toBe(0);
    expect(setupResultExitCode(status, true)).toBe(4);
    const result = await setup.lifecycle('setup', noConfirm);
    expect(result.state).toBe('recovery_required');
    expect(setupResultExitCode(result)).toBe(4);
    expect(JSON.stringify([status, result])).not.toContain(SECRET);
  });

  it('keeps sentinel secrets out of every public result', async () => {
    const state = world();
    install(state, 'codex');
    install(state, 'claude');
    state.executables.set('opencode', '/usr/bin/opencode'); // version probe throws with the sentinel
    const setup = service(state, [...allFake().slice(0, 2), createDiscoveryOnlyAdapter('opencode')]);
    const outputs = [
      await setup.configuration(),
      await setup.lifecycle('remove', noConfirm),
      await service(state, allFake().slice(0, 2)).lifecycle('setup', noConfirm),
    ];
    for (const output of outputs) {
      expect(JSON.stringify(output)).not.toContain(SECRET);
      expect(decodeSetupResult(JSON.parse(JSON.stringify(output)))).toEqual(output);
    }
  });
});

describe('status truth table', () => {
  const ready = [{ component: 'skill', state: 'ready' }, { component: 'mcp_entry', state: 'ready' }] as const;
  const cases: readonly [string, FakeAdapterOptions, string, boolean, number][] = [
    ['configured and effective', { components: ready, route: 'native_cli_queue' }, 'ready', true, 0],
    ['hooks awaiting native review', { components: [...ready, { component: 'hooks', state: 'awaiting_hook_review' }],
      route: 'native_cli_queue' }, 'awaiting_hook_review', false, 3],
    ['configured, session ineffective', { components: ready, route: 'unavailable' }, 'configured_restart_required', true, 3],
    ['configured, effect unproven', { components: ready, route: 'unknown' }, 'configured_effect_unknown', true, 3],
    ['drifted', { components: [{ component: 'skill', state: 'drifted' }] }, 'drifted', false, 3],
    ['conflict', { components: [{ component: 'skill', state: 'conflict' }] }, 'conflict', false, 3],
    ['unsupported version', { supported: false, components: ready }, 'unsupported', false, 3],
    ['detected but not configured', {}, 'drifted', false, 3],
  ];

  it.each(cases)('%s', async (_name, options, state, ok, checkExit) => {
    const machine = world();
    install(machine, 'codex');
    const status = await service(machine, allFake(options)).configuration();
    expect(status).toMatchObject({ state, ok });
    expect(setupResultExitCode(status)).toBe(0);
    expect(setupResultExitCode(status, true)).toBe(checkExit);
  });

  it('excludes absent harnesses and lets the most severe detected harness win', async () => {
    const machine = world();
    install(machine, 'codex');
    install(machine, 'claude');
    const adapters = [
      fakeAdapter('claude', { components: ready, route: 'native_cli_queue' }),
      fakeAdapter('codex', { components: [...ready, { component: 'hooks', state: 'awaiting_hook_review' }], route: 'native_cli_queue' }),
      fakeAdapter('opencode', { components: [{ component: 'plugin', state: 'conflict' }] }),
    ];
    const status = await service(machine, adapters).configuration();
    expect(status.state).toBe('awaiting_hook_review');
    expect(status.harnesses.map(harness => harness.harness)).toEqual(['claude', 'codex']);
  });

  it('names the CLI fallback only when an installed khala is found', async () => {
    const machine = world();
    install(machine, 'codex');
    const options = { components: ready, route: 'unknown' } as const;
    const without = await service(machine, allFake(options)).configuration();
    expect(without.diagnostics.map(diagnostic => diagnostic.code)).toContain('cli_fallback_unavailable');
    machine.executables.set('khala', '/usr/bin/khala');
    const withFallback = await service(machine, allFake(options)).configuration();
    expect(withFallback.diagnostics.map(diagnostic => diagnostic.code)).toContain('cli_fallback');
    expect(JSON.stringify(withFallback)).not.toMatch(/idle|ready to deliver/i);
  });

  it('reports a detected harness without a real adapter as unsupported', async () => {
    const machine = world();
    install(machine, 'claude');
    const status: SetupResult = await service(machine, HARNESS_IDS.map(createDiscoveryOnlyAdapter)).configuration();
    expect(status.state).toBe('unsupported');
    expect(status.harnesses).toEqual([{ harness: 'claude', executable: { present: true, path: '/usr/bin/claude' },
      version: { detected: '1.2.3', supported: false }, components: [], route: 'unknown' }]);
  });
});
