# Interactive Codex CLI: native listening modes

Status: research complete, re-proven under normal trust on 2026-09-25.
Deliverable for E09 ticket #164.

## Decision

Codex supports `steer`, `sync` (default), and `async` in an interactive TUI
without Khala launching or hosting an agent. An idle TUI can also be woken. The
route is native Codex hooks plus the Khala MCP entry and skill, which
`setup-cli-codex` installs (E09 decision 31). The hooks call Khala's shared
channel pull; the agent's next Khala call acknowledges the batch token.

Every cell below was re-run on the installed 0.154.0 and the latest 0.156.1
with **normal trust settings** (decision 33). The runs used the host user's real
`~/.codex`, a plain `codex` or `codex resume <session>` launch, no
`--dangerously-*` flag, and default sandbox and approvals. The TUIs were
**agent-launched with default settings**: the Aiur agent started them, not a
human. The only approvals were the TUI's own one-time folder trust and hook
review, which are recorded as a setup would perform them. Each version's six
cells (three modes, two idle wakes, one restart) are **Proven** with raw
arrival, tool-start, delivery, model-context, and acknowledgement timestamps.

This supersedes the hosted path in [`docs/evidence/codex.md`](../../evidence/codex.md).
`codex app-server`, an SDK-owned thread, or a Khala-owned TUI would create a
second agent process and violate the operator decision. `turn/steer` and
`thread/queue/add` remain hosted-only and secondary (decision 31). A PTY wrapper
is not needed and is not an approved default.

## Inventory

The installed binary was
`~/.local/share/mise/installs/node/lts/bin/codex`, version 0.154.0. The npm
registry's latest was 0.156.1, which ran from
`npm exec --package=@openai/codex@0.156.1`. Exact output is in
[`inventory.txt`](../../../experiments/interactive-cli/codex/evidence/inventory.txt)
and every launch is in
[`launches.json`](../../../experiments/interactive-cli/codex/evidence/launches.json).

