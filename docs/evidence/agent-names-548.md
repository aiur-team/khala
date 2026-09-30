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
