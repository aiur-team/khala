# Interactive Codex CLI: native listening modes

Status: research complete, 2026-09-24. Deliverable for E09 ticket #164.

## Decision

Codex can support `steer`, `sync` (default), and `async` in the user's own
interactive TUI without Khala launching or hosting an agent. The recommended
adapter is a setup-managed set of native Codex hooks plus the Khala MCP entry
and skill; the hooks call Khala's shared channel pull. The installed 0.154.0
and then-latest 0.156.1 were each exercised
in a real PTY. All six version/mode cells are proven.

This supersedes the hosted path in [`docs/evidence/codex.md`](../../evidence/codex.md):
`codex app-server`, an SDK-owned thread, or a Khala-owned TUI would create a
second agent process and violate the operator decision. A PTY wrapper is not
needed for v1 and is not an approved default.

## Inventory

The installed binary was
`/home/everdred/.local/share/mise/installs/node/lts/bin/codex`, version 0.154.0.
The npm registry offered 0.156.1, so the same proof was repeated with that
package. Exact output is retained in
[`inventory.txt`](../../../experiments/interactive-cli/codex/evidence/inventory.txt).

| Native surface | Finding | Product use |
|---|---|---|
| Codex hooks | `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, and `Stop` can block or add model context. Stable and enabled in both tested versions. | Primary route. |
| `codex queue` | Reaches a live TUI, but is notification-only for Khala: `--message` puts its bytes in argv, has no stdin alternative, no receipt, and can duplicate. Existing proof is in [`codex-native-cli.md`](../../evidence/codex-native-cli.md). | At most a fixed, content-free idle wake. Never carry channel bytes. |
| `codex resume` | Resumes a persisted conversation as a new invocation; it does not expose a control socket for the already-running TUI. | Recovery only, not delivery. |
| `app-server` / `--remote` | Starts or connects a separately hosted app-server. No command or observed socket attaches an app-server to the live local TUI; a second writer is rejected. | Excluded by the one-agent-process rule. |
| MCP client | Tools and their results reach the model, but generic server-initiated notifications are client UI/protocol events rather than unsolicited model context. | Explicit `async` read and result piggyback only. |
| SDK | Owns the agent/thread lifecycle. | Excluded by the one-agent-process rule. |
| Setup-managed hooks/skill | Install hooks and teach explicit channel operations inside the user-owned session; Codex has no separate plugin package. | Installation and `async` UX. |
| Config reload / stdin / local IPC | No supported live config reload, message stdin, attach socket, or local IPC ingress was found. | Not a delivery route. |

Official contracts: [Codex hooks](https://learn.chatgpt.com/docs/hooks),
[app server](https://developers.openai.com/codex/app-server), and
[remote Queue/Steer semantics](https://openai.com/index/codex-now-generally-available/).

## Mode matrix

Evidence code and selected raw logs live in
[`experiments/interactive-cli/codex/`](../../../experiments/interactive-cli/codex/README.md).

| Mode | Native route in the live TUI | 0.154.0 | 0.156.1 | Recommended route |
|---|---|---|---|---|
| `steer` | `PreToolUse` blocks the next tool long enough to inject the batch; `PostToolUse` injects when a message arrived during the tool; `Stop` is the no-more-tools fallback. | **Proven**: a batch arrived during a 20-second Bash sleep at `22:18:00.455Z` and was injected 1 ms after `PostToolUse` at `22:18:02.443Z`. A second run proved `PreToolUse`. | **Proven**: a batch arrived during a 20-second Bash sleep at `22:52:14.179Z` and was injected 2 ms after `PostToolUse` at `22:52:26.095Z`; the live agent acknowledged it. | Native hooks, next tool boundary. Hard abort remains off. |
| `sync` (default) | Ignore `PostToolUse`; pull at `Stop` after the active turn, or at the next `UserPromptSubmit` for an idle notification. | **Proven**: `PostToolUse` stayed silent; `Stop` delivered at `22:19:11.914Z` and the live agent acknowledged. | **Proven**: a batch arrived during a 20-second Bash sleep at `22:53:25.857Z`; `PostToolUse` left it pending and `Stop` delivered at `22:53:35.960Z`. | Native `Stop` plus `UserPromptSubmit`; optional fixed-content `codex queue` wake. |
| `async` | Automatic hooks never pull. The agent chooses when to invoke the structured `khala_read` tool or `/khala read` skill. | **Proven**: prompt/tool hooks stayed silent; explicit read occurred at `22:20:20.665Z`, then acknowledgement. | **Proven**: prompt/tool hooks stayed silent; explicit read occurred at `22:25:41.931Z`, then acknowledgement. | Explicit structured read in the live session. |

The machine-checkable summary is
[`live-run.json`](../../../experiments/interactive-cli/codex/evidence/live-run.json);
selected source events are
[`installed-0.154.0.jsonl`](../../../experiments/interactive-cli/codex/evidence/installed-0.154.0.jsonl)
and [`latest-0.156.1.jsonl`](../../../experiments/interactive-cli/codex/evidence/latest-0.156.1.jsonl).

## Production design

The user starts Codex normally, then points that session at a Khala channel URL
or asks it to create a channel. Creation and admission require human
confirmation. Setup installs native hooks, the Khala MCP entry, and the skill;
Khala never starts Codex, an app-server, or an SDK agent.

```text
user-started Codex TUI
  ├─ native lifecycle hook ─┐
  └─ explicit khala_read ───┤ session ID + verified binding/generation
                            ▼
                  shared listening-mode pull
                            ▼
                 bounded channel batch + token
                            │
             hook context or structured tool result
                            ▼
                 next trusted Khala operation
                    acknowledges prior token
