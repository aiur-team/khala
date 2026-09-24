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
| A3 | Internal-mode product v1 exposes receipt evidence to the owner in the UI. Sender-visible external receipts and disclosure preferences require a separate external-channel policy contract. |
| A4 | Receipt granularity stays `releaseId`. A release may contain several events, so the UI must not put per-message checkmarks on a batch unless the release contains exactly that message. |
| A5 | **Channel** is the product term in every user- and agent-facing name. Literal existing paths or Matrix-internal types containing `room` remain unchanged here; `channel-terminology` owns the existing-code rename. |

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
| Codex native CLI `0.154.0` + local inbox | `codex queue` proves only `harness_queued`; the queue ID is not correlated to the consumed user item. Released bytes are read from the durable CLI inbox. | **Queued at agent session** until stronger evidence arrives. | Possible through shared `khala read` and the next authenticated Khala call. The current listener cursor is not evidence: it advances immediately after stdout accepts a line. |
| Codex hosted app-server `0.154.0` (secondary) | A correlated `userMessage.clientId` yields `context_consumed`; `turn/completed` is separate. Duplicate and out-of-order notifications emit each fact once. | **Added to agent context**; separately **Agent turn completed**. | Possible when the route delivers the shared batch/token format and the next authenticated Khala call returns that token. Do not auto-upgrade `context_consumed`; hosted evidence cannot substitute for the user's own interactive CLI. |
| Claude Code `2.1.276` evidence route | Hosted streaming observed write, replay, nonce-based consumption, and completion while alive, but failed reconnect/resume; production capability remains `unsupported`. | No production read/ack claim. Evidence may continue to show the narrower experimental facts. | **Unproven.** Claude `2.1.282` is installed locally, but no live plugin/hook acknowledgement proof was run for it. Hooks can deliver context; a hook firing is not agent acknowledgement. |
| OpenCode `1.17.10` plugin | The installed CLI exposes plugin/server/session surfaces. Current official plugin docs describe prompt/context hooks and session/message events, but this repo contains no retained live proof tied to `releaseId`. | **Unproven**; never show context or acknowledgement from plugin registration alone. | **Unproven** until `opencode-session-bridge` and `opencode-delivery-contract` prove shared-batch handling, a later token-bearing call, and negative correlation cases. |
| Generic `agent_installed_listener` | Capability is experimental with no receipt evidence. `khala listen` writes JSON to stdout, then durably acknowledges its inbox cursor. | At most the existing connector/inbox fact; not “read.” | Possible only after it adopts the shared batch/token contract; stdout acceptance alone never emits the new fact. |
| MCP tool-result piggyback | `mcp-result-piggyback` owns whether pending messages become model-visible through a tool result. No proof is present on this branch. | **Unproven** until `mcp-piggyback-evidence` passes. | Piggyback appends the same batch format. Returning that tool result does not acknowledge it; the next authenticated Khala call must return its token. |

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
4. Reuse the closed result and refusal vocabulary owned by `mcp-inbox-batch` and `listening-mode-pull`; do not add a receipt-specific acknowledgement result. Refusal or uncertainty before durable receipt insertion produces no receipt. Uncertainty after the immutable token-return fact commits preserves that fact and recovers only the exact-token cursor advance through replay.
5. Generate the stable receipt ID from `['agent', bindingId, generation, releaseId, 'agent_acknowledged']`. The first successful acknowledgement persists a canonical fact whose `observedAt` is its commit time; every field remains immutable, and repeats return that stored fact unchanged even after restart. Changed binding generation cannot acknowledge an earlier binding.
6. Stage compatibility before production: `read-receipt-contract` adds version-specific v1/v2 types and a storage/transport union without widening the existing v1-only UI type, so every commit compiles while stores preserve both versions. `read-receipt-ui` then adopts that union in browser, timeline, review, and presence consumers; neither ticket emits a new version. `read-receipt-recording` may then write v2 acknowledgement receipts, and the harness-specific tickets may advertise the new capability only for proven routes. Persisted v1 rows remain v1 and require no lossy rewrite.

