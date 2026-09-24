# OpenCode bridge and DeepSeek acceptance

Research for I3 and the OpenCode half of Acceptance 2. Evidence was gathered on
2026-09-24 against the locally installed OpenCode `1.17.10`,
`@opencode-ai/plugin`/`@opencode-ai/sdk` `1.17.10`, Node `22.23.2`, and the
configured DeepSeek provider. This is a design, not a compatibility claim for
other versions.

## Summary

Install a user-scope OpenCode plugin through `npx @aiur/khala setup`. The plugin
runs inside the person's already-started interactive OpenCode TUI and binds one
human-admitted Khala channel to that exact session. Khala never starts or hosts
OpenCode. The production route must consume the one bounded Khala inbox-batch
operation; Khala owns acknowledgement through the batch token, so OpenCode
never adds a second lease, cursor, acknowledgement, or deduplication scheme.

| Mode | OpenCode delivery | Support decision |
|---|---|---|
| `sync` (default) | No proved route into the user-started TUI session. | Blocking/unproven for product acceptance. During proof work the binding reports unsupported, defaults to `async`, and explains why; that fallback does not satisfy final three-mode acceptance. |
| `async` | Never inject automatically. Expose the shared `khala_read` operation owned by `listening-mode-pull` inside the same TUI session. | Design supported by the durable inbox batch; delivery into the interactive session remains unproven. |
| `steer` | From the plugin, submit once to the event-correlated TUI session with `session.promptAsync`; never abort by default. | A server-side busy-session observation exists, but equivalence to the person's interactive TUI is unproven and must not populate capabilities yet. |

The OpenCode bridge owns its interactive-session proof, OpenCode routes, and
server-auth proof. It consumes
`listening-mode-contract`, `listening-mode-pull`, `mcp-inbox-batch`, and
`mcp-result-piggyback`; `acceptance` owns both acceptance runs.

## Findings and evidence

### Local proofs

The throwaway plugin is retained at
`experiments/internal-mode/opencode-bridge/.opencode/plugins/khala-proof.js`.
Secrets were read only by the launched process; no token, full transcript, or
message body beyond fixed proof markers is retained here. Sanitized raw command
output, the host, and the versioned executable path are retained in
[`evidence.md`](../../../experiments/internal-mode/opencode-bridge/evidence.md).

| Capability | Method and observation | Result |
|---|---|---|
| Exact installation | `opencode --version`; inspected the locally installed package metadata and SDK types. | OpenCode, plugin, and SDK `1.17.10`; proven locally. The retained proof itself imports no packages and pins the OpenCode binary version. |
| DeepSeek catalog | `opencode models deepseek`, then `/provider`. | `deepseek/deepseek-flash` and `deepseek/deepseek-v4-pro` were available; the active proof model was `deepseek/deepseek-flash` (displayed as “DeepSeek V4.1 Flash”). |
| Reproduction drift | Repeated the catalog check from a fresh OpenCode data directory during final review. | The fresh catalog listed `deepseek/deepseek-v4-flash`, `deepseek/deepseek-v4-flash-vision-exp`, and `deepseek/deepseek-v4-pro`, but not the proved `deepseek/deepseek-flash`. An exact replay is currently unavailable and must fail closed rather than substitute. |
| Configuration drift | A request using configured `deepseek/deepseek-v4-flash` returned `ProviderModelNotFoundError` and suggested the two catalog entries above. | Acceptance must record the resolved provider/model and fail clearly on stale configuration. |
| Session API, idle | Created a session, posted a session-addressed message, and read the session messages. | DeepSeek replied exactly `SYNC-DEEPSEEK-OK`; observed on a server-created session, not proved in the person's TUI. The original command transcript was not retained, so this cannot populate `HarnessCapabilities`. |
| Session API, busy | Started an asynchronous prompt containing an 8-second tool call, observed `busy`, then posted a second asynchronous prompt. | At the tool boundary DeepSeek consumed the second prompt and replied `BUSY-SECOND-OK.` This is evidence for server-side `steer`, not proof that the route reaches the user-started interactive session. |
| TUI append + submit | Appended a fixed marker through `/tui/append-prompt`, submitted through `/tui/submit-prompt`, and read the resulting session. | DeepSeek replied exactly `TUI-PUSH-DEEPSEEK-OK`; mechanism proven, target-session safety unproven. |
| Real plugin push | The person started a TUI with the retained local plugin. On `session.idle` it appended and submitted a Khala-shaped marker. | The same session grew from two to four messages and DeepSeek replied exactly `PLUGIN-PUSH-DEEPSEEK-OK`; interactive I3 is feasible, but the directory-scoped route's target safety and all three mode boundaries remain unproven. |
| Hard abort | During a 15-second tool call, posted `/session/{id}/abort`, observed `true`, `idle`, and `MessageAbortedError`; then sent a follow-up to the same session. | The follow-up returned `AFTER-ABORT-DEEPSEEK-OK`; exact-version server abort is proven. Abort is not rollback and tool side effects remain a risk. |

