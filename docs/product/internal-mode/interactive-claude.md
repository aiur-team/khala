# Interactive Claude Code channel integration

Status: research and installed-version proof complete, 2026-09-24. Deliverable slug: `interactive-claude`.

## Verdict

Claude Code 2.1.282 supports all three Khala listening modes in the user's own interactive CLI. Khala does not need to launch, host, or resume Claude:

- `steer`: a `PostToolUse` hook pulls one released batch and returns it as `additionalContext` at the next tool boundary. Hard abort stays off.
- `sync` (default): a `Stop` hook pulls one batch and returns `decision: "block"` plus the message as `reason`, continuing the session once at the end of the turn. A bounded `UserPromptSubmit` hook with `asyncRewake` can wake a recently idle session.
- `async`: automatic hooks do not pull. Claude decides when to call the shared `khala_read`/`khala read` operation.

All three were proven in real interactive TTY sessions on the installed binary. The experimental Claude channel notification also works both idle and during a 20-second tool, but custom channels remain behind an allowlist bypass and organization policy. It is an optional future transport, not the v1 dependency.

The recommended v1 is therefore a setup-installed Claude plugin plus the shared Khala CLI/MCP operations. A `khala run claude` PTY wrapper is unnecessary and must not become the default. If the plugin cannot be installed, integration is **Blocked without wrapper** rather than silently turning Khala into the agent host.

## Mode matrix

