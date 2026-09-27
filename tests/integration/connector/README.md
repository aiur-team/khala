# KHA-133 live base-runtime acceptance

This is an opt-in integration test for the exact Codex native route and version supported by the installed connector. It creates a disposable Synapse/Postgres project, uses independent Chromium Matrix clients, catches up verified encrypted events into the real SQLite ledger, invokes the real Codex native queue and local inbox, kills the connector after queue acceptance but before receipt persistence, then restarts from the same disk. The owner release is an authenticated test fixture, not a browser human approval. It does not establish model consumption or acceptance for another harness/version.

Default test discovery does not run the live proof. Direct execution without KHALA_42_LIVE=1 reports skipped/not run. Explicit opt-in with a missing or unproven native fixture fails as not_observed_native_gate; it never turns a fake harness or skipped case into acceptance.

Prepare an isolated, disposable Codex 0.154.0 session and its reviewed Khala hooks. Do not use a personal or production thread. The secret-free JSON descriptor has v:1, disposable:true, harness:"codex", sessionId:<designated running disposable thread UUID>, workdir:<absolute disposable workdir>, and codexHome:<absolute disposable CODEX_HOME>. The test never creates or replaces the native session. The current account/model gate may prevent this run and must be reported as not_observed.

From the repository root, with Docker, Node, pnpm and Chromium installed, run these commands in order:

1. pnpm install --frozen-lockfile
2. pnpm -C experiments/browser-crypto install --frozen-lockfile
3. pnpm -C experiments/browser-crypto build
4. pnpm -C apps/connector exec vite build --config vite.matrix.config.mjs
5. pnpm exec tsc -p tests/integration/connector/tsconfig.json
6. node --import tsx --test tests/integration/connector/crash-boundary.test.ts tests/integration/connector/native-gate.test.ts tests/integration/connector/supervisor.test.ts
7. KHALA_42_LIVE=1 KHALA_42_NATIVE_SESSION=/absolute/path/to/disposable-session.json node --import tsx --test tests/integration/connector/live.proof.ts

If the host's /tmp user quota is exhausted, set TMPDIR to an existing owner-private directory with space. The proof places Matrix credentials only in a mode-0600 packet under its temporary directory and removes its own scratch state and random Docker project in finally. It never prints tokens, private keys, or message bodies. An abrupt test-runner kill may leave its own random Docker project; inspect its khala-backend-spike-* label and remove only that project.

The accepted IPC message contains only release, binding, generation and session identifiers. The supervisor sends SIGKILL only after the real createHostedCodexHarness returns a harness-sourced harness_queued receipt. The dispatcher is suspended before its receipt transaction. On restart the test requires the same binding/device/session, an outcome_unknown record, zero further native submissions, one exact released local-inbox item, and another encrypted pending item that remains reviewable and absent from that inbox. The queue receipt is native acceptance, not proof that a model consumed the item. Browser review, real owner control path, and hosted deployment remain separate acceptance work.
