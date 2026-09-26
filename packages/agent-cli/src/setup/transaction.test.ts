import { spawn, spawnSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sha256 } from './filesystem.js';
import { parseManifest, type SetupManifest } from './manifest.js';
import {
  executeSetupPlan, inspectSetupRecovery, setupStatePaths, type ExecutablePlan, type ExecuteOptions, type ExecutionOutcome,
  type SetupRoots, type SetupStatePaths,
} from './transaction.js';
import { bytes, op, plan, removalPlan, snapshot, syntheticHome } from './fixtures/setup-home.js';

let root: string;
let roots: SetupRoots;
let state: SetupStatePaths;

beforeEach(async () => {
  ({ root, roots } = await syntheticHome());
  state = setupStatePaths(roots);
});
afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

const run = (current: ExecutablePlan, options: Partial<ExecuteOptions> = {}) => executeSetupPlan({
  roots, searchPath: '/usr/bin:/bin', confirmedDigest: current.planDigest, replan: async () => current, ...options,
});
const manifest = async (): Promise<SetupManifest | null> => {
  const file = await fsp.readFile(state.manifest).catch(() => null);
  return file === null ? null : parseManifest(new Uint8Array(file));
};
const exists = (target: string) => fsp.lstat(target).then(() => true, () => false);
const read = async (target: string) => new TextDecoder().decode(await fsp.readFile(target));
const mode = async (target: string) => (await fsp.stat(target)).mode & 0o777;
/** Everything outside executor state. */
const userState = () => snapshot(root, { exclude: [path.dirname(state.stateDirectory)] });
const expectNoTransactionLeftovers = async () => {
  expect(await exists(state.journal)).toBe(false);
  expect(await exists(state.lock)).toBe(false);
};

// A three-harness-component install: installer payload + launcher, and a foreign config edit.
const ORIGINAL = bytes('{"user":"original"}\n');
const V1_CONFIG = bytes('{"user":"original","mcp":{"khala":"v1"}}\n');
const V2_CONFIG = bytes('{"user":"original","mcp":{"khala":"v2"}}\n');
const V1_PAYLOAD = bytes('payload v1');
const V2_PAYLOAD = bytes('payload v2');
const V1_LAUNCHER = bytes('#!/bin/sh\nexec v1\n');
const V2_LAUNCHER = bytes('#!/bin/sh\nexec v2\n');
const targets = () => ({
  payload1: path.join(roots.xdgDataHome, 'khala', 'versions', '1', 'khala.js'),
  payload2: path.join(roots.xdgDataHome, 'khala', 'versions', '2', 'khala.js'),
  launcher: path.join(roots.xdgDataHome, 'khala', 'bin', 'khala'),
  config: path.join(roots.home, '.claude', 'settings.json'),
  skill: path.join(roots.home, '.claude', 'skills', 'khala', 'SKILL.md'),
});
const seedConfig = async () => {
  await fsp.mkdir(path.dirname(targets().config), { recursive: true });
  await fsp.writeFile(targets().config, ORIGINAL, { mode: 0o644 });
  await fsp.chmod(targets().config, 0o644);
};
const setupV1 = () => {
  const t = targets();
  return plan('setup', [
    op.create(t.payload1, V1_PAYLOAD, { component: 'payload' }),
    op.create(t.launcher, V1_LAUNCHER, { component: 'launcher' }),
    op.set(t.config, ORIGINAL, V1_CONFIG, { component: 'mcp_entry' }),
    op.create(t.skill, bytes('skill v1'), { component: 'skill' }),
  ], [V1_PAYLOAD, V1_LAUNCHER, V1_CONFIG, bytes('skill v1')]);
};
const upgradeV2 = () => {
  const t = targets();
  return plan('setup', [
    op.delete(t.payload1, sha256(V1_PAYLOAD), { component: 'payload' }),
    op.create(t.payload2, V2_PAYLOAD, { component: 'payload' }),
    op.replace(t.launcher, V1_LAUNCHER, V2_LAUNCHER, { component: 'launcher' }),
    op.set(t.config, V1_CONFIG, V2_CONFIG, { component: 'mcp_entry' }),
  ], [V2_PAYLOAD, V2_LAUNCHER, V2_CONFIG]);
};
const expectKind = <K extends ExecutionOutcome['kind']>(outcome: ExecutionOutcome, kind: K) => {
  expect(outcome.kind).toBe(kind);
  return outcome as Extract<ExecutionOutcome, { kind: K }>;
};

