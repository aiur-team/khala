# KHA-133 live base-runtime acceptance

This is an opt-in integration test for the exact Codex native route and version supported by the installed connector. It creates a disposable Synapse/Postgres project, uses independent Chromium Matrix clients, catches up verified encrypted events into the real SQLite ledger, invokes the real Codex native queue and local inbox, kills the connector after queue acceptance but before receipt persistence, then restarts from the same disk. The owner release is an authenticated test fixture, not a browser human approval. It does not establish model consumption or acceptance for another harness/version.

Default test discovery does not run the live proof. Direct execution without KHALA_42_LIVE=1 reports skipped/not run. Explicit opt-in with a missing or unproven native fixture fails as not_observed_native_gate; it never turns a fake harness or skipped case into acceptance.

Prepare an isolated, disposable Codex 0.157.1 GPT-6-Sol session with the normally reviewed Khala hooks, following `native-sol-sync.README.md`. Do not use a personal or production thread. Its `bind` command writes a mode-0600 `state/crash-descriptor.json` with the exact live TUI process witness, session, workdir, private Codex home, and preflight binding. The crash runner checks that witness before any Matrix or Docker effect, then mints a distinct crash ledger binding. It never creates or replaces the native session. A missing or changed witness remains not observed.

From the repository root, with Docker, Node, pnpm and Chromium installed, run these commands in order:

1. pnpm install --frozen-lockfile
2. pnpm -C experiments/browser-crypto install --frozen-lockfile
3. pnpm -C experiments/browser-crypto build
4. pnpm -C apps/connector exec vite build --config vite.matrix.config.mjs
5. pnpm exec tsc -p tests/integration/connector/tsconfig.json
6. node --import tsx --test tests/integration/connector/crash-boundary.test.ts tests/integration/connector/native-gate.test.ts tests/integration/connector/supervisor.test.ts
7. With the bound TUI still running, set `KHALA_42_NATIVE_SESSION` to its `state/crash-descriptor.json`, choose a nonexistent owner-private `KHALA_42_RECOVERY_FILE` named `/home/everdred/.cache/khala-executor/relay-recovery-<12 hex chars>.json`, and set `TMPDIR` to the matching private sibling `~/.cache/khala-executor/s-<same 12 hex chars>`. The short scratch and browser profile names keep Chromium's Unix socket within its 108-byte limit. Run `KHALA_42_LIVE=1 node --conditions=khala-source --import tsx --test tests/integration/connector/live.proof.ts` in the bounded test scope.

The runner creates its exact private scratch directory at `TMPDIR` and places Matrix credentials only in a mode-0600 packet there. Its normal cleanup removes its own scratch state and random Docker project. It never prints tokens, private keys, or message bodies. An abrupt runner kill may leave the recovery file naming that one `khala-closure-*` Docker project and its matching `s-<id>` scratch directory; use the bounded recovery helper for only that project and scratch path.

The accepted IPC message contains only release, binding, generation and session identifiers. The supervisor sends SIGKILL only after the real createHostedCodexHarness returns a harness-sourced harness_queued receipt. The dispatcher is suspended before its receipt transaction. On restart the test requires the same binding/device/session, an outcome_unknown record, zero further native submissions, one exact released local-inbox item, and another encrypted pending item that remains reviewable and absent from that inbox. The queue receipt is native acceptance, not proof that a model consumed the item. Browser review, real owner control path, and hosted deployment remain separate acceptance work.