The installed SDK also exposes `session.status`, `session.idle` events,
session-addressed `promptAsync`, `abort`, and message reads. The TUI append and
submit calls are directory-scoped rather than session-ID-scoped. Endpoint
presence and a Khala-started server session are both insufficient: capability
evidence must show delivery into the person's own user-started TUI session.

### Repository evidence

| Existing seam | Consequence |
|---|---|
| `packages/agent-cli/src/cli/inbox.ts` stores per-binding/generation JSONL. | Consume the single bounded peek and batch token from `mcp-inbox-batch`; Khala acknowledges the token on the agent's next Khala call. The OpenCode host does not deduplicate. |
| `packages/contracts/src/delivery/harness.ts` describes observed harness `busy` behavior, while connector dispatch policy uses `queue | wait | reject` and refuses steering routes. | Derive `steer | sync | async` support from `HarnessCapabilities` in `listening-mode-contract`; do not overload `busy`. |
| `packages/harnesses/src/codex/` is port-first, exact-version/evidence-scoped, and fail-closed. | Mirror that shape: inject an OpenCode client port, isolate SDK calls in composition, and derive advertised support from evidence. |
| Route names, fixtures, CLI decoding, connector admission, and presence labels are closed projections. | Add an evidence-scoped `opencode_plugin` route in one coordinated contract ticket before the plugin advertises tested delivery. |
| `tests/e2e/harness/{live,scenario,evidence}.ts` records source versions and rejects all-skipped live runs. | `acceptance` consumes the OpenCode harness pieces and owns the live driver, Aiur ticket creation, log verification, and cleanup. |

## Design

### Boundary and state

One human-admitted binding generation maps to exactly one `{sessionID,
directory, opencodeVersion, providerID, modelID}` tuple supplied by the plugin
running in the user-started TUI. If the interactive proof establishes a stable
TUI-owned server identity, its authenticated URL may be recorded as secondary
transport metadata. A deleted session, changed server identity, version/model
drift, or stale generation degrades the binding; the bridge never starts an
agent, selects another session, or creates a replacement silently.

The plugin consumes only canonical released Khala messages. It does not capture
assistant output, tool output, history, or the user's TUI draft. Replies remain
deliberate `khala_send`/`khala send` operations (D3).

Persist per binding:

| State | Why |
|---|---|
| binding generation and exact OpenCode session tuple | Continue only the admitted session after restart. |
| in-flight OpenCode request identity and outcome | Reconcile API uncertainty without inventing an inbox acknowledgement. |
| exact OpenCode/provider/model evidence key | Prevent stale support claims. |

