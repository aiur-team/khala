# Interactive Claude Code channel integration

Status: research and installed-version proof complete, 2026-09-24; re-proven under normal trust settings per E09 decision 33. Deliverable slug: `interactive-claude`.

## Verdict

Claude Code 2.1.282 delivers all three Khala listening modes into an already-running interactive CLI session, and wakes an idle session for `steer` and `sync`. Khala does not need to launch, host, or resume Claude. Every proof session was **agent-launched with default settings**: the proof harness started the normal interactive TUI in a terminal it controlled, with no flags. No human started these sessions, so they are not "user-started"; they exercise the same binary, settings sources, and trust prompts a user's own session uses.

- `steer`: a synchronous `PostToolUse` hook pulls one bounded batch and returns it as `additionalContext` at the next tool boundary. `Stop` is the fallback when the turn uses no more tools. Hard abort stays off.
- `sync` (default): a synchronous `Stop` hook pulls one batch and returns `decision: "block"` with the batch as `reason`, continuing the turn once. `stop_hook_active=true` returns nothing.
- `async`: hooks never pull. The agent decides when to call `khala_read`, which is bound to the real `CLAUDE_CODE_SESSION_ID`.
- Idle agents (decision 34): a background `Stop` watcher with `asyncRewake` wakes the idle session with a content-free marker, and a synchronous hook delivers the batch. It was proven 150 s into idle and again after re-arming. The committed 40-second `UserPromptSubmit` watcher was run live as required and **fails**; see [Idle delivery](#idle-delivery).
- Acknowledgement: in every run, the agent's next Khala call (`khala_send`) carried the retained batch token. A hook pull never acknowledges. A live SIGKILL restart fenced the old token and redelivered the batch with a fresh one exactly once.

The route is one setup-installed user-scope Claude plugin (hooks, the `khala_*` MCP entry, and the `/khala` skill), as `claude-plugin` already specifies. A `khala run claude` PTY wrapper is unnecessary and must not become the default.

## Normal-trust conditions (decision 33)

| Condition | What the proof did |
|---|---|
| Launch command | `cd <proof-project> && env -i HOME=~ USER PATH TERM=xterm-256color LANG=en_US.UTF-8 SHELL=/bin/bash claude`, inside a detached tmux pane. There are no CLI flags. `env -i` only strips the parent agent's `CLAUDE_*` variables so the child is a top-level session. `SHELL=/bin/bash` avoids a host zsh `cd` hook that hangs non-interactive shells. |
| Forbidden flags | None used: no `--dangerously-skip-permissions`, `--setting-sources`, `--plugin-dir`, `--mcp-config`, `--permission-mode`, or development-channel flag. |
| Settings sources | Default user, project, and local settings. The user's own plugins and the user-default `auto` permission mode stayed active, so Bash, `khala_read`, and `khala_send` calls were approved by Claude's auto-mode classifier. There were no manual approvals and no allow rules. |
| One-time approvals, as setup would do | `claude plugin marketplace add <repo>/experiments/interactive-cli/claude/marketplace --scope local` and `claude plugin install khala-proof@khala-proof --scope local`, run in the proof project. The folder-trust dialog ("Yes, I trust this folder") was accepted once on first launch. No separate hook or MCP trust prompt appeared. |
| Per-event identity | Every `events.jsonl` line carries `runId`, `cliVersion` (`2.1.282 (Claude Code)`), and the exact launch command; every hook and MCP line carries the Claude `sessionId`. |
| Isolation | Proof state lives beside the project, not inside it. A discarded first attempt kept state in the cwd, and Claude 2.1.282's per-command "what this command changed" view then displayed an inbox file. That run is excluded. |

## Mode matrix

All rows ran on 2.1.282 under the conditions above. Raw logs are in `runs/<run>/events.jsonl`, with TTY captures in `runs/<run>/tty.txt` under [`experiments/interactive-cli/claude/`](../../../experiments/interactive-cli/claude/). Times are UTC on 2026-09-25.

| Mode | Route | Native/fallback | Result | Evidence |
|---|---|---|---|---|
| `steer` | Plugin `PostToolUse` → `additionalContext` | Native plugin hook | **Proven.** Session `567bbda0…`: `Bash sleep 20` started at `00:34:42.979`. The message arrived at `00:34:47.245`. The tool ended at `00:35:04.229`, and the batch was released at that `PostToolUse` at `00:35:04.231`, 2 ms later. The next Khala call, `khala_send`, acknowledged it at `00:35:08.253`. The tool was not interrupted. | [`runs/steer`](../../../experiments/interactive-cli/claude/runs/steer/) |
| `sync` (default) | Plugin `Stop` → `decision: block` | Native plugin hook | **Proven.** Session `1cb99244…`: the message arrived at `00:35:31.065` during the tool. `PostToolUse` at `00:35:47.829` did not release it. `Stop` released it at `00:35:49.202`, `khala_send` acknowledged it at `00:35:53.832`, and the following `Stop` had `stop_hook_active=true` (no loop). | [`runs/sync`](../../../experiments/interactive-cli/claude/runs/sync/) |
| `async` | Agent-chosen `khala_read` MCP call | Native MCP tool | **Proven.** Session `bfed27a9…`: the message arrived at `00:36:09.690` and produced no hook or model activity for 30 s. After a neutral prompt, the agent chose `khala_read`, which released the batch at `00:36:44.534` for the same `sessionId` the hooks saw. `khala_send` acknowledged it at `00:36:47.899`. | [`runs/async`](../../../experiments/interactive-cli/claude/runs/async/) |
| Idle `sync`/`steer` | `Stop`-armed `asyncRewake` watcher → content-free wake → synchronous hook pull | Native plugin hook | **Proven.** Session `09c03b7e…`: idle from `00:40:38.597`. The message arrived at `00:43:08.645` (150 s idle), the wake fired at `08.651`, and the synchronous `UserPromptSubmit` released the batch at `08.705`. `khala_send` acknowledged it at `00:43:13.809`. The watcher re-armed at the next `Stop`. A second message in `steer` mode, 60 s later, woke the session 158 ms after arrival. | [`runs/rewake-stop-long`](../../../experiments/interactive-cli/claude/runs/rewake-stop-long/) |
| Idle, committed 40-second route | `UserPromptSubmit` `asyncRewake`, claim in the second (backgrounded) invocation | Native plugin hook | **Fails; replaced.** Details in the next section. | [`runs/rewake-prompt40`](../../../experiments/interactive-cli/claude/runs/rewake-prompt40/), [`runs/rewake-prompt40-expiry`](../../../experiments/interactive-cli/claude/runs/rewake-prompt40-expiry/) |
| Restart | New session generation fences the old token and requeues | Khala-side contract | **Proven.** Session `cf0e976e…` received the batch at `PostToolUse` (`00:48:22.759`) and was SIGKILLed before any Khala call. The fresh launch `f61a8ab1…` bound generation 2 at `00:48:29.803`, fencing token `f6567bf7110b`, whose replay returned `stale_generation`. The batch was redelivered with fresh token `ebfe00b497b5` at `00:48:38.234` and acknowledged by `khala_send` at `00:48:42.893`. That token's replay returned `duplicate`, and the next turn received nothing. | [`runs/restart`](../../../experiments/interactive-cli/claude/runs/restart/) |

Every automatic delivery is framed as `<khala-channel-batch untrusted="true">`. Message bodies travel only on the releaser's stdin, in hook JSON output, and in structured MCP arguments. They never appear in argv, the environment, or the event log, which records byte counts and SHA-256. The batch token never enters model context or logs; logs carry a 12-hex `tokenId` digest.

## Idle delivery

Decision 34 requires idle delivery for `steer` and `sync`. Both idle routes below are content-free: the wake notice contains no message bytes, and the batch arrives through a hook whose output reaches the model.

### Committed route: 40-second `UserPromptSubmit` watcher (fails)

The design committed before this rework armed an `asyncRewake` watcher on every `UserPromptSubmit`, kept it alive for **40 seconds after that prompt**, and claimed the batch in the next invocation of the same hook. Run live (session `1a1e7433…`), it showed:

1. **The wake works.** A message that arrived 17 s after the prompt woke the idle session 83 ms later.
2. **The claimed batch is lost.** The claiming invocation is itself a backgrounded `asyncRewake` hook, so its `additionalContext` never reaches the model. Claude replied "A Khala update is pending but hasn't come through yet". The next Khala call then acknowledged that unseen batch together with a later one, a silent loss.
3. **The 40-second bound.** Nothing wakes a session for messages arriving later than 40 s after the last prompt, or after a wake, which does not re-arm. In the expiry trial (session `a36f2deb…`), the watcher armed at `00:49:21.378` and expired at `00:50:01.477`. A message arriving at `00:50:01.692` produced no activity for 60 s and was delivered only at the next human prompt's `Stop`, at `00:51:03.724` ([`runs/rewake-prompt40-expiry`](../../../experiments/interactive-cli/claude/runs/rewake-prompt40-expiry/)).
4. **It ignores busy state.** In both trials, when a human prompt arrived while a message was queued, the watcher exited 2 immediately and injected a spurious wake into the active turn.

### Replacement route: `Stop`-armed idle watcher (proven)

- **Arm at idle.** Register the watcher on `Stop`, with `asyncRewake: true`, beside the synchronous `Stop` hook. Every turn end arms one watcher. A per-session owner nonce supersedes older watchers, so exactly one is live.
- **Wake only while idle.** The watcher exits 2 only when Khala's pending signal is set and the session's last state is idle, meaning a `Stop` returned empty. It never wakes a busy turn.
- **Content-free marker, synchronous claim.** The watcher writes a wake marker and prints a fixed notice. Claude starts a synthetic turn whose `UserPromptSubmit` runs the synchronous hook; that hook consumes the marker and pulls. Every live wake took the `UserPromptSubmit` path. As a defensive fallback, not observed live, the synchronous `Stop` hook also consumes the marker when `stop_hook_active=true`. The backgrounded watcher never claims.
- **Beyond 40 seconds.** Claude documents that it does not enforce `timeout` for `async` background command hooks, and the live watcher was not killed. It used a 3000 s lifetime and woke at 150 s. Because it re-arms at every `Stop`, each wake extends coverage. Watcher lifetime is a `local-automation-fence` limit, not a Claude limit.
- **Beyond the watcher lifetime.** Once a watcher expires without a wake, the session has no watcher until its next turn. `HarnessCapabilities` and the UI must then say that the idle agent receives messages at its next turn, as decision 34 requires until a route is proven for that interval. The future no-deadline option is an allowlisted Claude channel push (below). Periodic self-wakes are rejected because each one spends a model turn.
- **Lifecycle.** After `/exit`, no watcher process remained; Claude terminated it with the session. The watcher also exits if its Claude process is gone.

## Acknowledgement semantics

- The plugin's trusted adapter retains each released token outside model context and attaches it to the **agent's next Khala call**: `khala_send`, `khala_read`, `khala_status`, or a mode call. In every live run, that call was `khala_send`.
- A hook pull does **not** acknowledge. Firing a hook is not evidence that the model processed the previous batch. If another hook pull happens first, the adapter retains both tokens, and the next agent call acknowledges both.
- Only a synchronous hook, one whose output provably reaches the model, may claim a batch. The committed 40-second route shows that an `asyncRewake` claim combined with next-call acknowledgement silently loses messages.
- A new binding generation, such as a fresh session after a crash, fences all of the previous generation's unacknowledged tokens and requeues their releases. Replaying a fenced token returns `stale_generation`, and replaying an acknowledged token returns `duplicate`.

## Exact inventory

The complete machine-readable inventory is [`inventory.json`](../../../experiments/interactive-cli/claude/inventory.json).

| Item | Observation |
|---|---|
| Host | `<executor-host>`, Linux `7.1.4-arch1-1`, x86_64 |
| CLI | `2.1.282 (Claude Code)` |
| Launcher | `~/.local/bin/claude` |
| Resolved binary | `~/.local/share/claude/versions/2.1.282` |
| SHA-256 | `3afe8535c0cc33f0e24f7b25dab7a1727b8b592196f8496a8bc302ba2161eed3` |
| Embedded build | `2026-09-24T03:59:36Z`, git `88e628ac87357ab077f78e21f78aee6156f01ab3` |
| Authentication/policy | First-party Claude Max login; no managed settings file. This does not prove an organization would enable channels. |
| Session identity | Hook input `session_id` and the plugin MCP server's `CLAUDE_CODE_SESSION_ID` agreed in every run. A fresh launch gets a new ID. |

## Native surface survey

| Surface | What 2.1.282 provides | Fitness for an already-running interactive session |
|---|---|---|
| Hooks | `PostToolUse` `additionalContext`; `Stop` block with reason; `SessionStart`; command hooks with `asyncRewake` on `Stop`. Hook input includes `session_id`. | **Recommended and proven.** Installed before launch; they run inside the session's own lifecycle. |
| Plugins | One plugin packages hooks, the MCP entry, and skills; `claude plugin install --scope user|project|local`. | **Recommended.** Setup owns install/remove. |
| MCP tools | `khala_read`/`khala_send`/`khala_status` with `CLAUDE_CODE_SESSION_ID` in the server environment. | **Recommended** for `async` read, send, and acknowledgement. |
| Claude MCP channels | The server declares `experimental["claude/channel"]` and pushes `notifications/claude/channel`. | **Preview-gated; not in the matrix.** The earlier run ([`runs/channel-run`](../../../experiments/interactive-cli/claude/runs/channel-run/events.jsonl)) needed `--dangerously-load-development-channels`, which decision 33 excludes, so it is gate evidence only. |
| Agent SDK / streaming input | `--input-format stream-json` requires `--print`; it is a separate process. | **Disqualified.** Khala would host the agent. |
| Remote control, resume, `claude mcp serve` | Claude-owned remote workflow; a new process from saved state; Claude as an MCP server. | **Not a Khala transport.** |
| Messaging socket / IPC | `CLAUDE_CODE_MESSAGING_SOCKET` is exported to Claude's own children; no public attach contract. | **Blocked/unproven.** Do not depend on private internals. |
| stdin/queue, PTY typing | The TTY belongs to the editor; a wrapper could type into it. | **Last resort only.** Not required. |

### Fallback disposition

| Candidate | Result | Reason |
|---|---|---|
| `khala run claude` PTY wrapper | **Not required** | Native hooks prove every mode, including idle delivery. |
| Agent SDK streaming input | **Blocked as a product route** | Print mode only, and Khala would host a second agent. |
| Khala-hosted `claude`/resume process | **Blocked as a product route** | Not the user's live session. |

## Risks

| Risk | Treatment |
|---|---|
| Delivered peer content can steer a tool-capable model. | Visible untrusted framing; outbound actions stay approval-gated. |
| `sync` delivery renders as "Stop hook error" in the TUI. | The display label is Claude's own. Show the Khala framing first; capability text explains the label. Track upstream. |
| An asynchronous claim loses messages. | Only synchronous hooks claim; the regression test fails if a watcher claims. |
| A watcher expires and idle messages wait. | Watcher lifetime comes from `local-automation-fence`; status reports it; the UI says "next turn" when no watcher is live. |
| An untrusted folder or uninstalled plugin disables hooks. | Setup verifies plugin install and trust before reporting any mode; otherwise capabilities stay `unproven`. |
| Auto-mode or permission prompts block `khala_*` calls. | Setup may propose an allow rule for the `khala_*` MCP tools and records it. Delivery itself needs no permission. |
| Proof state inside the cwd leaks through Claude's file-change views. | Production state lives in the Khala server, never in the project. |
| Hook contracts change after 2.1.282. | Capability evidence is pinned by version; setup fails closed on untested versions. |
| Crash between delivery and acknowledgement. | Generation fencing plus requeue: at-least-once across sessions, exactly-once acknowledgement. |

## Ticket contracts

The Claude runtime belongs to existing owner slugs from [`claude-plugin.md`](claude-plugin.md) (E09 decisions 26 and 27). `listening-mode-contract` owns `HarnessCapabilities`, including acknowledgement and idle-delivery claims; there is no separate capability-reporting ticket. This deliverable creates **no new slugs**. Each block below amends the named owner contract; unamended fields stand.

### `claude-session-adapter` — amendment

| Field | Amendment |
|---|---|
| **scope** | Add: retain every released token per session, and attach all retained tokens to the next **agent-initiated** Khala call (`khala_send`, `khala_read`, `khala_status`, mode calls). Hook pulls retain but never carry. A new binding generation fences prior-generation tokens and requeues their releases. |
| **acceptance** | Add: (1) a hook pull never acknowledges; (2) two hook pulls before an agent call produce two retained tokens that one call acknowledges; (3) after a session is replaced, the old token returns `stale_generation`, the release is redelivered with a fresh token, and replaying the acknowledged fresh token returns `duplicate`; (4) the session selector is the MCP server's `CLAUDE_CODE_SESSION_ID` (proven equal to the hook `session_id`) in MCP, and the hook `session_id` in hooks. |
| **tests** | Add the **wrong-implementation test:** release a batch at `PostToolUse`, fire a second `PostToolUse`, and fail if any acknowledgement is recorded before the agent's next Khala call. Add the live restart trial from [`runs/restart`](../../../experiments/interactive-cli/claude/runs/restart/) as installed-version acceptance. |
| **blocked-by** | Unchanged. |

### `claude-plugin-hooks` — amendment

| Field | Amendment |
|---|---|
| **scope** | Replace the `UserPromptSubmit` + `asyncRewake` watcher with the `Stop`-armed idle watcher: one watcher per session (owner nonce), wake only while idle, a content-free fixed notice, and the claim in the synchronous `UserPromptSubmit` or `Stop` hook. The watcher never pulls. |
| **acceptance** | Add: (1) idle `sync` and `steer` delivery for a release more than 40 s after the last prompt; (2) the watcher re-arms at every `Stop`; (3) no wake while busy; (4) no watcher process survives `/exit`; (5) watcher lifetime comes from `local-automation-fence`, and capabilities say "next turn" when no watcher is live. Remove the "watcher armed on prompt" wording. |
| **tests** | Add the **wrong-implementation test:** fail if any `asyncRewake` hook emits a batch or calls pull; fail if a release queued during an active turn triggers a wake before `Stop`. Add installed-version idle acceptance at more than 40 s of idle, as in [`runs/rewake-stop-long`](../../../experiments/interactive-cli/claude/runs/rewake-stop-long/). |
| **blocked-by** | Unchanged: `claude-session-adapter`, `listening-mode-contract`, `local-automation-fence`. |

### `claude-plugin-dispatch` — amendment

| Field | Amendment |
|---|---|
| **scope** | Add: `khala_status` as a content-free Khala call that carries retained tokens. The bundled skill tells the agent that replying through `khala_send`, or any Khala call, is what acknowledges delivered messages. |
| **acceptance** | Add: an agent-initiated `khala_read` releases only to the caller's `CLAUDE_CODE_SESSION_ID` binding; a foreign session ID is denied and logged without disclosure. |
| **tests** | Add the **wrong-implementation test:** call `khala_read` with another session's ID and fail if anything is released. |
| **blocked-by** | Unchanged. |

### `claude-plugin-channel-commands` — no amendment

This proof exercised no `create`, `join`, or `who` behavior. The contract stands as written.

### `setup-cli-claude` — amendment

| Field | Amendment |
|---|---|
| **scope** | Add: install the single plugin through Claude's own `claude plugin` commands at user scope; verify the folder-trust precondition and report it; optionally propose an allow rule for the `khala_*` MCP tools and record the choice. Never pass trust-bypass flags, and never launch Claude. |
| **acceptance** | Add: setup proves each mode only from installed-version evidence recorded with the exact launch command, CLI version, and session ID; a missing plugin or an untrusted folder leaves every mode `unproven`. |
| **tests** | Add the **wrong-implementation test:** fail if setup writes `--dangerously-*`, `--setting-sources`, or `--plugin-dir` into any launch path or documentation, or claims a mode without that evidence. |
| **blocked-by** | `claude-plugin-hooks`, `claude-plugin-dispatch`, `listening-mode-contract`. |

### `listening-mode-contract` — capability input

This deliverable supplies Claude 2.1.282 evidence only. For the interactive CLI, `steer`, `sync`, and `async` are proven. `acknowledgement` is `batch_token_next_call`. Idle delivery is "while a watcher is live, else next turn". Hard abort is `unsupported`.
