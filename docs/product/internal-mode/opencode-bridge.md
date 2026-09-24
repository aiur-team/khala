# OpenCode bridge and DeepSeek acceptance

Research for I3 and the OpenCode half of Acceptance 2. Evidence was gathered on
2026-09-24 against the locally installed OpenCode `1.17.10`,
`@opencode-ai/plugin`/`@opencode-ai/sdk` `1.17.10`, Node `22.23.2`, and the
configured DeepSeek provider. This is a design, not a compatibility claim for
other versions.

## Summary

Build a dedicated `@khala/opencode-plugin` package around an explicit OpenCode
session binding. The production bridge should use the session-addressed server
API, not the global TUI draft, and consume Khala's durable agent inbox directly.
It must acknowledge a release only after OpenCode accepts it and persist enough
state to reconcile a crash without blindly submitting twice.

| Mode | OpenCode delivery | Support decision |
|---|---|---|
| `sync` (default) | Retain the release until the bound session is idle, then submit only through an atomic idle-queue or while holding an exclusive session-producer lease. | Unproven: `status` plus `promptAsync` is racy and may become `steer`. Advertise unsupported until the race is solved and tested. |
| `async` | Never inject automatically. Leave messages pending for the plugin's explicit `khala_read` tool. | Design supported by the durable inbox; agent-facing tool integration remains unproven. |
| `steer` | While busy, submit once with `session.promptAsync`; the local proof delivered at the next tool boundary. Hard abort is a separate opt-in capability. | Proven only for the exact local OpenCode/DeepSeek combination; must fail closed elsewhere. |