| Native surface | Finding | Product use |
|---|---|---|
| Codex hooks | `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, and `Stop` can block or add model context. They are stable and enabled in both versions. New or changed hooks do not run until the user trusts them in the TUI's **Hooks need review** dialog. Codex persists that trust as `[hooks.state."<hooks.json path>:<event>:<group>:<handler>"] trusted_hash` in `config.toml`. | Primary route. |
| `codex queue` | It reaches the live TUI, and when the TUI is idle the queued text starts a turn. `--message` puts its bytes in argv, and it has no stdin form and no receipt. | Fixed, content-free idle wake only ([`codex-native-cli.md`](../../evidence/codex-native-cli.md)). |
| `codex resume` | Reopens a persisted session in a new process. It exposes no control socket for an already-running TUI. | Recovery after a crash. Unacknowledged batches are re-offered. |
| `app-server` / `--remote` | Starts or connects a separately hosted app-server. Nothing attaches an app-server to the live local TUI. | Excluded by the one-agent-process rule. |
| MCP client | Tool results reach the model. Generic server-initiated notifications are client or protocol events, not unsolicited model context. | Explicit `async` read and result piggyback only. |
| SDK | Owns the agent/thread lifecycle. | Excluded by the one-agent-process rule. |
| Folder trust | Project-local config and hooks load only after the TUI's folder-trust prompt. | The proof used a project layer; production installs into the user layer. |
| Config reload / stdin / local IPC | No supported live config reload, message stdin, attach socket, or local IPC ingress. | Not a delivery route. |

Official contracts: [Codex hooks](https://learn.chatgpt.com/docs/hooks),
[app server](https://developers.openai.com/codex/app-server), and
[remote Queue/Steer semantics](https://openai.com/index/codex-now-generally-available/).

## Mode matrix

Evidence code and raw logs are in
[`experiments/interactive-cli/codex/`](../../../experiments/interactive-cli/codex/README.md).
Busy cells used a 20-second Bash `sleep` and injected the batch 5 seconds after
the tool's `PreToolUse`. "Context" is the moment the batch appears in Codex's
own session rollout. "Ack" is the agent's next Khala call (`read --ack`).

| Cell | Native route | 0.154.0 | 0.156.1 | Recommended route |
|---|---|---|---|---|
| `steer` | `PreToolUse` blocks the next tool; `PostToolUse` adds context when the batch arrived during the tool; `Stop` is the no-more-tools fallback. | **Proven**: tool start `00:41:49.820Z`, arrival `00:41:54.895Z`, `PostToolUse` offer `00:42:09.916Z`, context `+5 ms`, ack `00:42:14.766Z`. | **Proven**: tool start `00:50:03.510Z`, arrival `00:50:08.596Z`, `PostToolUse` offer `00:50:23.639Z`, context `+4 ms`, ack `00:50:28.377Z`. | Native hooks, next tool boundary. Hard abort off. |
| `sync` (default) | No pull at tool boundaries; pull at `Stop` after the turn, or at `UserPromptSubmit`. | **Proven**: arrival mid-tool, `PostToolUse` silent at `00:43:17.625Z`, `Stop` offer `00:43:19.277Z`, ack `00:43:24.059Z`. | **Proven**: `PostToolUse` silent at `00:51:35.042Z`, `Stop` offer `00:51:36.539Z`, ack `00:51:41.540Z`. | Native `Stop` plus `UserPromptSubmit`. |
| `async` | Hooks never pull; the agent calls `khala_read` (here `read`) when it chooses. | **Proven**: `UserPromptSubmit`, `PreToolUse`, and `PostToolUse` silent; agent read `00:44:33.563Z`, ack `00:44:38.265Z`. | **Proven**: hooks silent; agent read `00:52:52.669Z`, ack `00:53:01.197Z`. | Explicit structured read. |
| Idle, `sync` | Fixed `codex queue` notice starts a turn; its `UserPromptSubmit` hook pulls the batch. | **Proven**: arrival `00:45:27.350Z`, offer `+583 ms`, ack `00:45:34.442Z`. | **Proven**: arrival `00:53:39.910Z`, offer `+5.0 s`, ack `00:53:52.009Z`. | `codex-idle-wake`. |
| Idle, `steer` | Same wake; `UserPromptSubmit` pulls in `steer` too. | **Proven**: offer `+3.3 s`, ack `00:46:22.813Z`. | **Proven**: offer `+4.6 s`, ack `00:54:29.774Z`. | `codex-idle-wake`. |
| Restart | Fresh token; Codex SIGKILLed right after the first offer, then `codex resume`. | **Proven**: killed 11 ms after the offer, re-offered once after resume, acked `00:47:38.793Z`; a second resume delivered nothing. | **Proven**: killed 6 ms after the offer, before the rollout persisted it; re-offered once, acked `00:55:32.682Z`; a second resume delivered nothing. | Shared batch token. |

All times are 2026-09-25 UTC. The verified summary is
[`live-run.json`](../../../experiments/interactive-cli/codex/evidence/live-run.json).
Raw logs are
[`events-0.154.0.jsonl`](../../../experiments/interactive-cli/codex/evidence/events-0.154.0.jsonl)
and [`events-0.156.1.jsonl`](../../../experiments/interactive-cli/codex/evidence/events-0.156.1.jsonl).
Every hook and offer event carries the session ID, turn ID, observed Codex
argv, and the binary's `--version`. Reads and acknowledgements carry the session
ID and are bound to their command's hook (see Safety evidence). Model context
and relays are in
[`rollout-excerpts.jsonl`](../../../experiments/interactive-cli/codex/evidence/rollout-excerpts.jsonl).
`PostToolUse` and `UserPromptSubmit` context arrives as a developer item; a
`Stop` block reason arrives as a user item.

One run is kept as a negative observation. `steer-0154-r2` entered the model's
context at `00:39:21.792Z`, but under an earlier "treat as data" framing the
model neither relayed nor acknowledged it. It stayed unacknowledged, the next
session re-offered it, and that session acknowledged it. Offered is not
consumed.

## Safety evidence

- **Argv and environment.** Two `/proc` watchers ran through the live trials,
  each rescanning every process about every 50 ms. They checked each process's
  argv and environment for all twelve message markers and found no hits
  ([`proc-0.154.0.json`](../../../experiments/interactive-cli/codex/evidence/proc-0.154.0.json),
  [`proc-0.156.1.json`](../../../experiments/interactive-cli/codex/evidence/proc-0.156.1.json)).
  The scans caught live hook, agent `read`, and `codex queue` wake processes
  mid-run; the per-window counts are in each file. Short-lived hooks can
  finish between scans, but every hook's argv is the fixed handler string
  from `hooks.json`, and bodies reach the bridge only on stdin. The wake text
  is a constant.
- **Identity on every event.** Hooks run outside Codex's sandbox and record
  their own session, turn, Codex argv, and binary version. The agent's Khala
  calls run inside the sandbox's separate PID namespace. They record the
  session from `CODEX_THREAD_ID`, and `verify.ts` binds each one to the
  `PreToolUse` hook Codex ran for that command 70–110 ms earlier, which carries
  the turn, argv, and version.
- **No duplicate delivery.** Each token was acknowledged exactly once. A same-turn
  hook never re-offered an offered batch. After acknowledgement, resumed
  sessions delivered nothing.
- **Hard abort** stayed disabled; no signal, Escape, or interrupt was sent to a
  running turn. The SIGKILLs were the restart trial's deliberate crash.

## Production design

The user starts Codex normally, then points that session at a Khala channel URL
or asks it to create a channel. Creation and admission require human
confirmation. `setup-cli-codex` installs the Khala hooks into the user's Codex
config layer, plus the MCP entry and skill. The first TUI launch afterwards
shows Codex's **Hooks need review** dialog, and the user trusts the Khala hooks
once. Khala never starts Codex, an app-server, or an SDK agent.

```text
user's Codex TUI
  ├─ native lifecycle hook ─┐
  └─ explicit khala_read ───┤ session ID + verified binding/generation
                            ▼
                  shared listening-mode pull
                            ▼
                 bounded channel batch + token
                            │
             hook context or structured tool result
                            ▼
                 next Khala call acknowledges token