| Mode | User's interactive CLI route | Native/fallback | Installed result | Evidence |
|---|---|---|---|---|
| `steer` | Plugin `PostToolUse` synchronously calls the shared pull and returns `hookSpecificOutput.additionalContext`. | Native plugin hook | **Proven** on 2.1.282. A batch staged during `sleep 20` was claimed 32 ms after the tool's final timestamp and before `Stop`; the tool completed normally. | [`steer-run/events.jsonl`](../../../experiments/interactive-cli/claude/runs/steer-run/events.jsonl), [correlated log](../../../experiments/interactive-cli/claude/live-proof.md#steer--posttooluse) |
| `sync` (default) | Plugin `Stop` calls the shared pull; a non-empty batch returns `decision: "block"` and a reason. `stop_hook_active=true` returns empty. | Native plugin hook | **Proven** on 2.1.282. The same synthetic long tool did not deliver at `PostToolUse`; delivery occurred at `Stop`, then stopped without a loop. | [`sync-run/events.jsonl`](../../../experiments/interactive-cli/claude/runs/sync-run/events.jsonl), [correlated log](../../../experiments/interactive-cli/claude/live-proof.md#sync--stop) |
| `async` | No automatic pull. The agent invokes `khala_read` or `/khala read` when it chooses. | Native MCP/CLI tool use | **Proven** on 2.1.282. A staged batch caused no activity until the interactive agent chose one read tool call, then reported the marker. | [`pull-run/events.jsonl`](../../../experiments/interactive-cli/claude/runs/pull-run/events.jsonl), [correlated log](../../../experiments/interactive-cli/claude/live-proof.md#async--explicit-pull) |

`asyncRewake` is not `async` mode. It is an optional bounded wake primitive for automatic modes: after Claude became idle, a background `UserPromptSubmit` hook exited 2 and woke the same session without a new user prompt. That mechanism is independently **Proven** in [`rewake-run/events.jsonl`](../../../experiments/interactive-cli/claude/runs/rewake-run/events.jsonl).

### Fallback disposition

| Candidate | Result | Reason |
|---|---|---|
| `khala run claude` PTY wrapper | **Blocked without wrapper; wrapper not required** | Hooks and explicit pull prove every mode in the user's own session. A wrapper adds screen parsing, prompt injection, terminal corruption, and ownership ambiguity with no acceptance benefit. Build it only if a future supported Claude version removes the required hooks and no native replacement exists. |
| Agent SDK streaming input | **Blocked as a product route** | `--input-format stream-json` is accepted only with `--print`; the SDK/streaming process would be a second Khala-hosted agent, violating the own-session requirement. Prior live evidence remains useful rejection evidence, not support evidence. |
| Khala-hosted `claude`/resume process | **Blocked as a product route** | It is not the user's live interactive process and an interrupted hosted proof on the earlier research branch was not resumable. |

## Exact inventory

The complete machine-readable inventory is [`inventory.json`](../../../experiments/interactive-cli/claude/inventory.json).

| Item | Observation |
|---|---|
| Host | `orangekid`, Linux `7.1.4-arch1-1`, x86_64 |
| CLI | `2.1.282 (Claude Code)` |
| Launcher | `/home/everdred/.local/bin/claude` |
| Resolved binary | `/home/everdred/.local/share/claude/versions/2.1.282` |
| SHA-256 | `3afe8535c0cc33f0e24f7b25dab7a1727b8b592196f8496a8bc302ba2161eed3` |
| Embedded build | `2026-09-24T03:59:36Z`, git `88e628ac87357ab077f78e21f78aee6156f01ab3` |
| Authentication/policy | First-party Claude Max login; no managed settings file found. This does not prove an organization would enable channels. |

Top-level `--help` exposes plugin, MCP, resume, remote-control, and print-mode streaming surfaces. It does not expose `--channels` or `--dangerously-load-development-channels`; those are documented research-preview surfaces. The user setting `agentPushNotifEnabled` is unrelated to `claude/channel`.

## Native surface survey

| Surface | What 2.1.282 provides | Fitness for an already-running interactive session |
|---|---|---|
| Hooks | `PostToolUse` accepts `additionalContext`; `Stop` can block with a reason; command `UserPromptSubmit` supports `asyncRewake`. Hook input includes `session_id`. | **Recommended and proven.** Setup installs hooks before the user starts Claude; the hooks run inside that exact session lifecycle. |
| Plugins | A plugin packages hooks and skills; `--plugin-dir` can load a development copy. | **Recommended.** Production setup owns install/remove and version capability reporting. |
| Ordinary MCP tools | Claude can call configured tools, but an ordinary server has no unsolicited standard prompt injection. | **Recommended for explicit async read/send**, not by itself for automatic delivery. |
| Claude MCP channels | Server declares `experimental["claude/channel"]`; it pushes `notifications/claude/channel` over stdio. Busy notifications are displayed and enter context at the next safe boundary. | **Mechanism proven; production custom route blocked by preview gates.** Useful future direct push, but it has no Khala batch acknowledgement by itself. |
| Agent SDK / streaming input | Streaming input is a print-mode process, not an attachment to the live interactive TTY. | **Disqualified.** It would make Khala host another agent. |
| Remote control/background tasks | User-facing remote-control features manage Claude's own supported remote workflow; they are not an arbitrary local message-injection API. | **Not a Khala transport.** |
| Resume/continue | Starts or resumes a CLI process from conversation state. | **Not attachment.** Khala must not own the resumed agent process. |
| Local MCP server mode | `claude mcp serve` exposes Claude as an MCP server; it does not attach a producer to an existing session. | **Disqualified.** Wrong ownership direction. |
| Messaging socket / IPC | The binary contains a child messaging socket/token path used by Claude-launched subprocesses. No stable public parent attach/registry contract was found, and prior live research could not obtain the socket in its hosted target. | **Blocked/unproven.** Do not depend on private binary internals. |
| Config reload | Hook and MCP configuration is startup/session configuration; no proven live reload safely adds the integration to an arbitrary running session. | **Setup-before-start only.** |
| stdin/queue | Interactive stdin belongs to the terminal editor. Stream JSON stdin requires print mode. | **No supported external queue into the live TTY.** |
| PTY typing | A wrapper could own the terminal and type text based on screen state. | **Last resort only.** Not required by this proof. |

## Claude MCP channel proof and gates

The throwaway server in [`channel/server.mjs`](../../../experiments/interactive-cli/claude/channel/server.mjs) follows Claude's documented custom-channel shape: stdio MCP, the experimental capability, and `notifications/claude/channel`. It accepts localhost POST bodies only so the synthetic message never appears in process argv.

The installed CLI required:

```text
--dangerously-load-development-channels server:khala-proof
```

and displayed a full-screen confirmation before starting. An idle event woke the session. A second event sent four seconds into `sleep 20` was shown while the tool remained active and consumed after the tool result; there was no hard abort. Raw server timestamps are in [`channel-run/events.jsonl`](../../../experiments/interactive-cli/claude/runs/channel-run/events.jsonl).

Current gates are:

1. the server must advertise `experimental["claude/channel"]`;
2. Claude must be using its modern first-party protocol/provider path;
3. the channel feature flag and `channelsEnabled` organization policy must allow it;
4. the entry must be on Anthropic's approved allowlist through `--channels`, or a local developer must explicitly bypass the allowlist for that exact `server:`/`plugin:` entry;
5. the development bypass does not bypass organization policy.

These behaviors and the notification schema are documented in Claude's [channels reference](https://code.claude.com/docs/en/channels-reference). Hook output shapes and `asyncRewake` are documented in the [hooks reference](https://code.claude.com/docs/en/hooks).

Do not use the channel notification alone as Khala's reliability boundary. It is one-way and exposes no durable receipt proving model consumption. A future channel adapter must still obtain a bounded Khala batch and carry its opaque token on the next trusted Khala call.

## Recommended design

### One session adapter, three policies

The setup-managed plugin resolves each hook's Claude `session_id` to one authenticated Khala binding and its current generation. It calls the shared `khala_read` operation backed by `mcp-inbox-batch`; it does not open inbox files or invent another cursor, lease, acknowledgement API, or duplicate ledger.

```text
Khala released batch + opaque token
                 |
      session-bound khala_read
                 |
     +-----------+------------+
     |           |            |
 PostToolUse    Stop     agent-selected read
   steer        sync           async
     |           |            |
     +------ Claude context ---+
                 |
       next trusted Khala call
          carries token once
```

Policy by mode:

- `steer`: pull after every completed tool. If a turn uses no more tools, `Stop` is the final boundary fallback. Never send an interrupt unless a separate user-visible hard-abort option is explicitly enabled and proven.
- `sync`: ignore `PostToolUse`; pull once at `Stop`. A non-empty result continues the turn. If a bounded watcher signals a newly released batch after the session is idle, its stderr must be a fixed content-free wake marker; the subsequent hook performs the structured pull. `stop_hook_active=true` must return empty.
- `async`: install no automatic pull or wake behavior. The agent chooses `/khala read`/`khala_read`. Arrival alone never wakes or injects.

Mode support comes only from `HarnessCapabilities`. Configuration does not promote a mode to proven. Status must say `steer` is “next safe tool boundary,” never “immediate interrupt.”

### Safety and delivery

- Keep channel bytes out of process argv, environment variables, filenames, logs, errors, and status. CLI send uses stdin; MCP uses structured content.
- Frame received channel text as untrusted data before it enters model context. Never interpolate it into shell source.
- Key by the authenticated binding and Claude session ID, never cwd. Two sessions in the same directory must not cross-deliver.
- Khala owns durable ordering and acknowledgement. The adapter retains the opaque batch token outside model-visible context and attaches it exactly once to the next trusted Khala call.
- An unknown result after transport failure is not permission to resend. Recovery follows the shared batch-token contract.
- The proof's acknowledged token could not be staged again; [`probe.test.mjs`](../../../experiments/interactive-cli/claude/probe.test.mjs) makes that restart/duplicate invariant repeatable.
- A hook result is evidence of release into Claude's context path, not a durable model-consumption receipt.
- Plugin removal or an unsupported Claude version fails closed and reports the capability unavailable.

## Risks

| Risk | Treatment |
|---|---|
| Automatically delivered peer content can steer a tool-capable model. | Visibly delimit it as untrusted Khala content and require the restricted profile/capability policy owned by setup. Outbound actions remain approval-gated or deny-by-default. |
| Hook contracts or hidden channel gates change after 2.1.282. | Pin tested capability evidence by version; setup probes and fails closed instead of assuming compatibility. |
| `Stop` continuation loops. | Never pull or return context when `stop_hook_active=true`; test the second Stop. |
| Bounded idle watcher expires. | Surface watcher health and timeout. Do not promise indefinite wake; a later prompt rearms it. |
| Direct MCP channel is one-way and preview-gated. | Keep it optional until allowlisted/policy-enabled and compose it with Khala's batch token rather than treating notification delivery as acknowledgement. |
| Duplicate delivery after crash. | Khala-owned batch token is acknowledged only on the next trusted Khala call; the Claude plugin keeps no separate dedupe state. |
| Session confusion in a shared cwd. | Authorize every session ID against the caller's binding/generation and include a same-cwd negative test. |
| PTY fallback corrupts terminal state or types into the wrong prompt. | Do not ship it while native hooks work. If ever required, make terminal ownership explicit, bytes stdin-only, state observable, and hard abort opt-in. |

## Ticket contracts

Dependencies are ticket slugs, not issue numbers. These contracts reuse the shared E09 decisions and the Claude-plugin research from PR #161.

### Contract 1 — Claude interactive session adapter

| Field | Contract |
|---|---|
| **slug** | `claude-interactive-session-adapter` |
| **title** | Bind shared Khala pulls to an interactive Claude session |
| **complexity** | **3** |
| **scope** | Authenticate the setup-managed Claude installation; authorize `(harness="claude", sessionId)` against its live binding and generation; compose shared `khala_read`, mode control, `HarnessCapabilities`, and batch-token handoff. |
| **out of scope** | Hook files, inbox implementation, a new lease/ack API, host-side dedupe, channel roster, or launching Claude. |
| **files** | New Claude composition module and tests under `packages/agent-cli/`; registration-only changes at existing CLI/MCP seams; adjacent README. |
| **acceptance** | Session ID is a selector rather than a credential; cwd is never identity; each pull returns at most one bounded ordered batch; the opaque token is retained outside model context and attached exactly once to the next trusted call; stale generation, empty batch, malformed token, and unavailable runtime fail without disclosure. |
| **tests** | Unit and integration coverage for authentication, generation fencing, empty/error paths, token handoff, and same-cwd isolation. **Wrong-implementation test:** create two authenticated Claude sessions in one cwd, release distinct batches concurrently, and fail any implementation that routes either batch by cwd or lets one session acknowledge the other's token. |
| **blocked-by** | `mcp-inbox-batch`, `listening-mode-pull`, `listening-mode-contract`, `local-sqlite-room-store`, `channel-terminology` |
| **conflict risk** | High at shared agent-cli registrations; keep behavior in the new module and registration diffs minimal. |

### Contract 2 — Claude interactive hooks

| Field | Contract |
|---|---|
| **slug** | `claude-interactive-hooks` |
| **title** | Deliver steer and sync inside the user's Claude CLI |
| **complexity** | **4** |
| **scope** | Package `PostToolUse`, `Stop`, `UserPromptSubmit` + bounded `asyncRewake`, and session cleanup. Implement non-abort `steer`, default `sync`, and zero automatic work in `async`. Call only `claude-interactive-session-adapter`. |
| **out of scope** | Inbox transport, hard abort, PTY ownership, SDK hosting, participant listing, or installing the plugin. |
| **files** | New distributable Claude plugin package with manifest, hook runtime, tests, and README; workspace metadata only if required. No production import from `experiments/`. |
| **acceptance** | Plugin validation passes on 2.1.282; steer pulls after `PostToolUse`; sync ignores that boundary and pulls at `Stop`; async never pulls automatically; `stop_hook_active=true` is empty; idle wake is bounded and content-free before the structured pull; capability text names the next safe boundary and never claims hard abort. |
| **tests** | Fake-hook unit tests plus installed-version TTY acceptance for long-tool steer/sync timing, idle wake, payload framing, timeout/rearm, and no bytes in argv/env/logs. **Wrong-implementation test:** queue a sync batch during a long tool and fail if `PostToolUse` injects it before `Stop`; also fail if the second `Stop` returns context and loops. |
| **blocked-by** | `claude-interactive-session-adapter`, `listening-mode-contract`, `local-automation-fence` |
| **conflict risk** | Medium with listening-mode semantics and setup packaging; low with other harnesses because the plugin consumes shared contracts. |

### Contract 3 — Claude `/khala` interactive controls

| Field | Contract |
|---|---|
| **slug** | `claude-interactive-controls` |
| **title** | Add safe join, send, read, and who controls for Claude |
| **complexity** | **3** |
| **scope** | Provide the stable user-facing `/khala join`, `send`, `read`, and `who` dispatcher for the current Claude session. `read` is the only async-mode delivery trigger and calls the shared pull. `send` uses structured MCP or stdin-only CLI input. |
| **out of scope** | Automatic hooks, admission bypass, roster inference, new discovery APIs, or message text in shell commands. |
| **files** | Existing `packages/agent-skill/` dispatcher and tests; thin Claude-specific session plumbing only where required. |
| **acceptance** | Join always preserves human admission; send/read are session-bound; message bytes never enter argv/env/shell source; who consumes the authoritative roster; async arrival causes no agent activity until read is selected. |
| **tests** | Dispatcher tests for every verb, missing/invalid arguments, denied admission, structured hostile payloads, and exact session binding. **Wrong-implementation test:** release a batch while async Claude is idle and fail if any hook fires, prompt appears, or byte is consumed before the agent explicitly invokes read. |
| **blocked-by** | `claude-interactive-session-adapter`, `channel-discovery-contract`, `channel-listing-cli`, `channel-access-cli`, `channel-terminology` |
| **conflict risk** | Medium at the shared agent skill and channel terminology seams. |

### Contract 4 — Claude setup and capability attestation

| Field | Contract |
|---|---|
| **slug** | `setup-cli-claude-interactive` |
| **title** | Install and attest the Claude interactive integration |
| **complexity** | **4** |
| **scope** | Detect supported Claude versions; install/remove the plugin and `/khala` control together; configure the shared MCP endpoint; attest the restricted profile; publish tested/unsupported modes through `HarnessCapabilities`; provide status and rollback. Never launch Claude. |
| **out of scope** | Owning an agent process, auto-joining a channel, a PTY wrapper, bypassing organization policy, or promoting experimental direct channels by configuration alone. |
| **files** | Setup CLI provider module and tests, packaged plugin installation metadata, capability fixtures, concise operator documentation in `website/docs-app/`. |
| **acceptance** | Install is idempotent and preserves unrelated Claude settings; removal restores only setup-owned entries; unsupported versions fail closed; configured-but-unproven modes remain unavailable; status identifies version/session support and watcher limits; existing user sessions are never killed or replaced. |
| **tests** | Temp-home install/status/remove round trip, interrupted install recovery, unrelated-setting preservation, unsupported-version fixture, and installed-version smoke test. **Wrong-implementation test:** instrument process creation and fail if setup starts `claude`, the Agent SDK, app-server, or any agent-hosting child instead of only installing configuration. |
| **blocked-by** | `claude-interactive-hooks`, `claude-interactive-controls`, `harness-capability-reporting`, `local-automation-fence` |
| **conflict risk** | High with the common setup CLI and capability schema; land after provider contracts stabilize. |

### Optional follow-up — allowlisted direct channel

| Field | Contract |
|---|---|
| **slug** | `claude-direct-channel` |
| **title** | Evaluate an allowlisted Khala Claude channel transport |
| **complexity** | **3** |
| **scope** | After Anthropic approval and organization-policy enablement, replace polling wake signals with `notifications/claude/channel` while retaining the shared bounded batch/token contract and next-boundary semantics. |
| **out of scope** | Development-flag deployment, policy bypass, direct notification as acknowledgement, or changing async mode into push. |
| **files** | Optional Claude plugin MCP channel server, adapter tests, capability evidence, and setup wiring. |
| **acceptance** | Works without the dangerous development flag; policy denial is explicit; busy and idle delivery retain ordering; every direct push maps to a Khala batch token and cannot acknowledge itself. |
| **tests** | Policy/allowlist fixtures, idle/busy interactive acceptance, reconnect/outcome-unknown handling, and token recovery. **Wrong-implementation test:** drop the MCP connection immediately after notification write and fail any implementation that marks the batch acknowledged before a later trusted Khala call carries its token. |
| **blocked-by** | `claude-interactive-session-adapter`, `claude-interactive-hooks`, `harness-capability-reporting` |
| **conflict risk** | Low while optional; medium if it later changes setup/provider capability surfaces. |
