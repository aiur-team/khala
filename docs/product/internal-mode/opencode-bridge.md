# OpenCode bridge and DeepSeek acceptance

Research for I3 and the OpenCode harness inputs to Acceptance 2. Evidence was
gathered on 2026-09-24 against the locally installed OpenCode `1.17.10`,
`@opencode-ai/plugin`/`@opencode-ai/sdk` `1.17.10`, Node `22.23.2`, and the
configured DeepSeek provider. This is a design, not a compatibility claim for
other versions.

## Summary

`setup-cli-opencode` installs a user-scope OpenCode plugin through
`npx @aiur/khala setup`. The plugin ships inside the `@aiur/khala` package, not
as a separate `@khala/*` workspace package. It runs inside the person's
already-started interactive OpenCode TUI and binds one human-admitted Khala
channel to that exact session. Khala never starts or hosts OpenCode. Every
route consumes the one bounded Khala inbox batch. Khala acknowledges through
the batch token, so OpenCode never adds a second lease, cursor, acknowledgement,
or deduplication scheme.

The interactive proof for #166 (PR #180) replaces this document's earlier
provisional routes. It shows `sync` is feasible on `1.17.10`, and that busy
`promptAsync` is **not** a `steer` route.

| Mode | OpenCode route (in-process plugin, same session) | Evidence status |
|---|---|---|
| `sync` (default) | Queue while busy. The idle watcher rechecks the bound session's status and calls session-addressed `promptAsync` once after it becomes idle. | Observed in a default-settings TUI by #180. Stays `unproven` in `HarnessCapabilities` until retained interactive evidence merges and matches the exact evidence key. |
| `async` | No automatic call. The plugin's `khala_read` tool delegates to the shared `listening-mode-pull` operation. | Observed in a default-settings interactive TUI by #180; same admission rule. |
| `steer` | On the bound session's `tool.execute.after`, take the pending batch; add its envelope at that session's next `experimental.chat.messages.transform`. Never abort. | Observed in a default-settings interactive TUI by #180. Stays `unproven` until the retained proof merges and matches the exact evidence key (see `opencode-delivery-contract`). |

This area owns `opencode-interactive-cli-proof`, `opencode-server-auth-proof`,
and the OpenCode routes. It consumes `listening-mode-contract`,
`listening-mode-pull`, `mcp-inbox-batch`, and `mcp-result-piggyback`.
`acceptance` owns both acceptance runs.

## Findings and evidence

### Interactive proof (#166, PR #180)

Source: `docs/product/internal-mode/interactive-opencode.md` and
`experiments/interactive-cli/opencode/evidence/` on PR #180. OpenCode `1.17.10`,
`deepseek/deepseek-flash`, interactive TUI launched by the proof agent with
default trust settings, no port, and no bypass flags. A pass required DeepSeek
to call `khala_send` with a nonce derived from the batch. API acceptance alone
did not count.

| Capability | Observation | Result |
|---|---|---|
| `steer` | During built-in `bash sleep 20`, the transform applied after the first tool; `STEER-ACK-318` was sent before the next `bash` began; no abort. Tail placement was consumed, and durable re-apply preserved `PERSIST-318` on a later model call. | Proven by native hooks with the required built-in-tool and persistence checks. |
| Busy `promptAsync` (negative control) | Accepted mid-turn, but tool 2 ran before the batch was consumed. | Not a `steer` route. |
| `sync` | Both tools completed with no channel action. The idle watcher called `promptAsync` 13 ms after `session.idle`, and `SYNC-ACK-195` followed. | Proven by the idle watcher plus session-addressed `promptAsync`. |
| `async` | The fresh batch survived a dwell and an unrelated turn; only an explicit `khala_read` returned it (`ASYNC-ACK-406`). | Proven by an explicit tool. |
| Restart before acknowledgement | After a logged reset and fresh `batch-restart-006`, the TUI restarted on the same session; the next `khala_read` acknowledged the retained token and returned no messages. | No host dedupe needed. |
| Embedded server auth | Headless `opencode serve` rejects missing or wrong Basic auth (`401`). With auth enabled, an interactive TUI exits on its own unauthenticated `/config/providers` call. | External control of the TUI server is **blocked** on `1.17.10`; #180 used no port and kept delivery in-process. |

