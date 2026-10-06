import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { readStack, registrationSecret } from '../../fixtures/live/stack';
const exec = promisify(execFile);
describe.skipIf(process.env.KHALA_E2E_LIVE !== '1')('hosted encryption across process restore', () => {
  it('decrypts offline messages, applies an offline mode command, and resumes after exit', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'khala-1246-live-'));
    try {
      const homeserver = process.env.KHALA_CRYPTO_TEST_HOMESERVER ?? readStack().homeserver;
      const secret = process.env.KHALA_CRYPTO_TEST_SECRET ?? registrationSecret();
      const { stdout } = await exec(process.execPath, ['--import', 'tsx', 'fixtures/crypto-store/live-proof.ts', homeserver, root], {
        cwd: path.resolve(import.meta.dirname, '../..'), timeout: 150_000, maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, KHALA_CRYPTO_TEST_SECRET: secret },
      });
      expect(stdout).not.toContain(secret);
      const result = stdout.split('\n').find(line => line.startsWith('{"initialDecrypted"'));
      expect(result && JSON.parse(result)).toEqual({ initialDecrypted: true, abruptRestartMessages: 2, offlineModeApplied: true, historyDecrypted: true, savedDeviceCredentials: true, exitResumeDecrypted: true });
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 180_000);
});
