// Runs one Vitest project. pnpm forwards a literal `--` from
// `pnpm test:e2e -- <file>`, and Vitest ignores every filter after it, so the
// separator is dropped before the file filters are passed on.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const [project, ...rest] = process.argv.slice(2);
if (!['conformance', 'e2e'].includes(project)) throw new Error(`unknown test project: ${project}`);

const config = fileURLToPath(new URL('./vitest.config.ts', import.meta.url));
const filters = rest.filter(argument => argument !== '--');
// `pnpm run` puts the workspace's `node_modules/.bin` on PATH.
const result = spawnSync('vitest', ['run', '--config', config, '--project', project, ...filters], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