### Earlier local proofs (secondary)

The throwaway plugin is retained at
`experiments/internal-mode/opencode-bridge/.opencode/plugins/khala-proof.js`.
Sanitized raw output, the host, and the versioned executable path are retained
in [`evidence.md`](../../../experiments/internal-mode/opencode-bridge/evidence.md).
The session-addressed probes below did not retain evidence tying them to a
person-started TUI, so they cannot populate `HarnessCapabilities`.

| Capability | Method and observation | Result |
|---|---|---|
| Exact installation | `opencode --version`; installed package metadata and SDK types. | OpenCode, plugin, and SDK `1.17.10`. |
| DeepSeek catalog | `opencode models deepseek`, then `/provider`. | The proof used `deepseek/deepseek-flash`. |
| Reproduction drift | Fresh-data catalog check during review. | Listed `deepseek/deepseek-v4-flash`, `-v4-flash-vision-exp`, and `-v4-pro`, not `deepseek/deepseek-flash`. Replay must fail closed, not substitute. |
| Configuration drift | Configured `deepseek/deepseek-v4-flash` returned `ProviderModelNotFoundError`. | Preflight must record the resolved provider/model and fail on stale configuration. |
| Session API, idle | Server-created session; DeepSeek replied `SYNC-DEEPSEEK-OK`. | Secondary. |
| Session API, busy | Second `promptAsync` during an 8-second tool; reply `BUSY-SECOND-OK.` | Secondary, and superseded: #180 shows the route misses the next-tool boundary in the TUI. |
| TUI append + submit | `/tui/append-prompt` + `/tui/submit-prompt`; reply `TUI-PUSH-DEEPSEEK-OK`. | Directory-scoped; can hit the wrong session or submit a draft. Not a product route. |
| Real plugin push | Plugin in a person-started TUI appended and submitted on `session.idle`; `PLUGIN-PUSH-DEEPSEEK-OK`. | Plugin loading in the TUI is feasible; route superseded by #180. |
| Hard abort | `/session/{id}/abort` during a tool; follow-up `AFTER-ABORT-DEEPSEEK-OK`. | Server abort works; not rollback. Separate `hard-cancel` only. |

### Repository evidence

| Existing seam | Consequence |
|---|---|
| `packages/agent-cli/src/cli/inbox.ts` stores per-binding/generation JSONL. | Consume the single bounded peek and batch token from `mcp-inbox-batch`; Khala acknowledges on the agent's next Khala call. |
| `packages/contracts/src/delivery/harness.ts` describes observed harness `busy`, and connector dispatch refuses steering routes. | Derive `steer | sync | async` support from `HarnessCapabilities` in `listening-mode-contract`; do not overload `busy`. |
| `packages/harnesses/src/codex/` is port-first, exact-version/evidence-scoped, and fail-closed. | Mirror that shape: inject an OpenCode client port, isolate SDK calls in composition, derive support from evidence. |
| Route names, fixtures, CLI decoding, connector admission, and presence labels are closed projections. | Add an evidence-scoped `opencode_plugin` route in one contract ticket before the plugin advertises delivery. |
| Workspace packages are named `@khala/*`. | The OpenCode plugin is not one of them. It ships in `@aiur/khala`. |

## Design

### Boundary and state

One human-admitted binding generation maps to exactly one `{sessionID,
directory, opencodeVersion, providerID, modelID}` tuple, supplied by the plugin
running in the user-started TUI. All calls use the in-process plugin API and
its session-addressed client. The bridge never uses the TUI's embedded server
from outside the process. A deleted session, version/model drift, or stale
generation degrades the binding. The bridge never starts an agent, selects
another session, or creates a replacement silently.

The plugin consumes only canonical released Khala messages. It does not capture
assistant output, tool output, history, or the user's TUI draft. Replies remain
deliberate `khala_send`/`khala send` operations (D3).

| Persisted per binding | Why |
|---|---|
| binding generation and exact session tuple | Continue only the admitted session after restart. |
| in-flight OpenCode request identity and outcome | Reconcile API uncertainty without inventing an inbox acknowledgement. |
| exact OpenCode/provider/model evidence key | Prevent stale support claims. |