The person starts OpenCode and then asks it to open a channel URL or create a
channel. Joining consumes `channel-access-cli-mcp`, `channel-access-journal`,
and `channel-access-inbox`; listing consumes `channel-agent-listing`. Channel
creation is a human-confirmed shared CLI/MCP operation, not an OpenCode-specific
agent launcher. Setup is agent-runnable but must preview its plan and relay the
person's confirmation before `@aiur/khala` writes user-scope plugin config.

Human `stop` outranks `pause`, and both outrank the agent-selected mode from the
shared listening-mode store. Pause retains backlog. Stop invokes the shared
`stop-control` contract to end the bound OpenCode agent session, then disposes
the listener while leaving the local server and channel available for resume.
Neither control may claim to roll back a prompt OpenCode already accepted.

The plugin consumes the same bounded inbox batch and token as every other agent
surface. A connector-side OpenCode harness may send a content-free hint over an
owner-only Unix socket, but the plugin always re-reads through
`mcp-inbox-batch`; the hint carries no message. In `async`, the plugin's tool
facade delegates to the one `khala_read` operation from `listening-mode-pull`.
There is no OpenCode cursor, lease, acknowledgement, dedupe table, second pull
operation, or parser of `khala listen` stdout.

### Delivery state machine

1. Peek one bounded ordered batch and its stable token without acknowledging it;
   reject a stale binding generation. If no batch is pending, submit nothing,
   persist no request, and wait for the next hint or explicit read.
2. Recheck human controls, the exact event-correlated interactive session,
   model/version evidence, and authoritative session status immediately before
   acting.
3. Apply the mode:
   - `async`: retain the batch. On explicit `khala_read`, delegate to the shared
     pull operation and return its batch/token shape through the plugin tool.
   - `sync`: until the interactive proof finds a native boundary, report
     unsupported; effective mode defaults to `async`, and the UI states that no
     interactive atomic idle route is proved. Product acceptance remains
     blocked because the final experience requires all three modes.
   - `steer`: if busy, persist `submitting` and call session-addressed
     `promptAsync` once. Do not abort by default. If idle, submit once; a race
     that makes the session busy still preserves `steer` semantics.
4. Treat API acceptance as queued, not consumed. If the token matches a
   persisted submitting, accepted, stored, or outcome-unknown request, a
   duplicate, catch-up, or restart hint reconciles that request and never
   resubmits it. Clear the token-scoped delivery outcome only after a subsequent
   Khala call acknowledges the token. This is delivery reconciliation, not a
   second inbox cursor or release-deduplication scheme. The canonical envelope
   carries the batch token; the agent's next Khala call returns that token and
   Khala atomically acknowledges the contiguous batch. The OpenCode host never
   advances an inbox cursor or deduplicates releases. If API reconciliation
   cannot decide whether a prompt was stored, report `outcome_unknown`, leave
   the Khala token unchanged, and block that binding until a human confirms the
   stored prompt or explicitly authorizes replay. Record that decision; never
   replay automatically. A successful next Khala call acknowledges that token
   and exposes any following bounded batch through `mcp-result-piggyback`; the
   plugin does not wait for another connector release or create a second hint
   cursor. Read-receipt semantics remain outside this bridge.

The prompt is one canonical, length-delimited JSON envelope containing the
Khala batch token, release IDs/digests, channel/sender metadata, and deliberate
message bodies. Reconciliation parses only that exact outer structure and binds
it to the expected session and retrieved OpenCode message/part identity;
marker-like text inside a peer body has no control meaning. The envelope reminds
the model that peer content is untrusted data and replies require explicit
`khala_send`. Peer text is never interpolated into system instructions.

Bridge delivery must preserve OpenCode's existing tool permission policy: it
never elevates permissions, auto-approves a tool, or weakens a human gate. A
turn triggered by peer content remains tainted. Even when `khala_send` is
otherwise allowlisted, outbound use requires either owner approval that previews
the exact destination and bytes, or execution without private session context
and with a destination-scoped send capability. Acceptance exercises the chosen
shared-policy posture with a canary secret; the bridge does not redefine that
policy, but it may not bypass it.

