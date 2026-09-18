// The live gate, tested end to end: each case runs fixture files through `run.mjs`
// (the same entry `pnpm test:e2e` uses) in a live environment and checks the exit
// status. A child process, rather than an in-process `startVitest`, keeps the
// reporter's `process.exitCode` out of this run and covers the reporter wiring too.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const fixture = (name: string) => `tests/e2e/harness/fixtures/live-gate/${name}.fixture.ts`;
const RUN_GATE = 'live mode: no live case passed with live evidence';

function run(args: readonly string[], env: Readonly<Record<string, string>>): Promise<{ status: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['tests/e2e/harness/run.mjs', 'live-gate', ...args], {
      cwd: root,
      env: {
        ...process.env,
        KHALA_E2E_LIVE: '',
        KHALA_E2E_DISPOSABLE_ENV: '',
        PATH: `${path.join(root, 'node_modules', '.bin')}${path.delimiter}${process.env.PATH ?? ''}`,
        ...env,
      },
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.on('error', reject);
    // CI forces color, so strip ANSI codes before matching summary text.
    child.on('close', status => resolve({ status, output: stripVTControlCharacters(output) }));
  });
}

const live = { KHALA_E2E_LIVE: '1', KHALA_E2E_DISPOSABLE_ENV: 'live-gate-fixture' };

describe.concurrent('live gate fixture runs', { timeout: 60_000 }, () => {
  it('passes a live run in which one live case returned live evidence', async () => {
    const { status, output } = await run([fixture('pass')], live);
    expect(output).not.toContain(RUN_GATE);
    expect(status).toBe(0);
  });

  it('skips live entries with the reason when live mode is off', async () => {
    const { status, output } = await run([fixture('pass')], {});
    expect(output).toContain('Tests  1 skipped');
    expect(output).not.toContain(RUN_GATE);
    expect(status).toBe(0);
  });

  it('fails a live run with no live entries', async () => {
    const { status, output } = await run([fixture('no-entries')], live);
    expect(output).toContain(RUN_GATE);
    expect(status).toBe(1);
  });

  it('fails a live run whose name filter skips every live case', async () => {
    const { status, output } = await run([fixture('pass'), '-t', 'matches-nothing'], live);
    expect(output).toContain(RUN_GATE);
    expect(status).toBe(1);
  });

  it('fails a live run whose only "live:" case was not declared through describeLive', async () => {
    const { status, output } = await run([fixture('spoofed')], live);
    expect(output).toContain('Tests  1 passed');
    expect(output).toContain(RUN_GATE);
    expect(status).toBe(1);
  });

  it('fails a live entry whose every case skipped, even when another entry passed', async () => {
    const { status, output } = await run([fixture('entry-skipped')], live);
    expect(output).toContain('gate-uncovered: live mode ran no live case; all-skipped is not acceptance');
    expect(output).not.toContain(RUN_GATE);
    expect(status).toBe(1);
  });

  it('fails live cases that return fake, empty or hand-built evidence', async () => {
    const { status, output } = await run([fixture('weak-evidence')], live);
    expect(output).toContain('returned fake-contract evidence');
    expect(output).toContain('returned a live manifest with no records');
    expect(output).toContain('returned no evidence manifest issued by a scenario');
    expect(output).toContain(RUN_GATE);
    expect(status).toBe(1);
  });
});
