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
inbox. Add a lock-protected bounded batch drain with a transactional output
writer first; then package the hooks.
Keep the existing `packages/agent-skill` as the stable literal `/khala`
dispatcher for `join`, `send`, `read`, and `who`. Plugin skills are officially
namespaced, even though the installed version accepted literal `/khala join`
when no command conflicted.

The operator's 2026-09-24 mode rename supersedes the stale wording in
[`requirements.md`](requirements.md): the modes are `steer`, `sync` (default),
and `async`. This research found no hard mid-tool interrupt. Claude's proven
`steer` behavior is delivery at the next tool boundary.

## Findings and evidence

### Installed-version proof

The throwaway plugin under
[`experiments/internal-mode/claude-plugin/`](../../../experiments/internal-mode/claude-plugin/README.md)
was loaded with `--plugin-dir` in an interactive Linux TTY. Its strict manifest
validation and deterministic concurrency test both pass.

| Claim | Claude Code 2.1.282 observation | Status |
|---|---|---|
| `PostToolUse` synchronous drain | A Bash tool completed, the hook returned `additionalContext`, and Claude consumed `post-tool-delivered-140` immediately after the result. | Proven once |
| `Stop` continues instead of idling | The hook returned `stop-delivered-140`; Claude continued, then invoked `Stop` again with `stop_hook_active=true`. | Proven once |
| `UserPromptSubmit` + `asyncRewake` wakes idle | After the first `Stop`, the background hook exited 2 when a message appeared. Claude resumed under the same session ID with a new prompt ID and consumed `rewake-delivered-140`. | Proven once within 90 seconds |
| Session identity | All hook events carried the same `session_id`; cwd was recorded separately. Current Claude docs also expose matching `CLAUDE_CODE_SESSION_ID` to Bash subprocesses. | Proven for one session; official contract |
| Atomic per-session claim | Two concurrent hook processes in the same cwd targeted session A. Exactly one claimed A's item; neither consumed session B's item, which B later drained. | Deterministic single-item proof; batching is unproven |
| Literal dispatcher | `/khala join` loaded the plugin skill and expanded `$ARGUMENTS` to `join`, producing `KHPLUG-COMMAND join`. | Proven with no command collision |

Evidence is summarized in
[`evidence.json`](../../../experiments/internal-mode/claude-plugin/evidence.json);
the concurrency regression is
[`probe.test.mjs`](../../../experiments/internal-mode/claude-plugin/probe.test.mjs).
The hook event log and exact Claude session ID were intentionally not committed.

### Current Claude contracts

