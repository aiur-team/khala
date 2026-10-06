import { KHALA_AGENT_VERSION } from './version';

type Main = { default: (argv: readonly string[]) => unknown };
type Hook = { default: (stdin: string, argv: readonly string[]) => unknown };
type Load<T> = (() => Promise<T>) | undefined;

/**
 * Finds command modules. The checkout (bin/khala.mjs) discovers TypeScript files through
 * tsx; the published bundle (src/cli-bundle.ts) uses a static map. Either returns
 * undefined for a module that does not exist.
 */
export type CliModules = {
  mcp(): Load<Main>;
  local(): Load<Main>;
  watch(): Load<Main>;
  install(): Load<Main>;
  wake?(): Load<Main>;
  hook(name: string): Load<Hook>;
};

const HOOK_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const STDIN_CAP = 1024 * 1024;
export const USAGE = 'usage: khala mcp | khala watch [--harness claude|codex|cursor --session <id>] | khala hook <name> | khala local <command> | khala install codex | khala install cursor | khala wake on|off|status [--driver <d>] [--harness <id>] [--json] | khala install opencode | khala install mcp --print [--harness <id>] | khala --version';

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > STDIN_CAP) return '';
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function exitCode(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error('bad_exit');
  return value;
}

/** Runs one `khala` invocation and returns its exit code. Failures never print details. */
export async function runCli(argv: readonly string[], modules: CliModules): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === '--version') {
    console.log(KHALA_AGENT_VERSION);
    return 0;
  }
  if (cmd === 'mcp' || cmd === 'install' || cmd === 'watch' || cmd === 'wake') {
    const load = modules[cmd]?.();
    if (!load) { console.error(`khala: ${cmd} not available`); return 1; }
    try { return exitCode(await (await load()).default(rest)); }
    catch { console.error('khala: internal_error'); return 1; }
  }
  if (cmd === 'local') {
    const load = modules.local();
    if (!load) { console.log('{"error":"internal_error"}'); return 1; }
    try { return exitCode(await (await load()).default(rest)); }
    catch { console.log('{"error":"internal_error"}'); return 1; }
  }
  if (cmd === 'hook') {
    const [name = '', ...args] = rest;
    const load = HOOK_NAME.test(name) ? modules.hook(name) : undefined;
    if (!load) { console.error(`khala: unknown hook ${name}`); return 1; }
    try {
      const run = (await load()).default;
      return exitCode(await run(await readStdin(), args));
    } catch {
      process.stderr.write('{"ok":false,"warning":"khala_hook_suppressed","code":"internal_error"}\n');
      return 1;
    }
  }
  console.error(USAGE);
  return 1;
}
