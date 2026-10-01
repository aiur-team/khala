# Live acceptance runner

## Candidate evidence for local E2E lanes

`candidate.ts` exports `allocateNamespace`, `fingerprintEffectiveConfig`,
`verifyArtifact`, `validateCandidate`, `validateJournal`, and `writeEvidence`.
Use a new private namespace for **each** run. Measure the source commit,
lockfile, source inputs and built artifacts before creating the candidate;
verify artifact bytes against their recorded SHA-256 digests. The installed CLI
tarball is the `cli` artifact. Record exact native CLI versions and service image
digests. In dependency-free internal mode, record hosted web, function,
connector, hook, and plugin components and service images as `N/A`.

The secret-free effective config fingerprint covers stable, allowlisted values;
record local versus production origin, CSP, and provider differences separately.
The origin must be exactly an HTTP(S) origin, with no invite path, query, or
credentials. An external candidate must include at least one service-image digest.
Comparing candidates refuses source/input, build, image, config, native-version,
and namespace drift. For each operation, supply separate ordered `pending`,
`released`, `model-consumed`, `acknowledged`, and `durable-browser-visible`
receipts with the same operation, event, binding and generation IDs. The model
stages require model-origin evidence; browser visibility requires a durable
browser-origin observation. A queued release, HTTP response, empty read, or
optimistic UI state cannot fill those receipts. `writeEvidence` writes an
exclusive mode `0600` JSON file containing only validated identifiers and
digests. Never pass credentials, invite URLs, message bodies, ciphertext,
private keys, browser storage, or raw terminal/service logs into it.

Focused contract tests: `pnpm test:e2e -- tests/e2e/acceptance/candidate.test.ts`.
This evidence format does not assert that either real three-party canary ran.

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

## Isolated internal native canary (draft)

`pnpm test:internal:native` is the opt-in, local three-party runner. It uses a clean-tree `acceptance:pack` tarball, two new tmux PTYs, a short private `/tmp/khala-native-*` home, and an isolated headless Chromium profile. It never attaches to an existing agent or browser. The CLI reports the first missing stage as JSON with `kind: "unproven"`; a setup or capability check is not an E2E pass. Only `verify` may produce `pass`, after model-side read/send, exact owner ACKs, peer ACKs, and replies visible following browser reload. The existing packaged smoke remains the fast synthetic route check.

Use Node 22.23.2 and a clean committed checkout. The example pins the cached native Codex 0.159.3 Linux binary; verify the digest before using it. Codex 0.160.0 may be pinned only for the explicit manual MCP path (`setup-manual-codex`); that path proves deliberate `khala_read`/`khala_send`, not Sync, Steer, or idle wake. A version or digest mismatch is `unproven` before room creation.

```sh
PIN=$(mktemp -d /tmp/khala-codex-pin-XXXXXXXX)
chmod 700 "$PIN"
npm install -g --offline --ignore-scripts --prefix "$PIN" @openai/codex@0.159.3
CODEX_BIN="$PIN/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex"
CODEX_SHA=8bf204b36a2f6dd0dab73aa2f639892e67ef9ac8befccb4a05b1496ebf25c479
test "$(sha256sum "$CODEX_BIN" | cut -d ' ' -f 1)" = "$CODEX_SHA"
export npm_config_store_dir="$PWD/.aiur-runtime/pnpm-store"
mise exec node@22.23.2 -- pnpm acceptance:pack --out "$TMPDIR/khala-803-pack"
PACK=$(find "$TMPDIR/khala-803-pack" -maxdepth 1 -name 'aiur-khala-*.tgz' -print -quit)
RUN=$(mise exec node@22.23.2 -- node --import tsx scripts/internal-native-canary.mjs init "$PACK" --codex-bin "$CODEX_BIN" --codex-sha256 "$CODEX_SHA" | jq -r .directory)
mise exec node@22.23.2 -- node --import tsx scripts/internal-native-canary.mjs auth-handoff "$RUN"
mise exec node@22.23.2 -- node --import tsx scripts/internal-native-canary.mjs auth "$RUN"
mise exec node@22.23.2 -- node --import tsx scripts/internal-native-canary.mjs setup "$RUN"
mise exec node@22.23.2 -- node --import tsx scripts/internal-native-canary.mjs start-agents "$RUN" gpt-5.3-codex claude-sonnet-4-6 --external-pty
```

`auth-handoff` copies only `~/.codex/auth.json` and `~/.claude/.credentials.json` into the mode-0700 run home as mode-0600 files. It never prints credentials or copies `~/.claude.json`. `auth` checks both providers' native login status before PTY launch. If either needs interactive sign-in, complete it under the printed private `HOME`/`CODEX_HOME` and rerun `auth`; do not import general account settings. The private profile and PTYs may contact model providers. Khala's Node transport is constrained to loopback and Chromium uses a loopback-only proxy bypass; outbound attempts are counted without logging destinations.

`--external-pty` prints two private launcher paths. Run each launcher in its own persistent terminal; this is the recommended path for an Executor driving fresh sessions outside an agent sandbox that reaps detached tmux servers. Without that flag, `start-agents` creates a private tmux socket and prints attach commands. In each fresh native TUI, complete one real model turn, review its native trust dialog, and copy its `/status` session ID. The exact IDs must appear in that run's private native session files. Then:

```sh
mise exec node@22.23.2 -- pnpm --silent test:internal:native open "$RUN" '<codex-session-id>' '<claude-session-id>'
mise exec node@22.23.2 -- pnpm --silent test:internal:native browser "$RUN"
```

`open` prints a private owner URL and a channel URL. The browser action redeems the owner URL in its own headless profile and prints a CDP loopback endpoint. Use that endpoint to drive the browser independently; `pnpm internal:native:browser "$RUN" ...` is a small CDP helper. Ask each existing model to request the channel through its installed Khala tool, using the channel URL, then review each pending request in the browser:

```sh
pnpm --silent internal:native:browser "$RUN" approve codex
pnpm --silent internal:native:browser "$RUN" approve claude
pnpm --silent test:internal:native challenge "$RUN"
```

The challenge output is tied to the exact session digests and approved binding generations. Send its `body` through the browser (`printf '%s' "$BODY" | pnpm --silent internal:native:browser "$RUN" send`). In the same PTYs, have each model call `khala_read`, acknowledge as its native route requires, and call `khala_send` with its computed reply. Have each then read and acknowledge the peer reply. Do not paste the challenge text into the PTYs; it must enter through the browser. For each reply, pipe its expected text to `internal:native:browser "$RUN" contains`; that command reloads the page before recording visibility. Finally run `pnpm --silent test:internal:native verify "$RUN"`. It writes sanitized #805 candidate/receipt envelopes only when all gates pass. Run `... stop "$RUN"` to end owned processes or `... destroy "$RUN"` to end them and remove the private home after evidence review.
