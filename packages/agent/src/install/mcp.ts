import { isHarnessId } from '@khala/contracts/m1/harness';
import type { InstallDeps } from './main';

const USAGE = 'usage: khala install mcp --print [--harness <id>]';

/** Print portable configuration without installing packages or touching client files. */
export async function runMcpInstall(flags: readonly string[], deps: InstallDeps): Promise<number> {
  const stdout = deps.stdout ?? (line => { process.stdout.write(line + '\n'); });
  const stderr = deps.stderr ?? (line => { process.stderr.write(line + '\n'); });
  let harness = 'generic';
  let print = false;
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] === '--print' && !print) print = true;
    else if (flags[i] === '--harness' && isHarnessId(flags[i + 1])) harness = flags[++i]!;
    else { stderr(USAGE); return 1; }
  }
  if (!print) { stderr(USAGE); return 1; }
  const args = ['-y', 'khala-cli', 'mcp', '--harness', harness];
  stdout(JSON.stringify({ mcpServers: { khala: { command: 'npx', args } } }, null, 2));
  stdout(`npx ${args.join(' ')}`);
  return 0;
}