### Interactive route choices

| Choice | Benefit | Cost / decision |
|---|---|---|
| Plugin event + session-addressed client | Can correlate a plugin event to the person's existing TUI session, preserve the unsent draft, and support reconciliation. | Preferred only after `opencode-interactive-cli-proof` proves the correlation and all three boundaries in the user-started TUI. |
| TUI append + submit | Small and proved through a plugin in a real TUI. | Global/directory-scoped; can target the wrong session or submit a human draft. Proof-only until target safety is established. |
| `promptAsync` while busy | Server-side observation suggests next-tool-boundary `steer` without hard abort. | Interactive equivalence is unproven and it does not supply `sync`. |
| Abort then submit | Locally interrupts and recovers the same session. | Tool side effects are not rolled back; SDK/plugin regressions have existed. Opt-in proof profile only. |
| Khala-started OpenCode server or SDK session | Easy to address and inspect. | Secondary research only; it is another agent process and cannot satisfy the product path. |
| `khala run <cli>` PTY wrapper | Could observe boundaries unavailable to a native plugin. | Not approved. If the proof finds it is the only route, report `blocked_without_wrapper` and request an operator decision before designing it. |

`setup-cli-plan` owns `npx @aiur/khala setup|status|remove`. This area owns
`opencode-server-auth-proof`: before product bridge work, it must determine
whether the user-started OpenCode `1.17.10` TUI exposes a supported authenticated
server route, prove unauthenticated access fails closed when that route is used,
and retain negative evidence if it does not. Khala must not launch a server to
make the proof pass. Any setup-managed credential is never logged or embedded
in installed configuration. The descriptor carries only data approved by
`authenticated-loopback-server`; no message body or provider credential is
copied into it. A hosted-only success remains secondary and cannot unlock the
interactive bridge.

## Acceptance 2: OpenCode + DeepSeek run

`acceptance` owns the test script and composes this run after the required
contracts land. This document supplies OpenCode harness inputs only.

| Step | Required evidence |
|---|---|
| Preflight | The person starts OpenCode TUI with DeepSeek and a separate Claude Code CLI agent. Record OpenCode/plugin/SDK/Node versions, resolved DeepSeek provider/model, bridge capability record, and the already-existing TUI session ID. Reject configured-model drift rather than substituting silently. |
| Admission and binding | From the user-started TUI, the agent opens a channel URL or creates a channel with human confirmation; every participant follows the channel access request/grant flow. Evidence maps one binding generation to that existing session ID. A second OpenCode session is the wrong-target oracle. |
| Bidirectional channel exchange | The OpenCode + DeepSeek agent and Claude agent exchange deliberate markers through the channel. Executor logs correlate release/event IDs without full content. Neither agent is launched by Khala. |
| `sync` | Deliver at the proved interactive end-of-turn/idle boundary into the bound TUI session. Until such a boundary is proved, report unsupported and default to `async`, but mark Acceptance 2 blocked rather than treating the fallback as success. |
| `async` | Send more markers than one bounded batch. Assert no OpenCode prompt before shared `khala_read`, then the same ordered batch/token shape used by CLI and MCP. Each next Khala call acknowledges through its token and exposes the following batch through `mcp-result-piggyback`, without a new release; the OpenCode host has no dedupe state. |
| `steer` | In separate idle and long-tool cases, send one marker from the plugin to the event-correlated TUI session. On a matching evidence key, assert only the bound interactive session changes and busy delivery is consumed at the next safe boundary. If the key does not match, the UI and run must say unsupported. |
| Controls and restart | Pause before submission, resume, restart before token acknowledgement, then stop. Assert the same stable Khala batch/token is retained, the host created no dedupe state, Stop ends the bound OpenCode agent session through `stop-control`, the local server/channel remain resumable, and no delivery occurs after stop. |
| Safety oracle | The unbound session and an unsent TUI draft remain byte-for-byte unchanged; an unauthenticated server request is rejected; an injected request for a denied filesystem/network action remains denied or human-gated; with `khala_send` otherwise pre-authorized, the selected owner-approval or context-isolation posture prevents a canary secret from leaving the bound session; no transcript/tool output appears in Khala; evidence contains no credentials or full messages. |
| Cleanup | `acceptance` removes test tickets/channels/processes and records the Executor verdict. The run fails if cleanup or any required evidence is missing. |