### Agent action and validation

There is no `khala_acknowledge` tool or command. `mcp-inbox-batch` owns the bounded durable peek and opaque batch token; `listening-mode-pull` exposes that same operation as MCP `khala_read` and CLI `khala read`; MCP piggyback appends the same batch format. A supported client automatically returns the pending token on its immediate next authenticated Khala call through the shared client/application-call envelope. Khala then acknowledges the batch and records one content-free `agent_acknowledged` fact for each release in its committed prefix.

Authentication and token validation run before the primary operation. A valid acknowledgement commits independently even if that operation later returns a domain rejection or execution error; both outcomes remain observable. Conversely, an acknowledgement failure must not convert the primary operation into success or invent a receipt.

The token remains binding- and generation-scoped, opaque to callers, and owned by the shared batch contract. It never appears in argv, Khala logs, errors, receipts, or UI. Recipient-local private inbox state may persist it only as required by that contract. Returning it proves a later authenticated Khala interaction after the batch was made available; it does not prove which bytes entered model context or whether the agent understood them.

`mcp-inbox-batch` is the sole owner of pending-token lifecycle for one binding generation and permits one active serialized consumer. Receipt tickets add no host-side token register or duplicate ledger. CLI, MCP, and plugin routes must converge through that owner: concurrent attempts either serialize at the local call boundary or fail closed and retry without replacing or losing the outstanding token. A route that requires multiple direct inbox consumers remains `unproven`.

Every later call is authenticated through the common agent transport. The server derives the binding and generation from a server-held, binding-scoped principal or capability. The trusted connector/local server records the facts only when all checks pass:

| Check | Reason |
|---|---|
| Caller holds the exact binding and generation. | Prevents one agent acknowledging for another or a revoked instance. |
| The token names the exact current, previously issued batch for that binding generation. | Prevents arbitrary receipt creation and cross-batch skip-ahead. |
| Every acknowledged `releaseId` belongs to the committed prefix represented by that batch token. | Prevents an injected message from naming unrelated backlog. |
| The batch was made available to that binding generation. | Absence of a delivery receipt is not evidence of non-delivery, but merely issuing or returning the batch response is not acknowledgement. |
| Receipt insert is unique by stable receipt ID. | Makes repeats and reconnects idempotent. |
| The acknowledgement envelope and resulting receipt contain no message-content bytes; the primary operation keeps its normal request and response payload. | Preserves the content-free receipt boundary without forbidding token return on `khala_send` or another content-bearing Khala operation. |

The JSONL inbox cursor and SQLite receipt ledger are separate durability domains, so the implementation must not claim a cross-store transaction. After authentication and token validation, Khala first inserts the stable receipt facts and a durable projection-outbox entry under the connector ledger's revocation fence, then asks `mcp-inbox-batch` to advance the exact token. If receipt insertion fails, the cursor stays put. If recovery confirms that exact-token cursor advancement did not commit, the same batch replays and the next authorized attempt reuses the immutable receipts before retrying the advance; if advancement committed, the durable cursor prevents replay. Authorization and revocation checks run before this idempotency lookup, so a revoked caller cannot use replay as an oracle. A revocation that serializes before receipt insertion prevents the fact; one that serializes after insertion may leave a truthful receipt and an outstanding batch that no revoked caller can advance. The outbox survives either case and is projected independently; Codex, Claude, and OpenCode own no duplicate suppression.

The agent integration instructions say: make the next Khala call only after handling the delivered batch; do not fetch unseen backlog that the client cannot carry forward correctly. The protocol cannot guarantee compliance, which is why the UI describes the exact later-call attestation.

### UI

