# Live acceptance runner

Acceptance 2 from [`docs/product/internal-mode/acceptance.md`](../../docs/product/internal-mode/acceptance.md) (AC3). This is a manual script. It creates two `acceptance`-labelled tickets in `aiur-team/khala`, the normal Aiur Executor works them, and the script then checks from durable evidence that the two Executor-owned CLI sessions exchanged messages over one channel.

```sh
pnpm acceptance:live --profile <profile.json> --confirm-live [--resume <channel-id>]
```

Run it on the Executor host, with `gh` authenticated for `aiur-team/khala`. It prints a JSON report. The exit code is `0` for `pass`, `1` for `fail` or `unproven`, and `2` for `refused` or a usage error.

## What it does

1. It takes the host lock for the repository: an exclusive SQLite (fcntl) lock under `$XDG_STATE_HOME/khala-acceptance/`. The kernel releases it when the process dies, and there is no TTL. A second run refuses, whatever its profile.
2. It stages the build under test (see [Build under test](#build-under-test)), then runs `npx <khalaPackage> status` and records the output. The optional hardening result never gates the run. It then preflights the repository, its labels and write access.
3. It starts the local server with `npx <khalaPackage> internal`, or `internal --resume <channel-id>`, and asks you to confirm the channel. It starts no agent.
4. It creates the ticket pair from the fixed prompt in `prompt.ts`.
5. It grants each access request only after you confirm it at the terminal. A request is tied to its ticket when the requester's session fingerprint matches the native session the Executor recorded.
6. It records each binding from the agent's `READY` announcement, attributed by the server. For each mode that both routes make effective, it requests the mode, announces it, and waits for the ordered three-event handshake.
7. It posts `hold`, checks that both sessions are alive with the same identity, and then calls Stop with exactly the two recorded binding IDs and generations. It refuses a stale or mismatched target.
8. It always closes the launcher, even after a failure or timeout. It then reads the post-shutdown store snapshot, which it refuses to do while any launcher holds the internal root.
9. It returns a verdict (`verify.ts`) and closes only the issues it owns: the same repository, the `acceptance` label, the run marker line, and the run's creation window.

## Profiles

A profile is strict JSON, decoded by `decodeProfile` in `profile.ts`:

- `name`
- `repository`: must be `aiur-team/khala`
- `dispatchLabel`
- `khalaPackage`: an exact `@aiur/khala@x.y.z`, or `{ "tarball", "sha256", "commit" }` for a local tarball
- `timeoutMs`
- `roles`: two entries, `a` and `b`. Each has `harness`, `provider`, `model`, `labels` and the route's `HarnessCapabilities`.

### Build under test

Until `@aiur/khala` is published, pack it locally from a clean tree:

```sh
pnpm acceptance:pack --out <directory>
```

It refuses tracked or untracked changes, packs through the release package gate (`scripts/agent-cli-package-gate.mjs`), and refuses if packing moved `HEAD` or changed the tree. It writes `<tarball>.provenance.json` next to the tarball and prints the `khalaPackage` value to paste into the profile:

```json
{ "tarball": "/abs/path/aiur-khala-0.1.0.tgz", "sha256": "<64 hex>", "commit": "<full commit id>" }
```

Before starting any process, the runner copies the tarball into a private directory under `$XDG_STATE_HOME/khala-acceptance/packages/` and hashes the copy. It refuses the run when that digest, or the provenance record's commit and digest, differ from the profile. `npx --yes --package <copy> khala …` then runs only that copy. A directory, a relative path or a workspace tree is never run. The report's `khalaPackage` field records the build that ran: the npm pin, or the tarball's source path, measured sha256 and commit.

A mode runs only when `listeningModeView` makes it effective for both routes. Every other mode is reported as skipped and is never replaced by another.

## Evidence and verdicts

Only durable evidence counts:

- the store snapshot: bindings, event order, client transactions, and `agent_acknowledged` receipts linked to each handshake event;
- the `native_session` record in the Executor's per-ticket `.agent_events.jsonl`, read from `AIUR_LOGS_ROOT`, which defaults to `~/.aiur/logs`;
- GitHub metadata;
- the runner's own Stop record.

Agent prose, comments and closed tickets prove nothing. Absent evidence is `unproven`, contradicting evidence is `fail`, and a run that errored or timed out is `fail`. Only `pass` passes.

Today a live run cannot pass, for three reasons: the internal server composes no listening-mode control (#392), no receipt facts are recorded in internal mode, and Aiur logs no `native_session` record. Those gaps belong to their owning tickets, not to this runner.

Offline tests: `pnpm test:e2e -- tests/e2e/acceptance`.