The run may report the separate `hard-cancel` capability unsupported without
changing the non-abort `steer` result. It may not claim support from an HTTP
`200`, an abort boolean, or endpoint discovery alone.

## Risks and open assumptions

| Risk / assumption | Treatment |
|---|---|
| OpenCode message storage does not prove model consumption. | A verified stored user message permits only a queued claim. OpenCode read receipts belong to the read-receipt contract, not this bridge. |
| An idle status read and `promptAsync` submission are not atomic. | Keep `sync` unsupported until an atomic idle-queue or exclusive all-producer lease is proved; test the race explicitly. |
| Status and idle events race with pause, restart, and new work. | Serialize per binding; treat events as hints and re-read authoritative state at the submission linearization point. |
| Hard abort can leave external tool side effects. | Never describe abort as rollback; keep it off by default and evidence-gated. |
| Plugin disposal or server restart changes the URL. | Degrade and require explicit rebind; never follow a new server/session automatically. |
| The configured DeepSeek model name can be stale. | Preflight compares configuration with the live provider catalog and records the resolved identity. |
| Shared mode and receipt vocabulary may change in parallel. | `listening-mode-contract` is the capability single writer; OpenCode read receipts remain outside these contracts. |
| Assumption: `local-sqlite-channel-store` supplies durable channel/binding state and `listening-mode-pull` supplies explicit read surfaces. | The plugin does not recreate either responsibility. |
| A plugin can correlate an event/session ID with the person's active TUI and submit without touching the draft. | `opencode-interactive-cli-proof` must prove this for each mode; otherwise the bridge is blocked, not redirected to a Khala-hosted agent. |

## Non-goals

- Implementing product code in this research ticket.
- Defining shared `steer | sync | async` semantics or UI controls.
- Building the local server, admission, or durable channel substrate.
- Implementing `@aiur/khala` setup/remove/status or publishing packages.
- Launching or hosting OpenCode, or designing an unapproved PTY wrapper.
- Creating Aiur tickets, judging Executor logs, or owning global cleanup.
- Capturing model output as channel messages, dumping transcripts, or admitting an agent
  without a human.
- Compatibility claims beyond the recorded exact-version evidence.

## Ticket contracts

### 1. `opencode-delivery-contract`

| Field | Contract |
|---|---|
| Title | Add the evidence-scoped OpenCode delivery route |
| Complexity | `complexity:3` |
| Scope | Add evidence-scoped `opencode_plugin` route/capability vocabulary and project it through delivery fixtures, agent CLI decoding, connector admission, and presence label `OpenCode plugin`. Keep listening mode separate from harness `busy`; consume `acknowledgement: unknown | unsupported | batch_token_next_call` from `HarnessCapabilities`. |
| Out of scope | Plugin implementation, OpenCode setup, shared mode semantics, Aiur acceptance orchestration. |
| Files/packages | `packages/contracts/src/delivery/`; `packages/contracts/fixtures/delivery/`; `packages/agent-cli/src/cli/types.ts`; `packages/connector/src/route-admission.ts`; `apps/connector/src/composition/agent/{harnesses,presence}.ts` and adjacent tests/docs. |
| Acceptance criteria | `HarnessCapabilities` is the only support source; a route is selectable only for its exact evidence key; stale/unknown versions fail closed; automation is refused unless `acknowledgement` is `batch_token_next_call`; presence displays `OpenCode plugin`; no route stores a second copy of mode support. |
| Tests | Extend contract fixtures and connector projection tests. **Wrong implementation test:** an `opencode_plugin` claim with no matching evidence, unsupported `steer`, or acknowledgement other than `batch_token_next_call` must be refused rather than admitted as a generic listener. |
| Blocked by | `opencode-interactive-cli-proof`, `listening-mode-contract`, `setup-cli-plan`. |
| Conflict risk | **High:** connector contract unions and fixtures are single-writer surfaces. Keep shared-file edits minimal and land after `listening-mode-contract`. |

