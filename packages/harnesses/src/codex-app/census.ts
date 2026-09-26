// The process census rules of the Codex app proof kit
// (`experiments/interactive-cli/codex-app/verify.ts`), applied to a live session. A
// session that bypasses normal trust settings (decision 33) or runs under a Khala
// process (decision 24) is never one a proof covers, whatever the proof record says.
// The facts come from the observed process table, never from a caller's claim.

import { basename } from 'node:path';

export type CodexAppProcess = Readonly<{ pid: number; ppid: number; argv: readonly string[] }>;

/** A process table snapshot taken in the session, and the Codex process hosting its hooks and MCP entry. */
export type CodexAppCensus = Readonly<{ sessionPid: number; processes: readonly CodexAppProcess[] }>;

// `--yolo` is Codex's hidden alias for `--dangerously-bypass-approvals-and-sandbox`.
const TRUST_BYPASS = [
  '--dangerously-bypass-hook-trust',
  '--dangerously-skip-permissions',
  '--dangerously-bypass-approvals-and-sandbox',
  '--yolo',
  '--setting-sources',
  '--port',
];

// Option values that turn off the sandbox or approvals just as those flags do, passed
// directly or as a `-c key=value` config override.
const TRUST_BYPASS_VALUES: readonly { options: readonly string[]; bypass: (value: string) => boolean }[] = [
  { options: ['-s', '--sandbox'], bypass: value => value === 'danger-full-access' },
  { options: ['-a', '--ask-for-approval'], bypass: value => value === 'never' },
  {
    options: ['-c', '--config'],
    bypass: value =>
      /^\s*(?:approval_policy\s*=\s*["']?never|sandbox_mode\s*=\s*["']?danger-full-access)["']?\s*$/.test(value),
  },
];

const KHALA = /(?:^|[\s/@\\])(?:@aiur\/)?khala\b/i;

const isCodex = (argv: readonly string[]) => argv.some(token => /^codex(?:\.js|\.exe)?$/.test(basename(token)));

// An option's value follows as the next token, after `=`, or, for a short option,
// attached (`-sdanger-full-access`).
function optionValues(argv: readonly string[], option: string): string[] {
  const short = /^-[a-z]$/.test(option);
  return argv.flatMap((token, index) => {
    if (token === option) return index + 1 < argv.length ? [argv[index + 1]!] : [];
    if (token.startsWith(`${option}=`)) return [token.slice(option.length + 1)];
    if (short && token.startsWith(option) && token.length > 2) return [token.slice(2)];
    return [];
  });
}

/** The flag or option value in `argv` that bypasses normal trust settings, if any. */
export function codexAppTrustBypass(argv: readonly string[]): string | undefined {
  const flag = TRUST_BYPASS.find(name => argv.some(token => token === name || token.startsWith(`${name}=`)));
  if (flag) return flag;
  for (const { options, bypass } of TRUST_BYPASS_VALUES) {
    for (const option of options) {
      const value = optionValues(argv, option).find(bypass);
      if (value !== undefined) return `${option} ${value}`;
    }
  }
  return undefined;
}

function ancestors(proc: CodexAppProcess, byPid: ReadonlyMap<number, CodexAppProcess>): CodexAppProcess[] {
  const chain: CodexAppProcess[] = [];
  for (let next = byPid.get(proc.ppid); next && !chain.includes(next); next = byPid.get(next.ppid)) chain.push(next);
  return chain;
}

/**
 * Why the observed session is not one a proof can cover, or `null` when the census
 * passes. The session's own process tree is checked: the session process, every
 * ancestor, and every descendant, so an app server the session spawned counts too.
 */
export function codexAppCensusViolation(census: CodexAppCensus | null): string | null {
  if (census === null) return 'No process census was taken in this session.';
  const byPid = new Map(census.processes.map(proc => [proc.pid, proc]));
  const session = byPid.get(census.sessionPid);
  if (session === undefined) return 'The session process is not in the process census.';
  const lineage = [session, ...ancestors(session, byPid)];
  if (lineage.some(proc => KHALA.test(proc.argv.join(' ')))) {
    return 'The session runs under a Khala process; Khala never starts or hosts an agent.';
  }
  const descendants = census.processes.filter(proc => ancestors(proc, byPid).includes(session));
  for (const proc of [...lineage, ...descendants]) {
    if (!isCodex(proc.argv)) continue;
    const bypass = codexAppTrustBypass(proc.argv);
    if (bypass !== undefined) return `The session bypasses normal trust settings (${bypass}).`;
  }
  return null;
}
