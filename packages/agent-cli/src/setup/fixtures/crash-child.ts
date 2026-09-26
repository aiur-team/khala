// Child process for crash tests: applies a plan and SIGKILLs itself at the named boundary,
// leaving the journal, backups, and a dead-holder lock exactly as a real crash would.
import { executeSetupPlan, type ExecutablePlan, type SetupRoots } from '../transaction.js';
import type { SetupOperation, Sha256Digest } from '../types.js';

type Input = {
  roots: SetupRoots;
  killAt: string;
  plan: { command: 'setup' | 'remove'; planDigest: Sha256Digest; operations: SetupOperation[]; contents: [Sha256Digest, string][] };
};

const input = JSON.parse(process.argv[2]!) as Input;
const plan: ExecutablePlan = {
  ...input.plan,
  contents: new Map(input.plan.contents.map(([digest, base64]) => [digest, new Uint8Array(Buffer.from(base64, 'base64'))])),
};
const outcome = await executeSetupPlan({
  roots: input.roots,
  searchPath: '/usr/bin:/bin',
  confirmedDigest: plan.planDigest,
  replan: async () => plan,
  boundary: name => {
    if (name === input.killAt) process.kill(process.pid, 'SIGKILL');
  },
});
process.stdout.write(JSON.stringify({ kind: outcome.kind }));