- Replace every “Read by the agent” label for `context_consumed` with “Added to agent context.”
- Show “Batch token returned” only for `agent_acknowledged`. Put a keyboard-focusable help control beside it and programmatically associate the status with: “A later Khala call returned the token for this batch. This does not prove the agent acted on the message, the message entered context, was understood, or was completed.”
- Render receipt facts as chips/list items rather than selecting one latest fact. Use one canonical non-semantic order everywhere: ascending receipt-kind code, then timestamp and receipt ID only as same-kind tie-breakers. Never reorder by perceived strength or derive a progress percentage.
- Group all `agent_acknowledged` facts sharing the same non-secret evidence reference into one batch-evidence group, even when the token covered several releases. Each release links to that group; never repeat the status as if it represented separate agent actions.
- Make the owner-authorized channel timeline the durable evidence surface. Its read model joins each `releaseId` to event references and the shared batch evidence group across initial load, reload, and pagination. Review confirmation may link to that durable target but must not be the only place evidence appears.
- For a one-event, one-release batch, show evidence beside that message. Otherwise render the batch/release evidence group before its member rows, give it a stable DOM target and focusable heading, and label each loaded member link “View batch evidence.” Activation scrolls and moves focus to the group; browser back restores the invoking row. If group members span pages, load the target group and its referenced rows before exposing the link. Never replace a missing target with an inferred status.
- After initial hydration, announce each newly observed receipt fact once through a polite live region without moving focus. Initial and replayed facts stay silent.
- In the agent panel, render capability `unknown` as “Batch-token return support not verified,” `unsupported` as “Batch-token return not supported,” and `batch_token_next_call` as “Batch-token return supported.” A supported route with no receipt has no token-return fact—not an error or unread status.
- Model receipt-evidence access separately as `loading`, `ready`, `partial`, or `unavailable`. Keep messages visible in every state; show neutral “Delivery evidence unavailable” copy with retry for partial/unavailable reads, and render “no token-return fact” only after a ready read confirms absence.
- Carry that closed capability state through the connector presence snapshot, browser decoder, channel port/controller, and panel; never derive it from `lastReceipt` or a route label. The current code remains under the literal `features/room` path until `channel-terminology` renames it.

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
| Acknowledgement leaks activity in external channels. | Owner-only internal UI in v1; external disclosure requires a separate explicit policy. |
| Batch receipts look message- or release-specific. | Group every receipt from the same batch evidence reference together, link each member to that group, and suppress per-message ticks. |
| Contract version causes partial deployment failures. | `read-receipt-contract` is a read-compatible consumer-first deployment that emits no new receipt or capability values. Only later tickets produce them after every deployed consumer can preserve them. |
| Concurrent E09 work edits the same capability and tool surfaces. | Sequence on the ticket dependencies below; do not duplicate `listening-mode-contract`, `claude-plugin-hooks`, `opencode-session-bridge`, or `mcp-result-piggyback` composition work. |
| An agent makes no later Khala call. | Show no acknowledgement rather than retrying, nagging, or inferring one. A supported client that does make another call must carry the pending token; omission is a conformance failure and creates no receipt. |

## Non-goals

- Proving attention, comprehension, agreement, correctness, or tool success.
- Treating delivery observations as an ordered progress state.
- Per-token/model-internal telemetry, chain-of-thought, transcript capture, or content-bearing receipts.
- Automatically acknowledging on batch response writes, stdout writes, hook execution, prompt injection, replies, or turn completion.
- Adding a second batch, lease, pull, or acknowledgement API; `mcp-inbox-batch` and `listening-mode-pull` own those shared surfaces.
- External-channel receipt visibility or privacy policy.
- Reworking listening modes, Claude hooks, OpenCode push, or MCP piggyback delivery; this design consumes the exact contracts named below.

## Ticket contracts

### `read-receipt-contract` — Version and preserve receipt contracts