The OpenCode-specific bridge should not define the shared listening-mode model,
admission, or Aiur ticket orchestration. Those belong to `listening-modes` (#139),
the internal substrate (#138), and `acceptance` (#147), respectively.

## Findings and evidence

### Local proofs

The throwaway plugin is retained at
`experiments/internal-mode/opencode-bridge/.opencode/plugins/khala-proof.js`.
Secrets were read only by the launched process; no token, full transcript, or
message body beyond fixed proof markers is retained here.

| Capability | Method and observation | Result |
|---|---|---|
| Exact installation | `opencode --version`; inspected the locally installed package metadata and SDK types. | OpenCode, plugin, and SDK `1.17.10`; proven locally. The retained proof itself imports no packages and pins the OpenCode binary version. |
| DeepSeek catalog | `opencode models deepseek`, then `/provider`. | `deepseek/deepseek-flash` and `deepseek/deepseek-v4-pro` were available; the active proof model was `deepseek/deepseek-flash` (displayed as “DeepSeek V4.1 Flash”). |
| Reproduction drift | Repeated the catalog check from a fresh OpenCode data directory during final review. | The fresh catalog listed `deepseek/deepseek-v4-flash`, `deepseek/deepseek-v4-flash-vision-exp`, and `deepseek/deepseek-v4-pro`, but not the proved `deepseek/deepseek-flash`. An exact replay is currently unavailable and must fail closed rather than substitute. |
| Configuration drift | A request using configured `deepseek/deepseek-v4-flash` returned `ProviderModelNotFoundError` and suggested the two catalog entries above. | Acceptance must record the resolved provider/model and fail clearly on stale configuration. |
| Session API, idle | Created a session, posted a session-addressed message, and read the session messages. | DeepSeek replied exactly `SYNC-DEEPSEEK-OK`; proven. |
| Session API, busy | Started an asynchronous prompt containing an 8-second tool call, observed `busy`, then posted a second asynchronous prompt. | At the tool boundary the first turn did not continue to final text; DeepSeek consumed the second prompt and replied `BUSY-SECOND-OK.` This route is `steer`, not `sync`, while busy. |
| TUI append + submit | Appended a fixed marker through `/tui/append-prompt`, submitted through `/tui/submit-prompt`, and read the resulting session. | DeepSeek replied exactly `TUI-PUSH-DEEPSEEK-OK`; mechanism proven, target-session safety unproven. |
| Real plugin push | Loaded the retained local plugin in a TUI. On `session.idle` it appended and submitted a Khala-shaped marker. | The same session grew from two to four messages and DeepSeek replied exactly `PLUGIN-PUSH-DEEPSEEK-OK`; I3 is feasible. |
| Hard abort | During a 15-second tool call, posted `/session/{id}/abort`, observed `true`, `idle`, and `MessageAbortedError`; then sent a follow-up to the same session. | The follow-up returned `AFTER-ABORT-DEEPSEEK-OK`; exact-version server abort is proven. Abort is not rollback and tool side effects remain a risk. |

The installed SDK also exposes `session.status`, `session.idle` events,
session-addressed `promptAsync`, `abort`, and message reads. The TUI append and
submit calls are directory-scoped rather than session-ID-scoped. Endpoint
presence alone is not evidence that a delivery mode works.

### Repository evidence

| Existing seam | Consequence |
|---|---|
| `packages/agent-cli/src/cli/inbox.ts` stores per-binding/generation JSONL, deduplicates, locks one listener, and separates `readNext()` from `acknowledge()`. | The plugin should compose this API directly. Parsing `khala listen` stdout would lose a message if the plugin crashed after the CLI acknowledged but before OpenCode accepted it. |
| `packages/contracts/src/delivery/harness.ts` describes observed harness `busy` behavior, while connector dispatch policy uses `queue | wait | reject` and refuses steering routes. | The per-agent `steer | sync | async` setting is a separate shared contract owned by #139; do not overload `busy`. |
| `packages/harnesses/src/codex/` is port-first, exact-version/evidence-scoped, and fail-closed. | Mirror that shape: inject an OpenCode client port, isolate SDK calls in composition, and derive advertised support from evidence. |
| Route names, fixtures, CLI decoding, connector admission, and presence labels are closed projections. | Add an evidence-scoped `opencode_plugin` route in one coordinated contract ticket before the plugin advertises tested delivery. |
| `tests/e2e/harness/{live,scenario,evidence}.ts` records source versions and rejects all-skipped live runs. | Reuse it for the OpenCode/DeepSeek driver, but let #147 own Aiur ticket creation, Executor-log verification, and cleanup. |

## Design

### Boundary and state

One human-admitted binding generation maps to exactly one `{sessionID,
directory, serverUrl, opencodeVersion, providerID, modelID}` tuple. A deleted
session, changed server URL, version/model drift, or stale generation degrades
the binding; the bridge never selects another session or creates a replacement
silently.

The plugin consumes only canonical released Khala messages. It does not capture
assistant output, tool output, history, or the user's TUI draft. Replies remain
deliberate `khala_send`/`khala send` operations (D3).

Persist per binding:

| State | Why |
|---|---|
| inbox cursor and binding generation | Continue the correct admitted stream after restart. |
| selected mode and human pause/stop state | Enforce human control before every submission. |
| release ID and delivery phase | Deduplicate and reconcile an ambiguous crash. |
| exact OpenCode/provider/model evidence key | Prevent stale support claims. |

Human `stop` outranks `pause`, and both outrank the agent-selected mode. Pause
retains backlog. Stop disposes the listener and requires explicit human restart.
Neither control may claim to roll back a prompt OpenCode already accepted.

The plugin is the single inbox listener. A connector-side OpenCode harness
appends exact released bytes, then sends a content-free hint over an owner-only
Unix socket; the plugin always re-reads the durable inbox. In `async`, its
`khala_read` tool uses that same listener to return the next ordered item. No
second CLI listener or parser of `khala listen` stdout is permitted.

### Delivery state machine

1. Read one release without acknowledging it; reject a stale binding generation.
2. Reconcile any prior `submitting` record from OpenCode messages/events. Never
   retry merely because the local receipt write is missing.
3. Recheck human controls, the exact bound session, model/version evidence, and
   authoritative session status immediately before acting.
4. Apply the mode:
   - `async`: retain the release. On explicit `khala_read`, return the next
     ordered item through the plugin tool and correlate its OpenCode tool-result
     part before acknowledgement.
   - `sync`: if busy, wait for `session.idle`. Submit only through a proved
     atomic idle-queue or while holding an exclusive producer lease that covers
     every TUI/API producer. OpenCode `1.17.10` has neither proved here, so the
     mode remains unsupported rather than using a racy status-read/submission
     pair.
   - `steer`: if busy, persist `submitting` and call session-addressed
     `promptAsync` once. Do not abort by default. If idle, submit once; a race
     that makes the session busy still preserves `steer` semantics.
5. Treat API acceptance as queued, not consumed. After correlating the exact
   canonical envelope with a stored user-message identity in the bound session,
   emit `harness_queued` and acknowledge the inbox item: OpenCode is now the
   durable owner. Emit `context_consumed` only after a later explicit model-side
   acknowledgement carries the release ID. If stored-message reconciliation
   cannot decide, report `outcome_unknown` and require intervention instead of
   replaying.

The prompt is one canonical, length-delimited JSON envelope containing a
bridge-generated release ID, digest, room/sender metadata, and the deliberate
message body. Reconciliation parses only that exact outer structure and binds it
to the expected session and retrieved OpenCode message/part identity; marker-like
text inside the peer body has no control meaning. The envelope reminds the model
that peer content is untrusted data and replies require explicit `khala_send`.
Peer text is never interpolated into system instructions.

Bridge delivery must preserve OpenCode's existing tool permission policy: it
never elevates permissions, auto-approves a tool, or weakens a human gate. An
admitted peer can still send hostile instructions, so acceptance includes a
denied or human-gated tool request and checks that no secret is exposed.

### Why the session API is primary

| Choice | Benefit | Cost / decision |
|---|---|---|
| Session-addressed API | Targets the admitted session, preserves a human's unsent draft, supports status/message reconciliation. | Requires a protected descriptor and authenticated server. Chosen. |
| TUI append + submit | Small and proven through a real plugin. | Global/directory-scoped; can target the wrong session or submit a human draft. Proof/fallback only, never advertised as tested without an independent target-safety proof. |
| `promptAsync` while busy | Locally proved next-tool-boundary `steer` without hard abort. | Cannot implement `sync`; must be capability-gated to exact evidence. |
| Abort then submit | Locally interrupts and recovers the same session. | Tool side effects are not rolled back; SDK/plugin regressions have existed. Opt-in proof profile only. |

The setup flow (#143) owns install/remove/status, descriptor permissions, and
OpenCode server authentication. The server uses a per-launch credential kept in
owner-only state and never logged; the bridge fails closed when authentication
is absent. The descriptor is owner-only, loopback-only, bound to the explicit
session, and contains only a credential handle/path—not the secret, message
bodies, or provider credentials. Authentication support on the exact installed
version still needs an explicit proof before implementation claims it.

## Acceptance 2: OpenCode + DeepSeek run

#147 should compose this run after the internal substrate, shared modes, setup,
and bridge tickets land.

| Step | Required evidence |
|---|---|
| Preflight | Record OpenCode/plugin/SDK/Node versions, resolved DeepSeek provider/model, bridge capability record, and an already-existing session ID. Reject configured-model drift rather than substituting silently. |
| Admission and binding | Human admits the agent; evidence maps one binding generation to the existing session ID. A second OpenCode session is present as the wrong-target oracle. |
| Bidirectional chat | A human or peer sends a deliberate marker through Khala; DeepSeek consumes it in the bound session and replies with a different deliberate marker through `khala_send`. Executor logs correlate release/event IDs without full content. |
| `sync` | First race another producer between idle observation and submission. The mode stays unsupported unless an atomic queue/exclusive lease prevents `steer`; if supported, a long-tool run proves no abort/concurrent prompt, exactly one post-idle submission, same session ID, and one consumption receipt. |
| `async` | Send two ordered markers. Assert no OpenCode prompt before explicit read, then ordered atomic drain without duplication. |
| `steer` | During a long tool call, send one marker. On a matching evidence key, assert next-boundary consumption in the same session. If the key does not match, the UI and run must say unsupported; fallback to `sync` is a failure. |
| Controls and restart | Pause before submission, resume, restart between API acceptance and receipt persistence, then stop. Assert retained backlog, no blind replay, and no delivery after stop. |
| Safety oracle | The unbound session and an unsent TUI draft remain byte-for-byte unchanged; an unauthenticated server request is rejected; an injected request for a denied filesystem/network action remains denied or human-gated; no transcript/tool output appears in Khala; evidence contains no credentials or full messages. |
| Cleanup | #147 removes test tickets/rooms/processes and records the Executor verdict. The run fails if cleanup or any required evidence is missing. |

The run may report hard-abort `steer` unsupported. It may not claim support from
an HTTP `200`, an abort boolean, or endpoint discovery alone.

## Risks and open assumptions

| Risk / assumption | Treatment |
|---|---|
| OpenCode message storage does not prove model consumption. | A verified stored user message permits only `harness_queued` and inbox acknowledgement; reserve `context_consumed` for an explicit model-side release-ID acknowledgement. |
| An idle status read and `promptAsync` submission are not atomic. | Keep `sync` unsupported until an atomic idle-queue or exclusive all-producer lease is proved; test the race explicitly. |
| Status and idle events race with pause, restart, and new work. | Serialize per binding; treat events as hints and re-read authoritative state at the submission linearization point. |
| Hard abort can leave external tool side effects. | Never describe abort as rollback; keep it off by default and evidence-gated. |
| Plugin disposal or server restart changes the URL. | Degrade and require explicit rebind; never follow a new server/session automatically. |
| The configured DeepSeek model name can be stale. | Preflight compares configuration with the live provider catalog and records the resolved identity. |
| Shared mode and receipt vocabulary may change in parallel. | The shared-contract ticket is single-writer and blocks plugin integration. |
| Assumption: #138 supplies a durable local room/binding and #141 or the agent CLI supplies explicit read/send surfaces. | The plugin does not recreate either responsibility. |

## Non-goals

- Implementing product code in this research ticket.
- Defining shared `steer | sync | async` semantics or UI controls (#139).
- Building the local server, admission, or durable room substrate (#138).
- Installing/removing the plugin or publishing packages (#143).
- Creating Aiur tickets, judging Executor logs, or owning global cleanup (#147).
- Capturing model output as chat, dumping transcripts, or admitting an agent
  without a human.
- Compatibility claims beyond the recorded exact-version evidence.

## Ticket contracts

### 1. Add the tested OpenCode delivery contract

| Field | Contract |
|---|---|
| Complexity | `complexity:3` |
| Scope | Add evidence-scoped `opencode_plugin` route/capability vocabulary and project it through delivery fixtures, agent CLI decoding, connector admission, and presence label `OpenCode plugin`. Keep listening mode separate from harness `busy`. |
| Out of scope | Plugin implementation, OpenCode setup, shared mode semantics, Aiur acceptance orchestration. |
| Files/packages | `packages/contracts/src/delivery/`; `packages/contracts/fixtures/delivery/`; `packages/agent-cli/src/cli/types.ts`; `packages/connector/src/route-admission.ts`; `apps/connector/src/composition/agent/{harnesses,presence}.ts` and adjacent tests/docs. |
| Acceptance | A capability is selectable only for the exact evidence key and truthful mode support; stale/unknown versions fail closed; presence displays `OpenCode plugin`. |
| Tests | Extend contract fixtures and connector projection tests. **Wrong implementation test:** an `opencode_plugin` claim with no matching evidence, or with unsupported `steer`, must be refused rather than admitted as a generic listener. |
| Blocked by | `listening-modes` (#139) for the shared mode contract; this `opencode-bridge` research evidence. |
| Conflict risk | **High:** #139 owns modes/UI truthfulness; #141 may touch agent CLI routes; connector contract unions and fixtures are single-writer surfaces. Land/serialize this ticket first. |

### 2. Wire released jobs to the OpenCode inbox

| Field | Contract |
|---|---|
| Complexity | `complexity:3` |
| Scope | Add a connector-side OpenCode `HarnessPort` that appends exact released bytes to the durable inbox, then sends a content-free hint to the one live plugin listener over an owner-only Unix socket. Project its receipts and ambiguous outcomes through connector composition without putting payloads in argv, environment, socket hints, or logs. |
| Out of scope | Prompt injection, mode scheduling, setup/authentication, shared route vocabulary, direct OpenCode API calls. |
| Files/packages | New `packages/harnesses/src/opencode/` adapter and tests; reviewed hint/wait additions in `packages/agent-cli/src/cli/inbox.ts`; `apps/connector/src/composition/agent/harnesses.ts` and adjacent tests/README. |
| Acceptance | Exact bytes are durable before notification; duplicate/uncertain enqueue never causes a second hint; a dead/mismatched listener fails closed; receipts distinguish inbox durability from model consumption; process ownership and socket permissions are explicit. |
| Tests | Fake inbox/notifier component tests plus connector composition coverage. **Wrong implementation test:** crash after enqueue but before hint, restart, and assert the durable release is recoverable exactly once rather than lost or appended twice. |
| Blocked by | Contract 1; `local-substrate` (#138); the reviewed inbox/listener ownership from `mcp-piggyback` (#141). |
| Conflict risk | **High:** #141 may change inbox/MCP read semantics and #139 owns mode/receipt truthfulness. Serialize shared inbox and connector-composition edits. |

### 3. Build the OpenCode session bridge

| Field | Contract |
|---|---|
| Complexity | `complexity:4` |
| Scope | Add `packages/opencode-plugin/` with a port-first bridge, exact `1.17.10` composition, explicit session binding, sole inbox-listener ownership, `khala_read`, per-binding serialization/dedupe/reconciliation, canonical envelope framing, evidence-gated modes, pause/stop enforcement, preserved tool permissions, authenticated server checks, and truthful receipts. |
| Out of scope | Shared contracts, generic setup/remove, hard abort enabled by default, admission, local substrate, transcript capture, other OpenCode versions. |
| Files/packages | New `packages/opencode-plugin/{package.json,src/**,README.md}` with SDK/inbox imports confined to `src/composition/`; export-map and workspace metadata as required. |
| Acceptance | Delivers once to the explicitly bound session; does not touch the TUI draft; `khala_read` atomically returns ordered pending messages through the sole listener; advances the inbox only after correlating a stored message and emits only `harness_queued` at that boundary; restart reconciles or reports `outcome_unknown`; unsupported `sync`, unauthenticated servers, drift, and stale generations fail closed; human controls and existing tool gates win. |
| Tests | Inject a fake OpenCode client and durable inbox; cover `sync` race/refusal, explicit `async` tool drain, gated `steer`, hostile marker bodies, unauthenticated server refusal, denied tool requests, pause/stop races, failure before ack, duplicates, restart ambiguity, model/version drift, and stale generations. **Wrong implementation test:** focus session B while binding points to A; only A may receive the release and B's draft must remain unchanged. |
| Blocked by | Contracts 1–2; `local-substrate` (#138); `listening-modes` (#139); reviewed explicit send semantics from `mcp-piggyback` (#141). |
| Conflict risk | **Medium/high:** #143 owns installation and descriptor lifecycle; #141 may evolve inbox/MCP composition; #139 owns mode semantics. Keep changes inside the new package and consume reviewed shared exports. |

### 4. Add the OpenCode/DeepSeek Acceptance 2 driver

| Field | Contract |
|---|---|
| Complexity | `complexity:3` |
| Scope | Add an exact-version OpenCode/DeepSeek live driver and evidence schema consumed by #147. Exercise the run above, including the wrong-session/draft oracle, truthful supported-or-unsupported results for all three modes, controls, restart reconciliation, and redaction. |
| Out of scope | Creating the general Aiur acceptance runner, fake-harness Acceptance 1, plugin/setup implementation, provider credentials in fixtures. |
| Files/packages | A dedicated `tests/e2e/internal-mode/opencode/` subtree; reuse `tests/e2e/harness/{live,scenario,evidence}.ts`; minimal package test configuration/README updates. |
| Acceptance | Live mode fails if skipped, versions/model identity drift, the pre-existing session changes, any marker is duplicated/misdirected, required `steer` is falsely downgraded, evidence is incomplete, or cleanup fails. Produces redacted evidence for #147's Executor verdict. |
| Tests | Fake driver tests for every failure classification plus a credential-gated live run. **Wrong implementation test:** return HTTP success while placing the marker in the unbound session; the evidence grader must fail. |
| Blocked by | Contract 3; #147's reviewed acceptance-driver and evidence interfaces; `setup-cli` (#143); `local-substrate` (#138); `listening-modes` (#139). |
| Conflict risk | **High:** #147 owns shared orchestration/evidence and #143 owns preflight/setup. Give this contract an OpenCode-only subtree and land it after those owners settle their interfaces. |
