// Live acceptance entry for KHA-138 (`KHALA_E2E_LIVE=1 pnpm test:e2e -- tests/e2e/security/security.test.ts`).
//
// Each case is a matrix row that only a disposable live environment can prove: real
// relay ciphertext and logs, and real receipt in a user's existing session. None of
// the prerequisites exists in this repository yet, so each case skips with the
// blocking reason, and the live gate then fails the entry: an all-skipped live run
// is not acceptance. The local composition proof runs without live mode in the
// sibling files (`pnpm test:e2e -- tests/e2e/security/`). See
// docs/evidence/security-acceptance.md for what each row has and lacks.

import fs from 'node:fs';
import path from 'node:path';
import { describeLive } from '../harness/live';
import { listFiles } from './fixtures';
import { REPO_ROOT } from './inventory';

/** Why a live row cannot run, or null once its prerequisite exists and the case must be written. */
function relayBlocker(): string | null {
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'packages/messaging/package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  const relay = Object.keys(manifest.dependencies ?? {}).some(name => /matrix|megolm|olm|mls/i.test(name));
  return relay ? null : 'blocked: no encrypted relay adapter is wired (packages/messaging has no relay SDK)';
}

function connectorEntryBlocker(): string | null {
  // KHA-136: no production module calls createConnectorRuntime yet; only tests do.
  const callers = listFiles(path.join(REPO_ROOT, 'apps/connector/src'))
    .filter(file => file.endsWith('.ts') && !file.endsWith('.test.ts') && !file.endsWith(path.join('runtime', 'create.ts')))
    .filter(file => fs.readFileSync(file, 'utf8').includes('createConnectorRuntime('));
  return callers.length > 0 ? null : 'blocked: no production connector entry point composes the review gate';
}

function unwritten(row: string): never {
  throw new Error(`${row}: its prerequisite now exists; write this live case before claiming the row`);
}

describeLive('KHA-138 security boundaries', liveCase => {
  liveCase('relay confidentiality: server records and logs hold neither canary nor key material', async ({ skip }) => {
    const blocker = relayBlocker();
    return blocker ? skip(blocker) : unwritten('relay confidentiality');
  });

  liveCase('review gate: the exact approved event reaches the existing session', async ({ skip }) => {
    const blocker = connectorEntryBlocker();
    return blocker ? skip(blocker) : unwritten('review gate');
  });

  liveCase('recovery: approved restore recovers a prior event; key loss never falls back to plaintext', async ({ skip }) => {
    const blocker = relayBlocker() ?? connectorEntryBlocker();
    return blocker ? skip(blocker) : unwritten('recovery');
  });
});
