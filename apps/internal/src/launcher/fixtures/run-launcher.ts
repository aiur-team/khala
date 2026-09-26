// Process harness: runs the real internal runtime against the fixture web
// bundle, exactly as `khala internal` does, with SIGINT/SIGTERM wired to abort.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInternalRuntime } from '../../composition/internal-cli';

const [, , mode, value, port] = process.argv;
const abort = new AbortController();
process.once('SIGINT', () => abort.abort());
process.once('SIGTERM', () => abort.abort());
const runtime = createInternalRuntime({
  bundleDirectory: path.join(path.dirname(fileURLToPath(import.meta.url)), 'internal-web'),
  startPort: Number(port),
  openBrowser: async () => ({ opened: false, reason: 'disabled in tests' }),
});
const write = (stream: NodeJS.WritableStream) => ({
  write: (text: string) => new Promise<void>(resolve => stream.write(text, () => resolve())),
});
process.exitCode = await runtime.runInternalCommand(
  mode === 'resume' ? { kind: 'resume', channelId: value! } : { kind: 'create' },
  { stdout: write(process.stdout), stderr: write(process.stderr), signal: abort.signal, env: process.env, cwd: process.cwd() },
);