### 2. `opencode-inbox-notifier`

| Field | Contract |
|---|---|
| Title | Wake the OpenCode plugin after durable inbox release |
| Complexity | `complexity:3` |
| Scope | Add a connector-side OpenCode `HarnessPort` whose `submit` verifies the matching shared batch is durable, ignores the supplied payload for transport, then invokes the per-binding/generation notifier endpoint exported by `mcp-inbox-batch` to send a content-free hint over its owner-only Unix socket. Define the hint contract consumed by `opencode-session-bridge`; that bridge performs the plugin-side `mcp-inbox-batch` peek. The plugin owns listener registration for its generation; this adapter never derives a private socket path. `reconcile` returns no stronger evidence unless the plugin supplies correlated evidence. Duplicate and catch-up hints are harmless. |
| Out of scope | Adding or deriving an agent-CLI inbox/socket path; a second inbox append/read/lease API; payloads in argv/environment/socket hints/logs; prompt injection; mode scheduling; setup/authentication; direct OpenCode API calls. If `mcp-inbox-batch` does not export the notifier endpoint, this contract remains blocked on that owner rather than expanding into its files. |
| Files/packages | New `packages/harnesses/src/opencode/` adapter and tests; minimal registration in `apps/connector/src/composition/agent/harnesses.ts`; no agent-CLI inbox implementation changes. |
| Acceptance criteria | The release is durable before notification; the adapter consumes only the exported notifier endpoint for the matching binding/generation; a dead or mismatched listener fails closed while the shared batch remains recoverable; startup or listener reconnect emits one coalesced catch-up hint for pending work; hints contain no message or token; repeated hints reconcile an already-submitted token and never create another prompt, inbox record, or acknowledgement; receipts claim no boundary stronger than observed. |
| Tests | Fake batch/notifier component tests plus connector composition coverage. **Wrong implementation test:** crash after durable release but before the hint, restart, and require a catch-up wake that exposes the same batch/token from `mcp-inbox-batch` without a second append; after submission but before acknowledgement, the same catch-up must reconcile without a second OpenCode prompt. |
| Blocked by | `opencode-delivery-contract`, `mcp-inbox-batch`, `listening-mode-dispatch`, `local-sqlite-channel-store`, `setup-cli-plan`. |
| Conflict risk | **High:** connector composition is shared. This ticket adds its own module and makes only the minimal route registration edit after the inbox and dispatch contracts settle. |

### 3. `opencode-server-auth-proof`

| Field | Contract |
|---|---|
| Title | Prove authenticated OpenCode access and refresh delivery evidence |
| Complexity | `complexity:3` |
| Scope | On OpenCode `1.17.10`, determine whether the person's user-started TUI exposes a supported authenticated server route; prove authenticated SDK/session calls and rejection without or with the wrong setup-managed credential when applicable. Against the exact configured DeepSeek model, rerun idle and busy probes from that TUI and retain exact redacted commands, host, version path, sanitized raw output, and negative claims. Never start OpenCode on Khala's behalf or substitute a catalog model silently. |
| Out of scope | Product plugin code, generic Khala loopback auth, setup file mutation, provider credentials, other OpenCode versions. |
| Files/packages | `experiments/internal-mode/opencode-bridge/auth/`; `docs/evidence/opencode-server-auth.md`; no product packages. |
| Acceptance criteria | Evidence distinguishes the user-started TUI route from a separately hosted server; an authenticated client reaches only the TUI-owned loopback server if supported; missing/wrong credentials fail before session data; credentials appear in neither argv nor logs; the exact configured provider/model resolves; retained probes prove only the bound TUI session changed. A hosted-only route, auth absence, or drift blocks the product bridge rather than permitting fallback or a capability claim. |
| Tests | Scripted positive/negative auth, idle, and busy probes with redaction and exact-model assertions. **Wrong implementation test:** start the server without authentication and require the evidence verifier to reject the run even when the session endpoint returns success. |
| Blocked by | None. |
| Conflict risk | Low: isolated proof, but its result is a hard gate for `opencode-session-bridge` and must align with descriptor handling from `authenticated-loopback-server`. |

