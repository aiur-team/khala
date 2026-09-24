# Claude Code plugin: hooks and slash commands

Status: research complete, 2026-09-24. Deliverable for E09 ticket #140.

## Summary

Claude Code 2.1.282 can support a Khala integration for interactive sessions
without owning Claude's process. A command hook can synchronously inject a
message after a tool result, a `Stop` hook can continue a turn instead of
idling, and an asynchronous `UserPromptSubmit` hook can wake an idle session.
The hook input and Bash subprocess environment both expose the Claude session
ID, so delivery can be keyed to the session rather than the working directory.

The plugin should be a thin consumer of `packages/agent-cli`, not a second
inbox. It calls only the `listening-mode-pull` operation
(`khala_read`/`khala read`), which is backed by the single `mcp-inbox-batch`
token API; it does not add a second batch, lease, acknowledgement, or pull API.
Keep the existing `packages/agent-skill` as the stable literal `/khala`
dispatcher for `join`, `send`, `read`, and `who`. Plugin skills are officially
namespaced, even though the installed version accepted literal `/khala join`
when no command conflicted.

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
| [Plugin skills](https://code.claude.com/docs/en/skills) are namespaced. Text after a command is passed as arguments. | A plugin-local skill has a canonical namespaced name. Preserve exact `/khala <verb>` through the already-installed user skill; do not depend on ambiguous alias resolution. |

### Reuse and gaps on `main`

| Existing asset | Reuse | Missing work |
|---|---|---|
| `SessionBinding` in `packages/contracts/src/delivery/binding.ts` | It already contains `harness` and `sessionId`; inbox state is fenced by binding ID and generation. | Resolve Claude `session_id`/`CLAUDE_CODE_SESSION_ID` to the verified binding. Never key by cwd. |
| Durable inbox in `packages/agent-cli/src/cli/inbox.ts` | `mcp-inbox-batch` owns the one bounded durable peek and Khala-side batch-token acknowledgement. | `listening-mode-pull` consumes that API; Claude calls only `khala_read`/`khala read` and owns no batch, lease, cursor, lock, or acknowledgement primitive. |
| CLI/MCP services in `packages/agent-cli` | Reuse `connect`, stdin-only `send`, and `status`; `listening-mode-pull` owns `khala_read` and `khala read`. | Claude needs session-aware composition of those operations, not another read implementation. |
| `packages/agent-skill/SKILL.md` | It is already installed as `/khala`, supervises safe CLI usage, and keeps message bytes off argv. | Replace the Claude route's long-running `listen` workflow with hook-aware `join/send/read/who` dispatch. Do not run the listener and hook pull routes together. |
| Participant-listing port and CLI status | Status can identify the current binding. | No participant roster exists. A truthful `who` consumes the promoted channel-discovery and roster contracts rather than inferring members from message authors. Existing non-Matrix code naming is owned by `channel-terminology`. |

## Design

### Session and delivery model

The shared session record is keyed by `(harness="claude", Claude session ID)`
and resolves to the current binding ID, binding generation, channel, and listening
mode. Hooks receive the ID in JSON; slash-command Bash calls receive the same ID
in `CLAUDE_CODE_SESSION_ID`. The ID is only a selector: the setup-managed
Claude credential or launch identity authenticates the caller and must be
authorized for that session claim before resolution. Cwd is metadata only.

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
   result using the shared batch format. Retain its opaque token inside the
   trusted adapter, scoped to the verified principal, binding, and generation;
   never expose it to model context or command output.
4. Carry the retained token through the trusted next Khala call so Khala performs the
   acknowledgement defined by `mcp-inbox-batch` and `listening-mode-pull`.
5. Treat malformed tokens, stale generations, and failed/unknown operations as
   no delivery; the shared operation retains the batch for its defined recovery
   path.

Every session-bound Khala operation uses one adapter call envelope that
atomically attaches the retained token, performs the next linearized call, and
stores any returned token. This includes send, pull, and shared mode-control
calls; it is token handoff, not a second acknowledgement or deduplication path.

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
| `async` | Automatic hooks do not pull. The agent explicitly invokes `/khala read`. | Public pull behavior and its evidence are owned by `listening-mode-pull`; do not advertise support before that evidence passes. |

Mode changes are session-scoped and must be visible in status/`who`. A mode
change in one of two Claude sessions sharing a cwd must not affect the other.
Watcher duration, rearming, and pause/wake limits come from
`local-automation-fence`; the plugin does not define a second automation budget.
Mode mutation is outside the four-command `/khala` dispatcher. The plugin reads
effective support from `HarnessCapabilities`; `listening-mode-agent-controls`
owns any separate cross-harness control surface.

### Hook lifecycle

| Event | Action | Guard/failure behavior |
|---|---|---|
| `UserPromptSubmit` | Mark the session active; replace any older watcher with exactly one bounded `asyncRewake` watcher for non-`async` mode. The watcher consumes `local-automation-fence`'s notification-only pending signal, which returns no payload or token, and may exit 2 only after the session is idle. | Cancellation of the older watcher must leave exactly one active watcher. Exit 0 on timeout or cancellation. Report watcher state; never promise an indefinite listener. The content-free two-step path is a production requirement that still needs an installed-version proof. |
| `PostToolUse` | In `steer`, invoke `khala_read` and return the shared framed batch as `additionalContext`; in `sync` or `async`, return empty. | Empty pull returns no output. Transport failure is diagnostic context, never fabricated channel content. Hard cancellation is not part of `steer`. |
| `Stop` | For `sync`, invoke `khala_read`; a non-empty batch keeps the session active while returning `additionalContext`, and an empty batch marks it idle before returning empty. For `steer`, use the same state machine only as the no-more-tools fallback. The subsequent `stop_hook_active=true` Stop marks the session idle before returning empty. Only then may a watcher observing a later release exit 2 with its fixed marker; the following `Stop` pulls it. | `stop_hook_active=true` never pulls or returns context. This prevents a self-sustaining stop loop and makes the active-to-idle transition definitive. `async` never pulls automatically. |
| `SessionEnd` | Remove ephemeral watcher/session state; durable batch/token state remains on Khala's side. | Cleanup must not invent an acknowledgement or mutate inbox state. |

Channel text is untrusted data. Every path that places it in Claude model
context—including agent-initiated `/khala read`—must JSON-encode and visibly
delimit it as Khala content; it must never interpolate it into shell source,
argv, environment variables, errors, status, or logs. Model-context delivery is
enabled only under a verified restricted Claude profile: reads and writes are
confined to explicit approved worktree/scratch roots, and every outbound
capability or data-egress path (including shell, network, and structured MCP such
as `khala_send`) is deny-by-default or requires human approval when acting on
channel content. This restriction does not block an explicit, user-authored
`/khala send`. If the profile cannot be verified, all model-context delivery,
including `/khala read`, fails closed; capability state remains `unproven`.

### Slash dispatcher

Use one `/khala` skill and dispatch on the first argument:

| Command | Primitive | Boundary |
|---|---|---|
| `/khala join <channel-or-code>` | `khala connect`/discovery request with the current session claim | May request access and report “awaiting human approval”; D11 forbids self-admission. |
| `/khala send [binding]` | Existing structured `khala_send` MCP tool | Never interpolate message text or `$ARGUMENTS` into a shell command. Keep `khala send` stdin as the manual shell primitive. |
| `/khala read` | Shared `khala read`/`khala_read` operation from `listening-mode-pull`, scoped by `CLAUDE_CODE_SESSION_ID` | Honors binding generation and the Khala-owned batch token; the plugin adds no alternate pull. |
| `/khala who` | New channel/agent listing API plus current session/mode | Blocked by `channel-listing-cli`; must not infer membership from timeline authors. |

Keep deterministic transport and authorization in CLI/MCP services. The skill
owns only argument interpretation, user-facing summaries, and safe
orchestration. `setup-cli-claude` owns installing/removing the plugin and user-scoped
skill together, including the `khala_send` MCP configuration.

## Trade-offs

| Choice | Benefit | Cost |
|---|---|---|
| Consume the shared pull contract backed by the batch/token API | Preserves one ordering, recovery, and acknowledgement model across MCP, CLI, OpenCode, and Claude. | Claude delivery must wait for `mcp-inbox-batch` and `listening-mode-pull`; it cannot optimize with a plugin-private cursor. |
| Khala-side token acknowledgement | Restart safety does not require host-side deduplication. | The plugin must preserve opaque tokens across its next Khala call and cannot infer acknowledgement from model behavior. |
| User-scoped `/khala` skill plus plugin hooks | Stable literal command and reuse of `agent-skill`; plugin stays deterministic. | Setup installs two coordinated assets rather than one plugin-only artifact. |
| Next-boundary `steer` | Matches observed Claude behavior and requires no hard abort. | It is not immediate during a long-running tool. UI capability text must say so. |
| Bounded `asyncRewake` watcher | Uses a documented Claude lifecycle and wakes an interactive idle session. | A watcher timeout creates a wake gap until rearmed; indefinite listening remains unproven. |

## Risks and open assumptions

| Risk/assumption | Treatment |
|---|---|
| The source requirements retain the pre-rename mode label. | The CODEOWNER/operator rename to `steer` is authoritative for this design and every contract below. |
| Plugin command aliasing can collide. | Treat the observed literal invocation as a no-collision proof only; exact `/khala` comes from the user-scoped skill. |
| Hook output success is not a Claude consumption receipt. | Preserve the shared batch token and make no stronger consumption claim; acknowledgement and restart suppression stay on Khala's side. |
| `asyncRewake` was proven only inside a 90-second window. | Surface watcher health/timeout and mark indefinite idle wake unproven until a longer installed-version test exists. |
| The probe used its test marker as `asyncRewake` stderr. | Production stderr is a fixed content-free wake marker; the release is delivered by the subsequent structured pull. That two-step behavior is unproven locally. |
| No installed-version signal was proven for the full restricted Claude profile. | `setup-cli-claude` must define and prove the attestation during setup. Until then, automatic modes stay unavailable and every unevidenced capability, including `async`, remains `unproven`. |
| CLI main is fail-closed today. | Block production hooks on the local runtime composition and shared `khala_read`; do not add a plugin-private transport or pull path. |
| Two sessions may share cwd and channel. | Key every operation and mode change by Claude session ID; add same-cwd negative tests. |
| Automatically injected peer text can instruct a tool-capable Claude session. | Gate automatic modes on a verified restricted profile; otherwise expose only explicit `async` reads. |

## Non-goals

- A hard mid-tool abort or experimental Claude channel push.
- A second inbox, channel roster, admission flow, or transport inside the plugin.
- Capturing transcripts or automatically posting Claude's final answer.
- Self-admission to a channel; approval remains human-only.
- Claiming support for Claude versions other than the tested 2.1.282.
- One-command install/remove behavior, owned by `setup-cli-claude`.

## Ticket contracts

Dependency names below are ticket slugs. For the discovery research in #144,
this document names the promoted equivalents of RD1, RD6, and RD7 as
`channel-discovery-contract`, `channel-listing-cli`, and `channel-access-cli`;
the Executor should preserve those slugs when promoting the shared contracts.

### Contract 1 — Claude session adapter

| Field | Contract |
|---|---|
| **slug** | `claude-session-adapter` |
| **complexity** | **3** |
| **scope** | Authenticate the invoking Claude installation through its setup-managed credential or launch identity; authorize `(harness="claude", sessionId)` as a selector for that principal's verified binding/generation; compose the existing `khala_read`, mode-control, `HarnessCapabilities`, and `local-automation-fence` notification-only pending-signal ports. Retain the prior batch token outside model-visible output for the next trusted Khala call exactly as the shared pull contract requires. |
| **out of scope** | Inbox reads, a second batch/lease/acknowledgement API, host-side deduplication, Claude hook files, skill prose, channel roster implementation, or setup/install. |
| **files/packages touched** | A new Claude-focused composition module under `packages/agent-cli/src/composition/`; adjacent adapter tests; minimal registration-only diffs in `packages/agent-cli/src/cli/app.ts` and `src/mcp/server.ts`; `packages/agent-cli/README.md`. |
| **blocked-by** | `mcp-inbox-batch`, `listening-mode-pull`, `listening-mode-contract`, `local-sqlite-room-store`, and `channel-terminology`. |
| **conflict risk** | High at agent-cli registration seams shared with `mcp-result-piggyback`, `listening-mode-pull`, and `channel-terminology`; keep behavior in the new module and registration diffs minimal. |

Acceptance criteria:

- The setup-managed credential or launch identity authenticates the caller;
  the supplied Claude session ID is authorized as a selector for that principal
  and can address only the active generation of its verified binding. Cwd is
  never identity, and the session ID is never a bearer credential.
- Every read delegates to the single `khala_read` application operation and
  returns its shared bounded batch shape and opaque token unchanged.
- The next Khala call carries the prior token through the shared contract;
  acknowledgement remains on Khala's side, and the Claude adapter keeps no
  deduplication ledger.
- Every session-bound send, pull, or mode-control call uses one atomic adapter
  envelope that attaches the retained token to the next linearized call exactly
  once and stores any returned token.
- The token remains scoped to the authenticated principal, binding, and
  generation and never appears in `additionalContext`, stdout, logs, errors, or
  another session's call.
- Requested/effective mode and support come from `listening-mode-contract` and
  `HarnessCapabilities`; unknown or unevidenced routes remain `unproven`.
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
| **slug** | `claude-plugin-hooks` |
| **complexity** | **4** |
| **scope** | Add a distributable Claude plugin manifest and hook runtime for `PostToolUse`, `Stop`, `UserPromptSubmit` + `asyncRewake`, and cleanup. Call `claude-session-adapter` with the hook `session_id`, render the shared batch format, and forward batch tokens only through subsequent Khala calls. Implement non-abort `steer` after-tool delivery and `sync` end-of-turn delivery. Consume verified/unverified restricted-profile state from `HarnessCapabilities` and fail closed for model-context delivery when unverified. |
| **out of scope** | CLI transport/inbox ownership, hard mid-tool abort, slash-command installation, participant listing, or generic harness support. |
| **files/packages touched** | New `packages/claude-plugin/` manifest, hooks, runtime, tests, and README; workspace/package metadata if required. No production import from `experiments/`. |
| **blocked-by** | `claude-session-adapter`, `listening-mode-contract`, and `local-automation-fence`. |
| **conflict risk** | Medium with `listening-mode-contract` on mode behavior and downstream `setup-cli-claude` on plugin layout/install paths; low with `opencode-bridge` because both consume shared primitives instead of forking them. `setup-cli-claude` must consume this packaged artifact and owns provisioning/attestation. |

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
- The hook never reads or acknowledges inbox state and never deduplicates
  releases; the trusted adapter forwards the prior opaque batch token only on
  its next Khala call and never places it in model-visible output.
- Automatic `steer`/`sync` is available only when the runtime verifies the
  restricted profile: reads and writes are limited to explicit approved roots,
  and automatically injected content cannot use any outbound capability or
  data-egress path, including `khala_send`, without deny-by-default enforcement
  or human approval. An unrestricted session performs no automatic delivery;
  explicit `async` pull remains evidence-gated, and an explicit user-authored
  `/khala send` remains legitimate.
- A verified capability fixture enables the eligible hook; an unverified one
  fails closed. Downstream `setup-cli-claude` provisions and attests the profile,
  consumes this packaged artifact, and never promotes configured default `sync`
  without passing evidence in `HarnessCapabilities`.

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
  contains no release bytes.
- **Wrong-implementation test:** run default `sync` through a tool call and fail
  if `PostToolUse` injects the queued batch before `Stop`; this rejects the old
  design where `steer` and `sync` shared the after-tool boundary.
- Let the watcher time out, verify no false support claim, then rearm with a new
  prompt and prove a subsequent wake.
- With verified and unverified capability fixtures, prove unverified
  model-context delivery fails before hook output while explicit user-authored
  `/khala send` remains allowed. `setup-cli-claude` owns the full hostile-content
  egress proof across filesystem, shell, network, and structured MCP for both
  automatic delivery and agent-initiated `/khala read`.

### Contract 3 — Bound-session `/khala send` and `/khala read`

| Field | Contract |
|---|---|
| **slug** | `claude-plugin-dispatch` |
| **complexity** | **3** |
| **scope** | Extend the existing user-scoped `khala` skill with a dispatcher for `send` and `read`; pass `CLAUDE_CODE_SESSION_ID` as an authorized selector through `claude-session-adapter`; route authored bodies through `khala_send`; route `/khala read` through the existing `khala_read` MCP operation or `khala read` CLI command only under the verified restricted profile; render effective support from `HarnessCapabilities`. |
| **out of scope** | Channel discovery, roster, `join`, `who`, setup/remove automation, or moving authorization into prompt instructions. |
| **files/packages touched** | `packages/agent-skill/SKILL.md`; `packages/agent-skill/src/skill-docs.test.ts`; dispatcher helpers/tests if needed; `packages/agent-skill/README.md`. Shared CLI/MCP files receive no new pull implementation. |
| **blocked-by** | `claude-session-adapter`, `listening-mode-pull`, and `channel-terminology`. |
| **conflict risk** | High with downstream `setup-cli-claude` on installed assets and MCP configuration; medium with `channel-terminology` on public names. Setup must consume this packaged skill. No channel-discovery file conflict. |

Acceptance criteria:

- Interactive Claude Code accepts the exact forms `/khala send` and
  `/khala read` after supported setup.
- The dispatcher rejects missing/unknown verbs with concise help and delegates
  deterministic behavior to CLI services.
- `send` passes the body as structured `khala_send` MCP input; arguments,
  status, errors, and logs never contain or echo the message body. The manual
  `khala send` command remains stdin-only.
- `read` calls only the shared `khala_read`/`khala read` operation and returns
  its batch format; no `khala_check`, plugin-private pull, or local acknowledge
  path exists.
- `read` fails closed before model-context delivery when the restricted profile
  is absent. Its batch token stays in the trusted adapter and is never rendered
  in command output or model context.
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
- Run two same-cwd Claude sessions and prove `read` and `send` target the
  correct session.
- **Wrong-implementation test:** instrument the shared `khala_read` port and
  fail if `/khala read` touches inbox storage, calls a differently named pull
  operation, acknowledges locally, or suppresses a returned release itself.
- Present a foreign session ID from a separately authenticated caller and
  require denial; run hostile channel text through `/khala read` with the
  restricted profile absent and require zero model-visible bytes and zero egress.
- Keep `SKILL.md`, README examples, and the existing skill-doc contract test in
  sync.

### Contract 4 — `/khala join` and `/khala who`

| Field | Contract |
|---|---|
| **slug** | `claude-plugin-channel-commands` |
| **complexity** | **2** |
| **scope** | Add `join` and `who` to the user-scoped dispatcher after the channel-discovery contracts provide listing, access-request, and joined-agent APIs. `join` may request access and report approval state; `who` renders the authoritative joined-agent list plus the current session and effective mode. |
| **out of scope** | Granting admission, implementing discovery/roster storage, changing `send`/`read`, or setup/remove automation. |
| **files/packages touched** | `packages/agent-skill/SKILL.md`; `packages/agent-skill/src/skill-docs.test.ts`; dispatcher helpers/tests; `packages/agent-skill/README.md`. |
| **blocked-by** | `claude-plugin-dispatch`, `channel-discovery-contract`, `channel-listing-cli`, and `channel-access-cli`. |
| **conflict risk** | High with the channel-discovery contracts on result schemas and human-approval states; low with `setup-cli-claude` if install paths from `claude-plugin-dispatch` remain unchanged. |

Acceptance criteria:

- Interactive Claude Code accepts exact `/khala join` and `/khala who` forms.
- `join` can discover/request access but never admits the agent; without human
  approval it reports a pending decision and creates no admitted binding.
- `who` uses the authoritative roster API, includes a safe current-session label
  plus effective mode, and never infers membership from timeline authors or
  renders the raw Claude session ID unless the listing contract explicitly
  classifies that disclosure as safe.
- Both commands bind to `CLAUDE_CODE_SESSION_ID` and preserve the error/body
  disclosure rules from Contract 3.
- Any missing discovery/listing/access type blocks this ticket and is fixed by
  its owning channel-discovery slug; this consumer never edits those contracts.

Tests:

- **Wrong-implementation test:** attempt `join` without human approval and
  assert no admitted binding exists; a direct self-admission path must fail.
- Invoke both literal forms in an interactive installed-version test and assert
  authoritative channel state/output, not only skill discovery.
- Run two same-cwd sessions and prove `join`/`who` resolve the correct binding
  and roster.
- Keep `SKILL.md`, README examples, and the skill-doc contract test in sync.