| Contract | Design consequence |
|---|---|
| [Hooks](https://code.claude.com/docs/en/hooks) provide `session_id`; `PostToolUse` and `Stop` can return event-specific `additionalContext`. | Hooks can call one session-aware drain and inject only its returned release. |
| `Stop` provides `stop_hook_active` and bounds consecutive continuations. | Return no context when already active or when the drain is empty; never construct a continuation loop. |
| `asyncRewake` runs a command hook in the background and wakes Claude when it exits 2. Hook timeouts still apply. | It is an idle-wake window, not proof of an indefinitely resident listener. Timeouts and rearming must be visible. |
| [Environment variables](https://code.claude.com/docs/en/env-vars) expose `CLAUDE_CODE_SESSION_ID` to Bash and PowerShell tools. | Slash operations can pass the exact session ID to `khala`; they must not fall back to cwd. |
| [Plugin skills](https://code.claude.com/docs/en/skills) are namespaced. Text after a command is passed as arguments. | A plugin-local skill has a canonical namespaced name. Preserve exact `/khala <verb>` through the already-installed user skill; do not depend on ambiguous alias resolution. |

### Reuse and gaps on `main`

| Existing asset | Reuse | Missing work |
|---|---|---|
| `SessionBinding` in `packages/contracts/src/delivery/binding.ts` | It already contains `harness` and `sessionId`; inbox state is fenced by binding ID and generation. | Resolve Claude `session_id`/`CLAUDE_CODE_SESSION_ID` to the verified binding. Never key by cwd. |
| Durable inbox in `packages/agent-cli/src/cli/inbox.ts` | Keep release deduplication, cursor, acknowledge, generation fencing, and the listener lock. | Add a bounded batch drain that holds the same lock across read, the consumer's final write, and acknowledge. Direct `readNext` plus `acknowledge` is not process-atomic. |
| CLI services in `packages/agent-cli/src/cli/app.ts` | Reuse `connect`, stdin-only `send`, and `status`; add `read` rather than starting another listener. | `src/cli/main.ts` still composes an unavailable client, and the bootstrap client is constructed for one fixed claim. Live session-aware composition is required. |
| `packages/agent-skill/SKILL.md` | It is already installed as `/khala`, supervises safe CLI usage, and keeps message bytes off argv. | Replace the Claude route's long-running `listen` workflow with hook-aware `join/send/read/who` dispatch. Do not run listener and hook drains together. |
| `RoomPort` and CLI status | Status can identify the current binding. | No participant roster exists. A truthful `who` depends on E09 #144 rather than inferring members from message authors. |

## Design

### Session and delivery model

The shared session record is keyed by `(harness="claude", Claude session ID)`
and resolves to the current binding ID, binding generation, room, and listening
mode. Hooks receive the ID in JSON; slash-command Bash calls receive the same ID
in `CLAUDE_CODE_SESSION_ID`. Cwd is metadata only.

```text
Claude event / slash command
        │ session ID
        ▼
session → verified binding + generation + mode
        │
        ▼
agent-cli one-shot drain → existing durable inbox → release bytes
        │
        ├─ hook: JSON additionalContext
        ├─ asyncRewake: fixed content-free stderr marker, then Stop drain
        └─ /khala read: stdout
```

One-shot drain semantics:

1. Resolve the current binding and generation from the Claude session ID.
2. Acquire the existing per-binding listener lock and revalidate that generation
   while holding the lock.
3. Read a bounded batch of the releases currently available for that generation,
   capped by the existing delivery limits (`maxSelectionEvents` and
   `maxPayloadBytes`). Leave overflow queued.
4. Give that batch to a consumer-supplied writer while retaining the lock. The
   CLI writer emits its framed stdout response; the hook writer emits the final
   event-specific JSON response.
5. Acknowledge the batch only after the writer succeeds, then release the lock.

This shared transactional writer prevents two hooks from consuming one item and
avoids loss between CLI output and final hook framing. A crash after final output
but before acknowledge may redeliver the batch; release IDs must remain visible
so downstream handling can be idempotent. Claude offers no receipt that proves
it consumed hook output, so exactly-once delivery into model context is unproven
and should not be claimed.

### Mode mapping

| Mode | Automatic hook behavior | Proven support |
|---|---|---|
| `steer` | Synchronous `PostToolUse` drain; `Stop` is the idle fallback. | Next-tool-boundary delivery proven. Hard mid-tool interruption is unproven and out of v1. |
| `sync` (default) | `Stop` drains before Claude idles. A `UserPromptSubmit` `asyncRewake` watcher can resume a recently idle session when a release arrives. | Stop continuation and one bounded idle wake proven. Indefinite idle wake is unproven. |
| `async` | Automatic hooks do not drain. The agent invokes `/khala read`. | CLI design only; depends on the one-shot drain. |

Mode changes are session-scoped and must be visible in status/`who`. A mode
change in one of two Claude sessions sharing a cwd must not affect the other.
The slash surface has no dedicated mode verb, so v1 may accept
`/khala who --mode <steer|sync|async>` or delegate to a common CLI mode command;
the implementation ticket must choose one spelling shared by all harnesses.

### Hook lifecycle

| Event | Action | Guard/failure behavior |
|---|---|---|
| `UserPromptSubmit` | Mark the session active; replace any older watcher with exactly one bounded `asyncRewake` watcher for non-`async` mode. The watcher observes pending state without claiming it and may exit 2 only after the session is idle. | Exit 0 on timeout or cancellation. Report watcher state; never promise an indefinite listener. The content-free two-step path is a production requirement that still needs an installed-version proof. |
| `PostToolUse` | In `steer`, invoke the synchronous one-shot drain and return framed `additionalContext`. | Empty drain returns no output. Transport failure is diagnostic context, never fabricated chat content. |
| `Stop` | For `steer` or `sync`, make one drain attempt before marking the session idle and return `additionalContext` if non-empty. Once idle, a watcher that observes a later release exits 2 with a fixed marker; the following `Stop` drains it. | If `stop_hook_active=true`, return empty. This prevents a self-sustaining stop loop. |
| `SessionEnd` | Remove ephemeral watcher/session state; durable inbox state remains. | Cleanup must not acknowledge unread releases. |

Room text is untrusted data. The hook must JSON-encode and visibly delimit it as
Khala content; it must never interpolate it into shell source, argv, environment
variables, errors, status, or logs. Automatic `steer` and `sync` delivery must be
enabled only under a verified restricted Claude profile: writes confined to the
approved worktree/scratch area, with approval retained for shell and network
actions. If that profile cannot be verified, advertise only `async`.

### Slash dispatcher

Use one `/khala` skill and dispatch on the first argument:

| Command | Primitive | Boundary |
|---|---|---|
| `/khala join <room-or-code>` | `khala connect`/discovery request with the current session claim | May request access and report “awaiting human approval”; D11 forbids self-admission. |
| `/khala send [binding]` | Existing structured `khala_send` MCP tool | Never interpolate message text or `$ARGUMENTS` into a shell command. Keep `khala send` stdin as the manual shell primitive. |
| `/khala read` | New one-shot drain for `CLAUDE_CODE_SESSION_ID` | Honors binding generation and the per-session mode. |
| `/khala who` | New room/agent listing API plus current session/mode | Blocked by E09 #144; must not infer membership from timeline authors. |

Keep deterministic transport and authorization in CLI/MCP services. The skill
owns only argument interpretation, user-facing summaries, and safe
orchestration. E09 #143 owns installing/removing the plugin and user-scoped
skill together, including the `khala_send` MCP configuration.

## Trade-offs

| Choice | Benefit | Cost |
|---|---|---|
| Reuse the durable inbox and lock | Preserves cursor, generation, and payload-isolation invariants. | Requires a new one-shot primitive and live CLI composition before hook packaging. |
| Acknowledge after stdout write | Avoids silent message loss on hook failure. | A crash window can redeliver; exactly-once model consumption is impossible to prove. |
| User-scoped `/khala` skill plus plugin hooks | Stable literal command and reuse of `agent-skill`; plugin stays deterministic. | Setup installs two coordinated assets rather than one plugin-only artifact. |
| Next-boundary `steer` | Matches observed Claude behavior and requires no hard abort. | It is not immediate during a long-running tool. UI capability text must say so. |
| Bounded `asyncRewake` watcher | Uses a documented Claude lifecycle and wakes an interactive idle session. | A watcher timeout creates a wake gap until rearmed; indefinite listening remains unproven. |

## Risks and open assumptions

| Risk/assumption | Treatment |
|---|---|
| The source requirements retain the pre-rename mode label. | The CODEOWNER/operator rename to `steer` is authoritative for this design and every contract below. |
| Plugin command aliasing can collide. | Treat the observed literal invocation as a no-collision proof only; exact `/khala` comes from the user-scoped skill. |
| Hook stdout success is not a Claude consumption receipt. | Preserve release IDs and prefer at-least-once redelivery over pre-output acknowledgement. |
| `asyncRewake` was proven only inside a 90-second window. | Surface watcher health/timeout and mark indefinite idle wake unproven until a longer installed-version test exists. |
| The probe used its test marker as `asyncRewake` stderr. | Production stderr is a fixed content-free wake marker; the release is delivered by the subsequent structured drain. That two-step behavior is unproven locally. |
| No installed-version signal was proven for the full restricted Claude profile. | E09 #143 must define and prove the attestation during setup. Until then, the plugin truthfully exposes `async` only. |
| CLI main is fail-closed today. | Block production hooks on the local runtime composition; do not add a plugin-private transport. |
| Two sessions may share cwd and room. | Key every operation and mode change by Claude session ID; add same-cwd negative tests. |
| Automatically injected peer text can instruct a tool-capable Claude session. | Gate automatic modes on a verified restricted profile; otherwise expose only explicit `async` reads. |

## Non-goals

- A hard mid-tool abort or experimental Claude channel push.
- A second inbox, room roster, admission flow, or transport inside the plugin.
- Capturing transcripts or automatically posting Claude's final answer.
- Self-admission to a room; approval remains human-only.
- Claiming support for Claude versions other than the tested 2.1.282.
- One-command install/remove behavior, owned by E09 #143.

## Ticket contracts

### Contract 1 — Session-aware one-shot CLI delivery

| Field | Contract |
|---|---|
| **complexity** | **4** |
| **scope** | Compose a live session-aware `AgentClientPort`; resolve `(harness, sessionId)` to the verified binding/generation; add a bounded lock-protected batch drain with a transactional writer callback used by CLI and hook framing; consume #139's listening-mode type and persistence API and expose the effective mode for the Claude session. |
| **out of scope** | Claude hook files, skill prose, room roster implementation, setup/install, or a second transport. |
| **files/packages touched** | `packages/contracts/src/delivery/binding.ts` only if the existing claim is insufficient; `packages/connector/src/bootstrap/ports.ts`; `packages/agent-cli/src/composition/bootstrap.ts`; `packages/agent-cli/src/cli/{types,app,inbox,main}.ts`; adjacent tests; `packages/agent-cli/README.md`. |
| **blocked-by** | E09 #138 (local server/substrate composition) and E09 #139 (shared listening-mode semantics). |
| **conflict risk** | High with #138 in CLI composition and #139 in mode naming/storage; coordinate types before either implementation edits shared files. Low with #141/#142 because they should consume the same primitive rather than fork it. |

Acceptance criteria:

- A caller supplies the Claude session ID and can read only the active generation
  of its verified binding; cwd is never used as identity.
- The drain holds the same listener lock across generation revalidation, bounded
  batch read, the consumer's final output write, and acknowledge. A failed CLI
  or hook writer leaves the entire batch recoverable.
- `send` still accepts authored bytes only on stdin. A successful `read` writes
  the framed release only to stdout; argv, environment, status, errors, and logs
  do not leak message bodies.
- The effective mode comes from #139, defaults to `sync`, accepts only
  `steer|sync|async`, and is isolated between sessions; this contract does not
  create another mode store.
- The executable entry point uses the live local composition when configured
  and remains fail-closed otherwise.

Tests:

- **Wrong-implementation test:** open two inbox handles/processes for one
  binding and race one-shot reads. Exactly one returns and acknowledges the
  release; a direct unlocked `readNext` implementation must fail this test.
- Queue more than one release before a boundary; one bounded batch returns every
  item that fits, preserves order, and leaves overflow queued. An
  acknowledge-before-final-hook-write implementation must fail by recovering
  the full batch after an injected writer failure.
- Put two Claude session IDs in the same cwd with different bindings/messages;
  each reads only its own release and mode changes never cross sessions.
- Force stdout failure after read; restarting can read the same release. Force
  success; restarting does not read it again.
- Exercise stale generation, listener-busy, empty inbox, invalid mode, and
  unavailable-runtime errors without payload disclosure.
- Run the `@khala/agent-cli` package tests and the built-entrypoint test.

### Contract 2 — Claude interactive hook plugin

| Field | Contract |
|---|---|
| **complexity** | **3** |
| **scope** | Add a distributable Claude plugin manifest and hook runtime for `PostToolUse`, `Stop`, `UserPromptSubmit` + `asyncRewake`, and cleanup. Use Contract 1's transactional drain writer with the hook `session_id` so acknowledgement follows the final event-specific JSON write; implement the mode mapping and safe context framing above. |
| **out of scope** | CLI transport/inbox ownership, hard mid-tool abort, slash-command installation, participant listing, or generic harness support. |
| **files/packages touched** | New `packages/claude-plugin/` manifest, hooks, runtime, tests, and README; workspace/package metadata if required. No production import from `experiments/`. |
| **blocked-by** | Contract 1 and E09 #139. Integration testing also needs E09 #138's local runtime and #143's restricted-profile setup contract. |
| **conflict risk** | Medium with #139 on mode behavior and #143 on plugin layout/install paths; low with #142 if package names and shared primitives are agreed first. |

Acceptance criteria:

- `claude plugin validate --strict` passes on the supported installed version.
- `steer` drains after `PostToolUse`; `sync` drains at `Stop`; `async` never
  auto-drains. `Stop` is empty when `stop_hook_active=true`.
- Each boundary injects the bounded batch available at claim time, preserving
  order; overflow remains queued for the next eligible boundary.
- A queued release inside the configured watcher window wakes an idle
  interactive session through `asyncRewake`; timeout/cancellation is observable.
- Every hook uses its input `session_id`, frames room text as untrusted Khala
  content, and keeps bodies out of argv/env/logs/errors.
- Capability/status says “next tool boundary” for `steer` and does not claim a
  hard interrupt or indefinite idle wake.
- Automatic `steer`/`sync` is available only when the runtime verifies the
  restricted filesystem/tool profile; an unrestricted session exposes only
  `async`.
- Supported setup from #143 provisions and validates that profile, and a newly
  configured session starts in effective `sync` without manual permission
  reconfiguration.

Tests:

- **Wrong-implementation test:** launch two interactive/fake-hook sessions in
  one cwd with distinct session IDs, race drains, and assert zero cross-session
  delivery. A cwd-keyed implementation must fail.
- Race two matching hooks for one session; only one injects the release.
- Cover empty drain, runtime unavailable, malformed release, `stop_hook_active`, and
  payloads containing shell syntax, JSON delimiters, and prompt-injection text.
- Installed-version TTY test: observe `PostToolUse` delivery, one `Stop`
  continuation without a loop, a content-free bounded idle wake followed by a
  structured drain, and session-ID continuity. Captured stderr contains no
  release bytes.
- Let the watcher time out, verify no false support claim, then rearm with a new
  prompt and prove a subsequent wake.
- Inject hostile peer text under automatic delivery and prove it cannot write
  outside the allowed worktree/scratch area, make a network request, or mutate
  Khala policy without approval. The same profile absent must force `async`.

### Contract 3 — Bound-session `/khala send` and `/khala read`

| Field | Contract |
|---|---|
| **complexity** | **3** |
| **scope** | Extend the existing user-scoped `khala` skill with a dispatcher for `send` and `read`; pass `CLAUDE_CODE_SESSION_ID` to CLI primitives; route authored bodies through the structured `khala_send` MCP tool; expose the effective mode and the shared CLI mode-change primitive from #139. |
| **out of scope** | Room discovery, roster, `join`, `who`, setup/remove automation, or moving authorization into prompt instructions. |
| **files/packages touched** | `packages/agent-skill/SKILL.md`; `packages/agent-skill/src/skill-docs.test.ts`; dispatcher helpers/tests if needed; `packages/agent-skill/README.md`; existing `packages/agent-cli/src/mcp/` tests if the tool contract needs coverage. Coordinate install and MCP configuration with #143. |
| **blocked-by** | Contract 1, E09 #139 (shared mode API), and E09 #143 (Claude MCP/setup configuration). |
| **conflict risk** | High with #143 on installed assets and MCP configuration; medium with #139 on the shared mode command. No #144 file conflict. |

Acceptance criteria:

- Interactive Claude Code accepts the exact forms `/khala send` and
  `/khala read` after supported setup.
- The dispatcher rejects missing/unknown verbs with concise help and delegates
  deterministic behavior to CLI services.
- `send` passes the body as structured `khala_send` MCP input; arguments,
  status, errors, and logs never contain or echo the message body. The manual
  `khala send` command remains stdin-only.
- All operations bind to `CLAUDE_CODE_SESSION_ID`; there is no cwd-global
  current session.
- The dispatcher can read and change the effective mode through #139's common
  primitive without creating another mode store.

Tests:

- **Wrong-implementation test:** send content containing spaces, quotes,
  command substitution, newlines, and JSON delimiters; the exact bytes reach
  structured MCP input and nothing executes or appears in argv/env/logs/tool
  results.
- Invoke both literal forms in an interactive installed-version test and assert
  room state/output, not only skill discovery.
- Run two same-cwd Claude sessions and prove `read`, `send`, and mode changes
  target the correct session.
- Keep `SKILL.md`, README examples, and the existing skill-doc contract test in
  sync.

### Contract 4 — `/khala join` and `/khala who`

| Field | Contract |
|---|---|
| **complexity** | **2** |
| **scope** | Add `join` and `who` to the user-scoped dispatcher after #144 provides discovery and roster APIs. `join` may request access and report approval state; `who` renders the authoritative roster plus the current session and effective mode. |
| **out of scope** | Granting admission, implementing discovery/roster storage, changing `send`/`read`, or setup/remove automation. |
| **files/packages touched** | `packages/agent-skill/SKILL.md`; `packages/agent-skill/src/skill-docs.test.ts`; dispatcher helpers/tests; `packages/agent-skill/README.md`; #144's public client types only if integration reveals a documented gap. |
| **blocked-by** | Contract 3 and E09 #144 (truthful room/agent listing and human-gated join discovery). |
| **conflict risk** | High with #144 on result schemas and human-approval states; low with #143 if install paths from Contract 3 remain unchanged. |

Acceptance criteria:

- Interactive Claude Code accepts exact `/khala join` and `/khala who` forms.
- `join` can discover/request access but never admits the agent; without human
  approval it reports a pending decision and creates no admitted binding.
- `who` uses the authoritative roster API, includes current session/effective
  mode, and never infers membership from timeline authors.
- Both commands bind to `CLAUDE_CODE_SESSION_ID` and preserve the error/body
  disclosure rules from Contract 3.

Tests:

- **Wrong-implementation test:** attempt `join` without human approval and
  assert no admitted binding exists; a direct self-admission path must fail.
- Invoke both literal forms in an interactive installed-version test and assert
  authoritative room state/output, not only skill discovery.
- Run two same-cwd sessions and prove `join`/`who` resolve the correct binding
  and roster.
- Keep `SKILL.md`, README examples, and the skill-doc contract test in sync.
