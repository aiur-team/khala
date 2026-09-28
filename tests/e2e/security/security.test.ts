// Live acceptance entry for KHA-138 (`KHALA_E2E_LIVE=1 pnpm test:e2e -- tests/e2e/security/security.test.ts`).
//
// These are final integrated acceptance rows, distinct from the opt-in disposable
// SDK/Postgres relay component test. Each remains blocked until the exact protected
// owner/browser/native composition is exercised. All-skipped live mode still fails.

import { describeLive } from '../harness/live';

const RELAY_BLOCKER = 'blocked: needs the protected hosted owner/browser send path and its owned relay DB/log scan; the direct SDK relay component is narrower';
const REVIEW_BLOCKER = 'blocked: needs protected owner approval and an installed native existing-session receipt through openProductionConnector';
const RECOVERY_BLOCKER = 'blocked: needs retained-key profile reopen and separate total-device-loss readmission without old-history backfill';

// One entry per matrix row: the live gate passes an entry when any of its cases ran, so
// rows never share an entry that one passing row could satisfy for the others.
describeLive('KHA-138 relay confidentiality', liveCase => {
  liveCase('server records and logs hold neither canary nor key material', async ({ skip }) => {
    return skip(RELAY_BLOCKER);
  });
});

describeLive('KHA-138 review gate', liveCase => {
  liveCase('the exact approved event reaches the existing session', async ({ skip }) => {
    return skip(REVIEW_BLOCKER);
  });
});

describeLive('KHA-138 recovery', liveCase => {
  liveCase('retained endpoint reopens its own keys; total device loss has no history backfill', async ({ skip }) => {
    return skip(RECOVERY_BLOCKER);
  });
});
