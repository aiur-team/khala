# Agent naming verification (#548)

Verified 2026-09-29 in the isolated `548-strict-names` worktree. No production
services or data were used.

- Focused contracts, messaging, connector projection/storage, CLI reads, control
  authority, timeline controller, and snapshot publisher tests: 159 passed,
  one existing platform-dependent CLI test skipped.
- Channel and fictional showcase browser tests: both passed, including desktop
  and phone widths.
- Full `pnpm typecheck`, `pnpm lint`, and `pnpm build`: passed. Full typecheck
  and lint plus the web build were rerun successfully after the final
  snapshot-publisher extraction.
- Disposable native proof: `node --conditions=khala-source --import tsx
  tests/integration/agent-names-live.ts` passed against Synapse 1.161.0. Four
  participants use separate browser crypto stores. A late human and agent can
  decrypt an encrypted current-name snapshot while pre-join text and rename
  events remain inaccessible. The wire snapshot does not contain its plaintext
  name. The disposable Docker project and volumes are removed afterward.
- Local four-participant proof:
  `apps/internal/src/composition/internal-delivery/agent-naming-proof.test.ts`
  passed with real SQLite, HTTP, separate agent disk inboxes, and CLI reads.
  Foreign-human and agent rename writes are rejected; retry produces one rename;
  both agents receive ordered metadata; historical bylines remain unchanged.
- Production publisher helper tests verify owner-only snapshot writes, source
  rename identity, stable transaction IDs across retries/tabs, failed writes,
  and an obsolete-generation fence. The native test validates the Matrix
  encryption/history primitive; it does not execute the deployed hosted
  membership publisher or the hosted approval-to-native-delivery path.

The ordered projection tests cover an earlier held message followed by a rename,
restart/retry, a rename inside one approved release, split acknowledgements,
legacy committed intake migration, and crash recovery after an inbox append.
The projection stores approved bytes only; held bodies stay outside its journal.

## Integration with main through b657d8a4

Integrated the exact main commits containing #607 initial decryption and #608
unavailable timeline rows. Naming remains in the shared Matrix event projection;
the complete name-history scan and owner-only publisher remain present. Explicit
historical event IDs remain intact so paginated ciphertext does not inflate the
live unread count. Unavailable rows stay visible while decrypted messages wait
for the name-history check.

Full typecheck, 59 combined web tests, 20 messaging timeline/name tests, and
targeted ESLint passed. The 25 screen/evidence tests passed again after restoring
the name-readiness gate. Earlier current-main integration also passed 22
admission tests, with separate assertions for admission claims and durable
forward/reverse agent identities.

Browser verification was attempted twice, including a sequential retry with an
owner-private temporary directory. Chromium failed during launch, before page
execution, with `HistoryService::Init` / `Zygote could not fork` errors. The
earlier passing browser and native proofs above remain prior-head evidence.
The original independent review found no actionable bugs; a follow-up review
agent could not run because of the session thread limit. The final merge was
reviewed manually.

## Independent review fixes

The independent review of `b659b671` identified two attribution gaps. Both were
reproduced with failing tests before the fixes:

- A page with an undecryptable event could incorrectly finish name replay.
  Contract pages now retain unavailable event IDs. The controller reports
  incomplete history and withholds decrypted bylines until those events resolve;
  late-key replacement restores name readiness without losing unavailable rows
  or the explicit historical IDs introduced by #608.
- A departed agent with no readable authored message was absent from name
  replay. The owner-authenticated room participant endpoint now resolves bounded
  historical target IDs through the durable room identity directory. Naming
  timeline items carry that authenticated target identity; projection replays
  the event while retaining owner checks.

CI attempt 2 also exposed an inventory omission for the existing agent
participant endpoint. Its metadata-only security coverage is now declared,
and all 14 inventory tests pass. The endpoint returns room identities rather
than held content or mutable current names.

After these fixes: 75 focused web tests, 56 control authorization/directory
tests, 20 messaging timeline/name tests, and all 754 contract tests pass. Full
typecheck, lint, and build pass. After stale temporary files were cleaned by
the operator, the bounded sequential channel browser test passed using normal
`/tmp`. The full hosted membership/approval/native-delivery proof remains
separate and outstanding.