The person starts OpenCode, then asks it to open a channel URL or create a
channel. Joining consumes `channel-access-cli-mcp`, `channel-access-journal`,
and `channel-access-inbox`; listing consumes `channel-agent-listing`. Channel
creation is a human-confirmed shared CLI/MCP operation.

Human `stop` outranks `pause`, and both outrank the agent-selected mode. Pause
retains backlog. Stop invokes `stop-control` to end the bound OpenCode agent
session. The local server and channel stay available for resume. Neither
control claims to roll back a prompt OpenCode already accepted.

A connector-side harness may send a content-free hint over the encapsulated
inbox notifier. The plugin always re-reads through `mcp-inbox-batch`, and the
hint carries no message. There is no OpenCode cursor, lease, acknowledgement,
dedupe table, second pull operation, or parser of `khala listen` stdout.

### Delivery state machine

1. Peek one bounded ordered batch and its stable token without acknowledging it;
   reject a stale generation. With nothing pending, submit nothing.
2. Recheck human controls, the exact bound session, model/version evidence, and
   session status immediately before acting.
3. Apply the mode:
   - `async`: retain the batch. On `khala_read`, delegate to the shared pull
     operation and return its batch/token shape.
   - `sync`: while busy, keep the batch pending. When the idle watcher observes
     the bound session as idle, persist `submitting` and call session-addressed
     `promptAsync` once. Status or idle events for another session change
     nothing.
   - `steer`: on `tool.execute.after` for the bound session, mark the batch
     in flight. At the next `experimental.chat.messages.transform` whose last
     user message carries the bound `sessionID`, append the envelope. Skip a
     mismatch without dropping the batch. Never abort; never use busy
     `promptAsync`.
4. Treat API acceptance as queued, not consumed. A duplicate, catch-up, or
   restart hint for a token that is already submitting, stored, or
   `outcome_unknown` reconciles that request and never resubmits it. The
   agent's next Khala call returns the token and Khala atomically acknowledges
   the batch; any following batch arrives through `mcp-result-piggyback`. If
   reconciliation cannot decide whether a prompt was stored, report
   `outcome_unknown`, leave the token unchanged, and block the binding until a
   human confirms or authorizes replay. Never replay automatically.

The prompt is one canonical, length-delimited JSON envelope with the batch
token, release IDs/digests, channel/sender metadata, and message bodies.
Reconciliation parses only that outer structure, bound to the expected session
and OpenCode message/part identity; marker-like text in a peer body has no
control meaning. The envelope frames peer content as untrusted data and says
replies require explicit `khala_send`. Peer text is never interpolated into
system instructions.

`khala_send` follows OpenCode's normal permission policy. The bridge never
elevates permissions, auto-approves a tool, or weakens a human gate.

### Route choices

| Choice | Decision |
|---|---|
| `tool.execute.after` + next message transform | `steer` route. The transform hook is experimental and has no session argument, so correlate through `messages[*].info.sessionID` and gate it by version. |
| Idle watcher + session-addressed `promptAsync` | `sync` route. Status observation and submit are not atomic, so serialize per binding and re-read state immediately before submitting. |
| Busy `promptAsync` | Rejected for `steer`. It is accepted but misses the next-tool boundary. |
| TUI append + submit | Rejected. It is directory-scoped and can hit another session or submit a draft. |
| Abort then submit | Separate opt-in `hard-cancel` only. Tool side effects are not rolled back. |
| External client of the embedded TUI server | Blocked on `1.17.10`: the TUI exits when auth is enabled, and an unauthenticated server is not acceptable. |
| Khala-started server or SDK session | Secondary research only; it is another agent process. |
| `khala run <cli>` PTY wrapper | Not needed: #180 found native routes for all three modes. |

`opencode-server-auth-proof` retains the negative embedded-server evidence and
makes the in-process-only rule verifiable. The descriptor carries only data that
`authenticated-loopback-server` approves. It never contains a message body or a
provider credential.

## Acceptance 2 harness inputs

`acceptance` owns the test script, the run (`opencode-deepseek-claude-live-acceptance`),
log verification, and cleanup. This area supplies:

