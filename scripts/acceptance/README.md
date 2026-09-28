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
4. It creates the ticket pair with `agent:todo` (or the profile's normal dispatch label) and `model:codex`. The normal test driver runs on the Executor's Codex GPT-6 Sol default. `nativeParticipantPrompt` is the separate, deterministic text sent to the Executor-started interactive CLI fixture. The fixture's harness and model never choose the worker backend.
5. The Executor starts exactly one ordinary native TUI CLI fixture per ticket in a tmux pane, outside Khala. Before the fixture uses Khala, the Executor captures its session identity with the command below. The worker drives that fixture; the worker session never joins the channel. The runner grants each request only after you confirm it. A request is tied to its ticket when its session fingerprint matches the private fixture record.
6. It attributes each `READY` marker to a participant through the server timeline, then resolves the active binding through the authenticated owner's binding list, matching the harness and exact captured session fingerprint. The participant does not supply binding IDs. For each mode that both routes make effective, it requests the mode for both bindings through the owner's listening-mode route. A mode counts as effective only when the server's re-read confirms that binding generation both requests and runs it. It then announces the mode and waits for the ordered three-event handshake. A mode the server does not confirm is announced `unsupported` and stays unproven.
7. It posts `hold`, checks that both sessions are alive with the same identity, and then calls Stop with exactly the two recorded binding IDs and generations. It refuses a stale or mismatched target.
8. On failure or timeout before a successful Stop, it rechecks each captured fixture's exact owner request and uses the owner's per-request revoke route. The route fences a connected request's exact binding before reporting success; a refused or unavailable revoke is recorded as failed `requestCleanup`. The runner never widens cleanup to whole-channel Stop. It always closes the launcher, then reads the post-shutdown store snapshot, which it refuses to do while any launcher holds the internal root.
9. It returns a verdict (`verify.ts`) with a separate per-ticket `requestCleanup` outcome and closes only the issues it owns: the same repository, the `acceptance` label, the run marker line, and the run's creation window. A failed pair remains non-passing even when its request cleanup succeeds.

## Profiles

A profile is strict JSON, decoded by `decodeProfile` in `profile.ts`:

- `name`
- `repository`: must be `aiur-team/khala`
- `dispatchLabel`
- `khalaPackage`: an exact `@aiur/khala@x.y.z`, or `{ "tarball", "sha256", "commit" }` for a local tarball
- `timeoutMs`
- `roles`: two entries, `a` and `b`. Each has native-fixture `harness`, `provider`, `model`, exact `cliVersion` and the route's `HarnessCapabilities`. These are expected evidence values, never driver dispatch labels.

### OpenCode with DeepSeek and Claude (AC5)

The [AC5 profile generator](profiles/opencode-deepseek-claude.ts) fixes role A to OpenCode 1.17.10 with DeepSeek and role B to Claude Code 2.1.283 with Anthropic. It reads the current route capability declarations, pins the package from `acceptance:pack`, and writes only JSON to stdout. The runner's native fixture capture checks each installed CLI version and selected model before accepting a live result. Check `opencode models deepseek` and choose an exact model it advertises; the example uses `deepseek/deepseek-flash`, which must be replaced if the installed catalog differs. Claude's `opus` is a native model alias.

```sh
opencode models deepseek
pnpm --silent acceptance:pack --out /tmp/khala-acceptance-pack > /tmp/khala-acceptance-pack.json
pnpm exec tsx --conditions=khala-source scripts/acceptance/profiles/opencode-deepseek-claude.ts \
  /tmp/khala-acceptance-pack.json deepseek/deepseek-flash opus > /tmp/khala-ac5-profile.json
pnpm acceptance:live --profile /tmp/khala-ac5-profile.json --confirm-live
```

The generator never starts a CLI or calls a provider. The live command is opt-in and creates issues in `aiur-team/khala`; it requires the `acceptance` label, installed Khala native routes, and the Executor's two interactive fixtures. For the pinned capabilities, `steer` and `async` are shared proven modes. Claude `sync` remains experimental without its own owner grant, so the profile records it as skipped. A requested mode that the server does not confirm stays non-passing `unproven`.

### Native CLI fixture capture

For each new ticket, the normal Executor starts one interactive `claude`, `codex`, or `opencode` TUI in its own tmux pane under normal trust settings. Record the native CLI's own session ID, the observed provider/model and `--version` output from that fixture, and its exact launch argv and launch time in a private JSON observation file. The CLI must launch with an explicit `--model` or `-m` argument; the capture checks the native command and model flag against `/proc/<pid>/cmdline`. Record the actual TUI PID, executable, `/proc/<pid>/stat` start ticks (field 22), kernel boot ID, terminal from `/proc/<pid>/fd/0`, and tmux pane ID, rather than an app-server or SDK process. The capture verifies that tmux owns that terminal and runs `/proc/<pid>/exe --version` for an exact version match. A different ID, model, provider, version, or unavailable evidence leaves the native session unproven. The ticket's labels or worker prose cannot fill these fields.

For Codex and Claude, the outer Executor fixture driver opens `/status` in the native TUI and keeps the complete view visible before capture. Resize the pane if the session ID is clipped. The driver then dismisses the view so the native participant can perform ordinary Khala work. After the final handshake, the driver opens `/status` again and leaves it visible through the runner's hold barrier and Stop; the runner polls for both fresh identities before stopping. The capture and runner read the panes without sending keys or signals. Codex's status supplies session ID, provider, and model. Claude's interactive status supplies its session ID, selected model alias and full model ID, and Claude Max account; the image supplies its version. The observed Claude model may be the alias or full ID shown there, but it must match the exact launch flag.

For OpenCode, the native TUI must have completed at least one ordinary model turn before its first Khala operation. Its active pane title is joined to exactly one session in its own read-only SQLite store under the verified process's `XDG_DATA_HOME`; the latest assistant message supplies the exact provider and model IDs. The visible TUI provider and launch `--model` must agree. An untitled, ambiguous, missing, or model-free session is unproven. No capture command sends keys, launches an agent, or stops a CLI. These identity routes establish the native fixture only; they do not establish any listening mode or event-linked receipt by themselves.

The observation file must be owned by the Executor user and mode `0600`. After the runner prints the run ID and ticket number, but **before the native fixture's first Khala command**, capture it with:

```sh
pnpm exec tsx scripts/acceptance/capture.ts <private-executor-observation.json>
```

The JSON keys are `source` (`executor-native-tmux-fixture`), `repository` (`aiur-team/khala`), `runId` (12 lowercase hex digits), `ticket`, `role` (`a` or `b`), `sessionId`, `pid`, `harness`, `provider`, `model`, `cliVersion`, `versionOutput`, `startedAt` (ISO time), `processStartTicks`, `bootId`, `executable`, `argv` (array), `tty`, and `tmuxPane` (for example `%7`). The capture checks the live process and pane, records its own `capturedAt` time and native identity proof, and creates one exclusive mode `0600` record under `$XDG_STATE_HOME/khala-acceptance/native-sessions/`. Older records without that proof are ignored. It refuses a second capture for the same ticket/role. At grant, the runner checks the captured process and image plus the exact server-issued session fingerprint while the status view is dismissed. It refuses an access request created before `capturedAt` and never grants an unmatched request. At hold and after Stop, it rechecks the fresh native identity. Never put tokens or prompts in the observation; keep the file outside a worker checkout. The runner report includes only the safe provider/model/version/PID summary.

### Build under test

Until `@aiur/khala` is published, pack it locally from a clean tree:

```sh
pnpm acceptance:pack --out <directory>
```

It refuses tracked or untracked changes. It then packs through the release package gate (`scripts/agent-cli-package-gate.mjs`) in a fresh `git worktree` at `HEAD`, with dependencies installed from the lockfile. Ignored build output in your checkout, such as a leftover `apps/web/dist/internal-web`, never reaches the tarball. It refuses if packing moved the worktree's `HEAD` or changed its tree. It writes `<tarball>.provenance.json` next to the tarball and prints the `khalaPackage` value to paste into the profile:

```json
{ "tarball": "/abs/path/aiur-khala-0.1.0.tgz", "sha256": "<64 hex>", "commit": "<full commit id>" }
```

Before starting any process, the runner copies the tarball into a private directory under `$XDG_STATE_HOME/khala-acceptance/packages/` and hashes the copy. It refuses the run when that digest, or the provenance record's commit and digest, differ from the profile. `npx --yes --package <copy> khala …` then runs only that copy. A directory, a relative path or a workspace tree is never run. The report's `khalaPackage` field records the build that ran: the npm pin, or the tarball's source path, measured sha256 and commit.

A mode runs only when `listeningModeView` makes it effective for both routes. Every other mode is reported as skipped and is never replaced by another.

## Evidence and verdicts

Only durable evidence counts:

- the store snapshot: bindings, event order, client transactions, and `agent_acknowledged` receipts linked to each handshake event;
- the private Executor fixture capture for the exact repository/run/ticket/role, checked again against the live process at the hold barrier and after Stop;
- GitHub metadata;
- the runner's own Stop record.

Agent prose, comments and closed tickets prove nothing. Absent evidence is `unproven`, contradicting evidence is `fail`, and a run that errored or timed out is `fail`. Only `pass` passes.

A live run still requires owned event-linked receipt facts and a proven mode route. A binding whose CLI has not reported a trusted, proven identity and version leaves unsupported modes unproven (decisions 34 and 37). The runner never promotes a requested model label or an app-server identity into native session proof.

Offline tests: `pnpm test:e2e -- tests/e2e/acceptance`.