describe('setup transaction', () => {
  it('applies a plan with exact modes, commits the manifest, and a second setup is byte- and mtime-identical', async () => {
    await seedConfig();
    const t = targets();
    const committed = expectKind(await run(setupV1()), 'committed');
    expect(committed.changed).toBe(true);
    expect(committed.operations.map(item => item.status)).toEqual(['applied', 'applied', 'applied', 'applied']);
    expect(await read(t.config)).toBe(new TextDecoder().decode(V1_CONFIG));
    expect(await mode(t.payload1)).toBe(0o400);
    expect(await mode(t.launcher)).toBe(0o500);
    expect(await mode(t.config)).toBe(0o644);
    expect(await mode(path.dirname(t.payload1))).toBe(0o700);
    expect(await mode(state.manifest)).toBe(0o600);
    const recorded = (await manifest())!;
    expect(recorded.entries.map(entry => [entry.path, entry.ownership, entry.baseline.hash])).toEqual([
      [t.config, 'foreign', sha256(ORIGINAL)],
      [t.skill, 'foreign', null],
      [t.payload1, 'installer', null],
      [t.launcher, 'installer', null],
    ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
    await expectNoTransactionLeftovers();

    // The lock briefly touches the state directory entry itself; every file below it and everywhere else is untouched.
    const everything = async () => [await snapshot(root, { mtimes: true, exclude: [state.stateDirectory] }), await snapshot(state.stateDirectory, { mtimes: true })];
    const before = await everything();
    const again = expectKind(await run(plan('setup', [])), 'committed');
    expect(again).toMatchObject({ changed: false, operations: [] });
    expect(await everything()).toEqual(before);
  });

  it('replans under the lock and never applies a stale confirmation', async () => {
    await seedConfig();
    const confirmed = setupV1();
    const before = await userState();
    // The config changed after the person confirmed: the planner now proposes plan B.
    const replacement = plan('setup', [op.create(targets().skill, bytes('b'))], [bytes('b')]);
    const outcome = expectKind(await run(replacement, { confirmedDigest: confirmed.planDigest }), 'replanned');
    expect(outcome.plan.planDigest).toBe(replacement.planDigest);
    expect(await userState()).toEqual(before);
    expect(await exists(state.manifest)).toBe(false);
  });

  it('refuses setup for an unsupported harness before mutation but still removes manifest-matching state', async () => {
    await seedConfig();
    expectKind(await run(setupV1()), 'committed');
    const before = await snapshot(root);
    const refused = expectKind(await run({ ...upgradeV2(), unsupportedHarnesses: ['claude'] }), 'refused');
    expect(refused.state).toBe('unsupported');
    expect(await snapshot(root)).toEqual(before);

    const removal = { ...removalPlan((await manifest())!), unsupportedHarnesses: ['claude' as const] };
    expectKind(await run(removal), 'committed');
    expect(await read(targets().config)).toBe(new TextDecoder().decode(ORIGINAL));
  });

  it('upgrade retains the original pre-Khala baseline so removal restores the user bytes, not v1', async () => {
    await seedConfig();
    const t = targets();
    const pristine = await userState();
    expectKind(await run(setupV1()), 'committed');
    expectKind(await run(upgradeV2()), 'committed');
    const upgraded = (await manifest())!;
    const config = upgraded.entries.find(entry => entry.path === t.config)!;
    expect(config.postimage).toBe(sha256(V2_CONFIG));
    // Wrong-implementation killer: the baseline must still be the original, not the v1 postimage.
    expect(config.baseline.hash).toBe(sha256(ORIGINAL));

    // A remover that restores the v1 managed postimage is refused outright.
    const wrong = plan('remove', [op.restore(t.config, sha256(V2_CONFIG), sha256(V1_CONFIG))]);
    expect(expectKind(await run(wrong), 'refused').diagnostics[0]!.code).toBe('baseline_mismatch');

    expectKind(await run(removalPlan(upgraded)), 'committed');
    expect(await read(t.config)).toBe(new TextDecoder().decode(ORIGINAL));
    expect(await mode(t.config)).toBe(0o644);
    expect(await exists(state.manifest)).toBe(false);
    expect(await exists(state.backups)).toBe(false);
    // Only the executor state directory remains beyond the user's original tree.
    expect(await userState()).toEqual(pristine);
    expect(await exists(path.join(roots.xdgDataHome, 'khala'))).toBe(false);
  });

  it('drift in one managed path refuses the whole removal and touches nothing', async () => {
    await seedConfig();
    const t = targets();
    expectKind(await run(setupV1()), 'committed');
    const removal = removalPlan((await manifest())!);
    await fsp.writeFile(t.skill, 'user edited the skill');
    const before = await snapshot(root);
    const refused = expectKind(await run(removal), 'refused');
    expect(refused.state).toBe('drifted');
    expect(await snapshot(root)).toEqual(before);
    expect(await read(t.config)).toBe(new TextDecoder().decode(V1_CONFIG));
  });

  it('refuses unowned targets, including a byte-identical Khala-named installer file', async () => {
    const t = targets();
    await fsp.mkdir(path.dirname(t.launcher), { recursive: true });
    await fsp.writeFile(t.launcher, V1_LAUNCHER);
    const create = expectKind(await run(plan('setup', [op.create(t.launcher, V1_LAUNCHER, { component: 'launcher' })], [V1_LAUNCHER])), 'refused');
    expect(create).toMatchObject({ state: 'conflict', diagnostics: [{ code: 'unowned_target' }] });
    await seedConfig();
    const remove = expectKind(await run(plan('remove', [op.delete(t.config, sha256(ORIGINAL))])), 'refused');
    expect(remove).toMatchObject({ state: 'conflict', diagnostics: [{ code: 'unowned_target' }] });
    expect(await read(t.config)).toBe(new TextDecoder().decode(ORIGINAL));
  });

  it('rolls back every applied operation when a later target changes between planning and apply', async () => {
    await seedConfig();
    const t = targets();
    const pristine = await userState();
    const outcome = expectKind(await run(setupV1(), {
      boundary: async name => {
        if (name !== 'recorded:2') return;
        await fsp.mkdir(path.dirname(t.skill), { recursive: true });
        await fsp.writeFile(t.skill, 'appeared after planning');
      },
    }), 'rolled_back');
    expect(outcome.operations.map(item => item.status)).toEqual(['rolled_back', 'rolled_back', 'rolled_back', 'rolled_back']);
    expect(outcome.diagnostics[0]).toMatchObject({ code: 'precondition_failed' });
    // The new bytes are preserved; everything Khala wrote is undone.
    expect(await read(t.skill)).toBe('appeared after planning');
    await fsp.rm(path.dirname(path.dirname(t.skill)), { recursive: true });
    expect(await userState()).toEqual(pristine);
    expect(await exists(state.manifest)).toBe(false);
    expect(await exists(state.backups)).toBe(false);
    await expectNoTransactionLeftovers();
  });

  const boundaries = (count: number) => [
    'prepared',
    ...Array.from({ length: count }, (_, index) => [`applying:${index}`, `applied:${index}`, `recorded:${index}`]).flat(),
    'committed',
  ];

  it.each(boundaries(4))('a failure at %s rolls back to the exact preimage', async boundary => {
    await seedConfig();
    const pristine = await userState();
    const outcome = await run(setupV1(), {
      boundary: name => {
        if (name === boundary) throw new Error('injected');
      },
    });
    expect(outcome.kind).toBe('rolled_back');
    expect(await userState()).toEqual(pristine);
    expect(await exists(state.manifest)).toBe(false);
    expect(await exists(state.backups)).toBe(false);
    await expectNoTransactionLeftovers();
  });

  it.each(['manifest_published', 'journal_removed'])('a failure at %s after commit is finalized by the next command', async boundary => {
    await seedConfig();
    const outcome = await run(setupV1(), {
      boundary: name => {
        if (name === boundary) throw new Error('injected');
      },
    });
    expect(outcome.kind).toBe('recovery_required');
    expectKind(await run(plan('setup', [])), 'committed');
    expect((await manifest())!.entries).toHaveLength(4);
    expect(await read(targets().config)).toBe(new TextDecoder().decode(V1_CONFIG));
    await expectNoTransactionLeftovers();
  });

  it('records rollback_failed when a rollback cannot be proven, preserving the user bytes', async () => {
    await seedConfig();
    const t = targets();
    const outcome = expectKind(await run(setupV1(), {
      boundary: async name => {
        if (name !== 'recorded:3') return;
        await fsp.writeFile(t.config, 'user edit mid-transaction');
        throw new Error('injected');
      },
    }), 'recovery_required');
    expect(outcome.operations.map(item => item.status)).toEqual(['rolled_back', 'rolled_back', 'rollback_failed', 'rolled_back']);
    expect(await read(t.config)).toBe('user edit mid-transaction');
    expect(await inspectSetupRecovery(roots)).toBe('recovery_required');
    // Every later command retries the bounded recovery and keeps refusing until it can be proven.
    expectKind(await run(plan('setup', [])), 'recovery_required');
    await fsp.writeFile(t.config, V1_CONFIG);
    expectKind(await run(plan('setup', [])), 'committed');
    expect(await read(t.config)).toBe(new TextDecoder().decode(ORIGINAL));
    expect(await inspectSetupRecovery(roots)).toBe('clean');
  });

  it('refuses a corrupt journal and a newer journal schema without touching anything', async () => {
    await seedConfig();
    await fsp.mkdir(state.stateDirectory, { recursive: true });
    await fsp.writeFile(state.journal, '{"v":1,"id":"not-a-uuid"');
    const before = await userState();
    expect(await inspectSetupRecovery(roots)).toBe('recovery_required');
    expect(expectKind(await run(setupV1()), 'recovery_required').diagnostics[0]!.code).toBe('journal_corrupt');
    await fsp.writeFile(state.journal, JSON.stringify({ v: 2 }));
    expect(await inspectSetupRecovery(roots)).toBe('unsupported');
    expect(expectKind(await run(setupV1()), 'refused').state).toBe('unsupported');
    expect(await userState()).toEqual(before);
    expect(await exists(state.journal)).toBe(true);
  });

  it('refuses a newer manifest schema', async () => {
    await fsp.mkdir(state.stateDirectory, { recursive: true });
    await fsp.writeFile(state.manifest, JSON.stringify({ v: 2 }));
    expect(expectKind(await run(setupV1()), 'refused').diagnostics[0]!.code).toBe('manifest_unsupported');
  });

  it('refuses symlinked targets up front and a symlink swapped in mid-apply', async () => {
    await seedConfig();
    const t = targets();
    const outside = path.join(root, 'outside');
    await fsp.mkdir(outside);
    await fsp.writeFile(path.join(outside, 'SKILL.md'), 'outside');
    await fsp.mkdir(path.join(roots.home, '.claude', 'skills'), { recursive: true });
    await fsp.symlink(outside, path.join(roots.home, '.claude', 'skills', 'khala'));
    const upfront = expectKind(await run(setupV1()), 'refused');
    expect(upfront.diagnostics[0]!.code).toBe('unsafe_path');
    await fsp.rm(path.join(roots.home, '.claude', 'skills', 'khala'));

    // Swap the config for a symlink to an outside file after the preconditions passed.
    const outcome = expectKind(await run(setupV1(), {
      boundary: async name => {
        if (name !== 'recorded:1') return;
        await fsp.rename(t.config, path.join(outside, 'moved.json'));
        await fsp.symlink(path.join(outside, 'moved.json'), t.config);
      },
    }), 'recovery_required');
    expect(outcome.operations[2]!.status).toBe('rollback_failed');
    expect(await read(path.join(outside, 'moved.json'))).toBe(new TextDecoder().decode(ORIGINAL));
    expect(await read(path.join(outside, 'SKILL.md'))).toBe('outside');
    expect(await exists(targets().payload1)).toBe(false);
  });

  it('returns a stable busy result while another live process holds the lock and reclaims a dead holder', async () => {
    await fsp.mkdir(state.stateDirectory, { recursive: true });
    const holder = spawn('sleep', ['30']);
    try {
      await fsp.writeFile(state.lock, JSON.stringify({ pid: holder.pid }));
      const busy = expectKind(await run(setupV1()), 'busy');
      expect(busy.diagnostics).toEqual([expect.objectContaining({ code: 'setup_busy' })]);
      expect(await exists(targets().payload1)).toBe(false);
    } finally {
      holder.kill('SIGKILL');
    }
    await new Promise(resolve => holder.once('exit', resolve));
    await seedConfig();
    expectKind(await run(setupV1()), 'committed');
    await expectNoTransactionLeftovers();
  });

  it('lets exactly one of two competing transactions mutate', async () => {
    await seedConfig();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const first = run(setupV1(), { boundary: name => (name === 'prepared' ? gate : undefined) });
    await new Promise(resolve => setTimeout(resolve, 50));
    const second = await run(setupV1());
    release();
    expect(second.kind).toBe('busy');
    expect((await first).kind).toBe('committed');
  });

  it('snapshots and reverses vendor command writes confined to declared paths', async () => {
    await seedConfig();
    const t = targets();
    const registry = path.join(roots.home, '.claude', 'plugins', 'installed.json');
    const calls: unknown[] = [];
    const runner = async (executable: string, args: readonly string[], env: Readonly<Record<string, string>>) => {
      calls.push({ executable, args, env });
      await fsp.mkdir(path.dirname(registry), { recursive: true });
      await fsp.writeFile(registry, '{"khala":true}');
    };
    const vendor = plan('setup', [
      op.vendor('/usr/bin/claude', [registry], { component: 'plugin' }),
      op.create(t.skill, bytes('skill'), {}),
    ], [bytes('skill')]);
    const outcome = await run(vendor, {
      runVendorCommand: runner,
      boundary: name => {
        if (name === 'recorded:1') throw new Error('injected');
      },
    });
    expect(outcome.kind).toBe('rolled_back');
    expect(calls).toEqual([{ executable: '/usr/bin/claude', args: ['plugin', 'install'], env: {
      HOME: roots.home, XDG_CONFIG_HOME: roots.xdgConfigHome, XDG_DATA_HOME: roots.xdgDataHome,
      XDG_STATE_HOME: roots.xdgStateHome, PATH: '/usr/bin:/bin',
    } }]);
    expect(await exists(registry)).toBe(false);
    expect(await exists(path.join(roots.home, '.claude', 'plugins'))).toBe(false);

    expectKind(await run(vendor, { runVendorCommand: runner }), 'committed');
    expect((await manifest())!.entries.find(entry => entry.path === registry)).toMatchObject({
      component: 'plugin', postimage: sha256(bytes('{"khala":true}')), baseline: { hash: null },
    });
  });
});

describe('setup transaction crash recovery', () => {
  const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
  const child = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'crash-child.ts');
  const crash = (current: ExecutablePlan, killAt: string) => spawnSync(process.execPath, [
    '--conditions=khala-source', '--import', 'tsx', child,
    JSON.stringify({ roots, killAt, plan: { ...current, contents: [...current.contents].map(([key, value]) => [key, Buffer.from(value).toString('base64')]) } }),
  ], { cwd: repository, encoding: 'utf8' });
  const recoverOnly = () => run(plan('setup', []), { confirmedDigest: `sha256:${'f'.repeat(64)}` });

  it.each([
    ...['prepared', 'applying:0', 'applied:0', 'recorded:0', 'applying:2', 'applied:2', 'recorded:3'].map(at => [at, 'rolled back'] as const),
    ...['committed', 'manifest_published', 'journal_removed'].map(at => [at, 'committed'] as const),
  ])('SIGKILL at %s recovers deterministically to the %s state', async (killAt, expected) => {
    await seedConfig();
    const pristine = await userState();
    const result = crash(setupV1(), killAt);
    expect(result.signal).toBe('SIGKILL');
    expect(await exists(state.lock)).toBe(true);

    expect(expectKind(await recoverOnly(), 'replanned').plan.operations).toEqual([]);
    const recovered = await userState();
    if (expected === 'rolled back') {
      expect(recovered).toEqual(pristine);
      expect(await exists(state.manifest)).toBe(false);
      expect(await exists(state.backups)).toBe(false);
    } else {
      expect(await read(targets().config)).toBe(new TextDecoder().decode(V1_CONFIG));
      expect((await manifest())!.entries).toHaveLength(4);
    }
    await expectNoTransactionLeftovers();
    // Recovery is idempotent: a second pass changes nothing.
    await recoverOnly();
    expect(await userState()).toEqual(recovered);
  }, 20_000);
});