| Input | Supplied by |
|---|---|
| Preflight record: OpenCode/plugin/SDK/Node versions, resolved DeepSeek provider/model, capability record, existing TUI session ID; fail on model drift. | `opencode-session-bridge` (`status` output via `setup-cli-opencode`) |
| Binding evidence: one generation mapped to the user-started session ID, with release/event IDs and no message content. | `opencode-session-bridge` |
| Per-mode timing oracles: `steer` consumed before the next tool, `sync` only after idle, `async` only on `khala_read`. | `opencode-session-bridge` |
| Restart and stop hooks: stable token across restart, no delivery after Stop. | `opencode-session-bridge` |

`hard-cancel` may be reported unsupported without changing the non-abort `steer`
result. Support is never claimed from an HTTP `200`, an abort boolean, or
endpoint discovery alone.

## Risks and open assumptions

| Risk / assumption | Treatment |
|---|---|
| OpenCode message storage does not prove model consumption. | A stored user message permits only a queued claim. OpenCode read receipts belong to `opencode-read-receipts`. |
| `experimental.chat.messages.transform` may change or disappear. | Gate `steer` to the retained version evidence; re-run the two-boundary oracle before adding a version. |
| Idle and submit are not atomic, and events race pause, restart, and new work. | Serialize per binding; treat events as hints and re-read state at submission. |
| Hard abort can leave external tool side effects. | Never describe abort as rollback; keep it off by default. |
| The configured DeepSeek model name can be stale. | Preflight compares configuration with the live catalog and records the resolved identity. |
| Assumption: `local-sqlite-channel-store` supplies durable channel/binding state and `listening-mode-pull` supplies explicit reads. | The plugin does not recreate either. |

## Non-goals

- Implementing product code in this research ticket.
- Defining shared `steer | sync | async` semantics or UI controls.
- Building the local server, admission, or durable channel substrate.
- Implementing `@aiur/khala` setup/remove/status or publishing packages.
- Launching or hosting OpenCode, or designing a PTY wrapper.
- Owning the acceptance script, Aiur test tickets, log verdicts, or cleanup.
- Capturing model output as channel messages or admitting an agent without a human.
- Compatibility claims beyond the recorded exact-version evidence.

## Ticket contracts

### 1. `opencode-delivery-contract`

| Field | Contract |
|---|---|
| Title | Add the evidence-scoped OpenCode delivery route |
| Complexity | `complexity:3` |
| Scope | Add evidence-scoped `opencode_plugin` route/capability vocabulary and project it through delivery fixtures, agent CLI decoding, connector admission, and presence label `OpenCode plugin`. Keep listening mode separate from harness `busy`; consume `acknowledgement: unknown | unsupported | batch_token_next_call` from `HarnessCapabilities`. |
| Out of scope | Plugin implementation, OpenCode setup, shared mode semantics, acceptance orchestration. |
| Files/packages | `packages/contracts/src/delivery/`; `packages/contracts/fixtures/delivery/`; `packages/agent-cli/src/cli/types.ts`; `packages/connector/src/route-admission.ts`; `apps/connector/src/composition/agent/{harnesses,presence}.ts` and adjacent tests. |
| Acceptance criteria | `HarnessCapabilities` is the only support source; a route is selectable only for its exact evidence key; stale/unknown versions fail closed; automation is refused unless `acknowledgement` is `batch_token_next_call`; presence displays `OpenCode plugin`. **OpenCode `steer` stays `unproven` in `HarnessCapabilities` until the accepted agent-launched, default-settings TUI proof with retained commands merges**; the server-session busy `promptAsync` observation never populates it. The same rule applies to `sync` and `async`. |
| Tests | Contract fixtures and connector projection tests. **Wrong implementation test:** an `opencode_plugin` fixture that claims `steer` with only server-session evidence, or with no retained interactive commands, must resolve to `unproven` and be refused. The same holds for acknowledgement other than `batch_token_next_call`. |
| Blocked by | `opencode-interactive-cli-proof`, `listening-mode-contract`, `setup-cli-plan`. |
| Conflict risk | **High:** connector contract unions and fixtures are single-writer surfaces. Keep edits minimal and land after `listening-mode-contract`. |