| Field | Contract |
|---|---|
| slug | `read-receipt-contract` |
| title | Version and preserve receipt contracts |
| complexity | `3` |
| scope | Define version-specific `DeliveryReceipt` v1/v2 types with the closed `agent_acknowledged`/`agent` pairing, retain explicit v1 decoding, add a storage/transport union, and update receipt fixtures plus connector storage/dispatch consumers before any producer emits v2. Keep existing UI consumers on the v1 type until `read-receipt-ui`. Preserve shared non-secret evidence references and immutable first-observation fields across restart. |
| out-of-scope | UI labels or presence; producing acknowledgements; changing the batch, pull, or `HarnessCapabilities` owners; harness/plugin setup; external disclosure. |
| files/packages | `packages/contracts/src/delivery/{receipts,README,index}.ts`, `packages/contracts/fixtures/delivery/`, `packages/connector/src/{storage,dispatch}/`, and contract/storage tests. |
| acceptance criteria | v1/v2 receipts decode as explicit versions; the storage/transport union preserves both while the existing UI type remains v1-only; v1 cannot carry the new kind/source; v2 enforces the bidirectional acknowledgement/agent-source invariant; stored v1 rows and embedded dispatch receipts survive restart unchanged; repeated v2 storage returns the original immutable fact; no production producer emits v2 in this ticket; the repository compiles before `read-receipt-ui` lands. |
| tests | Per-version decoder/fixture failures and round trips; invalid acknowledgement/source pairings; mixed-version storage restart; byte-identical v2 duplicate/restart checks. **Wrong implementation must fail:** a v1 or harness-sourced `agent_acknowledged`, an agent-sourced non-acknowledgement, or loss/promotion/regeneration of a stored receipt. |
| blocked-by | None. |
| conflict risk | **Medium** with `local-sqlite-channel-store` on local persistence and with `mcp-inbox-batch` on later receipt production; low with harness tickets because this ticket emits no new receipt. |

### `read-receipt-ui` — Render truthful receipt evidence

| Field | Contract |
|---|---|
| slug | `read-receipt-ui` |
| title | Render truthful receipt evidence |
| complexity | `3` |
| scope | Consume the receipt v1/v2 union and the acknowledgement capability owned by `listening-mode-contract`; consume the durable read model from `read-receipt-observation`; make the channel timeline the durable receipt surface across reload and pagination; update review labels, grouping/navigation, connector presence projection, strict browser decoding, and the channel panel. |
| out-of-scope | Receipt production or storage schema; changing capability ownership; external disclosure; renaming existing code owned by `channel-terminology`. |
| files/packages | Connector presence consumers; channel composition/controller supplied after `channel-terminology`; receipt/capability consumers in `apps/web/src/features/{review,timeline,agent-controls}/`; browser and accessibility tests. |
| acceptance criteria | Legacy capability absence presents as `unknown`; `unknown`, `unsupported`, and `batch_token_next_call` reach the channel panel unchanged; the owner-gated timeline preserves evidence across load, reload, and pagination; loading/ready/partial/unavailable evidence states never turn access failure into a false absence; UI uses the truthful labels, canonical kind ordering, shared batch grouping, accessible help, and evidence navigation above; newly arriving facts announce once after hydration without moving focus; every browser-facing receipt/capability read reuses the owner gate. |
| tests | Strict browser decoding and channel integration for unknown/unsupported/supported-without-receipt; owner-gate refusals for unauthenticated, wrong-owner, wrong-Origin, and invalid-launch-token requests; loading/partial/unavailable/retry states; initial/reload/paginated timeline fixtures; keyboard/name/description/focus-return assertions; silent hydration plus one polite announcement for a later fact; one- and multi-release batch navigation; deterministic ordering of unordered facts. **Wrong implementation must fail:** a failed evidence read rendered as “no token-return fact,” a `completed`-only release rendered acknowledged/read, a later completion hiding context evidence, one batch rendered as separate agent actions, a paginated target disappearing, an initial fact being re-announced, or metadata exposed outside the owner gate. |
| blocked-by | `read-receipt-contract`; `read-receipt-observation`; `listening-mode-contract`; `authenticated-loopback-server`; `local-web-entry`; `channel-terminology`. |
| conflict risk | **High** with `listening-mode-contract` around capability consumers, but that ticket remains the sole `HarnessCapabilities` owner; **medium** with `local-web-entry` and `channel-terminology` on channel composition and the post-rename panel path. |

