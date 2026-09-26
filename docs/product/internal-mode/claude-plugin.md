# Claude Code plugin: hooks and slash commands

Status: research complete, 2026-09-24. Deliverable for E09 ticket #140.

## Summary

Claude Code 2.1.282 can support a Khala integration in the person's own,
user-started interactive CLI without Khala launching or hosting Claude. A
command hook can synchronously inject a message after a tool result, a `Stop`
hook can continue a turn instead of idling, and an asynchronous
`UserPromptSubmit` hook can wake an idle session. The hook input and Bash
subprocess environment both expose the Claude session ID, so delivery can be
keyed to the session rather than the working directory. SDK-hosted and
Khala-hosted agent routes are secondary evidence only, not product paths; a
`khala run <cli>` PTY wrapper is not approved as the default fallback.

The plugin should be a thin consumer of `packages/agent-cli`, not a second
inbox. It calls only the `listening-mode-pull` operation
(`khala_read`/`khala read`), which is backed by the single `mcp-inbox-batch`
token API; it does not add a second batch, lease, acknowledgement, or pull API.
Reuse `packages/agent-skill` as the source for the literal `/khala` dispatcher,
but ship one user-scope Claude plugin containing that skill, the hooks, and the
MCP entry. `setup-cli-claude` installs that single plugin; there is no separate
installed `/khala` skill. Plugin skills are officially namespaced, even though
the installed version accepted literal `/khala join` when no command conflicted.

The operator's 2026-09-24 mode rename supersedes the stale wording in
[`requirements.md`](requirements.md): the modes are `steer`, `sync` (default),
and `async`. This research found no hard mid-tool interrupt. Claude's proven
`steer` behavior is delivery at the next tool boundary.