### 2. `opencode-inbox-notifier`

| Field | Contract |
|---|---|
| Title | Wake the OpenCode plugin after durable inbox release |
| Complexity | `complexity:3` |
| Scope | Add a connector-side OpenCode `HarnessPort` whose `submit` verifies the matching batch is durable and ignores the supplied payload for transport. Extend the post-`mcp-inbox-batch` `Inbox` port with a content-free `notifyListener` operation that encapsulates the per-binding/generation Unix-socket path. Define the hint contract consumed by `opencode-session-bridge`. Duplicate and catch-up hints are harmless. |
| Out of scope | Exposing a socket path; another inbox or batch API; payloads in argv/environment/hints/logs; prompt injection; mode scheduling; setup; direct OpenCode API calls. |
| Files/packages | New `packages/harnesses/src/opencode/` adapter and tests; `packages/agent-cli/src/cli/inbox.ts` and its test for the notifier port; minimal registration in `apps/connector/src/composition/agent/harnesses.ts`. |
| Acceptance criteria | The release is durable before notification; only the notifier port addresses the matching listener; a dead or mismatched listener fails closed and the batch stays recoverable; startup or reconnect emits one coalesced catch-up hint; hints contain no message or token; repeated hints never create another prompt, inbox record, or acknowledgement. |
| Tests | Fake batch/notifier component tests plus connector composition coverage. **Wrong implementation test:** crash after durable release but before the hint, restart, and require one catch-up wake that exposes the same batch/token without a second append. After submission but before acknowledgement, the same catch-up must not cause a second OpenCode prompt. |
| Blocked by | `opencode-delivery-contract`, `mcp-inbox-batch`, `listening-mode-dispatch`, `local-sqlite-channel-store`, `setup-cli-plan`. |
| Conflict risk | **High:** connector composition and `inbox.ts` are shared. Land after `mcp-inbox-batch`, add only the notifier method, and edit route registration minimally. |

### 3. `opencode-server-auth-proof`

| Field | Contract |
|---|---|
| Title | Retain OpenCode server-auth evidence and enforce in-process delivery |
| Complexity | `complexity:2` |
| Scope | Promote #180's headless Basic-auth and embedded-TUI results into retained evidence with exact redacted commands, host, and version path. Add a verifier that rejects any OpenCode evidence or route record relying on an external client of the TUI's embedded server. |
| Out of scope | Product plugin code, generic Khala loopback auth, setup changes, provider credentials, other OpenCode versions. |
| Files/packages | `experiments/internal-mode/opencode-bridge/auth/`; `docs/evidence/opencode-server-auth.md`; no product packages. |
| Acceptance criteria | Evidence shows missing/wrong credentials rejected by headless `opencode serve`, and the authenticated user-started TUI blocked on `1.17.10`. Credentials appear in neither argv nor logs. The verifier admits only in-process plugin routes. Khala never launches a server to make a proof pass. |
| Tests | Verifier fixtures for an in-process route, an authenticated external route, and an unauthenticated external route. **Wrong implementation test:** a record whose session calls went through an unauthenticated embedded server must be rejected even though every call returned `200`. |
| Blocked by | None. |
| Conflict risk | Low: isolated evidence. Must match the descriptor rules of `authenticated-loopback-server`. |

### 4. `opencode-interactive-cli-proof`