### `read-receipt-recording` — Record shared batch-token acknowledgements

| Field | Contract |
|---|---|
| slug | `read-receipt-recording` |
| title | Record shared batch-token acknowledgements |
| complexity | `4` |
| scope | Attach content-free receipt insertion to the Khala-side batch-token acknowledgement owned by `mcp-inbox-batch`: when the next authenticated call returns the prior token, persist one stable receipt per included release before advancing the exact JSONL batch token. Recover the cross-store crash window by replay plus stable-ID idempotency. Reuse the call envelope and closed outcomes from `mcp-inbox-batch`/`listening-mode-pull`; keep duplicate handling and restart recovery in Khala. |
| out-of-scope | A second batch, lease, pull, or acknowledgement API; a CLI/MCP acknowledgement command; per-release tokens; host-side deduplication; harness/plugin installation; UI. |
| files/packages | The acknowledgement integration port exposed by `mcp-inbox-batch`, authenticated transport ports from `authenticated-loopback-server` and `local-agent-client`, `packages/connector/src/{storage,dispatch}/` and its public facade, the durable receipt-projection outbox, delivery receipt contracts/fixtures, and focused storage/integration tests. Changes to shared-owner files must be minimal consumer hooks rather than parallel APIs. |
| acceptance criteria | The authenticated principal determines binding and generation; the immediate next Khala call automatically returns an issued token and acknowledges only that batch’s committed prefix; receipt insertion plus its projection-outbox entry commits under the SQLite revocation fence before exact-token cursor advancement; a failed receipt insert leaves the cursor unchanged; recovery distinguishes an uncommitted advance (replay and retry against the original immutable facts) from a committed advance (no replay); all facts from one acknowledgement share one non-secret evidence reference; tokens/content are absent from argv, logs, errors, receipts, and UI; refusal or uncertainty before receipt commit creates no fact, while uncertainty after commit preserves the immutable fact and recovers the cursor only; a valid acknowledgement commits before and independently of the primary operation’s domain result. |
| tests | Shared-call envelope/schema integration; no later call means no receipt; valid next token-bearing call; multi-release shared evidence reference; primary-operation rejection with committed acknowledgement; crashes before receipt commit, between receipt commit and cursor advance, and after cursor advance; byte-identical replay/idempotency; durable projection-outbox recovery; authorization-before-idempotency oracle checks; barrier-controlled acknowledgement/revocation in both orders; unauthenticated, forged-binding, expired, stale, cross-binding, missing/wrong-token refusal with no cursor advance or receipt; secret-redaction assertions; restart redelivery without host deduplication. **Wrong implementation must fail:** returning or writing the batch response alone creates no receipt, cursor advancement before a durable receipt/outbox entry can lose the fact, a committed cursor cannot replay the batch, agent B cannot return agent A’s token, a superseded or revoked generation cannot acknowledge its batch, releases from one batch receive unrelated evidence references, a rejected primary operation rolls back a valid acknowledgement, and a caller-supplied `releaseId` without the issued batch token creates no receipt. |
| blocked-by | `read-receipt-contract`; `mcp-inbox-batch`; `listening-mode-pull`; `authenticated-loopback-server`; `local-agent-client`. |
| conflict risk | **High** with `mcp-inbox-batch` on ordered acknowledgement recovery and `authenticated-loopback-server` on authenticated call metadata; **medium** with `listening-mode-pull` and `local-agent-client` on result propagation. This ticket must not edit their public operation names or create a sibling endpoint. |

### `read-receipt-observation` — Project durable receipt evidence