The operator's 2026-09-24 terminology decision likewise standardizes every
user- and agent-facing name on **channel**. `channel-terminology` (#163) owns
renaming existing non-Matrix code; Matrix-internal room types remain unchanged.

The Executor's shared E09 decisions also supersede the earlier draft's custom
transactional drain. `mcp-inbox-batch` owns bounded durable peek and batch-token
acknowledgement on Khala's side; `listening-mode-pull` owns both public pull
forms. Claude consumes those contracts, and never performs host-side duplicate
suppression.

Channel text is delivered to the normal interactive Claude session in every
supported mode. The plugin frames it visibly as untrusted Khala content;
`setup-cli-claude` may report optional hardening posture, but delivery never
depends on a restricted profile.

## Findings and evidence

### Installed-version proof

The throwaway plugin under
[`experiments/internal-mode/claude-plugin/`](../../../experiments/internal-mode/claude-plugin/README.md)
was loaded with `--plugin-dir` in an interactive Linux TTY. Its strict manifest
validation and deterministic concurrency test both pass.

| Claim | Claude Code 2.1.282 observation | Status |
|---|---|---|
| `PostToolUse` synchronous delivery hook | A Bash tool completed, the hook returned `additionalContext`, and Claude consumed `post-tool-delivered-140` immediately after the result. | Proven once |
| `Stop` continues instead of idling | The hook returned `stop-delivered-140`; Claude continued, then invoked `Stop` again with `stop_hook_active=true`. | Proven once |
| `UserPromptSubmit` + `asyncRewake` wakes idle | After the first `Stop`, the background hook exited 2 when a message appeared. Claude resumed under the same session ID with a new prompt ID and consumed `rewake-delivered-140`. | Proven once within 90 seconds |
| Session identity | All hook events carried the same `session_id`; cwd was recorded separately. Current Claude docs also expose matching `CLAUDE_CODE_SESSION_ID` to Bash subprocesses. | Proven for one session; official contract |
| Probe-only per-session claim | Two concurrent hook processes in the same cwd targeted session A. Exactly one claimed A's item; neither consumed session B's item, which B later read. | Deterministic proof of session keying only; production batching comes from `mcp-inbox-batch` |
| Literal dispatcher | `/khala join` loaded the plugin skill and expanded `$ARGUMENTS` to `join`, producing `KHPLUG-COMMAND join`. | Proven with no command collision |

Evidence is summarized in
[`evidence.json`](../../../experiments/internal-mode/claude-plugin/evidence.json);
the concurrency regression is
[`probe.test.mjs`](../../../experiments/internal-mode/claude-plugin/probe.test.mjs).
The hook event log and exact Claude session ID were intentionally not committed.

### Current Claude contracts

| Contract | Design consequence |
|---|---|
| [Hooks](https://code.claude.com/docs/en/hooks) provide `session_id`; `PostToolUse` and `Stop` can return event-specific `additionalContext`. | Hooks can call the shared session-aware pull and inject only its returned batch. |
| `Stop` provides `stop_hook_active` and bounds consecutive continuations. | Return no context when already active or when the pull is empty; never construct a continuation loop. |
| `asyncRewake` runs a command hook in the background and wakes Claude when it exits 2. Hook timeouts still apply. | It is an idle-wake window, not proof of an indefinitely resident listener. Timeouts and rearming must be visible. |
| [Environment variables](https://code.claude.com/docs/en/env-vars) expose `CLAUDE_CODE_SESSION_ID` to Bash and PowerShell tools. | Slash operations can pass the exact session ID to `khala`; they must not fall back to cwd. |
| [Plugin skills](https://code.claude.com/docs/en/skills) are namespaced. Text after a command is passed as arguments. | A plugin-local skill has a canonical namespaced name. Preserve exact `/khala <verb>` through the skill bundled in the installed plugin; do not depend on ambiguous alias resolution. |

### Reuse and gaps on `main`

| Existing asset | Reuse | Missing work |
|---|---|---|
| `SessionBinding` in `packages/contracts/src/delivery/binding.ts` | It already contains `harness` and `sessionId`; inbox state is fenced by binding ID and generation. | Resolve Claude `session_id`/`CLAUDE_CODE_SESSION_ID` to the verified binding. Never key by cwd. |
| Durable inbox in `packages/agent-cli/src/cli/inbox.ts` | `mcp-inbox-batch` owns the one bounded durable peek and Khala-side batch-token acknowledgement. | `listening-mode-pull` consumes that API; Claude calls only `khala_read`/`khala read` and owns no batch, lease, cursor, lock, or acknowledgement primitive. |
| CLI/MCP services in `packages/agent-cli` | Reuse `connect`, stdin-only `send`, and `status`; `listening-mode-pull` owns `khala_read` and `khala read`. | Claude needs session-aware composition of those operations, not another read implementation. |
| `packages/agent-skill/SKILL.md` | Reuse its safe CLI guidance and message-byte handling as the plugin's bundled `/khala` skill. | Replace the Claude route's long-running `listen` workflow with hook-aware `create/join/send/read/who` dispatch. Do not install it separately or run listener and hook pull routes together. |
| Participant-listing port and CLI status | Status can identify the current binding. | No participant roster exists. A truthful `who` consumes the promoted channel-discovery and roster contracts rather than inferring members from message authors. Existing non-Matrix code naming is owned by `channel-terminology`. |

## Design

### Session and delivery model

The shared session record is keyed by `(harness="claude", Claude session ID)`
and resolves to the current binding ID, binding generation, channel, and listening
mode. Hooks receive the ID in JSON; slash-command Bash calls receive the same ID
in `CLAUDE_CODE_SESSION_ID`. The ID is only a selector: the setup-managed
credential authenticates the caller and must be authorized for that session
claim before resolution. Cwd is metadata only.

```text
Claude event / slash command
        │ session ID
        ▼
session → verified binding + generation + mode
        │
        ▼
shared khala_read operation → mcp-inbox-batch → batch + token
        │
        ├─ hook: JSON additionalContext
        ├─ asyncRewake: fixed content-free stderr marker, then Stop pull
        └─ /khala read: stdout
```

Claude adapter semantics:

1. Resolve the current binding and generation from the Claude session ID.
2. Call the shared `khala_read` application operation; do not read inbox files,
   acquire a second listener lock, or define a plugin-private lease.
3. Render only the returned bounded ordered batch into the hook or slash-command
   result using the shared batch format. Return its opaque token to
   `ClaudeSessionStatePort`, implemented by the authenticated local Khala
   server and scoped to the verified principal, binding, and generation; never
   expose it to the hook/command process, model context, or command output.
4. Carry the retained token through the trusted next Khala call so Khala performs the
   acknowledgement defined by `mcp-inbox-batch` and `listening-mode-pull`.
5. Treat malformed tokens, stale generations, and failed/unknown operations as
   no delivery; the shared operation retains the batch for its defined recovery
   path.

Every session-bound Khala operation uses one server-side adapter call envelope
that durably and atomically attaches the retained token, performs the next
linearized call, and stores any returned token through `ClaudeSessionStatePort`.
This includes send, pull, and shared mode-control calls across separate hook or
slash-command processes; it is token handoff within Khala, not a second
acknowledgement or deduplication path.

Restart safety and duplicate suppression belong entirely to Khala's batch-token
contract. Claude never keeps a deduplication ledger or acknowledges the inbox
directly. The adapter treats the token according to the upstream contract's
confidentiality classification and never exposes it in `additionalContext`,
stdout, logs, errors, or another session's call. Claude also offers no receipt
proving model consumption of hook output, so that stronger claim remains
unproven.

### Mode mapping

| Mode | Automatic hook behavior | Installed mechanism evidence |
|---|---|---|
| `steer` | Invoke `khala_read` synchronously after each tool; `Stop` is the no-more-tools fallback. | After-tool injection is proven, but the composed Khala route remains `unproven` until its retained evidence passes. Hard cancellation is separate and out of v1. |
| `sync` (default) | Deliver at `Stop`, after the turn reaches its end boundary. A `UserPromptSubmit` `asyncRewake` watcher can resume a recently idle session when a release arrives. | Stop continuation and one bounded idle wake are proven mechanisms; the composed Khala route and indefinite idle wake remain `unproven`. |
| `async` | Automatic hooks do not pull. The person may type `/khala read`; during its turn the agent may call `khala_read` MCP explicitly. | Both entry points use the same session-bound operation from `listening-mode-pull`; do not advertise support before its evidence passes. |

Mode changes are session-scoped and must be visible in status/`who`. A mode
change in one of two Claude sessions sharing a cwd must not affect the other.
Watcher duration, rearming, and pause/wake limits come from
`local-automation-fence`; the plugin does not define a second automation budget.
Mode mutation is outside the `/khala` dispatcher. The plugin reads
effective support from `HarnessCapabilities`; `listening-mode-agent-controls`
owns any separate cross-harness control surface.

### Hook lifecycle

Setup enables the plugin user-wide, so its hooks run in every Claude session on
the machine. Each hook first checks that its session holds a grant from the
running launch: the session's own `claude-grant.json` names a binding and
matches `active.json`'s transport capability. Without one, the hook exits 0
with no output. It calls no `khala`, makes no network call and writes no file.
The actions below apply only to bound sessions. `SessionEnd` still removes the
session's own hook state, which an unbound session never has.

| Event | Action | Guard/failure behavior |
|---|---|---|
| `UserPromptSubmit` | Mark the session active; replace any older watcher with exactly one bounded `asyncRewake` watcher for non-`async` mode. The watcher consumes `local-automation-fence`'s notification-only pending signal, which returns no payload or token, and may exit 2 only after the session is idle. | Cancellation of the older watcher must leave exactly one active watcher. Exit 0 on timeout or cancellation. Report watcher state; never promise an indefinite listener. The content-free two-step path is a production requirement that still needs an installed-version proof. |
| `PostToolUse` | In `steer`, invoke `khala_read` and return the shared framed batch as `additionalContext`; in `sync` or `async`, return empty. | Empty pull returns no output. Transport failure is diagnostic context, never fabricated channel content. Hard cancellation is not part of `steer`. |
| `Stop` | For `sync`, invoke `khala_read`; a non-empty batch keeps the session active while returning `additionalContext`, and an empty batch marks it idle before returning empty. For `steer`, use the same state machine only as the no-more-tools fallback. The subsequent `stop_hook_active=true` Stop marks the session idle before returning empty. Only then may a watcher observing a later release exit 2 with its fixed marker; the following `Stop` pulls it. | `stop_hook_active=true` never pulls or returns context. This prevents a self-sustaining stop loop and makes the active-to-idle transition definitive. `async` never pulls automatically. |
| `SessionEnd` | Remove ephemeral watcher/session state; durable batch/token state remains on Khala's side. | Cleanup must not invent an acknowledgement or mutate inbox state. |

Channel text is untrusted data. Every path that places it in Claude model
context—including agent-initiated `/khala read`—must JSON-encode and visibly
delimit it as Khala content; it must never interpolate it into shell source,
argv, environment variables, errors, status, or logs. This framing applies in a
normal interactive Claude session and does not depend on a restricted profile.
`setup-cli-claude` may inspect and report optional hardening such as filesystem,
shell, network, or MCP approval posture, but a missing or weak hardening report
does not disable `steer`, `sync`, or `async` delivery.

### Slash dispatcher

Use the plugin's one bundled `/khala` skill and dispatch on the first argument:

| Command | Primitive | Boundary |
|---|---|---|
| `/khala create` | Human-confirmed `khala_create_channel` | Requests creation through `channel-access-cli-mcp`; no channel is created without the person's confirmation. |
| `/khala join <channel-url>` | Access request and grant with the current session claim | Uses `channel-access-journal` and `channel-access-inbox`; may report “awaiting human approval,” and never self-admits. |
| `/khala send [binding]` | Existing structured `khala_send` MCP tool | Instructs Claude to compose one deliberate message from the current task context, shows the target binding in the action summary, and reports the finite result without echoing the body. Never interpolate message text or `$ARGUMENTS` into a shell command. Keep `khala send` stdin as the manual shell primitive. |
| `/khala read` | Shared `khala read`/`khala_read` operation from `listening-mode-pull`, scoped by `CLAUDE_CODE_SESSION_ID` | The person-entered slash command invokes the same pull the agent may call directly through MCP. Both honor binding generation and the Khala-owned batch token; the plugin adds no alternate pull. |
| `/khala who` | New channel/agent listing API plus current session/mode | Blocked by `channel-agent-listing`; must not infer membership from timeline authors. |

Keep deterministic transport and authorization in CLI/MCP services. The skill
owns only argument interpretation, user-facing summaries, and safe
orchestration. `setup-cli-claude` owns installing/removing the single user-scope
plugin containing the skill, hooks, and MCP entry.

## Trade-offs

| Choice | Benefit | Cost |
|---|---|---|
| Consume the shared pull contract backed by the batch/token API | Preserves one ordering, recovery, and acknowledgement model across MCP, CLI, OpenCode, and Claude. | Claude delivery must wait for `mcp-inbox-batch` and `listening-mode-pull`; it cannot optimize with a plugin-private cursor. |
| Khala-side token acknowledgement | Restart safety does not require host-side deduplication. | The plugin must preserve opaque tokens across its next Khala call and cannot infer acknowledgement from model behavior. |
| One user-scope plugin containing skill, hooks, and MCP entry | Setup installs one coherent Claude integration while reusing `agent-skill` content. | The package owns more surfaces and must keep their versions aligned. |
| Next-boundary `steer` | Matches observed Claude behavior and requires no hard abort. | It is not immediate during a long-running tool. UI capability text must say so. |
| Bounded `asyncRewake` watcher | Uses a documented Claude lifecycle and wakes an interactive idle session. | A watcher timeout creates a wake gap until rearmed; indefinite listening remains unproven. |

## Risks and open assumptions

| Risk/assumption | Treatment |
|---|---|
| The source requirements retain the pre-rename mode label. | The CODEOWNER/operator rename to `steer` is authoritative for this design and every contract below. |
| Plugin command aliasing can collide. | Treat the observed literal invocation as a no-collision proof only; exact `/khala` comes from the plugin's bundled skill. |
| Hook output success is not a Claude consumption receipt. | Preserve the shared batch token and make no stronger consumption claim; acknowledgement and restart suppression stay on Khala's side. Later receipt evidence must target the same user-started CLI session; hosted app-server evidence is secondary. |
| `asyncRewake` was proven only inside a 90-second window. | Surface watcher health/timeout and mark indefinite idle wake unproven until a longer installed-version test exists. |
| The probe used its test marker as `asyncRewake` stderr. | Production stderr is a fixed content-free wake marker; the release is delivered by the subsequent structured pull. That two-step behavior is unproven locally. |
| Optional hardening posture varies between installations. | `setup-cli-claude` reports what it can verify, but normal interactive delivery stays available and is always framed as untrusted content. |
| CLI main is fail-closed today. | Block production hooks on the local runtime composition and shared `khala_read`; do not add a plugin-private transport or pull path. |
| Two sessions may share cwd and channel. | Key every operation and mode change by Claude session ID; add same-cwd negative tests. |
| Automatically injected peer text can instruct a tool-capable Claude session. | Visibly delimit it as untrusted Khala content, keep bytes out of executable surfaces, and report optional setup hardening without gating delivery. |

## Non-goals

- A hard mid-tool abort or experimental Claude channel push.
- A second inbox, channel roster, admission flow, or transport inside the plugin.
- Capturing transcripts or automatically posting Claude's final answer.
- Self-admission to a channel; approval remains human-only.
- Claiming support for Claude versions other than the tested 2.1.282.
- Launching, hosting, or supervising Claude on the user's behalf; hosted and SDK
  routes are secondary only.
- A default `khala run <cli>` PTY wrapper without a separate operator decision.
- One-command install/remove behavior, owned by `setup-cli-claude`.

## Ticket contracts

Dependency names below are ticket slugs. The discovery contracts use
`channel-agent-listing` (RD6), `channel-access-cli-mcp` (RD7),
`channel-access-journal`, and `channel-access-inbox`.

### Contract 1 — Claude session adapter

| Field | Contract |
|---|---|
| **title** | Claude session adapter |
| **slug** | `claude-session-adapter` |
| **complexity** | **3** |
| **scope** | Authenticate the invoking Claude installation through its setup-managed credential; authorize `(harness="claude", sessionId)` as a selector for that principal's verified binding/generation; compose the existing `khala_read`, mode-control, `HarnessCapabilities`, and `local-automation-fence` notification-only pending-signal ports. Add a `ClaudeSessionStatePort` whose authenticated local-server adapter durably retains the prior batch token and linearizes the next trusted Khala call exactly as the shared pull contract requires. |
| **out of scope** | Inbox reads, a second batch/lease/acknowledgement API, host-side deduplication, Claude hook files, skill prose, channel roster implementation, or setup/install. |
| **files/packages touched** | A new Claude-focused composition module under `packages/agent-cli/src/composition/`; adjacent adapter tests; minimal registration-only diffs in `packages/agent-cli/src/cli/app.ts` and `src/mcp/server.ts`; `packages/agent-cli/README.md`. |
| **blocked-by** | `mcp-inbox-batch`, `listening-mode-pull`, `listening-mode-contract`, `local-sqlite-channel-store`, and `channel-terminology`. |
| **conflict risk** | High at agent-cli registration seams shared with `mcp-result-piggyback`, `listening-mode-pull`, and `channel-terminology`; keep behavior in the new module and registration diffs minimal. |

Acceptance criteria:

- The setup-managed credential authenticates the caller;
  the supplied Claude session ID is authorized as a selector for that principal
  and can address only the active generation of its verified binding. Cwd is
  never identity, and the session ID is never a bearer credential.
- Every invocation resolves the current loopback port and bearer token at
  runtime from the owner-only 0600 descriptor. Installed plugin/MCP
  configuration, argv, environment variables, logs, and errors never contain
  either value; a missing, malformed, stale, or insecurely permissioned
  descriptor fails closed.
- Every read delegates to the single `khala_read` application operation and
  returns its shared bounded batch shape and opaque token unchanged.
- The next Khala call carries the prior token through the shared contract;
  acknowledgement remains on Khala's side, and the Claude adapter keeps no
  deduplication ledger.
- Every session-bound send, pull, or mode-control call uses one atomic adapter
  envelope that attaches the retained token to the next linearized call exactly
  once and stores any returned token. `ClaudeSessionStatePort` is implemented
  by the authenticated local Khala server, so separate hook/command processes
  and server restart do not create process-local token state.
- The token remains scoped to the authenticated principal, binding, and
  generation and never appears in `additionalContext`, stdout, logs, errors, or
  another session's call.
- Requested/effective mode and support come from `listening-mode-contract` and
  `HarnessCapabilities`; unknown or unevidenced routes remain `unproven`.
- `HarnessCapabilities.acknowledgement` is exactly `unknown`, `unsupported`, or
  `batch_token_next_call`; only the last value permits retained-token handoff.
- Idle-wake observation delegates to `local-automation-fence`'s pending signal,
  which returns no release bytes or batch token and never performs a pull.
- New behavior lives outside `cli/app.ts` and `mcp/server.ts`; those shared files
  receive registration-only changes and the live entrypoint remains fail-closed.

Tests:

- **Wrong-implementation test:** inject a fake `khala_read`, invoke two same-cwd
  Claude sessions with distinct IDs, and fail if either call targets the other's
  binding or if the adapter reads inbox storage directly.
- Authenticate a second caller and present a known foreign Claude session ID;
  deny it without disclosing payload, token, channel, mode, roster, or binding.
- Return a batch token, make the next Khala call, and assert that exact opaque
  token is forwarded once through the shared API. A local acknowledge or
  host-side deduplication implementation must fail.
- Start separate hook and slash-command processes around a local-server restart;
  the server-side state port attaches the retained token to exactly one next
  call without loss, replay, or cross-session leakage.
- Exercise descriptor rotation plus missing, malformed, stale, and non-0600
  descriptors; fail closed and assert port/token bytes never appear in installed
  configuration, argv, environment variables, logs, or errors.
- Race send, pull, and shared mode-control calls after a pull returns a token;
  the next linearized call carries it exactly once, and later calls do not.
- Assert the token never appears in hook context, command stdout, argv, env,
  logs, errors, status, or any differently bound session call.
- Exercise stale generation, malformed/unknown token, empty batch, unavailable
  runtime, and `unproven` capability results without payload disclosure.
- Prove the pending-signal port returns only notification state and cannot
  create a batch token, move a cursor, or acknowledge a release.
- Assert shared `cli/app.ts` and `mcp/server.ts` changes contain registration
  only; run the focused `@khala/agent-cli` adapter and built-entrypoint tests.

### Contract 2 — Claude interactive hook plugin

| Field | Contract |
|---|---|
| **title** | Claude interactive hook plugin |
| **slug** | `claude-plugin-hooks` |
| **complexity** | **4** |
| **scope** | Own and ship the Claude hook runtime for `PostToolUse`, `Stop`, `UserPromptSubmit` + `asyncRewake`, and cleanup inside the single user-scope plugin. Call `claude-session-adapter` with the hook `session_id`, render the shared batch format as untrusted content, and delegate batch-token retention and next-call forwarding exclusively to `claude-session-adapter`; the hook runtime never receives or stores token state. Implement non-abort `steer` after-tool delivery and `sync` end-of-turn delivery in the user's own interactive CLI. |
| **out of scope** | CLI transport/inbox ownership, hard mid-tool abort, participant listing, generic harness support, hosted/SDK Claude as a product route, or a default PTY wrapper. |
| **files/packages touched** | New `packages/claude-plugin/` manifest, hooks, runtime, bundled-skill/MCP-entry layout, tests, and README; workspace/package metadata if required. No production import from `experiments/`. |
| **blocked-by** | `claude-session-adapter`, `listening-mode-contract`, and `local-automation-fence`. |
| **conflict risk** | Medium with `listening-mode-contract` on capability evidence and downstream `setup-cli-claude` on plugin layout/install paths; low with `opencode-bridge` because both consume shared primitives instead of forking them. The #155 evidence-only contract (the reduced `claude-interactive-listening-route`) must be blocked by `claude-plugin-hooks`; it does not implement this runtime. |

Acceptance criteria:

- `claude plugin validate --strict` passes on the supported installed version.
- `steer` invokes the shared pull after `PostToolUse`, with `Stop` only as the
  no-more-tools fallback. Default `sync` pulls at `Stop`; `async` never pulls
  automatically. `Stop` is empty when `stop_hook_active=true`.
- Each eligible delivery boundary injects the bounded batch available at claim time, preserving
  order; overflow remains queued for the next eligible boundary.
- A queued release inside the configured watcher window wakes an idle
  interactive session through `asyncRewake`; timeout/cancellation is observable.
- Watcher duration, rearming, and pause/wake limits are read from
  `local-automation-fence`; its notification-only pending signal returns no
  payload/token, and the plugin defines no parallel limits or polling pull.
- Every hook uses its input `session_id`, frames channel text as untrusted Khala
  content, and keeps bodies out of argv/env/logs/errors.
- Capability/status comes from `HarnessCapabilities`, says “next safe boundary”
  for `steer`, and does not claim a hard interrupt or indefinite idle wake.
- Capability/status reports acknowledgement using only `unknown`, `unsupported`,
  or `batch_token_next_call`; no plugin-local acknowledgement state is added.
- The hook never reads or acknowledges inbox state and never deduplicates
  releases; the trusted adapter forwards the prior opaque batch token only on
  its next Khala call and never places it in model-visible output.
- `steer` and `sync` hook delivery work in a normal user-started interactive
  Claude CLI, while `async` performs no automatic pull. Every delivered batch
  is visibly framed as untrusted Khala content; optional setup hardening is
  reported but never gates delivery.
- Downstream `setup-cli-claude` is blocked by both `claude-plugin-hooks` and
  `claude-plugin-dispatch`, and installs their outputs as one user-scope plugin
  containing the skill, hooks, and MCP entry. Its integration evidence proves
  all three modes, with explicit `async` delivery delegated to `/khala read`.

Tests:

- **Wrong-implementation test:** launch two interactive/fake-hook sessions in
  one cwd with distinct session IDs, race pulls, and assert zero cross-session
  delivery. A cwd-keyed implementation must fail.
- Race two matching hooks for one session and require the shared pull contract
  to serialize them; the plugin must not create a second lock or lease.
- **Wrong-implementation test:** submit a second prompt while a non-`async`
  watcher is active; assert it cancels the old watcher, leaves exactly one,
  never exits 2 before `Stop` marks the session idle, and one later release
  produces exactly one wake followed by one pull.
- Queue a release while Claude processes non-empty `Stop` context; the watcher
  must not wake until the later `stop_hook_active=true` Stop marks the session
  idle. An initially empty Stop marks idle before its empty return.
- Cover empty pull, runtime unavailable, malformed release, `stop_hook_active`, and
  payloads containing shell syntax, JSON delimiters, and prompt-injection text.
- Installed-version TTY test: observe `steer` delivery after `PostToolUse`,
  default-`sync` delivery at `Stop` without a loop, a content-free bounded idle
  wake followed by a structured pull, and session-ID continuity. Captured stderr
  contains no release bytes. The test launches the normal interactive Claude
  CLI directly; an SDK or Khala-hosted session does not satisfy it.
- **Wrong-implementation test:** run default `sync` through a tool call and fail
  if `PostToolUse` injects the queued batch before `Stop`; this rejects the old
  design where `steer` and `sync` shared the after-tool boundary.
- Let the watcher time out, verify no false support claim, then rearm with a new
  prompt and prove a subsequent wake.
- Prove a native, automation-fenced rearm mechanism delivers a release queued
  after at least one watcher timeout boundary without another user prompt.
  Until that installed-CLI test passes, `sync` remains `unproven`; a wake gap is
  not supported `sync` behavior.
- In a normal unrestricted interactive CLI fixture, prove `steer` and `sync`
  deliver while `async` performs no automatic pull, and hostile channel text
  remains delimited and inert in shell, argv, environment, logs, and errors. An
  optional setup hardening report may vary without changing support.

### Contract 3 — Bound-session `/khala send` and `/khala read`

| Field | Contract |
|---|---|
| **title** | Bound-session `/khala send` and `/khala read` |
| **slug** | `claude-plugin-dispatch` |
| **complexity** | **3** |
| **scope** | Bundle the reused `khala` skill into the single user-scope plugin with a dispatcher for `send` and `read`; pass `CLAUDE_CODE_SESSION_ID` as an authorized selector through `claude-session-adapter`; route authored bodies through `khala_send`; route `/khala read` through the existing `khala_read` MCP operation or `khala read` CLI command in the normal interactive session; render effective support from `HarnessCapabilities`. |
| **out of scope** | Channel discovery, roster, `create`, `join`, `who`, setup/remove automation, or moving authorization into prompt instructions. |
| **files/packages touched** | `packages/agent-skill/SKILL.md` as the reusable source; plugin-bundled skill and MCP entry under `packages/claude-plugin/`; skill/dispatcher tests and READMEs. Shared CLI/MCP files receive no new pull implementation. |
| **blocked-by** | `claude-plugin-hooks`, `claude-session-adapter`, `listening-mode-pull`, and `channel-terminology`. |
| **conflict risk** | High with downstream `setup-cli-claude` on installed assets and MCP configuration; medium with `channel-terminology` on public names. `setup-cli-claude` must list both `claude-plugin-hooks` and `claude-plugin-dispatch` as blockers, then install their outputs as one plugin. No channel-discovery file conflict. |

Acceptance criteria:

- Interactive Claude Code accepts the exact forms `/khala send` and
  `/khala read` after supported setup.
- `setup-cli-claude` preflights the installed command registry and fails with an
  actionable collision error unless the bundled skill resolves exact
  `/khala <verb>` forms. It never silently substitutes a namespaced spelling or
  advertises support without an installed-version invocation proof.
- The dispatcher rejects missing/unknown verbs with concise help and delegates
  deterministic behavior to CLI services.
- `send` passes the body as structured `khala_send` MCP input; arguments,
  status, errors, and logs never contain or echo the message body. The manual
  `khala send` command remains stdin-only.
- `/khala send [binding]` instructs Claude to compose exactly one deliberate
  channel message from the current task context, identifies the target binding
  in its action summary, and reports success, rejection, or `outcome_unknown`
  without echoing the body. An agent may invoke `khala_send` directly with the
  same structured result contract.
- `read` calls only the shared `khala_read`/`khala read` operation and returns
  its batch format; no `khala_check`, plugin-private pull, or local acknowledge
  path exists.
- A person-entered `/khala read` and an agent-initiated `khala_read` MCP call
  use the same session-bound operation and produce the same framed result.
- `read` works in a normal interactive session, visibly frames the batch as
  untrusted Khala content, and never gates delivery on optional hardening. Its
  batch token stays in the trusted adapter and is never rendered in command
  output or model context.
- All operations bind to `CLAUDE_CODE_SESSION_ID`; there is no cwd-global
  current session.
- The dispatcher reads effective support from `HarnessCapabilities`, creates no
  mode-control syntax or store, and leaves unevidenced claims `unproven`.

Tests:

- **Wrong-implementation test:** send content containing spaces, quotes,
  command substitution, newlines, and JSON delimiters; the exact bytes reach
  structured MCP input and nothing executes or appears in argv/env/logs/tool
  results.
- Invoke both literal forms in an interactive installed-version test and assert
  channel state/output, not only skill discovery.
- Exercise both async actors: a person-entered `/khala read` and an
  agent-initiated `khala_read` MCP call must target the same session and return
  the same framing/token semantics.
- Installed-version agent-path test: without a person entering a slash command,
  Claude follows the bundled skill, calls `khala_read` MCP, and consumes a
  queued batch. Keep agent-controlled `async` capability `unproven` until this
  passes.
- Install beside a competing `khala` command and require setup to fail before
  claiming support; removing the collision then makes the exact literal forms
  pass.
- Run two same-cwd Claude sessions and prove `read` and `send` target the
  correct session.
- **Wrong-implementation test:** instrument the shared `khala_read` port and
  fail if `/khala read` touches inbox storage, calls a differently named pull
  operation, acknowledges locally, or suppresses a returned release itself.
- Present a foreign session ID from a separately authenticated caller and
  require denial; run hostile channel text through `/khala read` in a normal
  interactive session and require visible untrusted framing with zero shell,
  argv, environment, log, or error interpolation.
- Keep `SKILL.md`, README examples, and the existing skill-doc contract test in
  sync.

### Contract 4 — `/khala create`, `/khala join`, and `/khala who`

| Field | Contract |
|---|---|
| **title** | `/khala create`, `/khala join`, and `/khala who` |
| **slug** | `claude-plugin-channel-commands` |
| **complexity** | **2** |
| **scope** | Add `create`, `join`, and `who` to the plugin-bundled dispatcher. `create` calls human-confirmed `khala_create_channel`; `join <channel-url>` uses the access-request journal and human-grant inbox; `who` renders the authoritative joined-agent list plus the current session and effective mode. |
| **out of scope** | Granting admission, implementing discovery/roster storage, changing `send`/`read`, or setup/remove automation. |
| **files/packages touched** | `packages/agent-skill/SKILL.md` as the reusable source; plugin-bundled skill under `packages/claude-plugin/`; skill/dispatcher tests and READMEs. |
| **blocked-by** | `claude-plugin-dispatch`, `channel-agent-listing`, `channel-access-cli-mcp`, `channel-access-journal`, and `channel-access-inbox`. |
| **conflict risk** | High with the channel-discovery contracts on result schemas and human-approval states; low with `setup-cli-claude` if install paths from `claude-plugin-dispatch` remain unchanged. |

Acceptance criteria:

- Interactive Claude Code accepts exact `/khala create`,
  `/khala join <channel-url>`, and `/khala who` forms from the bundled plugin
  skill.
- `create` calls `khala_create_channel` and requires the person's confirmation;
  rejecting confirmation creates no channel.
- `join` takes a channel URL, writes the access request through
  `channel-access-journal`, observes the human grant through
  `channel-access-inbox`, and never admits the agent itself. Without approval it
  reports a pending decision and creates no admitted binding.
- `join` is non-blocking. `channel-access-inbox` is the single resume path: its
  grant, denial, or expiry control event is delivered to the same session at
  the next eligible hook boundary, or through explicit `khala_read` in `async`.
  A grant lets the shared access flow create the binding; denial/expiry reports
  the finite outcome. Retries reuse the journaled operation and never create a
  second request.
- `who` uses the authoritative roster API, includes a safe current-session label
  plus effective mode, and never infers membership from timeline authors or
  renders the raw Claude session ID unless the listing contract explicitly
  classifies that disclosure as safe.
- All commands bind to `CLAUDE_CODE_SESSION_ID` and preserve the error/body
  disclosure rules from Contract 3.
- Any missing discovery/listing/access type blocks this ticket and is fixed by
  its owning blocked-by dependency; this consumer never edits those contracts.

Tests:

- **Wrong-implementation test:** attempt `join` without human approval and
  assert no admitted binding exists; a direct self-admission path must fail.
- Start a non-blocking join, then exercise grant, denial, and expiry through
  `channel-access-inbox`; each outcome resumes only the requesting session,
  reaches a finite result through its current mode, and creates no duplicate
  request or binding.
- **Wrong-implementation test:** reject the confirmation for `/khala create`
  and assert no channel exists; silent creation must fail.
- Invoke all three literal forms in an interactive installed-version test and
  assert authoritative channel state/output, not only skill discovery.
- Run two same-cwd sessions and prove `create`/`join`/`who` resolve the correct
  binding and roster.
- Keep `SKILL.md`, README examples, and the skill-doc contract test in sync.
