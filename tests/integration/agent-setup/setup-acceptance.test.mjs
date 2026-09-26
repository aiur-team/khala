// Release acceptance for `npx @aiur/khala setup|status|remove`, run black-box against the
// packed tarball installed outside this repository. Unit coverage and exhaustive per-mutation
// fault injection live beside the setup modules; this suite proves the packaged flow end to
// end across mixed harness states. See README.md in this directory.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  SUPPORTED, approveCodexHooksNatively, confirmed, createMachine, filesBelow, holdProbe, harnessCalls,
  installHarness, installTarball, khala, khalaAsync, machineEnvironment, packedTarball, removeHarness, removeScratch,
  repackAtVersion, repositoryRoot, sha256, snapshot, writeDescriptor,
} from './harness.mjs';

const ALL = { claude: SUPPORTED.claude, codex: SUPPORTED.codex, opencode: SUPPORTED.opencode };
const USER_SECRET = `sk-user-${randomBytes(12).toString('hex')}`;

// Unrelated user configuration each harness already has. Formatting a parse-and-reserialize
// would destroy, plus a secret that must never reach any output.
const SEEDS = {
  '.claude/settings.json': '{\n  "theme": "dark",\n  "env": { "ANTHROPIC_API_KEY": "' + USER_SECRET + '" }\n}\n',
  '.codex/config.toml': `model = "o3"\n\n[mcp_servers.github]\ncommand = "gh-mcp"\nenv = { GITHUB_TOKEN = "${USER_SECRET}" }\n`,
  '.config/opencode/opencode.json': [
    '// my OpenCode config', '{', '\t/* keep */ "model":   "deepseek/deepseek-flash",',
    `\t"mcp": { "github": {"type": "remote", "url": "https://example.test/mcp", "headers": {"Authorization": "Bearer ${USER_SECRET}"}}, },`,
    '}', '',
  ].join('\r\n'),
};

function seed(machine, files = SEEDS) {
  for (const [relative, text] of Object.entries(files)) {
    const target = path.join(machine.home, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, text, { mode: 0o600 });
  }
}

// Remove deletes the manifest, journal, backups, and installer tree, but leaves the empty
// `~/.local/state/khala/setup` chain (Executor note on #262). Anything else must match.
const REMOVE_RESIDUE = ['.local', '.local/state', '.local/state/khala', '.local/state/khala/setup'];

function assertRestored(machine, baseline) {
  const now = snapshot(machine.home);
  const changed = [...new Set([...Object.keys(baseline), ...Object.keys(now)])].filter(key => baseline[key] !== now[key]);
  const unexpected = changed.filter(key => !(REMOVE_RESIDUE.includes(key) && baseline[key] === undefined && now[key].startsWith('dir ')));
  assert.deepEqual(unexpected, [], 'remove must restore every pre-Khala byte and absence');
}

const state = result => result.json?.state ?? result.json?.configuration?.state;
const codes = result => (result.json?.diagnostics ?? result.json?.configuration?.diagnostics ?? []).map(entry => entry.code);
const harness = (result, id) => (result.json?.harnesses ?? result.json?.configuration?.harnesses).find(entry => entry.harness === id);

let packed;
let v1;
let v2;

before(() => {
  packed = packedTarball();
  v1 = installTarball(packed.tarball);
  v2 = installTarball(repackAtVersion(packed.tarball, '0.2.0-acceptance.1'));
});

after(() => {
  packed?.cleanup();
  if (!process.env.KHALA_SETUP_KEEP) removeScratch();
});

describe('packaged install', () => {
  test('the tarball installs and runs outside the repository on the pinned Node', t => {
    const repository = fs.realpathSync(repositoryRoot);
    assert.ok(!v1.prefix.startsWith(repository + path.sep), `prefix ${v1.prefix} must be outside ${repository}`);
    const pinned = fs.readFileSync(path.join(repositoryRoot, '.node-version'), 'utf8').trim();
    if (process.env.CI) assert.equal(process.versions.node, pinned, 'CI must run acceptance on the pinned Node');
    else if (process.versions.node !== pinned) t.diagnostic(`local Node ${process.versions.node}; CI pins ${pinned}`);
    const machine = createMachine();
    const status = khala(v1, machine, ['status']);
    assert.equal(status.status, 0, status.stderr);
    assert.equal(status.json.v, 1);
    assert.equal(status.json.connected, false);
  });
});

