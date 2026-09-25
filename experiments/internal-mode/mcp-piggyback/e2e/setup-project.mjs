import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Writes the project-scoped Codex MCP entry for the product server and the
// Khala skill stand-in. Codex's own folder-trust prompt still gates the
// project config layer, and its MCP tool approval prompts are left as is.
//
//   setup-project.mjs <project-dir> <fixture-dir>
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../../..');
const [projectArgument, fixtureArgument] = process.argv.slice(2);
if (!projectArgument || !fixtureArgument) throw new Error('usage: setup-project.mjs <project-dir> <fixture-dir>');
const project = resolve(projectArgument);
const fixture = resolve(fixtureArgument);
const toml = [
  '[mcp_servers.khala]',
  `command = ${JSON.stringify(join(repo, 'node_modules/.bin/tsx'))}`,
  `args = [${JSON.stringify(join(here, 'serve.ts'))}]`,
  `env = { KHALA_E2E_DIR = ${JSON.stringify(fixture)} }`,
  '',
].join('\n');
await mkdir(join(project, '.codex'), { recursive: true, mode: 0o700 });
await writeFile(join(project, '.codex', 'config.toml'), toml, { mode: 0o600 });
await writeFile(join(project, 'AGENTS.md'), await readFile(join(here, 'AGENTS.proof.md'), 'utf8'), { mode: 0o600 });
console.log(JSON.stringify({ project, fixture, config: join(project, '.codex', 'config.toml') }));
