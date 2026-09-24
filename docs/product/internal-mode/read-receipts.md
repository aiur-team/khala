# Internal mode: honest agent read receipts

Status: research proposal, 2026-09-24. Scope is I8 under the fixed D1-D12 decisions in [requirements](requirements.md); the implementation seams come from the [reuse survey](survey.md).

## Summary

Khala cannot observe cognition. It can prove that bytes reached a connector, entered a harness queue, or were correlated with model input; a later agent-initiated Khala call can also return the token for a delivered batch. The UI should name those facts, never collapse them into “read.”

Add one independent delivery fact, `agent_acknowledged`, emitted only when the agent's next authenticated Khala call returns the opaque token for a previously delivered inbox batch. The shared `mcp-inbox-batch` operation owns that token and Khala-side acknowledgement; this design adds no second acknowledgement, batch, or lease API. Keep `context_consumed` as harness evidence and relabel it **Added to agent context**. Render **Batch token returned** only for the new fact, with help text that it proves a later Khala interaction—not agent action, comprehension, correctness, or completion. No route may synthesize this fact from a write, queue event, cursor advance, hook run, assistant reply, or completed turn.

## Assumptions

| ID | Assumption |
|---|---|
| A1 | The merged `requirements.md` and `survey.md` are the authoritative shared brief; this design does not reopen D1-D12. |
| A2 | I8’s “read” means a truthful batch-token return on a later agent-initiated Khala call, not proof of attention or semantic understanding. The product label therefore says “Batch token returned,” not “read” or “acknowledged.” |
| A3 | v1 exposes receipt evidence to the owner in the internal-mode UI. Sender-visible external receipts and disclosure preferences belong to `make-external`. |
| A4 | Receipt granularity stays `releaseId`. A release may contain several events, so the UI must not put per-message checkmarks on a batch unless the release contains exactly that message. |
| A5 | **Channel** is the product term in every user- and agent-facing name. Literal existing paths or Matrix-internal types containing `room` remain unchanged here; #163 owns the existing-code rename. |

## Findings and evidence

### Existing contract and UI

| Finding | Evidence | Consequence |
|---|---|---|
| Receipt kinds are closed, content-free, independent facts; `DeliveryReceipt` is v1 and its source is only `connector` or `harness`. | [`receipts.ts`](../../../packages/contracts/src/delivery/receipts.ts), [`delivery/README.md`](../../../packages/contracts/src/delivery/README.md) | Adding an agent-originated fact requires a versioned contract change, not a free-text annotation. |
| `HarnessCapabilities.receiptEvidence` advertises exactly which closed facts a route can emit. `support: tested` requires an evidence reference. | [`harness.ts`](../../../packages/contracts/src/delivery/harness.ts) | Acknowledgement support needs its own non-boolean capability; it must not be inferred from harness support. |
| Both current web surfaces label `context_consumed` as “Read by the agent”; review also treats `completed` as consumption. | [`review/receipt-labels.ts`](../../../apps/web/src/features/review/receipt-labels.ts), [`room/AgentPresencePanel.tsx`](../../../apps/web/src/features/room/AgentPresencePanel.tsx) | Existing copy overstates the contract. `completed` must not imply acknowledgement because receipt facts are non-ordinal. |
| Review selects only the latest receipt by timestamp even though the contract says facts are independent. | [`review/receipt-labels.ts`](../../../apps/web/src/features/review/receipt-labels.ts), [`ReviewScreen.tsx`](../../../apps/web/src/features/review/ReviewScreen.tsx) | Render a set of applicable evidence chips; a later completion must not erase an earlier context or acknowledgement fact. |

### What each route can honestly claim