| Field | Contract |
|---|---|
| slug | `read-receipt-observation` |
| title | Project durable receipt evidence |
| complexity | `3` |
| scope | Drain the durable receipt outbox from `read-receipt-recording` into the owner-local channel read model and a content-free structured agent-log event. Join immutable receipt facts to channel event references and shared batch groups, checkpoint projections idempotently, and resume after restart without depending on inbox replay. |
| out-of-scope | Creating receipts or advancing inbox cursors; UI rendering; live-run orchestration; token/content logging; changing the channel-store owner. |
| files/packages | Connector receipt-outbox projection port; the internal-mode adapter supplied by `local-sqlite-channel-store`; structured agent logging; projection/restart tests. |
| acceptance criteria | Connector receipt storage remains authoritative; its durable outbox retries until the channel read model stores the identical immutable fact and the content-free log observation is recorded; restart resumes from the projection checkpoint even when the inbox cursor already advanced; duplicates compare equal and never regenerate timestamps/evidence; conflicts fail closed; no token or message content reaches the channel projection or logs. |
| tests | Crash before projection, between channel-store write and checkpoint, and after checkpoint; repeated drain/restart; multi-release batch groups; channel join by event reference; structured-log schema and secret canaries. **Wrong implementation must fail:** advancing the inbox cursor and crashing before projection cannot permanently hide a committed receipt, and a duplicate projection cannot create a second fact or different evidence reference. |
| blocked-by | `read-receipt-recording`; `local-sqlite-channel-store`. |
| conflict risk | **High** with `local-sqlite-channel-store` on the owner-local read model; medium with `read-receipt-ui` and `internal-ci-acceptance`, which consume but do not own this projection. |

### `codex-read-receipts` — Prove and wire Codex acknowledgements

| Field | Contract |
|---|---|
| slug | `codex-read-receipts` |
| title | Prove and wire Codex acknowledgements |
| complexity | `2` |
| scope | Prove the user's own user-started interactive Codex CLI consumes the shared batch through `khala_read`, `mcp-result-piggyback`, or the native CLI inbox, preserves its token privately, and returns it on the next authenticated Khala call. Advertise `batch_token_next_call` only for the exact proven CLI route; keep hosted app-server evidence secondary. |
| out-of-scope | A Codex-specific acknowledgement operation; substituting hosted proof for the interactive CLI; synthesizing acknowledgement from `item/started`, queue IDs, context insertion, batch response, replies, or completion; supporting untested Codex versions. |
| files/packages | `packages/harnesses/src/codex/`, `packages/agent-skill/` guidance/capability fixtures bundled by `setup-cli-codex`, and the interactive Codex conformance subject. |
| acceptance criteria | The exact user-started CLI route advertises `batch_token_next_call` only after conformance proves access through `channel-access-journal`/`channel-access-inbox`, shared-batch delivery, authenticated binding identity, next-call token propagation, and correlated receipt recording; absence of any later call remains neutral; queue-only and batch-return-only paths never auto-ack; hosted results are labeled secondary; no Codex-side duplicate ledger is added. |
| tests | Interactive native-inbox, MCP pull, and piggyback capability tests; shared batch/next-call conformance; CLI/MCP contention that serializes or fails closed without token loss; no-later-call, missing-token conformance failure, and duplicate-token behavior. **Wrong implementation must fail:** a hosted-only pass, `item/started`, context insertion, batch response, direct competing inbox consumer, lost/overwritten token, or omitted next-call token cannot establish interactive-CLI support or `agent_acknowledged`. |
| blocked-by | `read-receipt-recording`; `listening-mode-contract`; `listening-mode-pull`; `mcp-inbox-batch`; `mcp-result-piggyback`; `mcp-piggyback-evidence`; `setup-cli-codex`; `channel-access-journal`; `channel-access-inbox`. |
| conflict risk | **Medium** with `listening-mode-contract` in capability fixtures, `listening-mode-pull`/`mcp-result-piggyback` in route composition, and `setup-cli-codex`; low with the Claude/OpenCode receipt tickets. |