### 4. `opencode-interactive-cli-proof`

| Field | Contract |
|---|---|
| Title | Prove all OpenCode modes in the user's TUI |
| Complexity | `complexity:3` |
| Scope | With the person starting OpenCode TUI, prove how a user-scope plugin identifies the event-correlated session and delivers `steer`, `sync`, and `async` into that same session without touching another session or draft. Record native plugin/client hooks and explicit negative results. If any mode is possible only through `khala run <cli>`, report `blocked_without_wrapper` for an operator decision; do not implement the wrapper. |
| Out of scope | Product bridge code, Khala-launched OpenCode processes, hosted SDK sessions as acceptance evidence, choosing a wrapper without approval, Claude/Codex proofs. |
| Files/packages | `experiments/internal-mode/opencode-bridge/interactive/`; `docs/evidence/opencode-interactive-cli.md`; no product packages. |
| Acceptance criteria | Evidence begins from a user-started TUI; correlates plugin event, session ID, provider/model, and observed prompt boundary; demonstrates all three modes or marks the missing mode blocking; proves another session and unsent draft are unchanged; no Khala process launches OpenCode. Hosted-only observations are labelled secondary. |
| Tests | Scripted/manual probe matrix for idle, long-tool, explicit read, restart, wrong session, and draft preservation. **Wrong implementation test:** a probe that succeeds only against a separately launched OpenCode server must fail interactive-route admission. |
| Blocked by | `opencode-server-auth-proof`, `listening-mode-contract`, `listening-mode-pull`. |
| Conflict risk | Low: isolated evidence, but its capability result is a hard gate for `opencode-session-bridge` and `opencode-listening-routes`. |

### 5. `opencode-session-bridge`

| Field | Contract |
|---|---|
| Title | Bind and reconcile one authenticated OpenCode session |
| Complexity | `complexity:4` |
| Scope | Add `packages/opencode-plugin/` as a user-scope plugin loaded by the person's existing TUI, with an event-correlated session binding, canonical batch-token envelope, native session-addressed submission, ambiguous-outcome reconciliation, pause/stop checks, preserved tool permissions, and fail-closed drift handling. |
| Out of scope | `khala_read`, selecting or advertising listening modes, host-side inbox dedupe/acknowledgement, setup/remove, hard abort by default, read receipts, transcript capture, other OpenCode versions. |
| Files/packages | New `packages/opencode-plugin/{package.json,src/**,README.md}` with SDK and descriptor imports confined to `src/composition/`; export-map/workspace metadata and package-local tests. |
| Acceptance criteria | Runs only inside and targets only the person's admitted interactive TUI session; never launches OpenCode or touches another session/draft; submits the canonical channel/sender batch envelope within the shared batch byte/token ceiling; leaves acknowledgement to the next Khala call; blocks for audited human resolution on `outcome_unknown` instead of blind replay; marks peer-triggered turns tainted and enforces the configured owner-approval or context-isolation posture before `khala_send`; stale generations, auth absence, oversized envelopes, and version/model drift fail closed; human controls and existing tool gates win. |
| Tests | Inject fake OpenCode/auth/batch ports; cover wrong session, hostile marker bodies, oversized envelopes, auth refusal, denied tools, a pre-authorized `khala_send` that still cannot exfiltrate a canary secret, pause/stop races, stored/not-stored/ambiguous outcomes and human resolution, restart with a stable token, drift, and stale generations. **Wrong implementation test:** focus session B while the binding names A; only A may receive the envelope and B's draft must remain byte-for-byte unchanged. |
| Blocked by | `opencode-delivery-contract`, `opencode-inbox-notifier`, `opencode-server-auth-proof`, `opencode-interactive-cli-proof`, `mcp-inbox-batch`, `listening-mode-contract`, `authenticated-loopback-server`, `stop-control`, `setup-cli-plan`, `channel-access-cli-mcp`, `channel-access-journal`, `channel-access-inbox`. |
| Conflict risk | **Medium/high:** new package isolation reduces overlap, but descriptor composition must follow `setup-cli-plan` and read-receipt work must remain outside this ticket. |