| Route | Proven ceiling | Honest UI | Agent acknowledgement support |
|---|---|---|---|
| Codex hosted app-server `0.154.0` | A correlated `userMessage.clientId` yields `context_consumed`; `turn/completed` is separate. Duplicate and out-of-order notifications emit each fact once. | **Added to agent context**; separately **Agent turn completed**. | Possible when the route delivers the shared batch/token format and the next authenticated Khala call returns that token. Do not auto-upgrade `context_consumed`. |
| Codex native CLI `0.154.0` + local inbox | `codex queue` proves only `harness_queued`; the queue ID is not correlated to the consumed user item. Released bytes are read from the durable CLI inbox. | **Queued at agent session** until stronger evidence arrives. | Possible through shared `khala read` and the next authenticated Khala call. The current listener cursor is not evidence: it advances immediately after stdout accepts a line. |
| Claude Code `2.1.276` evidence route | Hosted streaming observed write, replay, nonce-based consumption, and completion while alive, but failed reconnect/resume; production capability remains `unsupported`. | No production read/ack claim. Evidence may continue to show the narrower experimental facts. | **Unproven.** Claude `2.1.282` is installed locally, but no live plugin/hook acknowledgement proof was run for it. Hooks can deliver context; a hook firing is not agent acknowledgement. |
| OpenCode `1.17.10` plugin | The installed CLI exposes plugin/server/session surfaces. Current official plugin docs describe prompt/context hooks and session/message events, but this repo contains no retained live proof tied to `releaseId`. | **Unproven**; never show context or acknowledgement from plugin registration alone. | **Unproven** until `opencode-bridge` proves shared-batch handling, a later token-bearing call, and negative correlation cases. |
| Generic `agent_installed_listener` | Capability is experimental with no receipt evidence. `khala listen` writes JSON to stdout, then durably acknowledges its inbox cursor. | At most the existing connector/inbox fact; not “read.” | Possible only after it adopts the shared batch/token contract; stdout acceptance alone never emits the new fact. |
| MCP tool-result piggyback | `mcp-piggyback` owns whether pending messages become model-visible through a tool result. No proof is present on this branch. | **Unproven** until `mcp-piggyback` supplies evidence. | Piggyback appends the same batch format. Returning that tool result does not acknowledge it; the next authenticated Khala call must return its token. |

