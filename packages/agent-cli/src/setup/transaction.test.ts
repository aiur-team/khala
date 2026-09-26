import { spawn, spawnSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sha256 } from './filesystem.js';
import { currentBootId, processStartTime } from './lock-identity.js';
import { parseManifest, type SetupManifest } from './manifest.js';
import {
  executeSetupPlan, inspectSetupRecovery, setupStatePaths, type ExecutablePlan, type ExecuteOptions, type ExecutionOutcome,
  type SetupRoots, type SetupStatePaths,
} from './transaction.js';
import { bytes, op, plan, removalPlan, snapshot, syntheticHome } from './fixtures/setup-home.js';
import type { SetupOperation } from './types.js';

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

  it('applies setup for the supported harnesses while another detected harness is unsupported', async () => {
    await seedConfig();
    expectKind(await run({ ...setupV1(), unsupportedHarnesses: ['opencode'] }), 'committed');
    expect((await manifest())!.entries.every(entry => entry.harness === 'claude')).toBe(true);
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
    // Even a plan that never touches the drifted path refuses: the whole harness is checked first.
    const partial = plan('remove', removal.operations.filter(item => item.path !== t.skill));
    expect(expectKind(await run(partial), 'refused').state).toBe('drifted');
    expect(await snapshot(root)).toEqual(before);
  });

  it('keeps baseline backups when a rollback happens while the manifest is unreadable', async () => {
    await seedConfig();
    expectKind(await run(setupV1()), 'committed');
    const committed = await fsp.readFile(state.manifest);
    const baseline = (await manifest())!.entries.find(entry => entry.path === targets().config)!.baseline;
    const outcome = await run(upgradeV2(), {
      boundary: async name => {
        if (name !== 'recorded:1') return;
        await fsp.writeFile(state.manifest, 'garbage');
        throw new Error('injected');
      },
    });
    expect(outcome.kind).toBe('rolled_back');
    expect(await fsp.readFile(path.join(state.backups, ...baseline.backup!.split('/')))).toEqual(Buffer.from(ORIGINAL));
    await fsp.writeFile(state.manifest, committed);
    expectKind(await run(removalPlan((await manifest())!)), 'committed');
    expect(await read(targets().config)).toBe(new TextDecoder().decode(ORIGINAL));
  });

  it('config_entry_remove that leaves other Khala content keeps the path managed with its original baseline', async () => {
    await seedConfig();
    const t = targets();
    expectKind(await run(setupV1()), 'committed');
    const trimmed = bytes('{"user":"original","mcp":{}}\n');
    const removeEntry: SetupOperation = {
      id: 'remove-entry', harness: 'claude', component: 'mcp_entry', path: t.config, type: 'config_entry_remove',
      entry: 'mcp.khala', preimage: sha256(V1_CONFIG), postimage: sha256(trimmed),
    };
    expectKind(await run(plan('setup', [removeEntry], [trimmed])), 'committed');
    const entry = (await manifest())!.entries.find(item => item.path === t.config)!;
    expect(entry).toMatchObject({ postimage: sha256(trimmed), baseline: { hash: sha256(ORIGINAL) } });
    expectKind(await run(removalPlan((await manifest())!)), 'committed');
    expect(await read(t.config)).toBe(new TextDecoder().decode(ORIGINAL));
  });

  it('an entry-owned file tolerates harness rewrites, and config_entry_remove releases it', async () => {
    await seedConfig();
    const t = targets();
    const owned = { ...plan('setup', [op.set(t.config, ORIGINAL, V1_CONFIG, { component: 'mcp_entry' }), op.create(t.skill, bytes('s'))], [V1_CONFIG, bytes('s')]),
      entryOwnedPaths: [t.config] };
    expectKind(await run(owned), 'committed');
    expect((await manifest())!.entries.find(item => item.path === t.config)).toMatchObject({ entry: 'mcp.khala' });

    // The harness appends its own record; that is not drift, and other managed paths still work.
    const harness = bytes('{"user":"original","mcp":{"khala":"v1"}}\n{"trust":1}\n');
    await fsp.writeFile(t.config, harness);
    expectKind(await run(plan('setup', [op.replace(t.skill, bytes('s'), bytes('s2'))], [bytes('s2')])), 'committed');

    // A whole-file operation or a different entry on that path is refused before any write.
    const before = await userState();
    const restore = expectKind(await run(plan('remove', [op.restore(t.config, sha256(harness), sha256(ORIGINAL), { component: 'mcp_entry' })])), 'refused');
    expect(restore.diagnostics[0]!.code).toBe('invalid_plan');
    const other: SetupOperation = {
      id: 'other-entry', harness: 'claude', component: 'hooks', path: t.config, type: 'config_entry_set',
      entry: 'hooks.other', preimage: sha256(harness), postimage: sha256(bytes('x')),
    };
    expectKind(await run(plan('setup', [other], [bytes('x')])), 'refused');
    expect(await userState()).toEqual(before);

    const kept = bytes('{"user":"original"}\n{"trust":1}\n');
    const removeEntry: SetupOperation = {
      id: 'remove-entry', harness: 'claude', component: 'mcp_entry', path: t.config, type: 'config_entry_remove',
      entry: 'mcp.khala', preimage: sha256(harness), postimage: sha256(kept),
    };
    expectKind(await run(plan('remove', [removeEntry, op.delete(t.skill, sha256(bytes('s2')))], [kept])), 'committed');
    expect(await read(t.config)).toBe(new TextDecoder().decode(kept));
    expect(await exists(state.manifest)).toBe(false);
    expect(await exists(path.dirname(t.skill))).toBe(false);
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
    // Past `journal_removed` only unreferenced backups remain, which the next command collects.
    const next = await run(plan('setup', []));
    if (boundary === 'journal_removed') expectKind(next, 'committed');
    else expect(expectKind(next, 'recovered').resolution).toBe('finalized');
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
    expect(expectKind(await run(plan('setup', [])), 'recovered').resolution).toBe('rolled_back');
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

  const reusedPid: Array<[string, (identity: { pid: number | undefined; bootId: string | null; startTime: string | null }) => object, 'committed' | 'busy']> = [
    ['a different boot id', identity => ({ ...identity, bootId: 'some-previous-boot' }), 'committed'],
    ['a different process start time', identity => ({ ...identity, startTime: 'not-the-start-time' }), 'committed'],
    ['a matching identity is a live holder', identity => identity, 'busy'],
  ];
  it.each(reusedPid)('lock held by a live pid with %s', async (_name, record, expected) => {
    await fsp.mkdir(state.stateDirectory, { recursive: true });
    const holder = spawn('sleep', ['30']);
    try {
      const identity = { pid: holder.pid, bootId: currentBootId(), startTime: processStartTime(holder.pid!) };
      await fsp.writeFile(state.lock, JSON.stringify(record(identity)));
      await seedConfig();
      expectKind(await run(setupV1()), expected);
      if (expected === 'committed') await expectNoTransactionLeftovers();
    } finally {
      holder.kill('SIGKILL');
    }
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
  // The replan stands for the planner's recovery plan, whose digest the person approved.
  const recoverOnly = () => run(plan('setup', []));

  it.each([
    ...['prepared', 'applying:0', 'applied:0', 'recorded:0', 'applying:2', 'applied:2', 'recorded:3'].map(at => [at, 'rolled back'] as const),
    ...['committed', 'manifest_published', 'journal_removed'].map(at => [at, 'committed'] as const),
  ])('SIGKILL at %s recovers deterministically to the %s state', async (killAt, expected) => {
    await seedConfig();
    const pristine = await userState();
    const result = crash(setupV1(), killAt);
    expect(result.signal).toBe('SIGKILL');
    expect(await exists(state.lock)).toBe(true);

    const outcome = await recoverOnly();
    if (killAt === 'journal_removed') expectKind(outcome, 'committed');
    else expect(expectKind(outcome, 'recovered').resolution).toBe(expected === 'rolled back' ? 'rolled_back' : 'finalized');
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
    expectKind(await recoverOnly(), 'committed');
    expect(await userState()).toEqual(recovered);
  }, 20_000);

  it('recovers nothing unless the confirmed digest is the recovery plan for this journal (wrong-implementation killer)', async () => {
    await seedConfig();
    const result = crash(setupV1(), 'recorded:0');
    expect(result.signal).toBe('SIGKILL');
    const journal = await fsp.readFile(state.journal);
    const touched = await userState();
    const recovery = plan('setup', []);
    // The original setup's digest, or any other approval, only gets the recovery plan back.
    for (const confirmedDigest of [setupV1().planDigest, `sha256:${'f'.repeat(64)}` as const]) {
      expect(expectKind(await run(recovery, { confirmedDigest }), 'replanned').plan.planDigest).toBe(recovery.planDigest);
    }
    expect(await fsp.readFile(state.journal)).toEqual(journal);
    expect(await userState()).toEqual(touched);
    expectKind(await run(recovery), 'recovered');
    expect(await exists(state.journal)).toBe(false);
  }, 20_000);

  it('recovery deletes the temporaries a killed write left, and nothing else', async () => {
    await seedConfig();
    const pristine = await userState();
    expect(crash(setupV1(), 'applying:2').signal).toBe('SIGKILL');
    const temporary = (directory: string) => path.join(directory, `.khala-${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}.tmp`);
    const beside = temporary(path.dirname(targets().config));
    const user = path.join(path.dirname(targets().config), '.khala-mine.tmp');
    for (const file of [beside, temporary(state.stateDirectory), user]) await fsp.writeFile(file, 'partial');
    expectKind(await recoverOnly(), 'recovered');
    expect(await exists(beside)).toBe(false);
    expect(await exists(temporary(state.stateDirectory))).toBe(false);
    await fsp.rm(user);
    expect(await userState()).toEqual(pristine);
  }, 20_000);

  it('a crash inside a vendor command cannot be attributed later, so recovery preserves the path', async () => {
    const registry = path.join(roots.home, '.claude', 'plugins.json');
    await fsp.mkdir(path.dirname(registry), { recursive: true });
    // The vendor command writes its file, then kills the executor before the postimage is journaled.
    const script = `printf vendor > '${registry}'; kill -9 $PPID`;
    const vendor = plan('setup', [op.vendor('/bin/sh', [registry], { component: 'plugin' }, ['-c', script])]);
    expect(crash(vendor, 'never').signal).toBe('SIGKILL');
    await fsp.writeFile(registry, 'user edited later');
    const outcome = expectKind(await recoverOnly(), 'recovery_required');
    expect(outcome.operations[0]!.status).toBe('rollback_failed');
    expect(await read(registry)).toBe('user edited later');
  }, 20_000);
});