### 6. `opencode-listening-routes`

| Field | Contract |
|---|---|
| Title | Add shared pull and evidence-gated OpenCode modes |
| Complexity | `complexity:3` |
| Scope | Register the user-scope plugin's `khala_read` facade over the single `listening-mode-pull` operation; map only interactively proved native boundaries to `steer` and `sync`; derive effective support and acknowledgement only from `HarnessCapabilities`; keep the separate `hard-cancel` capability off. While `sync` remains unproven, report it unsupported and default to `async` with a reason, without claiming three-mode acceptance. |
| Out of scope | Reimplementing batch/pull/acknowledgement, binding/session reconciliation, read-receipt emission, generic UI, acceptance orchestration, hard abort enabled by default. |
| Files/packages | `packages/opencode-plugin/src/{tools,modes,composition}/` and tests; minimal package registration; no broad edits to `packages/agent-cli/src/cli/app.ts` or `mcp/server.ts`. |
| Acceptance criteria | All calls execute in the user-started TUI session; `async` makes no automatic prompt submission and `khala_read` returns the shared batch/token shape; `steer` and `sync` are enabled only for retained interactive evidence keys; missing `sync` is visibly unsupported, defaults to `async`, and blocks final acceptance; version/provider drift disables the route; hard abort requires a distinct future `hard-cancel` capability. |
| Tests | Mode matrix with fake pull and OpenCode ports, capability drift, proved busy/idle `steer` boundaries, multi-batch piggyback drain without a new release, no-abort assertion, token pass-through, and no-host-dedupe assertion. **Wrong implementation test:** without matching retained interactive `sync` evidence, an OpenCode `1.17.10` binding requesting `sync` must fail if any prompt is submitted automatically or if the effective mode is not `async` with an unsupported reason; with matching evidence, require exactly one submission at the proved boundary. |
| Blocked by | `opencode-session-bridge`, `opencode-interactive-cli-proof`, `listening-mode-pull`, `listening-mode-contract`, `mcp-result-piggyback`, `mcp-piggyback-evidence`, `setup-cli-plan`. |
| Conflict risk | **High:** `listening-mode-pull` owns CLI/MCP names and batch semantics, while this ticket owns only the OpenCode facade and routes. Land after `mcp-inbox-batch` → `mcp-result-piggyback` → `listening-mode-pull`; `acceptance` consumes the result later. |

Recommended order: run `opencode-server-auth-proof` independently. After
`listening-mode-contract` and `listening-mode-pull` land, run
`opencode-interactive-cli-proof`; both proofs must start from the person's TUI.
Wait for the remaining shared merge chain through `setup-cli-plan`. After setup
lands, run `opencode-delivery-contract` → `opencode-inbox-notifier` →
`opencode-session-bridge` → `opencode-listening-routes`. `acceptance` owns the
live OpenCode + DeepSeek to Claude driver after these contracts settle.