### `claude-read-receipts` — Prove and wire Claude acknowledgements

| Field | Contract |
|---|---|
| slug | `claude-read-receipts` |
| title | Prove and wire Claude acknowledgements |
| complexity | `2` |
| scope | In an ordinary user-started interactive Claude CLI, prove the route composed by `claude-session-adapter` and `claude-plugin-hooks` consumes the shared batch, keeps its token private, and returns it on the next authenticated Khala call; advertise only the exact proven version/route pair. |
| out-of-scope | A Claude-specific acknowledgement operation; a restricted-profile delivery gate; a separate installed `/khala` skill; treating hooks, prompt insertion, or the batch response as acknowledgement; OpenCode. |
| files/packages | Claude route output from `claude-session-adapter`/`claude-plugin-hooks`, shared receipt instructions and capability tests bundled into the single plugin by `setup-cli-claude`, and `experiments/internal-mode/read-receipts/claude/`. |
| acceptance criteria | Evidence records the ordinary user-started CLI, exact version/route, untrusted-content framing, batch/token correlation, idle/busy behavior, no later call, missing-token conformance failure, duplicate token, wrong binding/generation/token, and reconnect; retained artifacts use only non-secret correlation labels and redacted presence/equality results, never token bytes or reusable digests; unproven pairs stay `unknown`/`unsupported`; no host-side duplicate ledger is added. |
| tests | Offline plugin/shared-call tests including serialized plugin/MCP contention and fail-closed retry, automated retained-artifact secret scan, and an authorized disposable live run. **Wrong implementation must fail:** a hook firing, prompt entering context, batch result returning, direct competing inbox consumer, lost/overwritten token, or pending-token omission on the next Khala call produces no `agent_acknowledged`; retaining token material fails the artifact scan. |
| blocked-by | `read-receipt-recording`; `claude-session-adapter`; `claude-plugin-hooks`; `listening-mode-contract`; `listening-mode-pull`; `mcp-inbox-batch`; `mcp-result-piggyback`; `setup-cli-claude`; `channel-access-journal`; `channel-access-inbox`. |
| conflict risk | **High** with `claude-session-adapter` and `claude-plugin-hooks` until the interactive route settles; medium with `listening-mode-pull`, `mcp-result-piggyback`, and `setup-cli-claude`; low with the Codex/OpenCode receipt tickets. |

### `opencode-read-receipts` — Prove and wire OpenCode acknowledgements

| Field | Contract |
|---|---|
| slug | `opencode-read-receipts` |
| title | Prove and wire OpenCode acknowledgements |
| complexity | `2` |
| scope | In the user's own user-started OpenCode TUI, prove the route composed by `opencode-session-bridge` and `opencode-delivery-contract` consumes the shared batch, keeps its token private, and returns it on the next authenticated Khala call; advertise only the exact proven version/route pair. |
| out-of-scope | An OpenCode-specific acknowledgement operation; Claude/Codex; hosted proof as a substitute for the TUI; treating prompt/context hooks, message events, or the batch response as acknowledgement; changing `opencode-delivery-contract` push semantics. |
| files/packages | OpenCode route output from `opencode-session-bridge`/`opencode-delivery-contract`, shared receipt instructions and capability tests bundled by `setup-cli-opencode`, and `experiments/internal-mode/read-receipts/opencode/`. |
| acceptance criteria | Evidence records the user-started TUI, exact OpenCode/provider versions and route, batch/token correlation, idle/busy behavior, no later call, missing-token conformance failure, duplicate token, wrong binding/generation/token, and reconnect; retained artifacts use only non-secret correlation labels and redacted presence/equality results, never token bytes or reusable digests; unproven pairs stay `unknown`/`unsupported`; no host-side duplicate ledger is added. |
| tests | Offline plugin/shared-call tests including serialized plugin/MCP contention and fail-closed retry, automated retained-artifact secret scan, and an authorized disposable OpenCode + DeepSeek run. **Wrong implementation must fail:** a context hook, message event, batch result, direct competing inbox consumer, lost/overwritten token, or pending-token omission on the next Khala call produces no `agent_acknowledged`; retaining token material fails the artifact scan. |
| blocked-by | `read-receipt-recording`; `opencode-session-bridge`; `opencode-delivery-contract`; `listening-mode-contract`; `listening-mode-pull`; `mcp-inbox-batch`; `mcp-result-piggyback`; `setup-cli-opencode`; `channel-access-journal`; `channel-access-inbox`. |
| conflict risk | **High** with `opencode-session-bridge` and `opencode-delivery-contract` until the interactive route settles; medium with `listening-mode-pull`, `mcp-result-piggyback`, and `setup-cli-opencode`; low with the Codex/Claude receipt tickets. |