describe('clean lifecycle', () => {
  test('plan -> confirmed setup -> second setup changes nothing -> check -> confirmed exact remove', () => {
    const machine = createMachine(ALL);
    seed(machine);
    const baseline = snapshot(machine.home);
    const pristine = snapshot(machine.home, { mtimes: true });

    // Deterministic, zero-write planning: the plan, a repeat, and a dry run are the same bytes.
    const plan = khala(v1, machine, ['setup']);
    const repeat = khala(v1, machine, ['setup']);
    const dryRun = khala(v1, machine, ['setup', '--dry-run']);
    assert.equal(plan.status, 5, plan.stderr);
    assert.equal(plan.json.state, 'confirmation_required');
    assert.equal(repeat.stdout, plan.stdout, 'repeated plans must be byte-identical');
    assert.equal(dryRun.status, 5);
    assert.equal(dryRun.stdout, plan.stdout, 'a dry run prints the same plan');
    assert.deepEqual(snapshot(machine.home, { mtimes: true }), pristine, 'planning and dry runs write nothing');

    // The confirmation the agent relays carries everything the person approves.
    const confirmation = plan.json.confirmation;
    assert.equal(confirmation.required, true);
    assert.equal(confirmation.command, 'setup');
    assert.deepEqual(confirmation.harnesses, ['claude', 'codex', 'opencode']);
    assert.ok(confirmation.actions.length > 0);
    for (const relative of Object.keys(SEEDS)) assert.ok(confirmation.paths.includes(path.join(machine.home, relative)), `${relative} is named`);
    assert.match(confirmation.backup, /backups/);
    assert.equal(confirmation.planDigest, plan.json.planDigest);
    assert.ok(confirmation.request.includes(`--confirm ${plan.json.planDigest}`));

    const applied = khala(v1, machine, ['setup', '--confirm', plan.json.planDigest]);
    assert.equal(applied.status, 0, applied.stdout);
    assert.equal(applied.json.changed, true);
    // Codex hooks await the person's review in Codex's own dialog.
    assert.equal(applied.json.state, 'awaiting_hook_review');
    assert.ok(applied.json.operations.every(operation => operation.status === 'applied'));
    const installed = snapshot(machine.home, { mtimes: true });

    const again = khala(v1, machine, ['setup']);
    assert.equal(again.status, 0, again.stdout);
    assert.equal(again.json.changed, false);
    assert.deepEqual(again.json.operations, []);
    assert.equal(again.json.confirmation.required, false);
    assert.deepEqual(snapshot(machine.home, { mtimes: true }), installed, 'a satisfied setup writes nothing');

    const status = khala(v1, machine, ['status']);
    const check = khala(v1, machine, ['status', '--check']);
    assert.equal(status.status, 0, 'bare status is informational');
    assert.equal(check.status, 3, 'hook review is not ready for CI');
    assert.equal(state(check), 'awaiting_hook_review');

    const removed = confirmed(v1, machine, 'remove');
    assert.equal(removed.plan.status, 5);
    assert.equal(removed.plan.json.confirmation.command, 'remove');
    assert.equal(removed.applied.status, 0, removed.applied.stdout);
    assert.equal(removed.applied.json.changed, true);
    assertRestored(machine, baseline);
    assert.equal(khala(v1, machine, ['remove']).json.changed, false, 'a second remove has nothing to do');
  });

  test('after native hook approval the check reports the unproven route, not ready', () => {
    const machine = createMachine(ALL);
    assert.equal(confirmed(v1, machine, 'setup').applied.status, 0);
    const hooks = fs.readFileSync(path.join(machine.home, '.codex', 'hooks.json'));
    const trust = approveCodexHooksNatively(machine);

    // Claude and Codex routes stay `unknown` until a live proof (Executor note on #262).
    const status = khala(v1, machine, ['status']);
    const check = khala(v1, machine, ['status', '--check']);
    assert.equal(status.status, 0);
    assert.equal(state(status), 'configured_effect_unknown');
    assert.equal(status.json.configuration.ok, true);
    assert.equal(check.status, 3);
    assert.equal(harness(status, 'codex').components.find(entry => entry.component === 'hooks').state, 'ready');

    // Approval changes nothing Khala installed; setup stays a no-op.
    const again = khala(v1, machine, ['setup']);
    assert.equal(again.status, 0);
    assert.equal(again.json.changed, false);
    assert.deepEqual(fs.readFileSync(path.join(machine.home, '.codex', 'hooks.json')), hooks);

    // Removal takes Khala's entries out and never touches the person's trust records.
    assert.equal(confirmed(v1, machine, 'remove').applied.status, 0);
    assert.equal(fs.readFileSync(path.join(machine.home, '.codex', 'config.toml'), 'utf8').includes(trust), true);
  });
});