```

The proof bridge writes one pending batch atomically and records the session and
turn where it was offered. It suppresses a repeat within that turn, but an
unacknowledged batch is offered again on a later turn or restart. Production
must not copy this host-side inbox: `mcp-inbox-batch` owns durable ordered batch
state and acknowledgement, and `listening-mode-pull` owns the public CLI/MCP
read. The Codex adapter only resolves the verified live session and carries the
opaque prior token into the next trusted Khala operation.

Channel content is untrusted data. Frame it visibly and never interpolate it
into shell source, argv, environment, logs, status, or error text. Delivery uses
the normal interactive session; an optional setup hardening check cannot gate a
mode or change support state. The live proof sent bodies to the bridge on stdin.
If `codex queue` is used to wake an
idle TUI, its `--message` is a constant content-free notice; the hook performs
the authenticated pull. Batch tokens are opaque transport state, not message
bytes or proof that the model consumed the text.

### Boundary behavior

- `steer`: pull synchronously at every `PreToolUse`; block that attempted tool
  with framed channel context, then allow the agent to acknowledge and retry.
  If the release arrives while a tool runs, `PostToolUse` supplies it as
  `additionalContext`. At `Stop`, a non-empty pull continues once. No signal,
  Escape, cancellation, or hard abort occurs unless a future explicit grant
  enables it.
- `sync`: do nothing at intermediate tool boundaries. Pull at `Stop`; if a
  batch exists, return it and continue once. `stop_hook_active=true` never pulls,
  preventing a loop. An idle fixed notification may create a
  `UserPromptSubmit` boundary, where the hook pulls the actual batch.
- `async`: hooks record no pull and inject nothing. The agent's skill tells it
  when to use `khala_read`; the structured result carries the batch and the
  next trusted operation carries its acknowledgement token.

## Fallback assessment

`khala run codex` can technically own a PTY, infer tool boundaries from the
screen, and type fixed wake text, but it violates the operator's current
user-owned-session constraint because Khala launches the CLI. Therefore its
product status is **Blocked without wrapper approval**, not a supported route.
Native hooks prove all three required modes, so no exception is requested.

An MCP result piggyback is useful when the agent is already calling a Khala
tool, but it cannot guarantee the next arbitrary tool boundary. A skill-driven
check is exactly the `async` route, not a substitute for `steer` or `sync`.

## Risks

| Risk | Treatment |
|---|---|
| Hooks are not installed, trusted, or enabled. | Setup verifies exact installed artifacts and capability status; unsupported sessions advertise `unknown` or `unsupported` with a reason, never silently downgrade. |
| A fixed `codex queue` wake duplicates or its process dies. | Treat it as notification only. Durable batch state and token acknowledgement remain authoritative. |
| `Stop` delivery creates a continuation loop. | Never pull when `stop_hook_active=true`; deterministic tests cover the guard. |
| Hook success is mistaken for model consumption. | Call it “offered”; retain the batch until the shared token is acknowledged on a subsequent trusted operation. |
| Crash occurs after acting but before acknowledgement. | Reoffer on the next turn/restart. At-least-once delivery is safer than loss; operations carrying side effects need their own idempotency key. |
| Channel text drives tools or egress. | Delimit it as untrusted structured user content; setup may report optional hardening without making it a delivery precondition. |
| Codex changes hook JSON or semantics. | Setup tests the installed version, the supported-version matrix is explicit, and CI runs fixture contract tests. |
| Two sessions share a cwd. | Bind by authenticated Codex session ID and Khala binding generation; cwd is metadata only. |

## Ticket contracts

### Contract 1 — Interactive Codex adapter

| Field | Contract |
|---|---|
| **slug** | `interactive-codex` |
| **title** | Deliver all listening modes into a user-started Codex TUI |
| **complexity** | **4** |
| **scope** | Package setup-managed native Codex hooks, the Khala MCP entry, and the skill; resolve the authenticated TUI session to its verified binding/generation; compose `listening-mode-pull`, `mcp-inbox-batch`, `HarnessCapabilities`, and shared mode control; implement the three boundary mappings above without launching Codex. |
| **files/packages touched** | Codex adapter/hooks and focused tests; setup registration; MCP and skill registration; capability declarations; concise package/setup documentation. Production must not import `experiments/`. |
| **blocked-by** | `mcp-inbox-batch`, `listening-mode-pull`, `listening-mode-contract`, `listening-mode-store`, and `channel-access-cli-mcp`. |

Acceptance:

- In a user-started supported Codex TUI, an arrival during a 20-second tool is
  offered at the next hook boundary in `steer`, after the tool/turn in default
  `sync`, and only after an agent-chosen read in `async`.
- No setup, adapter, daemon, or Khala server launches or hosts Codex, an
  app-server, or an SDK agent. Joining or creating a channel requires the human
  confirmation defined by channel admission.
- Bodies enter the adapter only through structured input/stdin and never appear
  in argv, environment, logs, status, errors, or a content-bearing wake signal.
- One shared opaque batch token provides restart-safe acknowledgement. The same
  turn does not receive duplicates; an unacknowledged batch is reoffered after
  a later turn/restart. No host-side cursor, lease, inbox, or dedupe ledger is
  added.
- Hard abort is disabled. Capability text says `steer` means “next tool
  boundary,” and unsupported/unverified installations remain `unsupported` or
  `unknown` with a reason.
- Installed-version fixture tests and a real PTY acceptance run cover every
  supported Codex version before it is advertised.

**Wrong-implementation test:** start a real Codex TUI yourself with a 20-second
tool, enqueue a body containing a unique secret marker on stdin, and inspect
`/proc` for every adapter/wake process. Fail if Khala launched the TUI, if the
marker appears in argv or environment, if `sync` injects at `PostToolUse`, if
`async` injects before an explicit read, if `steer` waits past the next tool
boundary, if a same-turn hook duplicates the batch, or if restart loses an
unacknowledged token.

### Contract 2 — Fixed idle notification spike

| Field | Contract |
|---|---|
| **slug** | `codex-idle-wake` |
| **title** | Prove a content-free idle wake for interactive Codex |
| **complexity** | **2** |
| **scope** | Determine whether a constant `codex queue` notice reliably creates a native prompt boundary in the same user-started TUI, then let `UserPromptSubmit` perform the shared pull. It may improve idle latency but is not required for the three mode semantics. |
| **files/packages touched** | Codex adapter wake helper and focused real-TUI acceptance evidence only. |
| **blocked-by** | `interactive-codex`, `local-automation-fence`, and `listening-mode-pull`. |

Acceptance:

- Wake argv contains only a constant product string and identifiers classified
  safe for transport; no channel body, batch token, credential, or peer name.
- Repeated, late, missing, and post-restart notices cannot duplicate or lose a
  batch because the hook still uses the shared token contract.
- If installed-version testing cannot prove that `UserPromptSubmit` fires in
  the target TUI, report notification-only support and keep ordinary next-user-
  prompt sync behavior; do not fall back to launching Codex or screen typing.

**Wrong-implementation test:** enqueue a secret-marked batch while the TUI is
idle, trigger the wake, and fail if the marker or token appears in `/proc/*/cmdline`
or `/proc/*/environ`, if delivery bypasses `listening-mode-pull`, or if two wake
notices produce two offers in the same turn.