### `read-receipt-acceptance` — Cross-harness receipt acceptance

| Field | Contract |
|---|---|
| slug | `read-receipt-acceptance` |
| title | Cross-harness receipt acceptance |
| complexity | `3` |
| scope | Extend fake-harness CI and internal-mode Playwright coverage to assert the evidence matrix and truthful UI for Codex, Claude, OpenCode, generic, and unsupported routes. Existing Acceptance 2 runs may confirm receipt facts only by reading their agent logs and the channel store. |
| out-of-scope | Creating live test tickets, owning or modifying the live-run script, a separate acceptance Executor/harness, new harness routes, product implementation, assistant-output evidence, or external receipt disclosure. |
| files/packages | `tests/conformance/`, `tests/e2e/`, and internal-mode Playwright specs/fixtures; read-only log/channel-store assertions consumed by the existing Acceptance 2 run, with no new live-run orchestration. |
| acceptance criteria | Fake CI and Playwright cover batch returned without acknowledgement, no later call, valid next-call acknowledgement, missing-token conformance failure, serialized contention/fail-closed retry, duplicate token, cross-binding/stale/revoked refusal, unordered facts, multi-release batches, projection restart, restart redelivery without host deduplication, owner-only receipt/capability visibility, and neutral unsupported UI. Existing live runs report exact capability ceilings from logs and the channel store only. |
| tests | Fake-harness and Playwright tests, including acknowledgement/revocation race barriers, restart between peek and next call, v1/v2 receipt compatibility, and owner-gate denials for unauthenticated, wrong-owner, wrong-Origin, and invalid-launch-token requests; log/store readers against retained existing-run fixtures. **Wrong implementation must fail:** transport write, queue acceptance, batch response, inbox cursor movement, completed turn, hook event, host deduplication, pending-token omission, unauthorized metadata access, assistant prose, or a token for another binding/generation must never satisfy the acknowledgement assertion, and the ticket must not create a new live run. |
| blocked-by | `read-receipt-contract`; `read-receipt-recording`; `read-receipt-observation`; `read-receipt-ui`; `codex-read-receipts`; `claude-read-receipts`; `opencode-read-receipts`; `internal-ci-acceptance`; `authenticated-loopback-server`; `local-web-entry`; `local-sqlite-channel-store`. |
| conflict risk | **High** with `internal-ci-acceptance` in fake CI/Playwright composition; medium with `local-sqlite-channel-store` on read-only fact inspection. It consumes existing live-run outputs and must not edit their orchestration. |

## Recommended order

`read-receipt-contract → read-receipt-recording → read-receipt-observation → read-receipt-ui → (codex-read-receipts ∥ claude-read-receipts ∥ opencode-read-receipts) → read-receipt-acceptance`. Recording remains dormant until a harness ticket returns a token, so the consumer/read-model/UI chain lands before production v2 facts appear. The harness tickets wait for the exact interactive-session, setup, access, and delivery contracts named above. Receipt acceptance reuses `internal-ci-acceptance` and existing live-run logs/channel-store facts; it creates no second live run or harness.
