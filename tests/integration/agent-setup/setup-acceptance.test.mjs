// Release acceptance for `npx @aiur/khala setup|status|remove`, run black-box against the
// packed tarball installed outside this repository. Unit coverage and exhaustive per-mutation
// fault injection live beside the setup modules; this suite proves the packaged flow end to
// end across mixed harness states. See README.md in this directory.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parse as parseToml } from 'smol-toml';
import {
  SUPPORTED, approveCodexHooksNatively, confirmed, createMachine, filesBelow, holdProbe, harnessCalls,
  installHarness, installTarball, khala, khalaAsync, machineEnvironment, packedTarball, removeHarness, removeScratch,
  repackAtVersion, repositoryRoot, sha256, snapshot, writeDescriptor, writeSessionGrant,
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

  test('installed, absent, and unsupported harnesses are reported apart; an old Codex is skipped, not refused for all', () => {
    const machine = createMachine({ claude: SUPPORTED.claude, codex: 'codex-cli 0.1.0' });
    const pristine = snapshot(machine.home, { mtimes: true });
    const plan = khala(v1, machine, ['setup']);
    assert.equal(plan.status, 5, plan.stdout);
    assert.equal(plan.json.state, 'confirmation_required');
    assert.deepEqual(plan.json.confirmation.harnesses, ['claude'], 'only the supported harness is planned');
    assert.ok(plan.json.operations.every(operation => operation.harness === 'claude'));
    assert.ok(plan.json.diagnostics.some(entry => entry.code === 'harness_unsupported' && entry.harness === 'codex'));
    assert.deepEqual(snapshot(machine.home, { mtimes: true }), pristine);

    assert.deepEqual(harness(plan, 'claude').version, { detected: '2.1.283', supported: true });
    assert.deepEqual(harness(plan, 'codex').executable.present, true);
    assert.deepEqual(harness(plan, 'codex').version, { detected: '0.1.0', supported: false });
    assert.deepEqual(harness(plan, 'opencode')?.executable, { present: false, path: null }, 'absent OpenCode is reported absent');

    // A version probe that fails is distinct from absence.
    fs.writeFileSync(path.join(machine.bin, 'opencode'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const probed = khala(v1, machine, ['status']);
    assert.equal(harness(probed, 'opencode').executable.present, true);
    assert.equal(harness(probed, 'opencode').version.detected, null);
    removeHarness(machine, 'opencode');

    const applied = khala(v1, machine, ['setup', '--confirm', plan.json.planDigest]);
    assert.equal(applied.status, 0, applied.stdout);
    assert.equal(applied.json.ok, true);
    assert.equal(applied.json.state, 'configured_effect_unknown');
    assert.deepEqual(harness(applied, 'codex').version, { detected: '0.1.0', supported: false });
    for (const untouched of ['.codex', '.config/opencode']) assert.equal(fs.existsSync(path.join(machine.home, untouched)), false, `${untouched} is never created`);
    assert.equal(khala(v1, machine, ['status', '--check']).status, 3);
  });

  test('Claude plus an untested OpenCode sets up Claude and reports OpenCode as unsupported (#419)', () => {
    const machine = createMachine({ claude: SUPPORTED.claude, opencode: '1.15.6' });
    const { plan, applied } = confirmed(v1, machine, 'setup');
    assert.equal(plan.status, 5, plan.stdout);
    assert.deepEqual(plan.json.confirmation.harnesses, ['claude']);
    assert.equal(applied?.status, 0, applied?.stdout ?? plan.stdout);
    assert.equal(applied.json.changed, true);
    assert.equal(applied.json.state, 'configured_effect_unknown');
    assert.deepEqual(harness(applied, 'opencode').version, { detected: '1.15.6', supported: false });
    assert.ok(harness(applied, 'opencode').components.every(entry => entry.state === 'unsupported'));
    assert.ok(applied.json.diagnostics.some(entry => entry.code === 'harness_unsupported' && entry.harness === 'opencode'));
    assert.ok(fs.existsSync(path.join(machine.home, '.claude', 'settings.json')), 'Claude is configured');
    assert.equal(fs.existsSync(path.join(machine.home, '.config', 'opencode')), false, 'OpenCode is left untouched');
    const again = khala(v1, machine, ['setup']);
    assert.equal(again.status, 0, again.stdout);
    assert.equal(again.json.changed, false);
  });

  test('with every detected harness unsupported, setup refuses before any write', () => {
    const machine = createMachine({ opencode: '1.15.6', codex: 'codex-cli 0.1.0' });
    const pristine = snapshot(machine.home, { mtimes: true });
    const refused = khala(v1, machine, ['setup']);
    assert.equal(refused.status, 3, refused.stdout);
    assert.equal(refused.json.state, 'unsupported');
    assert.equal(refused.json.planDigest, null);
    assert.deepEqual(snapshot(machine.home, { mtimes: true }), pristine);
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

  test('an unsupported version is left unchanged by setup, and manifest-driven removal still restores the baseline', () => {
    const machine = createMachine(ALL);
    seed(machine);
    const baseline = snapshot(machine.home);
    assert.equal(confirmed(v1, machine, 'setup').applied.status, 0);
    installHarness(machine, 'codex', 'codex-cli 9.9.9');
    const installed = snapshot(machine.home, { mtimes: true });

    const skipped = khala(v1, machine, ['setup']);
    assert.equal(skipped.json.changed, false, skipped.stdout);
    assert.deepEqual(skipped.json.operations, []);
    assert.deepEqual(harness(skipped, 'codex').version, { detected: '9.9.9', supported: false });
    assert.ok(skipped.json.diagnostics.some(entry => entry.code === 'harness_unsupported' && entry.harness === 'codex'));
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

  // SIGKILLs a confirmed setup once its write-ahead journal shows an applied operation but
  // before the commit point, so the next command has a real rollback to do. A kill that lands
  // too early or too late is retried on a fresh machine.
  const ATTEMPTS = 20;
  async function killMidTransaction() {
    const started = journal => journal?.state === 'prepared' && journal.operations.some(entry => entry.status === 'applied');
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const machine = createMachine(ALL);
      seed(machine);
      const baseline = snapshot(machine.home);
      const journalPath = path.join(machine.home, '.local', 'state', 'khala', 'setup', 'transaction.v1.json');
      const readJournal = () => { try { return JSON.parse(fs.readFileSync(journalPath, 'utf8')); } catch { return null; } };
      const plan = khala(v1, machine, ['setup']);
      const run = khalaAsync(v1, machine, ['setup', '--confirm', plan.json.planDigest]);
      while (run.child.exitCode === null && run.child.signalCode === null) {
        if (started(readJournal())) { run.child.kill('SIGKILL'); break; }
        await new Promise(resolve => setImmediate(resolve));
      }
      await run.done;
      if (started(readJournal())) return { machine, plan, baseline };
    }
    throw new Error(`never interrupted a setup between its first write and its commit in ${ATTEMPTS} attempts`);
  }

  // Planned paths whose bytes are already the setup's postimage: proof that something was written.
  function writtenPaths(plan) {
    return plan.json.operations.filter(operation => operation.postimage && fs.existsSync(operation.path)
      && `sha256:${sha256(fs.readFileSync(operation.path))}` === operation.postimage).map(operation => operation.path);
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
    const { machine, plan, baseline } = await killMidTransaction();
    assert.notDeepEqual(writtenPaths(plan), [], 'the interrupted setup must have written a postimage for recovery to roll back');
    const recovery = khala(v1, machine, ['remove']);
    assert.notEqual(recovery.json.planDigest, null, 'a recovery plan the agent can relay');
    assert.match(recovery.json.confirmation.request, new RegExp(`khala remove --confirm ${recovery.json.planDigest}`));
    const next = khala(v1, machine, ['remove', '--confirm', recovery.json.planDigest]);
    assert.ok(next.json.diagnostics.some(item => item.code === 'recovered'), next.stdout);
    // The kill landed before the commit point, so recovery alone rolls every write back.
    assert.equal(next.status, 0, next.stdout);
    assert.deepEqual(writtenPaths(plan), []);
    const status = khala(v1, machine, ['status', '--check']);
    assert.notEqual(status.status, 4, status.stdout);
    assert.ok(!fs.existsSync(path.join(machine.home, '.local', 'state', 'khala', 'setup', 'transaction.v1.json')));
    assertRestored(machine, baseline);
  });
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

const INITIALIZE = `${JSON.stringify({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'acceptance', version: '0' } },
})}\n`;
// A tool call as Codex sends it, naming its thread in `_meta.threadId`; OpenCode names none.
const toolCall = (id, threadId) => `${JSON.stringify({
  jsonrpc: '2.0', id, method: 'tools/call',
  params: { ...(threadId === undefined ? {} : { _meta: { threadId } }), name: 'khala_send', arguments: { message: 'acceptance' } },
})}\n`;

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

  // Runs a staged entry until it exits or a second passes, then stops it.
  async function runEntry(machine, args, env = {}, input = '') {
    const launcher = path.join(machine.home, '.local', 'share', 'khala', 'bin', 'khala');
    const child = spawn(launcher, args, { env: machineEnvironment(machine, env), stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.write(input);
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
  // launch's binding capability; a transport-only launch is an unjoined agent. With a
  // `session`, the grant is that harness session's own `grant.json`, the entry is sent
  // `input` naming it, and `active.json` holds another session's grant it must not borrow.
  async function assertFollowsMovedDescriptor(args, { env, granted = false, session, input } = {}) {
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
        const descriptor = {
          v: 1, channelId: `ch_${'a'.repeat(16)}`, origin: `http://127.0.0.1:${server.address().port}`, transportCapability,
          ...(granted ? { grantRef: `grant-${index}`, bindingId: `binding-${index}`, bindingCapability } : {}),
        };
        if (session === undefined) writeDescriptor(machine, descriptor);
        else {
          writeSessionGrant(machine, session.harness, session.sessionId, descriptor);
          writeDescriptor(machine, { ...descriptor, grantRef: 'grant-other', bindingId: 'binding-other', bindingCapability: randomBytes(32).toString('base64url') });
        }
        const output = await runEntry(machine, args, env, input);
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

  // Codex `mcp_servers.khala` and OpenCode `mcp.khala` both run the launcher's bare `mcp-serve`,
  // which acts as the session each tool call names (#407).
  test('the installed MCP entry resolves the calling session\'s moved grant, never active.json', () =>
    assertFollowsMovedDescriptor(['mcp-serve'], {
      granted: true,
      session: { harness: 'codex', sessionId: 'acceptance-thread' },
      input: INITIALIZE + toolCall(2, 'acceptance-thread'),
    }));
});

// Every installed entry runs exactly as its harness config writes it. The machine's PATH holds
// neither `khala` nor `node`, so an entry that looks either up on PATH fails here (#403).
describe('installed entries', () => {
  const dataHome = machine => path.join(machine.home, '.local', 'share', 'khala');

  function claudePluginRoot(machine) {
    const versions = path.join(dataHome(machine), 'versions');
    const [version, ...others] = fs.readdirSync(versions);
    assert.deepEqual(others, [], 'one staged version');
    return path.join(versions, version, 'claude', 'marketplace', 'plugins', 'khala');
  }

  const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
  const handlers = hooks => Object.entries(hooks).flatMap(([event, groups]) =>
    groups.flatMap(group => group.hooks.map(handler => ({ event, command: handler.command }))));

  /** The MCP entries and hook commands the configured harnesses hold, read back as installed. */
  function installedEntries(machine) {
    const pluginRoot = claudePluginRoot(machine);
    const claudeMcp = readJson(path.join(pluginRoot, '.mcp.json')).mcpServers.khala;
    const entries = {
      pluginRoot,
      mcp: { claude: { command: claudeMcp.command, args: claudeMcp.args, env: claudeMcp.env } },
      claudeHooks: handlers(readJson(path.join(pluginRoot, 'hooks', 'hooks.json')).hooks),
      codexHooks: [],
    };
    const codexConfig = path.join(machine.home, '.codex', 'config.toml');
    if (fs.existsSync(codexConfig)) {
      const codexMcp = parseToml(fs.readFileSync(codexConfig, 'utf8')).mcp_servers.khala;
      entries.mcp.codex = { command: codexMcp.command, args: codexMcp.args, env: codexMcp.env ?? {} };
      entries.codexHooks = handlers(readJson(path.join(machine.home, '.codex', 'hooks.json')).hooks)
        .filter(handler => handler.command.endsWith(' codex-hook'));
    }
    const openCodeConfig = path.join(machine.home, '.config', 'opencode', 'opencode.json');
    if (fs.existsSync(openCodeConfig)) {
      const [command, ...args] = readJson(openCodeConfig).mcp.khala.command;
      entries.mcp.opencode = { command, args, env: {} };
    }
    return entries;
  }

  /**
   * Runs one process until it exits, `until(stdout)` holds, or `ms` passes, then stops it. A hook
   * gets its whole `input` and EOF, as its harness sends it; an MCP session keeps stdin open.
   */
  async function runProcess(command, args, env, { input, ms, until = null }) {
    // Its own process group, so stopping it also stops what a hook shell started.
    const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    child.stdin.on('error', () => {});
    let stdout = '';
    let stderr = '';
    let settle;
    const settled = new Promise(resolve => { settle = resolve; });
    // A command that does not exist emits `error` and never `exit`.
    const exited = new Promise(resolve => {
      child.once('exit', (code, signal) => { resolve({ code, signal }); settle(); });
      child.once('error', error => { resolve({ code: null, signal: null, error: error.code }); settle(); });
    });
    child.stdout.on('data', chunk => { stdout += chunk; if (until?.(stdout)) settle(); });
    child.stderr.on('data', chunk => { stderr += chunk; });
    if (until === null) child.stdin.end(input); else child.stdin.write(input);
    await Promise.race([settled, new Promise(resolve => setTimeout(resolve, ms))]);
    child.stdin.end();
    if (child.pid !== undefined) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } }
    return { ...(await exited), stdout, stderr };
  }

  const initialized = stdout => stdout.split('\n').some(line => { try { return JSON.parse(line).id === 1; } catch { return false; } });

  async function assertEntriesResolve(harnesses) {
    const machine = createMachine(harnesses);
    assert.equal(confirmed(v1, machine, 'setup').applied.status, 0);
    const entries = installedEntries(machine);
    assert.deepEqual(Object.keys(entries.mcp), Object.keys(harnesses));
    const launcher = path.join(dataHome(machine), 'bin', 'khala');
    for (const entry of Object.values(entries.mcp)) assert.equal(entry.command, launcher);
    assert.equal(entries.claudeHooks.length, 5);
    assert.deepEqual(entries.codexHooks.map(handler => handler.event),
      harnesses.codex === undefined ? [] : ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop']);
    const env = machineEnvironment(machine);
    for (const name of ['khala', 'node']) {
      for (const directory of env.PATH.split(':')) assert.ok(!fs.existsSync(path.join(directory, name)), `${name} is on the machine PATH`);
    }

    const { requests, servers, close } = await launches();
    const transportCapability = randomBytes(32).toString('base64url');
    const bindingCapability = randomBytes(32).toString('base64url');
    writeDescriptor(machine, {
      v: 1, channelId: `ch_${'b'.repeat(16)}`, origin: `http://127.0.0.1:${servers[0].address().port}`, transportCapability,
      grantRef: 'grant-0', bindingId: 'binding-0', bindingCapability,
    });
    // The Codex session `acceptance` holds its own grant; `active.json` is another session's.
    const sessionCapability = randomBytes(32).toString('base64url');
    writeSessionGrant(machine, 'codex', 'acceptance', {
      v: 1, channelId: `ch_${'b'.repeat(16)}`, origin: `http://127.0.0.1:${servers[0].address().port}`, transportCapability,
      grantRef: 'grant-1', bindingId: 'binding-1', bindingCapability: sessionCapability,
    });
    const since = count => requests.slice(count).map(request => request.headers);
    const answered = id => stdout => stdout.split('\n').some(line => { try { return JSON.parse(line).id === id; } catch { return false; } });
    try {
      // MCP entries are spawned directly, command and args as written, with the entry's env.
      for (const [harness, entry] of Object.entries(entries.mcp)) {
        const before = requests.length;
        const input = INITIALIZE + { claude: '', codex: toolCall(2, 'acceptance'), opencode: toolCall(2) }[harness];
        const until = harness === 'claude' ? initialized : answered(2);
        const result = await runProcess(entry.command, entry.args, { ...env, ...entry.env }, { input, ms: 3_000, until });
        assert.equal(result.error, undefined, `${harness} MCP entry ${entry.command} did not start`);
        const reached = since(before);
        if (harness === 'claude') {
          // The Claude entry holds no binding, so it serves its session tools and answers.
          assert.ok(initialized(result.stdout), `the Claude MCP entry never answered initialize: ${result.stderr}`);
          // #402: it never composes the default-descriptor internal client or delivery, so the
          // granted launch's binding credential is never presented.
          assert.ok(reached.every(headers => !headers.includes(bindingCapability)), 'the Claude MCP entry presented the binding credential');
        } else {
          // Against the stand-in launch the call is refused `not_connected`: Codex's after
          // presenting its own session's credential, OpenCode's before presenting any (#407).
          assert.ok(answered(2)(result.stdout), `the ${harness} MCP entry never answered the tool call: ${result.stderr}`);
          assert.ok(reached.every(headers => !headers.includes(bindingCapability)), `the ${harness} MCP entry borrowed active.json's binding`);
          if (harness === 'codex') {
            assert.ok(reached.some(headers => headers.includes(sessionCapability)), `the codex MCP entry never reached its session's grant: ${result.stderr}`);
          } else {
            assert.ok(reached.every(headers => !headers.includes(sessionCapability)), 'the opencode MCP entry acted as a Codex session');
          }
        }
      }

      // Hook commands run through `sh -c`, as Claude and Codex run them.
      // A watcher's wake marker, so UserPromptSubmit asks Khala too (the runtime's `sessionState`).
      const session = createHash('sha256').update('acceptance').digest('hex').slice(0, 32);
      const hookState = path.join(machine.home, '.local', 'state', 'khala', 'claude-hooks', session);
      const hookEnv = { ...env, CLAUDE_PLUGIN_ROOT: entries.pluginRoot };
      // #422: setup enables the plugin for every Claude session, so a session without a grant
      // gets no output and makes no call.
      for (const hook of entries.claudeHooks) {
        const before = requests.length;
        const input = JSON.stringify({ hook_event_name: hook.event, session_id: 'acceptance', stop_hook_active: false });
        const result = await runProcess('/bin/sh', ['-c', hook.command], hookEnv, { input, ms: 2_000 });
        assert.equal(result.code, 0, `${hook.command} failed unbound: ${result.stderr}`);
        assert.equal(result.stdout, '', `${hook.command} wrote output in an unbound session`);
        assert.deepEqual(since(before), [], `${hook.command} reached Khala from an unbound session`);
      }
      // The launcher's Claude session route grants this session, as `khala_request_access` would.
      const { claudeGrantPath } = await import(pathToFileURL(path.join(entries.pluginRoot, 'hooks', 'lib', 'runtime.mjs')).href);
      const grant = claudeGrantPath(path.join(machine.home, '.local', 'state', 'khala', 'internal'), 'acceptance');
      fs.mkdirSync(path.dirname(grant), { recursive: true, mode: 0o700 });
      fs.writeFileSync(grant, JSON.stringify({ v: 1, bindingId: 'binding-0', transportCapability }), { mode: 0o600 });
      for (const hook of entries.claudeHooks) {
        const before = requests.length;
        if (hook.event === 'UserPromptSubmit') {
          fs.mkdirSync(hookState, { recursive: true, mode: 0o700 });
          fs.writeFileSync(path.join(hookState, 'wake'), '');
        }
        const input = JSON.stringify({ hook_event_name: hook.event, session_id: 'acceptance', stop_hook_active: false });
        const result = await runProcess('/bin/sh', ['-c', hook.command], hookEnv, { input, ms: 2_000 });
        assert.ok(result.code !== 127 && result.code !== 126, `${hook.command} did not run: ${result.stderr}`);
        // SessionEnd only clears the session's hook state; every other hook asks Khala first.
        if (hook.event !== 'SessionEnd') {
          assert.ok(since(before).some(headers => headers.includes(transportCapability)), `${hook.command} never reached Khala: ${result.stderr}`);
        }
      }
      for (const hook of entries.codexHooks) {
        const before = requests.length;
        const input = JSON.stringify({ hook_event_name: hook.event, session_id: 'acceptance', turn_id: 'turn-1' });
        const result = await runProcess('/bin/sh', ['-c', hook.command], env, { input, ms: 5_000 });
        assert.equal(result.code, 0, `${hook.command} failed: ${result.stderr}`);
        assert.doesNotMatch(result.stderr, /not found|No such file/);
        // The installed hook asks as the session its input names, never as active.json's.
        assert.ok(since(before).some(headers => headers.includes(sessionCapability)), `${hook.command} never reached its session's grant: ${result.stderr}`);
        assert.ok(since(before).every(headers => !headers.includes(bindingCapability)), `${hook.command} borrowed active.json's binding`);
      }
    } finally { close(); }
  }

  test('every installed MCP entry and hook resolves the Khala runtime with neither khala nor node on PATH', () =>
    assertEntriesResolve(ALL));

  // Setup used to stage the launcher only for Codex, OpenCode, and Cursor.
  test('a Claude-only setup stages the launcher its MCP entry and hooks run', () =>
    assertEntriesResolve({ claude: SUPPORTED.claude }));
});