| Field | Contract |
|---|---|
| Title | Prove all OpenCode modes in the user's TUI |
| Complexity | `complexity:3` |
| Scope | From an interactive TUI under default trust settings, prove per-mode delivery into the event-correlated session with retained commands and events. #166 (PR #180) covers this scope with an honestly recorded agent-launched TUI; product acceptance still starts from the person's admitted session. If #180 merges with retained `steer`, `sync`, and `async` evidence meeting these criteria, it satisfies this contract and the Executor does not promote it. Otherwise, this ticket completes the missing modes. |
| Out of scope | Product bridge code, Khala-launched OpenCode, hosted sessions as evidence, a wrapper without approval, Claude/Codex proofs. |
| Files/packages | `experiments/internal-mode/opencode-bridge/interactive/` (or #180's `experiments/interactive-cli/opencode/`); `docs/evidence/opencode-interactive-cli.md`. |
| Acceptance criteria | Evidence begins from an interactive TUI under normal trust settings and labels who launched it; it correlates plugin event, session ID, provider/model, and observed boundary. `steer` is consumed before the next tool with no abort, `sync` only after the original turn becomes idle, and `async` only on `khala_read`. Another session and an unsent draft are unchanged. Retained commands allow a replay. |
| Tests | Two-tool probe matrix for idle, long-tool, explicit read, restart, wrong session, and draft preservation. **Wrong implementation test:** busy `promptAsync` offered as `steer` must fail because tool 2 starts before consumption, and a probe that succeeds only against a separately launched server must fail admission. |
| Blocked by | `listening-mode-contract`, `listening-mode-pull`. |
| Conflict risk | Low: isolated evidence, but it gates `opencode-session-bridge`. |

### 5. `opencode-session-bridge`

| Field | Contract |
|---|---|
| Title | Bind and reconcile one user-started OpenCode session |
| Complexity | `complexity:4` |
| Scope | Add the OpenCode plugin entry to the `@aiur/khala` package (for example an `@aiur/khala/opencode` export), installed by `setup-cli-opencode`. Provide the event-correlated binding, canonical envelope, `steer` hooks and durable re-apply, idle-watcher `sync`, explicit `khala_read`/`khala_send` tools, ambiguous-outcome reconciliation, serialized pause/stop checks, and fail-closed drift handling. |
| Out of scope | A separate `@khala/*` plugin package; host-side dedupe or acknowledgement; setup/remove; hard abort; read receipts; transcript capture; other OpenCode versions. |
| Files/packages | The plugin's `modes`, `hooks`, `tools`, and composition modules inside the `@aiur/khala` package layout owned by `setup-cli-plan`, with SDK and descriptor imports confined to composition; package-local tests. |
| Acceptance criteria | Runs in-process and targets only the admitted TUI session; never launches OpenCode or touches another session or draft; `steer` is consumed before the next tool with no abort and remains in later model context through durable re-apply; `sync` submits only after the session is observed idle; an idle-arriving `steer` or `sync` batch wakes within one notifier hint; `async` submits nothing automatically; the canonical envelope stays within the shared batch ceiling; acknowledgement occurs only through the next Khala call; `outcome_unknown` blocks for human resolution; stale generations, oversized envelopes, denied permissions, and version/model drift fail closed; human controls win. |
| Tests | Fake OpenCode/batch ports: two-tool mode matrix, already-idle wake, explicit pull, wrong session/draft, hostile marker bodies, oversized envelopes, denied tools, pause/stop races, stored/not-stored/ambiguous outcomes, restart with a stable token and durable re-apply, capability drift, stale generations, piggyback drain, no-abort, and no-host-dedupe assertions. **Wrong implementation test:** fail if busy `promptAsync` is used as `steer`, tool 2 starts before steer consumption, sync submits while busy, an idle batch waits for a user turn, re-apply exists only in memory, or session B changes while the binding names A. |
| Blocked by | `opencode-delivery-contract`, `opencode-inbox-notifier`, `opencode-server-auth-proof`, `opencode-interactive-cli-proof`, `mcp-inbox-batch`, `mcp-result-piggyback`, `mcp-piggyback-evidence`, `listening-mode-pull`, `listening-mode-contract`, `listening-mode-dispatch`, `authenticated-loopback-server`, `stop-control`, `setup-cli-plan`, `channel-access-cli-mcp`, `channel-access-journal`, `channel-access-inbox`. |
| Conflict risk | **Medium/high:** the package layout belongs to `setup-cli-plan`; add only the OpenCode module. Read receipts stay in `opencode-read-receipts`. |

Recommended order: `opencode-server-auth-proof` runs independently. Accept #180
as `opencode-interactive-cli-proof` or run the remainder after
`listening-mode-contract` and `listening-mode-pull`. After the shared merge chain
through `setup-cli-plan`, run `opencode-delivery-contract` →
`opencode-inbox-notifier` → `opencode-session-bridge`. `acceptance` then runs
`opencode-deepseek-claude-live-acceptance`.