Codex evidence: [`receipts.ts`](../../../packages/harnesses/src/codex/receipts.ts), [`receipts.test.ts`](../../../packages/harnesses/src/codex/receipts.test.ts), [hosted route](../../evidence/codex.md), and [native CLI route](../../evidence/codex-native-cli.md). Claude evidence: [existing-session probe](../../evidence/claude.md), [native route](../../evidence/claude-native-cli.md), and [`live-proof.json`](../../../experiments/claude-native/evidence/live-proof.json). Fallback evidence: [`cli/app.ts`](../../../packages/agent-cli/src/cli/app.ts), [`cli/inbox.ts`](../../../packages/agent-cli/src/cli/inbox.ts), and the [fallback skill](../../../packages/agent-skill/SKILL.md). OpenCode reference: [official plugin documentation](https://opencode.ai/v2/docs/build/plugins).

### Local proof run

| Command / observation (2026-09-24) | Result |
|---|---|
| `codex --version`; `claude --version`; `opencode --version` | `codex-cli 0.154.0`; Claude Code `2.1.282`; OpenCode `1.17.10`. Only the Codex version matches retained route evidence. |
| Contract, harness, CLI, and web package tests | 9 files / 472 tests; 6 / 140; 5 / 35; 32 / 369, all passing on Node `24.18.0`. |
| `claude --help` | Installed CLI exposes hooks/plugins and streamed hook events; help alone does not prove a read boundary. |
| `opencode --help` | Installed CLI exposes `plugin`, `serve`, `attach`, and session selection; help alone does not prove prompt correlation or acknowledgement. |

The first focused Vitest invocation from the repository root found no files because the shared config is package-rooted; the package-scoped runs above are the valid proof. Dependency install used the repository lockfile and the writable Aiur pnpm store. The repository pins Node `22.23.2`, so Node 24 results are supporting evidence, not the release gate.

## Design

### Evidence vocabulary

| Fact | Producer boundary | UI label | Must not imply |
|---|---|---|---|
| `transport_written` | Connector completed a transport write. | Delivered to connector | Harness acceptance or model input |
| `harness_queued` | Harness accepted/queued the release. | Queued at agent session | Immediate execution |
| `context_consumed` | Harness correlated this release to model-visible input. | Added to agent context | Attention, comprehension, or agreement |
| `agent_acknowledged` (new) | A later authenticated Khala call returned the shared token for the batch containing this release. | Batch token returned | Agent action, context insertion, comprehension, correctness, or task completion |
| `completed` | The correlated harness turn completed. | Agent turn completed | Successful tools, correct result, or acknowledgement |

These remain a set of facts, not a state machine. `outcome_unknown` may coexist with a later stronger observation, and timestamps order observations only.

### Contract shape

1. Define `DeliveryReceipt` v2 with `agent_acknowledged` and source `agent`. Keep v1 and v2 as an explicit discriminated union during rollout; the v2 decoder requires `agent_acknowledged` if and only if `source === 'agent'`, and v1 is never reinterpreted as agent evidence.
2. Through `listening-mode-contract`, the sole owner of `HarnessCapabilities`, add `acknowledgement: 'unknown' | 'unsupported' | 'batch_token_next_call'`. Keep legacy and new capability decoding during rollout; an absent field presents as unknown, and no producer advertises support until its exact route is proven. This describes the shared batch-token boundary, never a boolean promise.
3. Keep the receipt content-free and release-scoped: stable `receiptId`, `releaseId`, `bindingId`, generation, timestamp, source, and evidence reference. Receipts created by one batch acknowledgement share a server-generated, non-secret evidence reference for UI grouping; it is neither the token nor a reusable token digest. Do not add message bodies, model output, or free-text reasons.
4. Reuse the closed result and refusal vocabulary owned by `mcp-inbox-batch` and `listening-mode-pull`; do not add a receipt-specific acknowledgement result. A refused, expired, stale, malformed, or outcome-unknown batch acknowledgement produces no false delivery receipt.
5. Generate the stable receipt ID from `['agent', bindingId, generation, releaseId, 'agent_acknowledged']`. The first successful acknowledgement persists a canonical fact whose `observedAt` is its commit time; every field remains immutable, and repeats return that stored fact unchanged even after restart. Changed binding generation cannot acknowledge an earlier binding.
6. Stage compatibility before production: `read-receipt-contract` teaches every consumer and store to preserve both versions but emits no new versions; `read-receipt-recording` may then write v2 acknowledgement receipts, and the harness-specific tickets may advertise the new capability only for proven routes. Persisted v1 rows remain v1 and require no lossy rewrite.

### Agent action and validation

There is no `khala_acknowledge` tool or command. `mcp-inbox-batch` owns the bounded durable peek and opaque batch token; `listening-mode-pull` exposes that same operation as MCP `khala_read` and CLI `khala read`; MCP piggyback appends the same batch format. A supported client automatically returns the pending token on its immediate next authenticated Khala call through the shared client/application-call envelope. Khala then acknowledges the batch and records one content-free `agent_acknowledged` fact for each release in its committed prefix.

Authentication and token validation run before the primary operation. A valid acknowledgement commits independently even if that operation later returns a domain rejection or execution error; both outcomes remain observable. Conversely, an acknowledgement failure must not convert the primary operation into success or invent a receipt.

The token remains binding- and generation-scoped, opaque to callers, and owned by the shared batch contract. It never appears in argv, Khala logs, errors, receipts, or UI. Recipient-local private inbox state may persist it only as required by that contract. Returning it proves a later authenticated Khala interaction after the batch was made available; it does not prove which bytes entered model context or whether the agent understood them.

`mcp-inbox-batch` is the sole owner of pending-token lifecycle across CLI, MCP, and plugin callers for one binding generation. Receipt tickets add no host-side token register or duplicate ledger. A route may advertise `batch_token_next_call` only after the shared contract proves deterministic claim/retain/replace behavior under simultaneous cross-process calls; if one caller can lose or overwrite the current token, that route remains `unproven`.

Every later call is authenticated through the common agent transport. The server derives the binding and generation from a server-held, binding-scoped principal or capability. The trusted connector/local server records the facts only when all checks pass:

| Check | Reason |
|---|---|
| Caller holds the exact binding and generation. | Prevents one agent acknowledging for another or a revoked instance. |
| The token names the exact current, previously issued batch for that binding generation. | Prevents arbitrary receipt creation and cross-batch skip-ahead. |
| Every acknowledged `releaseId` belongs to the committed prefix represented by that batch token. | Prevents an injected message from naming unrelated backlog. |
| The batch was made available to that binding generation. | Absence of a delivery receipt is not evidence of non-delivery, but merely issuing or returning the batch response is not acknowledgement. |
| Receipt insert is unique by stable receipt ID. | Makes repeats and reconnects idempotent. |
| Request and response contain no content bytes. | Preserves the existing content-free receipt boundary. |

The liveness, revocation, batch-token verification, contiguous inbox acknowledgement, and unique receipt inserts run under the same Khala-side transaction/revocation fence. A revocation that serializes first must prevent both cursor advancement and receipt insertion; an acknowledgement that serializes first may commit both before revocation. Restart redelivers only Khala-unacknowledged batches with stable release IDs; Codex, Claude, and OpenCode do not own duplicate suppression.

The agent integration instructions say: make the next Khala call only after handling the delivered batch; do not fetch unseen backlog that the client cannot carry forward correctly. The protocol cannot guarantee compliance, which is why the UI describes the exact later-call attestation.

### UI

- Replace every “Read by the agent” label for `context_consumed` with “Added to agent context.”
- Show “Batch token returned” only for `agent_acknowledged`. Put a keyboard-focusable help control beside it and programmatically associate the status with: “A later Khala call returned the token for this batch. This does not prove the agent acted on the message, the message entered context, was understood, or was completed.”
- Render receipt facts as chips/list items rather than selecting one latest fact. Use one canonical non-semantic order everywhere: ascending receipt-kind code, then timestamp and receipt ID only as same-kind tie-breakers. Never reorder by perceived strength or derive a progress percentage.
- Group all `agent_acknowledged` facts sharing the same non-secret evidence reference into one batch-evidence group, even when the token covered several releases. Each release links to that group; never repeat the status as if it represented separate agent actions.
- For a one-event, one-release batch, show evidence beside that message. Otherwise render the batch/release evidence group before its member rows, give it a stable DOM target and focusable heading, and label each member link “View batch evidence.” Activation scrolls and moves focus to the group; browser back restores the invoking row. Render no link until its target exists, and never replace a missing target with an inferred status.
- In the agent panel, render capability `unknown` as “Batch-token return support not verified,” `unsupported` as “Batch-token return not supported,” and `batch_token_next_call` as “Batch-token return supported.” A supported route with no receipt has no token-return fact—not an error or unread status.
- Carry that closed capability state through the connector presence snapshot, browser decoder, channel port/controller, and panel; never derive it from `lastReceipt` or a route label. The current code remains under the literal `features/room` path until #163 renames it.

### Alternatives and trade-offs

| Alternative | Decision | Trade-off |
|---|---|---|
| Keep calling `context_consumed` “read.” | Reject | Zero implementation cost, but claims cognition from context insertion and excludes fallback routes. |
| Rename `context_consumed` only; add no agent fact. | Viable minimum, not I8 | Most truthful and simplest, but offers no cross-harness agent-side acknowledgement. |
| Infer read from any assistant reply or completed turn. | Reject | A reply may ignore some or all of a batch; `completed` is explicitly independent. |
| Auto-ack in hooks/plugins/listeners. | Reject | Proves hook/process activity, not an agent action; the existing receipt kinds already describe machine delivery. |
| Shared batch token on the next Khala call (recommended). | Choose | Reuses the single durable inbox contract and centralizes deduplication, but proves only a later Khala interaction and yields no receipt if that later call never occurs. |

## Risks

| Risk | Mitigation |
|---|---|
| Users interpret a returned token as agent action or comprehension. | Name the observable event, document the boundary inline, and never use a double-check/read icon. |
| Prompt injection asks an agent to acknowledge unseen IDs. | Accept only the opaque token for the exact issued batch under binding-scoped authentication; never accept caller-supplied release IDs or skip-ahead. This proves a later Khala interaction, not attention or comprehension. |
| Harness or provider transcripts retain a model-visible token. | Keep the shared batch token out of argv and Khala observability surfaces, scope it to one binding generation and issued batch, and do not promise deletion from third-party transcripts. |
| Acknowledgement leaks activity in external channels. | Owner-only internal UI in v1; `make-external` must make external disclosure an explicit policy. |
| Batch receipts look message- or release-specific. | Group every receipt from the same batch evidence reference together, link each member to that group, and suppress per-message ticks. |
| Contract version causes partial deployment failures. | `read-receipt-contract` is a read-compatible consumer-first deployment that emits no new receipt or capability values. Only later tickets produce them after every deployed consumer can preserve them. |
| Concurrent E09 work edits the same capability and tool surfaces. | Sequence on the ticket dependencies below; do not duplicate `listening-mode-contract`, `claude-plugin`, `opencode-bridge`, or `mcp-piggyback` composition work. |
| An agent makes no later Khala call. | Show no acknowledgement rather than retrying, nagging, or inferring one. A supported client that does make another call must carry the pending token; omission is a conformance failure and creates no receipt. |

## Non-goals

- Proving attention, comprehension, agreement, correctness, or tool success.
- Treating delivery observations as an ordered progress state.
- Per-token/model-internal telemetry, chain-of-thought, transcript capture, or content-bearing receipts.
- Automatically acknowledging on batch response writes, stdout writes, hook execution, prompt injection, replies, or turn completion.
- Adding a second batch, lease, pull, or acknowledgement API; `mcp-inbox-batch` and `listening-mode-pull` own those shared surfaces.
- External-channel receipt visibility or privacy policy; `make-external` owns that decision.
- Reworking listening modes, Claude hooks, OpenCode push, or MCP piggyback delivery; this design consumes their evidence.

## Ticket contracts

### `read-receipt-contract` — Version receipt contracts and truthful UI labels

| Field | Contract |
|---|---|
| slug | `read-receipt-contract` |
| title | Version receipt contracts and truthful UI labels |
| complexity | `3` |
| scope | Define `DeliveryReceipt` v2 with the closed `agent_acknowledged`/`agent` pairing, retain explicit legacy decoding, consume the acknowledgement capability added by `listening-mode-contract`, and update every receipt store/consumer, fixture, label, review surface, and presence surface before any producer emits v2. |
| out-of-scope | Changing the shared batch or capability owner; producing acknowledgements; harness/plugin setup; external disclosure; renaming existing code owned by #163. |
| files/packages | `packages/contracts/src/delivery/{receipts,README,index}.ts`, `packages/contracts/fixtures/delivery/`, capability consumers in `packages/{harnesses,agent-skill}/` and `apps/connector/`, `packages/connector/src/{storage,dispatch}/`, contract/conformance tests, the connector presence projection, and receipt/capability consumers in `apps/web/src/{composition/human,features/{review,room,agent-controls}}/`. |
| acceptance criteria | v1/v2 receipts decode as explicit versions; v1 cannot carry the new kind/source; v2 enforces the bidirectional acknowledgement/agent-source invariant; the capability field from `listening-mode-contract` preserves `unknown`, `unsupported`, and `batch_token_next_call`; stored v1 rows and embedded dispatch receipts survive restart unchanged; no production producer emits v2 in this ticket; all consumers deploy before later producer tickets; the closed capability state reaches the owner-authorized channel panel; UI follows the truthful labels, canonical kind ordering, shared batch grouping, accessible help, and evidence navigation above. |
| tests | Per-version decoder/fixture failures and round trips; invalid acknowledgement/source pairings; mixed-version storage restart; exhaustive capability/label compile tests; strict browser decoding and channel integration for unknown/unsupported/supported-without-receipt; internal-core owner-gate refusals for unauthenticated, wrong-owner, wrong-Origin, and invalid-launch-token requests; keyboard/name/description/focus-return assertions; one- and multi-release batch navigation; deterministic ordering of multiple unordered facts. **Wrong implementation must fail:** a v1 or harness-sourced `agent_acknowledged`, an agent-sourced non-acknowledgement, a `completed`-only release rendered acknowledged/read, a later completion hiding context evidence, one batch rendered as separate agent actions, metadata exposed outside the owner gate, and loss or promotion of a stored v1 row. |
| blocked-by | `listening-mode-contract`; #163. |
| conflict risk | **High** with `listening-mode-contract` around capability consumers, but that ticket remains the sole `HarnessCapabilities` owner; **medium** with `internal-core`, `make-external`, and #163 on channel composition (currently under literal `features/room` paths); low with `claude-plugin` and `opencode-bridge` if they consume rather than redefine the contract. |

### `read-receipt-recording` — Record shared batch-token acknowledgements

| Field | Contract |
|---|---|
| slug | `read-receipt-recording` |
| title | Record shared batch-token acknowledgements |
| complexity | `4` |
| scope | Attach content-free receipt insertion to the Khala-side batch-token acknowledgement owned by `mcp-inbox-batch`: when the next authenticated call returns the prior token, atomically advance the acknowledged prefix and insert one stable receipt per included release. Reuse the call envelope and closed outcomes from `mcp-inbox-batch`/`listening-mode-pull`; keep duplicate handling and restart recovery in Khala. |
| out-of-scope | A second batch, lease, pull, or acknowledgement API; a CLI/MCP acknowledgement command; per-release tokens; host-side deduplication; harness/plugin installation; UI. |
| files/packages | The acknowledgement integration port exposed by `mcp-inbox-batch`, shared authenticated-call transport from `internal-core`, `packages/connector/src/{storage,dispatch}/` and its public facade, delivery receipt contracts/fixtures, and focused storage/integration tests. Changes to shared-owner files must be minimal consumer hooks rather than parallel APIs. |
| acceptance criteria | The authenticated principal determines binding and generation; the immediate next Khala call automatically returns an issued token and acknowledges only that batch’s committed prefix; batch cursor advancement and immutable unique receipt insertion share the revocation transaction; all facts from one acknowledgement share one non-secret evidence reference; repeats return the original stored facts without regenerating timestamps or evidence; restart redelivers only Khala-unacknowledged batches; tokens/content are absent from argv, Khala logs, errors, receipts, and UI; refused, expired, stale, malformed, cross-binding, revoked, or outcome-unknown acknowledgement creates no receipt; a valid acknowledgement commits before and independently of the primary operation’s domain result. |
| tests | Shared-call envelope/schema integration; no later call means no receipt; valid next token-bearing call; multi-release shared evidence reference; primary-operation rejection with committed acknowledgement; storage restart/idempotency with byte-identical receipt fields; authorization-before-idempotency oracle checks; barrier-controlled acknowledgement/revocation in both orders; unauthenticated, forged-binding, expired, stale, cross-binding, missing/wrong-token refusal with no cursor advance or receipt; secret-redaction assertions; restart redelivery without host deduplication. **Wrong implementation must fail:** returning or writing the batch response alone creates no receipt, agent B cannot return agent A’s token, a superseded or revoked generation cannot acknowledge its batch, releases from one batch receive unrelated evidence references, a rejected primary operation rolls back a valid acknowledgement, and a caller-supplied `releaseId` without the issued batch token creates no receipt. |
| blocked-by | `read-receipt-contract`; `mcp-inbox-batch`; `listening-mode-pull`; `internal-core`. |
| conflict risk | **High** with `mcp-inbox-batch` on acknowledgement transaction composition and `internal-core` on authenticated call metadata; **medium** with `listening-mode-pull` on result propagation. This ticket must not edit their public operation names or create a sibling endpoint. |

### `codex-read-receipts` — Prove and wire Codex acknowledgements

| Field | Contract |
|---|---|
| slug | `codex-read-receipts` |
| title | Prove and wire Codex acknowledgements |
| complexity | `2` |
| scope | Prove that supported Codex routes consume the shared batch returned by `khala_read`/`khala read` or MCP piggyback, preserve its token privately, and return that token on the next authenticated Khala call after handling the batch. Advertise `batch_token_next_call` only for the exact proven route; preserve native `context_consumed` evidence unchanged. |
| out-of-scope | A Codex-specific acknowledgement operation; synthesizing acknowledgement from `item/started`, queue IDs, context insertion, batch response, replies, or completion; supporting untested Codex versions. |
| files/packages | `packages/harnesses/src/codex/`, Codex setup owned by `setup-cli`, `packages/agent-skill/` guidance/capability fixtures, and the Codex conformance subject. |
| acceptance criteria | The exact tested route advertises `batch_token_next_call` only after conformance proves shared-batch delivery, authenticated binding identity, token propagation on the next Khala call, and correlated receipt recording; absence of any later call remains neutral; queue-only and batch-return-only paths never auto-ack; no Codex-side duplicate ledger is added. |
| tests | Hosted and native-route capability tests; shared batch/next-call conformance; simultaneous CLI/MCP calls; no-later-call, missing-token conformance failure, and duplicate-token behavior. **Wrong implementation must fail:** observing `item/started`, adding input to context, returning the batch response, losing/overwriting the current token across callers, or omitting it on the next Khala call may yield narrower evidence but no `agent_acknowledged`. |
| blocked-by | `read-receipt-recording`; `listening-mode-contract`; `listening-mode-pull`; `mcp-inbox-batch`; `setup-cli`. |
| conflict risk | **Medium** with `listening-mode-contract` in capability fixtures, `listening-mode-pull` in route composition, and `setup-cli`; low with `claude-read-receipts` and `opencode-read-receipts`. |

### `claude-read-receipts` — Prove and wire Claude acknowledgements

| Field | Contract |
|---|---|
| slug | `claude-read-receipts` |
| title | Prove and wire Claude acknowledgements |
| complexity | `2` |
| scope | In a disposable session, prove that the route from `claude-plugin` consumes the shared batch, keeps its token private, and returns it on the next authenticated Khala call after handling the batch; advertise only the exact proven version/route pair. |
| out-of-scope | A Claude-specific acknowledgement operation; promoting unsupported native delivery; treating hooks, prompt insertion, or the batch response as acknowledgement; OpenCode. |
| files/packages | Claude plugin output selected by `claude-plugin`, `packages/agent-skill/` shared instructions/capability tests, `experiments/internal-mode/read-receipts/claude/`. |
| acceptance criteria | Evidence records exact version, route, batch/token correlation, idle/busy behavior, no later call, missing-token conformance failure, duplicate token, wrong binding/generation/token, and reconnect; retained artifacts use only non-secret correlation labels and redacted presence/equality results, never token bytes or reusable digests; unproven pairs stay `unknown`/`unsupported`; no host-side duplicate ledger is added. |
| tests | Offline plugin/shared-call tests including simultaneous plugin/MCP callers, automated retained-artifact secret scan, and an authorized disposable live run. **Wrong implementation must fail:** a hook firing, prompt entering context, batch result returning, losing/overwriting the current token across callers, or pending-token omission on the next Khala call produces no `agent_acknowledged`; retaining token material fails the artifact scan. |
| blocked-by | `read-receipt-recording`; `claude-plugin`; `listening-mode-contract`; `listening-mode-pull`; `mcp-inbox-batch`; `setup-cli`. |
| conflict risk | **High** with `claude-plugin` until its route API settles; medium with `listening-mode-pull` and `setup-cli` packaging; low with the Codex/OpenCode receipt tickets. |

### `opencode-read-receipts` — Prove and wire OpenCode acknowledgements

| Field | Contract |
|---|---|
| slug | `opencode-read-receipts` |
| title | Prove and wire OpenCode acknowledgements |
| complexity | `2` |
| scope | In a disposable session, prove that the route from `opencode-bridge` consumes the shared batch, keeps its token private, and returns it on the next authenticated Khala call after handling the batch; advertise only the exact proven version/route pair. |
| out-of-scope | An OpenCode-specific acknowledgement operation; Claude/Codex; treating prompt/context hooks, message events, or the batch response as acknowledgement; changing `opencode-bridge` push semantics. |
| files/packages | OpenCode plugin output selected by `opencode-bridge`, `packages/agent-skill/` shared instructions/capability tests, `experiments/internal-mode/read-receipts/opencode/`. |
| acceptance criteria | Evidence records exact OpenCode/provider versions, route, batch/token correlation, idle/busy behavior, no later call, missing-token conformance failure, duplicate token, wrong binding/generation/token, and reconnect; retained artifacts use only non-secret correlation labels and redacted presence/equality results, never token bytes or reusable digests; unproven pairs stay `unknown`/`unsupported`; no host-side duplicate ledger is added. |
| tests | Offline plugin/shared-call tests including simultaneous plugin/MCP callers, automated retained-artifact secret scan, and an authorized disposable OpenCode + DeepSeek run. **Wrong implementation must fail:** a context hook, message event, batch result, losing/overwriting the current token across callers, or pending-token omission on the next Khala call produces no `agent_acknowledged`; retaining token material fails the artifact scan. |
| blocked-by | `read-receipt-recording`; `opencode-bridge`; `listening-mode-contract`; `listening-mode-pull`; `mcp-inbox-batch`; `setup-cli`. |
| conflict risk | **High** with `opencode-bridge` until its route API settles; medium with `listening-mode-pull` and `setup-cli` packaging; low with the Codex/Claude receipt tickets. |

### `read-receipt-acceptance` — Cross-harness receipt acceptance

| Field | Contract |
|---|---|
| slug | `read-receipt-acceptance` |
| title | Cross-harness receipt acceptance |
| complexity | `3` |
| scope | Extend fake-harness CI and live Aiur acceptance to assert the evidence matrix and UI copy for Codex, Claude, OpenCode, and unsupported routes. |
| out-of-scope | New harness routes, product implementation, external receipt disclosure. |
| files/packages | `tests/conformance/`, `tests/e2e/`, internal-mode Playwright specs from `internal-core`, and live-ticket scripts/results from `acceptance`. |
| acceptance criteria | CI covers batch returned without acknowledgement, no later call, valid next-call acknowledgement including a generic listener, missing-token conformance failure, simultaneous cross-process callers, duplicate token, cross-binding/stale/revoked refusal, unordered facts, multi-release batches, restart redelivery without host deduplication, owner-only receipt/capability visibility, and neutral unsupported UI; live runs report exact capability ceilings. |
| tests | Fake harness and Playwright tests plus opt-in live tickets, including acknowledgement/revocation race barriers, restart between peek and next call, v1/v2 receipt compatibility, and internal-core owner-gate denials for unauthenticated, wrong-owner, wrong-Origin, and invalid-launch-token requests. **Wrong implementation must fail:** transport write, queue acceptance, batch response, inbox cursor movement, completed turn, hook event alone, host deduplication, pending-token omission, unauthorized metadata access, or a token for another binding/generation must never satisfy the acknowledgement assertion. |
| blocked-by | `read-receipt-contract`; `read-receipt-recording`; `codex-read-receipts`; `claude-read-receipts`; `opencode-read-receipts`; `internal-core`; `acceptance`. |
| conflict risk | **High** with `acceptance` in live scripts and `internal-core` in Playwright composition; low elsewhere if it consumes public ports only. |

## Recommended order

`read-receipt-contract → read-receipt-recording → (codex-read-receipts ∥ claude-read-receipts ∥ opencode-read-receipts) → read-receipt-acceptance`. The Claude and OpenCode tickets wait for `claude-plugin` and `opencode-bridge` rather than inventing their plugin APIs. Receipt acceptance reuses `acceptance` test-ticket machinery and must not create a second live harness.
