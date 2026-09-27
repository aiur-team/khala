// Invoked by the Executor fixture operator after the native TUI starts and
// before that fixture uses Khala. The worker does not write this private input.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { captureNativeSession } from './adapters/aiur';

const [file] = process.argv.slice(2);
if (!file || process.argv.length !== 3) {
  process.stderr.write('usage: pnpm acceptance:capture <private-executor-observation.json>\n');
  process.exitCode = 2;
} else {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077 || stat.uid !== process.getuid?.()) {
      throw new Error('observation must be a private regular file owned by this user');
    }
    const state = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
    const observation: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    const session = captureNativeSession(path.join(state, 'khala-acceptance', 'native-sessions'), observation);
    process.stdout.write(`captured ${session.repository} run ${session.runId} ticket ${session.ticket} role ${session.role} pid ${session.pid}\n`);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = 2;
  }
}