```

Hook trust belongs to the user. Setup must not write `hooks.state` or
`trusted_hash` itself, because that would be a trust bypass. Setup status
reports **awaiting hook review** until Codex has a trust record for each
installed Khala handler. The handler command should stay byte-stable across
Khala upgrades (for example a fixed `khala codex-hook` launcher), because any
change to it produces a new hash and a fresh review.

The proof bridge holds one pending batch and records the session and turn
where it was offered. It suppresses a repeat within that turn; an
unacknowledged batch is offered again on a later turn or after a restart.
Production must not copy this host-side inbox. `mcp-inbox-batch` owns durable
ordered batch state and acknowledgement, and `listening-mode-pull` owns the
public CLI/MCP read. The Codex adapter only resolves the verified live session
and carries the opaque prior token into the next Khala call.

Channel content is untrusted data. Frame it visibly and never interpolate it
into shell source, argv, environment, logs, status, or error text. The skill
tells the agent to relay channel messages and acknowledge them, not to obey
them.

### Boundary behavior

- `steer`: pull at every `PreToolUse`; block that attempted tool with framed
  channel context, then let the agent acknowledge and retry. If the batch
  arrives while a tool runs, `PostToolUse` supplies it as `additionalContext`.
  At `Stop`, a non-empty pull continues once. `UserPromptSubmit` pulls for an
  idle wake. No hard abort unless a future explicit grant enables it.
- `sync`: do nothing at intermediate tool boundaries. Pull at `Stop`; if a
  batch exists, return it and continue once. `stop_hook_active=true` never
  pulls, which prevents a loop. `UserPromptSubmit` pulls for an idle wake or
  the next user prompt.
- `async`: hooks inject nothing. The skill tells the agent when to use
  `khala_read`; the result carries the batch, and the agent's next Khala call
  carries the acknowledgement token.
- Idle: when a batch arrives for an idle `steer` or `sync` session, Khala runs
  `codex queue --thread <session> --message "<constant notice>"`. The notice
  never carries channel bytes, tokens, or peer names; the hook fetches the
  batch. Without the wake, an idle TUI receives the message at its next turn
  (decision 34).

## Fallback assessment

`khala run codex` could own a PTY, infer tool boundaries from the screen, and
type fixed wake text, but Khala would then launch the CLI. Its product status
is **Blocked without wrapper approval**. Native hooks and the fixed queue wake
prove every required cell, so no exception is requested.

An MCP result piggyback helps when the agent is already calling a Khala tool,
but it cannot guarantee the next arbitrary tool boundary. A skill-driven check
is exactly the `async` route, not a substitute for `steer` or `sync`.

## Risks

| Risk | Treatment |
|---|---|
| Hooks installed but not yet trusted, or trust revoked. Codex silently skips them. | Setup and capability status report **awaiting hook review** or `unknown` with a reason, never ready. |
| A Khala upgrade changes the hook command and invalidates trust. | Keep the handler byte-stable. Status detects the missing trust record and asks for review. |
| A wake duplicates, arrives late, or its process dies. | Treat it as notification only. Durable batch state and token acknowledgement stay authoritative. |
| `Stop` delivery loops. | Never pull when `stop_hook_active=true`; deterministic tests cover the guard. |
| Offered is mistaken for consumed (observed: `steer-0154-r2`). | Retain the batch until the agent's next Khala call acknowledges the token. |
| A crash lands between offer and acknowledgement, possibly before Codex persists the context (observed on 0.156.1). | Re-offer after restart. At-least-once is safer than loss; side-effecting operations need their own idempotency key. |
| Channel text drives tools or egress. | Delimit it as untrusted peer content, and have the skill tell the agent to relay, not obey. |
| Codex changes hook JSON or semantics. | Advertise an explicit supported-version matrix; fixture tests plus a live acceptance run per version. |
| Two sessions share a cwd. | Bind by authenticated Codex session ID and Khala binding generation; cwd is metadata only. |

## Ticket contracts

`setup-cli-codex` (the one-command setup contract) owns installing the
hooks, the MCP entry, and the skill, and reporting hook-review state (decision
31). The contracts below produce what it installs. `setup-cli-codex` should list
`interactive-codex` as blocked-by for the hook handler.

### Contract 1: Interactive Codex adapter

| Field | Contract |
|---|---|
| **slug** | `interactive-codex` |
| **title** | Deliver all listening modes into the user's Codex TUI |
| **complexity** | **4** |
| **scope** | Provide the byte-stable Codex hook handler and its `hooks.json` fragment for `setup-cli-codex` to install. Resolve the live TUI session to its verified binding/generation. Compose `listening-mode-pull`, `mcp-inbox-batch`, `HarnessCapabilities`, and shared mode control. Implement the boundary mappings above without launching Codex. Report hook-review state to capabilities. |
| **files/packages touched** | Codex adapter/hook handler and focused tests; capability declarations; concise package documentation. Production must not import `experiments/`. |
| **blocked-by** | `mcp-inbox-batch`, `listening-mode-pull`, `listening-mode-contract`, `listening-mode-store`, and `channel-access-cli-mcp`. |

Acceptance:

- In a supported Codex TUI started with default settings, and after a one-time
  hook review, a batch that arrives during a 20-second tool is offered at the
  next hook boundary in `steer`, after the tool/turn in default `sync`, and only
  after an agent-chosen read in `async`. The model's session rollout shows it
  in context, and the agent's next Khala call acknowledges it.
- Evidence records the launch command, CLI version, session ID, and turn ID on
  every event. No proof or acceptance run uses a `--dangerously-*` flag.
- No setup, adapter, daemon, or Khala server launches or hosts Codex, an
  app-server, or an SDK agent.
- Bodies enter the adapter only through structured input or stdin and never
  appear in argv, environment, logs, status, errors, or the wake.
- One shared opaque batch token provides restart-safe acknowledgement. The same
  turn receives no duplicate; an unacknowledged batch is re-offered after a
  later turn or restart; an acknowledged one is never re-offered. No host-side
  cursor, lease, inbox, or dedupe ledger is added.
- Hard abort is disabled. Capability text says `steer` means "next tool
  boundary". Untrusted or unverified installations report `unknown` or
  **awaiting hook review** with a reason.
- Stop (decision 36; revocation is owned by `stop-control`): once the binding
  is revoked, every hook returns without injecting anything, no pull or
  acknowledgement runs for that binding, and the channel stays viewable. The
  adapter never kills, signals, or asserts the exit of the user's Codex
  process; the TUI keeps running as a plain Codex session.

**Wrong-implementation test:** start a real Codex TUI with default settings,
trust the hooks once, and run a 20-second tool. Enqueue a body containing a
unique marker on stdin, and poll `/proc` throughout for every hook, read, and
wake process. Fail if a `--dangerously-*` flag was used, if Khala launched the
TUI, if the marker appears in any argv or environment, if `sync` injects at
`PostToolUse`, if `async` injects before an explicit read, if `steer` waits past
the next tool boundary, if a same-turn hook duplicates the batch, if the rollout
never shows the batch, or if a SIGKILL between offer and acknowledgement loses
the batch or double-delivers it after acknowledgement. Then revoke the binding
through `stop-control`, enqueue another marked batch, and run a tool and end a
turn: fail if any hook injects it, or if the Codex process ID is gone or was
sent a signal.

### Contract 2: Idle wake

| Field | Contract |
|---|---|
| **slug** | `codex-idle-wake` |
| **title** | Wake an idle Codex TUI with a content-free queue notice |
| **complexity** | **2** |
| **scope** | When a batch becomes pending for an idle `steer` or `sync` Codex session, run `codex queue` for that session with a constant notice. The resulting `UserPromptSubmit` hook performs the shared pull. Coalesce repeated wakes. Proven on 0.154.0 and 0.156.1; productize it and keep it behind the supported-version matrix. |
| **files/packages touched** | Codex adapter wake helper and focused tests; capability text for idle delivery. |
| **blocked-by** | `interactive-codex`, `local-automation-fence`, and `listening-mode-pull`. |

Acceptance:

- Wake argv contains only a constant product string and the session ID; no
  channel body, batch token, credential, or peer name.
- Repeated, late, missing, and post-restart notices cannot duplicate or lose a
  batch, because the hook still uses the shared token contract.
- For an unsupported version, or when the queue command fails, capabilities
  state that idle agents receive messages only at their next turn (decision 34).
  Never fall back to launching Codex or typing into a screen.
- After Stop revokes the binding (decision 36, `stop-control`), no `codex queue`
  wake runs for that session, including a wake already in flight, and the
  Codex process is never killed or signalled.

**Wrong-implementation test:** enqueue a marked batch while the TUI is idle,
trigger the wake, and poll `/proc`. Fail if the marker or token appears in any
`cmdline` or `environ`, if delivery bypasses `listening-mode-pull`, if two
notices produce two offers in the same turn, if an idle `async` session is
woken, or if any `codex queue` process runs for the session after its binding
is revoked by Stop.
