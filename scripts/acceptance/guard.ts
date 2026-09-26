// Every process the live runner starts passes this allowlist first. The runner
// may call `gh`, `npx <pinned @aiur/khala> status` and `npx <pinned @aiur/khala>
// internal [--resume <channel-id>]`. It never starts, wraps or hosts an agent:
// `khala run <cli>` and any agent CLI are refused by name, and anything else is
// refused because it is not on the list.

const AGENT_COMMANDS = new Set(['claude', 'codex', 'opencode', 'cursor-agent', 'cursor', 'aider', 'gemini']);
const GH_SUBCOMMANDS = new Set(['api', 'issue', 'label', 'repo']);
const CHANNEL_ID = /^[A-Za-z0-9_-]{1,128}$/;

export type CommandCheck = Readonly<{ ok: true }> | Readonly<{ ok: false; reason: string }>;

function basename(command: string): string {
  return command.split('/').pop() ?? command;
}

function khalaArguments(args: readonly string[]): CommandCheck {
  const [command, ...rest] = args;
  if (command === 'run') return { ok: false, reason: 'khala run wraps an agent CLI; the runner never launches an agent' };
  if (command === 'status' && rest.length === 0) return { ok: true };
  if (command === 'internal' && rest.length === 0) return { ok: true };
  if (command === 'internal' && rest.length === 2 && rest[0] === '--resume' && CHANNEL_ID.test(rest[1]!)) return { ok: true };
  return { ok: false, reason: `khala ${args.join(' ')} is not a runner command` };
}

/** Allows exactly the runner's own commands for the pinned package. */
export function checkCommand(argv: readonly string[], khalaPackage: string): CommandCheck {
  const [command, ...args] = argv;
  if (command === undefined) return { ok: false, reason: 'empty command' };
  const name = basename(command);
  if (AGENT_COMMANDS.has(name)) return { ok: false, reason: `${name} is an agent CLI; the Executor, not the runner, starts agents` };
  if (argv.some(argument => /\bapp-server\b/.test(argument))) return { ok: false, reason: 'hosted agent routes are never started by the runner' };
  if (name === 'khala') return khalaArguments(args);
  if (name === 'gh') {
    return args[0] !== undefined && GH_SUBCOMMANDS.has(args[0]) ? { ok: true } : { ok: false, reason: `gh ${args[0] ?? ''} is not a runner command` };
  }
  if (name === 'npx') {
    const [flag, spec, ...rest] = args;
    if (flag !== '--yes' || spec !== khalaPackage) return { ok: false, reason: `npx must run exactly ${khalaPackage}` };
    return khalaArguments(rest);
  }
  return { ok: false, reason: `${name} is not a runner command` };
}

export function assertCommand(argv: readonly string[], khalaPackage: string): void {
  const check = checkCommand(argv, khalaPackage);
  if (!check.ok) throw new Error(`refused command: ${check.reason}`);
}
