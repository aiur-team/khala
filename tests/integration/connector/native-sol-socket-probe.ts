// Disposable diagnostic: a model-originated call runs this inside Codex's
// ordinary tool sandbox. It emits only socket category, path length and errno.
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, unlink } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

const root = process.env.KHALA_42_SYNC_ROOT;
if (!root || !path.isAbsolute(root) || path.normalize(root) !== root) {
  throw new Error('private_fixture_root_required');
}

async function attempt(category: string, directory: string): Promise<void> {
  let directoryReady = false;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const observed = await lstat(directory);
    directoryReady = observed.isDirectory() && !observed.isSymbolicLink()
      && (observed.mode & 0o077) === 0 && observed.uid === process.getuid?.();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'unknown';
    process.stdout.write(JSON.stringify({ category, directoryReady, stage: 'directory', code }) + '\n');
    return;
  }
  if (!directoryReady) {
    process.stdout.write(JSON.stringify({ category, directoryReady, stage: 'directory', code: 'unsafe' }) + '\n');
    return;
  }
  const socketPath = path.join(directory, `probe-${randomUUID().slice(0, 8)}.sock`);
  const server = net.createServer();
  const result = await new Promise<{ code: string }>(resolve => {
    server.once('error', error => resolve({ code: (error as NodeJS.ErrnoException).code ?? 'unknown' }));
    server.listen(socketPath, () => resolve({ code: 'ok' }));
  });
  if (result.code === 'ok') await new Promise<void>(resolve => server.close(() => resolve()));
  else server.close();
  await unlink(socketPath).catch(() => undefined);
  process.stdout.write(JSON.stringify({ category, directoryReady, pathBytes: Buffer.byteLength(socketPath),
    stage: 'listen', code: result.code }) + '\n');
}

await attempt('private_state', path.join(root, 'state'));
await attempt('fallback_tmp', path.join('/tmp', `.khala-agent-cli-${process.getuid?.() ?? 0}`));
