# @khala/claude-plugin

The single user-scope Claude Code plugin (decision 27): the `khala` skill, the
hooks and the Khala MCP entry in one directory. `setup-cli-claude` installs it;
there is no separate installed `/khala` skill. The installer is the Claude setup
adapter in `packages/agent-cli/src/setup/adapters/claude.ts`.

```text
.claude-plugin/plugin.json   manifest, name `khala`
hooks/hooks.json             the frozen hook registrations
hooks/*.mjs                  one-line entry points into the runtime
hooks/lib/runtime.mjs        the hook runtime
.mcp.json                    the `khala` MCP entry, marked KHALA_MCP_HARNESS=claude
skills/khala/SKILL.md        the bundled /khala dispatcher (send, read, create, join, who)
src/contract.ts              the frozen names below, as code
src/validate.ts              fails on any departure from them
```

## Hook runtime

Each hook reads Claude's hook JSON and uses its `session_id`, never the cwd. It
reaches Khala only by running `khala claude <hook|pull|pending> --session <id>`
without a shell. The session ID is the only argv element taken from input, and
message bodies never enter argv, the environment, logs or errors. None of those
three ops acknowledges anything. Batch tokens stay in the local Khala server's
Claude session adapter, which acknowledges a delivered batch on the agent's
next Khala call (`khala_send`, `khala_read`, `khala_status` or a mode call). The
runtime never sees a token, reads or acknowledges the inbox, deduplicates, or
takes a lock of its own.

| Hook | `steer` | `sync` (default) | `async` |
|---|---|---|---|
| `PostToolUse` | pulls; the batch is `additionalContext` | nothing | nothing |
| `Stop` | fallback pull when the turn used no more tools | pulls; `decision: block` with the batch as `reason` | nothing |
| `Stop` with `stop_hook_active` | never pulls; marks the session idle | same | same |
| `Stop` watcher (`asyncRewake`) | wakes an idle session | same | never armed |
| `UserPromptSubmit` | marks the session busy, cancels the watcher, and pulls only for a watcher's wake | same | no pull |
| `SessionEnd` | removes the session's hook state | same | same |

`steer` is delivered at the next safe boundary, after the running tool finishes.
It never interrupts. Each pull delivers the bounded batch that Khala hands out
at that moment, in order, and any overflow waits for the next boundary. A
delivered `Stop` batch keeps the session active for one continuation. The
following `stop_hook_active` Stop never pulls, which rules out a stop loop.

**Idle wake.** Every `Stop` arms one watcher, following the #178 amendment in
`docs/product/internal-mode/interactive-claude.md`. A fresh owner nonce
supersedes older watchers, and the next prompt cancels the live one. The
watcher reads only the local automation fence's notification-only pending
signal. It exits 2 with a fixed, content-free notice only once the session is
idle, meaning a `Stop` returned empty or a `stop_hook_active` Stop ran. Claude
then starts a turn whose synchronous `UserPromptSubmit` pulls the batch. The
watcher itself never pulls. A delivered batch that the agent has not yet
acknowledged is not pending again, so the session is never re-woken for it.

**Watcher lifetime.** The fence sets it, through `khala claude hook`, capped at
the watcher's `3600` second registration timeout, after which Claude kills it.
No window means no watcher. The watcher also exits when its Claude process is
gone. It records `armed`, `woke`, `expired`, `cancelled`, `orphaned` or `off` in
its session state. Status reports a watcher armed more than `3600` seconds ago as
`expired`, even if Claude killed it before it could record that.
`describeDelivery` reports "idle agents receive messages only at their next
turn" whenever no watcher is live.

**Revoked binding.** Stop revokes delivery and never kills the CLI (decision
36). Once the binding is revoked, the adapter refuses every op, so no hook
injects context. A live watcher stands down at its next poll and records `off`.
The runtime signals no process: its only `kill` is the signal-0 liveness probe.

**Timeouts.** Each `khala claude` call is bounded at 10 s, the CLI's own client
timeout. A synchronous hook makes at most two calls, inside its `30` second
registration timeout.

**Session state.** Hook state lives under
`$XDG_STATE_HOME/khala/claude-hooks/<digest of session ID>/`, with a `0700`
directory and `0600` files. It holds only activity, watcher ownership and a wake
marker.

