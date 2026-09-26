// Manual entry point for Acceptance 2. See scripts/acceptance/README.md.
//
//   pnpm acceptance:live --profile <profile.json> --confirm-live [--resume <channel-id>]
//
// Prints the run report as JSON. Exits 0 only on `pass`.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { promisify } from 'node:util';
import { aiurLogs } from './adapters/aiur';
import { ghGitHub } from './adapters/github';
import { npxLauncher } from './adapters/launcher';
import { packageStager } from './adapters/package';
import { storeSnapshot } from './adapters/snapshot';
import { assertCommand } from './guard';
import { hostLock } from './lock';
import { decodeProfile } from './profile';
import { newRunId } from './prompt';
import { runAcceptance } from './runner';
import type { ControllerPort, StatusPort } from './types';

const USAGE = 'usage: pnpm acceptance:live --profile <profile.json> --confirm-live [--resume <channel-id>]';

function parse(argv: readonly string[]): Readonly<{ profile: string; resume: string | null }> {
  let profile: string | null = null;
  let resume: string | null = null;
  let confirmed = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--profile') profile = argv[++index] ?? null;
    else if (argument === '--resume') resume = argv[++index] ?? null;
    else if (argument === '--confirm-live') confirmed = true;
    else if (argument !== '--') throw new Error(`unknown argument ${argument}\n${USAGE}`);
  }
  if (!profile || !confirmed) throw new Error(USAGE);
  return { profile, resume };
}

function stateHome(): string {
  return process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
}

function npxStatus(): StatusPort {
  return {
    async status(khalaPackage) {
      const argv = ['npx', '--yes', khalaPackage, 'status'];
      assertCommand(argv, khalaPackage);
      const result = await promisify(execFile)(argv[0]!, argv.slice(1)).catch((error: { stdout?: string; code?: number }) => ({
        stdout: error.stdout ?? '', failed: true,
      }));
      const output: unknown = JSON.parse(result.stdout.trim().split('\n').pop() || 'null');
      return { ok: !('failed' in result), output };
    },
  };
}

function terminalController(): ControllerPort {
  const ask = async (question: string): Promise<boolean> => {
    const prompt = createInterface({ input: process.stdin, output: process.stderr });
    try {
      return /^y(es)?$/i.test((await prompt.question(`${question} [y/N] `)).trim());
    } finally {
      prompt.close();
    }
  };
  return {
    confirmChannel: channel => {
      process.stderr.write(`Open the channel in your browser: ${channel.humanUrl}\n`);
      return ask(`Use channel ${channel.channelId} (${channel.channelUrl}) for this run?`);
    },
    confirmGrant: grant => ask(
      `Grant role ${grant.role.toUpperCase()} (#${grant.ticket}, ${grant.harness}, session ${grant.sessionFingerprint.slice(0, 12)}…, `
      + `${grant.verified ? 'matches the Executor\'s session record' : 'NOT tied to an Executor session record'})?`,
    ),
    note: line => { process.stderr.write(`${line}\n`); },
  };
}

async function main(): Promise<number> {
  const args = parse(process.argv.slice(2));
  const profile = decodeProfile(JSON.parse(fs.readFileSync(args.profile, 'utf8')));
  const state = stateHome();
  const report = await runAcceptance({
    lock: hostLock(state),
    package: packageStager(path.join(state, 'khala-acceptance', 'packages')),
    status: npxStatus(),
    github: ghGitHub(),
    aiur: aiurLogs(process.env.AIUR_LOGS_ROOT || path.join(os.homedir(), '.aiur', 'logs'), profile.repository),
    launcher: npxLauncher(),
    snapshot: storeSnapshot(path.join(state, 'khala', 'internal')),
    controller: terminalController(),
    clock: { now: () => Date.now(), sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) },
  }, { profile, runId: newRunId(), resume: args.resume });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report.verdict === 'pass' ? 0 : report.verdict === 'refused' ? 2 : 1;
}

main().then(code => { process.exitCode = code; }, (error: Error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 2;
});