describe('mixed harness states', () => {
  test('no detected harness is a successful no-op that creates nothing', () => {
    const machine = createMachine();
    for (const args of [['setup'], ['remove'], ['status', '--check']]) {
      const result = khala(v1, machine, args);
      assert.equal(result.status, 0, `${args.join(' ')}: ${result.stdout}`);
      assert.equal(state(result), 'no_harness');
    }
    assert.deepEqual(snapshot(machine.home), {});
  });

  test('installed, absent, and unsupported harnesses are reported apart; unsupported refuses before any write', () => {
    const machine = createMachine({ claude: SUPPORTED.claude, codex: 'codex-cli 0.1.0' });
    const pristine = snapshot(machine.home, { mtimes: true });
    const refused = khala(v1, machine, ['setup']);
    assert.equal(refused.status, 3, refused.stdout);
    assert.equal(refused.json.state, 'unsupported');
    assert.equal(refused.json.planDigest, null);
    assert.deepEqual(snapshot(machine.home, { mtimes: true }), pristine);

    assert.deepEqual(harness(refused, 'claude').version, { detected: '2.1.283', supported: true });
    assert.deepEqual(harness(refused, 'codex').executable.present, true);
    assert.deepEqual(harness(refused, 'codex').version, { detected: '0.1.0', supported: false });
    assert.deepEqual(harness(refused, 'opencode')?.executable, { present: false, path: null }, 'absent OpenCode is reported absent');
    assert.equal(khala(v1, machine, ['status', '--check']).status, 3);

    // A version probe that fails is distinct from absence.
    fs.writeFileSync(path.join(machine.bin, 'opencode'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const probed = khala(v1, machine, ['status']);
    assert.equal(harness(probed, 'opencode').executable.present, true);
    assert.equal(harness(probed, 'opencode').version.detected, null);
    removeHarness(machine, 'opencode');

    // Without the unsupported harness, setup configures exactly the supported one.
    removeHarness(machine, 'codex');
    const plan = khala(v1, machine, ['setup']);
    assert.deepEqual(plan.json.confirmation.harnesses, ['claude']);
    const applied = khala(v1, machine, ['setup', '--confirm', plan.json.planDigest]);
    assert.equal(applied.status, 0, applied.stdout);
    assert.equal(applied.json.ok, true);
    assert.equal(applied.json.state, 'configured_effect_unknown');
    for (const absent of ['.codex', '.config/opencode']) assert.equal(fs.existsSync(path.join(machine.home, absent)), false, `${absent} is never created`);
    assert.equal(khala(v1, machine, ['status', '--check']).status, 3);
  });

  test('absent harnesses are reported without creating their config roots', () => {
    const empty = createMachine();
    const none = khala(v1, empty, ['status']);
    assert.equal(none.json.configuration.state, 'no_harness');
    assert.deepEqual(harness(none, 'claude')?.executable, { present: false, path: null }, 'claude is reported absent');

    const machine = createMachine({ claude: SUPPORTED.claude });
    const status = khala(v1, machine, ['status']);
    const plan = khala(v1, machine, ['setup']);
    for (const result of [status, plan]) {
      for (const absent of ['codex', 'opencode']) {
        const report = harness(result, absent);
        assert.deepEqual(report?.executable, { present: false, path: null }, `${absent} is reported absent`);
        assert.equal(report.version.detected, null);
        assert.deepEqual(report.components, [], `absent ${absent} implies no work`);
      }
    }
    assert.deepEqual(plan.json.confirmation.harnesses, ['claude'], 'absent harnesses are never planned');
    assert.deepEqual(snapshot(empty.home), {});
    assert.deepEqual(snapshot(machine.home), {});
  });

  test('an unsupported version blocks upgrade, but manifest-driven removal still restores the baseline', () => {
    const machine = createMachine(ALL);
    seed(machine);
    const baseline = snapshot(machine.home);
    assert.equal(confirmed(v1, machine, 'setup').applied.status, 0);
    installHarness(machine, 'codex', 'codex-cli 9.9.9');
    const installed = snapshot(machine.home, { mtimes: true });

    const refused = khala(v1, machine, ['setup']);
    assert.equal(refused.status, 3);
    assert.equal(refused.json.state, 'unsupported');
    assert.deepEqual(snapshot(machine.home, { mtimes: true }), installed);

    const removed = confirmed(v1, machine, 'remove');
    assert.equal(removed.applied?.status, 0, removed.plan.stdout);
    assertRestored(machine, baseline);
  });
});

describe('confirmation and drift', () => {
  test('a stale confirmation returns the replacement plan and writes nothing', () => {
    const machine = createMachine(ALL);
    seed(machine);
    const planA = khala(v1, machine, ['setup']);
    fs.writeFileSync(path.join(machine.home, '.claude', 'settings.json'), '{\n  "theme": "light"\n}\n');
    const changed = snapshot(machine.home, { mtimes: true });

    const stale = khala(v1, machine, ['setup', '--confirm', planA.json.planDigest]);
    assert.equal(stale.status, 5, stale.stdout);
    assert.equal(stale.json.state, 'confirmation_required');
    assert.notEqual(stale.json.planDigest, planA.json.planDigest);
    assert.deepEqual(snapshot(machine.home, { mtimes: true }), changed, 'plan A never applies');

    const applied = khala(v1, machine, ['setup', '--confirm', stale.json.planDigest]);
    assert.equal(applied.status, 0, applied.stdout);
  });

  test('drift refuses the whole removal until the managed bytes match again', () => {
    const machine = createMachine(ALL);
    seed(machine);
    const baseline = snapshot(machine.home);
    assert.equal(confirmed(v1, machine, 'setup').applied.status, 0);
    const skill = path.join(machine.home, '.codex', 'skills', 'khala', 'SKILL.md');
    const managed = fs.readFileSync(skill);
    fs.writeFileSync(skill, Buffer.concat([managed, Buffer.from('\nmy edit\n')]));
    const drifted = snapshot(machine.home, { mtimes: true });

    const refused = khala(v1, machine, ['remove']);
    assert.equal(refused.status, 3, refused.stdout);
    assert.equal(refused.json.state, 'drifted');
    assert.equal(refused.json.planDigest, null);
    assert.deepEqual(snapshot(machine.home, { mtimes: true }), drifted, 'no harness is partly removed');

    fs.writeFileSync(skill, managed);
    assert.equal(confirmed(v1, machine, 'remove').applied.status, 0);
    assertRestored(machine, baseline);
  });
});

describe('upgrade', () => {
  test('setup v1 -> upgrade v2 -> remove restores the pre-Khala bytes, not the v1 postimage', () => {
    const machine = createMachine(ALL);
    seed(machine);
    const baseline = snapshot(machine.home);
    assert.equal(confirmed(v1, machine, 'setup').applied.status, 0);
    const settings = path.join(machine.home, '.claude', 'settings.json');
    const v1Settings = fs.readFileSync(settings, 'utf8');

    const upgrade = confirmed(v2, machine, 'setup');
    assert.equal(upgrade.plan.status, 5, 'an upgrade is a confirmed change');
    assert.equal(upgrade.applied.status, 0, upgrade.applied.stdout);
    assert.notEqual(fs.readFileSync(settings, 'utf8'), v1Settings, 'v2 re-points Claude at its own marketplace');
    assert.ok(fs.existsSync(path.join(machine.home, '.local', 'share', 'khala', 'versions', v2.version)));
    assert.equal(khala(v2, machine, ['setup']).json.changed, false);

    assert.equal(confirmed(v2, machine, 'remove').applied.status, 0);
    assertRestored(machine, baseline);
    assert.equal(fs.readFileSync(settings, 'utf8'), SEEDS['.claude/settings.json']);
  });
});

describe('concurrency and interruption', () => {
  // How many `codex --version` probes one planning pass makes, measured rather than assumed.
  function probesPerPlan(machine) {
    const before = harnessCalls(machine, 'codex');
    const plan = khala(v1, machine, ['setup']);
    return { plan, probes: harnessCalls(machine, 'codex') - before };
  }

  test('a second mutation while one holds the lock gets a stable busy result and writes nothing', async () => {
    const machine = createMachine(ALL);
    const { plan, probes } = probesPerPlan(machine);
    // The first pass plans outside the lock; the next probe is the replan under it.
    const hold = holdProbe(machine, 'codex', probes + 1);
    const first = khalaAsync(v1, machine, ['setup', '--confirm', plan.json.planDigest]);
    try {
      await hold.held();
      const during = snapshot(machine.home, { mtimes: true });
      const second = khala(v1, machine, ['setup', '--confirm', plan.json.planDigest]);
      assert.equal(second.status, 3, second.stdout);
      assert.equal(second.json.state, 'conflict');
      assert.ok(codes(second).includes('setup_busy'), codes(second).join());
      assert.deepEqual(snapshot(machine.home, { mtimes: true }), during);
    } finally { hold.release(); }
    const done = await first.done;
    assert.equal(done.status, 0, done.stdout + done.stderr);
    assert.equal(done.json.changed, true);
  });

  test('a setup killed while holding the lock leaves nothing half-done, and the next run reclaims the lock', async () => {
    const machine = createMachine(ALL);
    seed(machine);
    const baseline = snapshot(machine.home);
    const { plan, probes } = probesPerPlan(machine);
    const hold = holdProbe(machine, 'codex', probes + 1);
    const first = khalaAsync(v1, machine, ['setup', '--confirm', plan.json.planDigest]);
    await hold.held();
    first.child.kill('SIGKILL');
    await first.done;
    hold.release();
    assert.ok(fs.existsSync(path.join(machine.home, '.local', 'state', 'khala', 'setup', 'lock')), 'the dead holder left its lock');
    assert.deepEqual(Object.keys(snapshot(machine.home)).filter(key => !key.startsWith('.local')).sort(), Object.keys(baseline).filter(key => !key.startsWith('.local')).sort());

    const retried = confirmed(v1, machine, 'setup');
    assert.equal(retried.applied?.status, 0, retried.plan.stdout);
    assert.equal(retried.applied.json.changed, true);
    assert.equal(confirmed(v1, machine, 'remove').applied.status, 0);
    assertRestored(machine, baseline);
  });

  // SIGKILLs a confirmed setup as soon as its write-ahead journal exists.
  async function killMidTransaction() {
    for (let attempt = 0; attempt < 10; attempt++) {
      const machine = createMachine(ALL);
      seed(machine);
      const baseline = snapshot(machine.home);
      const journal = path.join(machine.home, '.local', 'state', 'khala', 'setup', 'transaction.v1.json');
      const plan = khala(v1, machine, ['setup']);
      const run = khalaAsync(v1, machine, ['setup', '--confirm', plan.json.planDigest]);
      let killed = false;
      while (run.child.exitCode === null && run.child.signalCode === null) {
        if (fs.existsSync(journal)) { run.child.kill('SIGKILL'); killed = true; break; }
        await new Promise(resolve => setImmediate(resolve));
      }
      await run.done;
      if (killed && fs.existsSync(journal)) return { machine, plan, baseline };
    }
    throw new Error('never interrupted a setup mid-transaction in 10 attempts');
  }

  test('a crash mid-transaction leaves no torn file, CI sees exit 4, and nothing recovers unconfirmed', async () => {
    const { machine, plan } = await killMidTransaction();
    for (const operation of plan.json.operations) {
      if (!fs.existsSync(operation.path)) continue;
      const hash = `sha256:${sha256(fs.readFileSync(operation.path))}`;
      const preimage = operation.preimage ?? null;
      assert.ok(hash === operation.postimage || hash === preimage, `${operation.path} is neither its preimage nor its postimage`);
    }
    const frozen = snapshot(machine.home, { mtimes: true });
    const check = khala(v1, machine, ['status', '--check']);
    assert.equal(check.status, 4, check.stdout);
    assert.equal(state(check), 'recovery_required');
    // Every mutating command offers the same kind of relayable recovery plan and recovers
    // nothing, including one confirmed with the interrupted setup's own digest.
    for (const args of [['setup'], ['remove'], ['remove', '--dry-run'], ['setup', '--confirm', plan.json.planDigest]]) {
      const result = khala(v1, machine, args);
      assert.equal(result.status, 5, `${args.join(' ')}: ${result.stdout}`);
      assert.equal(state(result), 'confirmation_required');
      assert.notEqual(result.json.planDigest, plan.json.planDigest);
      assert.ok(result.json.diagnostics.some(item => item.code === 'recovery_available'), result.stdout);
    }
    assert.equal(khala(v1, machine, ['status']).status, 0, 'bare status stays informational');
    assert.deepEqual(snapshot(machine.home, { mtimes: true }), frozen);
  });

  test('a crash mid-transaction is recovered by the next confirmed command', async () => {
    const { machine, baseline } = await killMidTransaction();
    const recovery = khala(v1, machine, ['remove']);
    assert.notEqual(recovery.json.planDigest, null, 'a recovery plan the agent can relay');
    assert.match(recovery.json.confirmation.request, new RegExp(`khala remove --confirm ${recovery.json.planDigest}`));
    let next = khala(v1, machine, ['remove', '--confirm', recovery.json.planDigest]);
    assert.ok(next.json.diagnostics.some(item => item.code === 'recovered'), next.stdout);
    // A kill after the commit point finishes that setup, which then needs its own removal.
    if (next.status === 5) next = khala(v1, machine, ['remove', '--confirm', next.json.planDigest]);
    assert.equal(next.status, 0, next.stdout);
    const status = khala(v1, machine, ['status', '--check']);
    assert.notEqual(status.status, 4, status.stdout);
    assert.ok(!fs.existsSync(path.join(machine.home, '.local', 'state', 'khala', 'setup', 'transaction.v1.json')));
    assertRestored(machine, baseline);
  });
});

describe('runtime descriptor and secrets', () => {
  function sentinelDescriptor(install) {
    // A port whose spelling appears nowhere in the installed package, so a hit is a leak.
    const packageText = filesBelow(path.dirname(path.dirname(install.bin))).map(file => file.bytes.toString('latin1')).join('\n');
    let port;
    do port = 20_000 + Math.floor(Math.random() * 40_000); while (packageText.includes(`:${port}`));
    const token = randomBytes(32).toString('base64url');
    return {
      descriptor: { v: 1, channelId: `ch_${randomBytes(8).toString('hex')}`, origin: `http://127.0.0.1:${port}`, transportCapability: token },
      sentinels: [`127.0.0.1:${port}`, `:${port}`, token],
    };
  }

  test('descriptor port and token never reach config, argv, plan, manifest, backup, or output (wrong-implementation killer)', () => {
    const machine = createMachine(ALL);
    seed(machine);
    const first = sentinelDescriptor(v1);
    const second = sentinelDescriptor(v1);
    const descriptor = writeDescriptor(machine, first.descriptor);
    const outputs = [];
    const run = (install, args) => {
      const result = khala(install, machine, args);
      outputs.push(result.stdout, result.stderr);
      return result;
    };
    const confirm = (install, command) => {
      const plan = run(install, [command]);
      run(install, [command, '--dry-run']);
      return plan.status === 5 ? run(install, [command, '--confirm', plan.json.planDigest]) : plan;
    };
    const leaks = (sentinels, stage) => {
      // The descriptor is the one file allowed to hold them.
      const files = [...filesBelow(machine.home), ...filesBelow(machine.argv)].filter(file => file.path !== descriptor);
      for (const sentinel of sentinels) {
        for (const file of files) assert.ok(!file.bytes.includes(sentinel), `${stage}: ${file.path} contains descriptor value ${sentinel}`);
        for (const output of outputs) assert.ok(!output.includes(sentinel), `${stage}: output contains descriptor value ${sentinel}`);
      }
    };

    assert.equal(confirm(v1, 'setup').status, 0);
    run(v1, ['status']);
    run(v1, ['status', '--check']);
    // Backups exist now: every seeded config was changed.
    assert.ok(filesBelow(path.join(machine.home, '.local', 'state', 'khala', 'setup', 'backups')).length > 0);
    leaks(first.sentinels, 'after setup');

    // A new launch moves the descriptor to another origin and credential. The static
    // entries stay valid, so nothing is planned and no harness config is rewritten.
    const entries = snapshot(machine.home, { mtimes: true, exclude: [path.dirname(descriptor)] });
    writeDescriptor(machine, second.descriptor);
    const again = run(v1, ['setup']);
    assert.equal(again.status, 0);
    assert.equal(again.json.changed, false);
    assert.deepEqual(snapshot(machine.home, { mtimes: true, exclude: [path.dirname(descriptor)] }), entries);

    assert.equal(confirm(v2, 'setup').status, 0);
    leaks([...first.sentinels, ...second.sentinels], 'after upgrade');
    assert.equal(confirm(v2, 'remove').status, 0);
    leaks([...first.sentinels, ...second.sentinels], 'after remove');

    // Results never echo the person's own configuration either.
    for (const output of outputs) assert.ok(!output.includes(USER_SECRET), 'output contains a user config secret');
    const manifest = path.join(machine.home, '.local', 'state', 'khala', 'setup', 'manifest.v1.json');
    assert.equal(fs.existsSync(manifest), false);
  });

  // Two loopback servers stand in for two launches of the internal server. Each records the
  // requests it receives; a request carrying the current credential proves the entry re-read
  // the moved descriptor rather than any value captured at setup.
  async function launches() {
    const requests = [];
    const servers = await Promise.all([0, 1].map(index => new Promise(resolve => {
      const server = http.createServer((request, response) => {
        requests.push({ index, headers: JSON.stringify(request.headers) });
        response.writeHead(503).end();
      });
      server.listen(0, '127.0.0.1', () => resolve(server));
    })));
    return { requests, servers, close: () => { for (const server of servers) server.close(); } };
  }

  // Runs a staged entry until it exits or a second passes, then stops it.
  async function runEntry(machine, args, env = {}) {
    const launcher = path.join(machine.home, '.local', 'share', 'khala', 'bin', 'khala');
    const child = spawn(launcher, args, { env: machineEnvironment(machine, env), stdio: ['pipe', 'pipe', 'pipe'] });
    // `exit`, not `close`: a hook helper may keep inherited pipes open after the entry exits.
    const exited = new Promise(resolve => child.once('exit', resolve));
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 1_000))]);
    child.stdin.end();
    child.kill('SIGKILL');
    await exited;
    return output;
  }

  // `granted` publishes a launch that holds a human grant, so the entry presents that
  // launch's binding capability; a transport-only launch is an unjoined agent.
  async function assertFollowsMovedDescriptor(args, { env, granted = false } = {}) {
    const machine = createMachine(ALL);
    assert.equal(confirmed(v1, machine, 'setup').applied.status, 0);
    // The internal server owns the descriptor directory; it exists before any launch moves it.
    writeDescriptor(machine, { v: 1 });
    const entries = snapshot(machine.home, { mtimes: true, exclude: [path.join(machine.home, '.local', 'state', 'khala', 'internal')] });
    const { requests, servers, close } = await launches();
    try {
      for (const [index, server] of servers.entries()) {
        const transportCapability = randomBytes(32).toString('base64url');
        const bindingCapability = randomBytes(32).toString('base64url');
        const token = granted ? bindingCapability : transportCapability;
        writeDescriptor(machine, {
          v: 1, channelId: `ch_${'a'.repeat(16)}`, origin: `http://127.0.0.1:${server.address().port}`, transportCapability,
          ...(granted ? { grantRef: `grant-${index}`, bindingId: `binding-${index}`, bindingCapability } : {}),
        });
        const output = await runEntry(machine, args, env);
        const reached = requests.filter(request => request.index === index);
        assert.ok(reached.length > 0, `${args.join(' ')} never reached launch ${index}: ${output}`);
        assert.ok(reached.every(request => request.headers.includes(token)), `${args.join(' ')} did not present launch ${index}'s credential`);
      }
    } finally { close(); }
    assert.deepEqual(snapshot(machine.home, { mtimes: true, exclude: [path.join(machine.home, '.local', 'state', 'khala', 'internal')] }), entries, 'no entry is rewritten');
  }

  // The Claude plugin's hooks run `khala claude <op>`; the staged launcher runs that same runtime.
  test('the Claude hook entry re-reads a moved runtime descriptor on every call', () =>
    assertFollowsMovedDescriptor(['claude', 'status', '--session', 'acceptance']));

  // Codex `mcp_servers.khala` and OpenCode `mcp.khala` both run the launcher's bare `mcp-serve`.
  test('the Codex and OpenCode MCP entry resolves a moved runtime descriptor', () =>
    assertFollowsMovedDescriptor(['mcp-serve'], { granted: true }));
});
