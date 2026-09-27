// Process entry for `launcher-world.ts`: the real `khala internal` runtime against the
// launcher's fixture web bundle, as `apps/internal`'s own process harness runs it.
// Started with `--conditions=khala-source --import tsx`, because the runtime resolves
// the agent CLI's workspace source through that condition. The one argument is the
// internal command as JSON (`create` launches; `discovery` issues a descriptor), and
// its first stdout line is the command's report.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInternalRuntime } from '../../../apps/internal/src/composition/internal-cli';
import { INSTALLED_CLAUDE } from './installed-claude';

const abort = new AbortController();
process.once('SIGINT', () => abort.abort());
process.once('SIGTERM', () => abort.abort());
const runtime = createInternalRuntime({
  bundleDirectory: path.join(fileURLToPath(new URL('../../../', import.meta.url)), 'apps/internal/src/launcher/fixtures/internal-web'),
  startPort: 0,
  openBrowser: async () => ({ opened: false, reason: 'disabled in tests' }),
  // The installed Claude Code this world's launcher claims: inspected, and not proven.
  claudeVersion: async () => INSTALLED_CLAUDE,
});
const write = (stream: NodeJS.WritableStream) => ({
  write: (text: string) => new Promise<void>(resolve => stream.write(text, () => resolve())),
});
process.exitCode = await runtime.runInternalCommand(
  JSON.parse(process.argv[2] ?? '{"kind":"create"}'),
  { stdout: write(process.stdout), stderr: write(process.stderr), signal: abort.signal, env: process.env, cwd: process.cwd() },
);