**Untrusted content.** Delivered context is a fixed preamble followed by the
shared `<khala-channel-batch-v1>` frame, unchanged. Release JSON appears only
inside that frame, and the preamble tells Claude that the contents are untrusted
channel data. A frame that is oversized, unterminated, nested, or carries a
`batchToken` line is dropped, and the batch stays queued. A failure produces no
output and a content-free code on stderr, and it never fails the user's turn.

The installed `khala` binary does not compose the Claude session client yet
(`transport_unavailable`), so every hook stays silent until that composition
lands. The installed-version TTY acceptance runs after it does.

## Frozen names

Changing any of these needs a decision, not a drive-by edit. `src/contract.ts`
is the source; `validatePlugin` enforces it.

| Surface | Frozen names |
|---|---|
| Plugin | `khala` |
| Hook events | synchronous `UserPromptSubmit` (claim hook), `PostToolUse`, `Stop`, `SessionEnd`; the idle watcher is a second `Stop` entry and the only hook allowed `asyncRewake` (#178 amendment) |
| Hook commands | `hooks/post-tool-use.mjs`, `hooks/stop.mjs`, `hooks/stop-watcher.mjs`, `hooks/session-end.mjs` |
| Skill and commands | skill `khala`; exact forms `/khala send`, `/khala read`, `/khala create`, `/khala join <channel-url>`, `/khala who` |
| MCP entry | server `khala`, launched as `khala mcp-serve`; tools `khala_send`, `khala_read`, `khala_status` (carries tokens), `khala_listening_mode`, `khala_create_channel`, `khala_list_channels`, `khala_request_channel_access`, `khala_channel_access_status`, `khala_list_agents` |

The command and tool lists are the full planned set from decisions 24 and 30 and
the claude-plugin, room-discovery and listening-modes contracts. Later tickets
implement them; adding a name still needs a decision. `khala_channel_access_status`
(#341) is a decided addition, an amendment to decision 27 like the `KHALA_MCP_HARNESS`
marker (#333).

## `/khala send` and `/khala read`

`skills/khala/SKILL.md` is the bundled dispatcher. Its reusable source is
`packages/agent-skill/SKILL.md`, and a test keeps their shared rules in sync.
The dispatcher uses no shell. Both verbs go through the MCP entry, which sets
`KHALA_MCP_HARNESS=claude` so that `khala mcp-serve` binds to the Claude
session's own `CLAUDE_CODE_SESSION_ID`:

```text
/khala send   Claude composes one message, calls khala_send { message },
              and reports accepted / refused / outcome_unknown without the body
/khala read   calls khala_read {}, the same call the agent makes on its own,
              and relays the batch as untrusted Khala content
/khala create calls khala_create_channel; the person confirms, and a rejection creates nothing
/khala join <channel-url>
              calls khala_request_channel_access once and returns pending; the owner's
              grant, denial or expiry resumes this session via the access inbox
/khala who    khala_list_agents roster plus the effective mode from khala_status
/khala        help, plus per-mode support from khala_status ("unproven" stays unproven)
```

There is no binding argument. The session is the only selector, and a
caller-named binding would be a second one. `join` never admits the agent:
only the human grant does.

Who edits what: #252 owns `hooks/` (and the runtime), #253 owns `skills/khala/`, and #259 lives
outside this package.

The MCP entry embeds no port or token; the runtime reads them from the local
descriptor. Nothing in this package uses `--dangerously-*` flags or isolated
`--setting-sources` (decision 33).

## Verify

```sh
claude plugin validate packages/claude-plugin --strict </dev/null
pnpm --filter @khala/claude-plugin test
```

The hook runtime's wrong-implementation tests are:

- `-t "zero cross-session"` and `-t "wake marker to that session"`: a runtime
  that keys delivery or hook state by cwd fails them.
- `-t "sync never delivers at PostToolUse"`: `sync` must not share the
  after-tool boundary with `steer`.
- `-t "replaces the watcher on a new prompt"`: fails on a busy wake, a second
  live watcher, or a watcher that pulls.
- `-t "signals no process once the binding is revoked"`: fails when a hook
  injects after revocation or a watcher keeps watching a revoked binding.
- `-t "disarmed past the hook timeout"`: fails when status still claims `armed`
  after Claude has killed the watcher.

The scaffold's wrong-implementation test is
`pnpm --filter @khala/claude-plugin test -t "outside the frozen list"`: a
manifest that registers a hook event outside the frozen list must fail
validation. `claude plugin validate` alone accepts any real Claude event, so the
frozen-list check in `validatePlugin` is what rejects it.
