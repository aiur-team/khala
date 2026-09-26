// Live acceptance entry for KHA-138 (`KHALA_E2E_LIVE=1 pnpm test:e2e -- tests/e2e/security/security.test.ts`).
//
// Each entry is a matrix row that only a disposable live environment can prove: relay
// records and logs, real receipt in a user's existing session, and messaging key
// recovery. None of their prerequisites was available, so each case skips with the
// blocking reason, and the live gate then fails the entry: an all-skipped live run
// is not acceptance. The local composition proof runs without live mode in the
// sibling files (`pnpm test:e2e -- tests/e2e/security/`). See
// docs/evidence/security-acceptance.md for what each row has and lacks.

import fs from 'node:fs';
import path from 'node:path';
import { describeLive } from '../harness/live';
import { listFiles } from './fixtures';
import { REPO_ROOT } from './inventory';

/**
 * The relay is reached only through the human browser flow. Proving server records and
 * logs hold no plaintext or key material needs a disposable Synapse deployment with
 * database and log access. The KHA-132 descriptor (tests/integration/human) gives API
 * access only, and no such environment was available to write this case against.
 */
const RELAY_BLOCKER = 'blocked: needs a disposable Synapse deployment with database and log access; the KHA-132 live descriptor exposes the client API only';

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

// One entry per matrix row: the live gate passes an entry when any of its cases ran, so
// rows never share an entry that one passing row could satisfy for the others.
describeLive('KHA-138 relay confidentiality', liveCase => {
  liveCase('server records and logs hold neither canary nor key material', async ({ skip }) => {
    return skip(RELAY_BLOCKER);
  });
});

describeLive('KHA-138 review gate', liveCase => {
  liveCase('the exact approved event reaches the existing session', async ({ skip }) => {
    const blocker = connectorEntryBlocker();
    return blocker ? skip(blocker) : unwritten('review gate');
  });
});

describeLive('KHA-138 recovery', liveCase => {
  liveCase('approved restore recovers a prior event; key loss never falls back to plaintext', async ({ skip }) => {
    // Messaging key loss and restore run through the browser device, which only a live relay can exercise.
    return skip(RELAY_BLOCKER);
  });
});
