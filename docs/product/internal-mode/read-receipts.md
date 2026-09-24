# Internal mode: honest agent read receipts

Status: research proposal, 2026-09-24. Scope is I8 under the fixed D1-D12 decisions in [requirements](requirements.md); the implementation seams come from the [reuse survey](survey.md).

## Summary

Khala cannot observe cognition. It can prove that bytes reached a connector, entered a harness queue, or were correlated with model input; an agent can also explicitly attest that it handled a release. The UI should name those facts, never collapse them into “read.”

Add one independent delivery fact, `agent_acknowledged`, emitted only by an explicit agent-side `khala_acknowledge` action for a known `releaseId`. Keep `context_consumed` as harness evidence and relabel it **Added to agent context**. Render **Agent acknowledged** only for the new fact, with help text that it does not prove comprehension, correctness, or completion. No route may synthesize this fact from a write, queue event, cursor advance, hook run, assistant reply, or completed turn.

## Assumptions

| ID | Assumption |
|---|---|
| A1 | The merged `requirements.md` and `survey.md` are the authoritative shared brief; this design does not reopen D1-D12. |
| A2 | I8’s “read” means a truthful agent-side acknowledgement, not proof of attention or semantic understanding. The product label therefore says “acknowledged,” not “read.” |
| A3 | v1 exposes receipt evidence to the owner in the internal-mode UI. Sender-visible external receipts and disclosure preferences belong to Make external (#146). |
| A4 | Receipt granularity stays `releaseId`. A release may contain several events, so the UI must not put per-message checkmarks on a batch unless the release contains exactly that message. |

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
| Codex hosted app-server `0.154.0` | A correlated `userMessage.clientId` yields `context_consumed`; `turn/completed` is separate. Duplicate and out-of-order notifications emit each fact once. | **Added to agent context**; separately **Agent turn completed**. | Possible through the explicit tool after it is installed in the session. Do not auto-upgrade `context_consumed`. |
| Codex native CLI `0.154.0` + local inbox | `codex queue` proves only `harness_queued`; the queue ID is not correlated to the consumed user item. Released bytes are read from the durable CLI inbox. | **Queued at agent session** until stronger evidence arrives. | Possible through the explicit tool. The current listener cursor is not evidence: it advances immediately after stdout accepts a line. |
| Claude Code `2.1.276` evidence route | Hosted streaming observed write, replay, nonce-based consumption, and completion while alive, but failed reconnect/resume; production capability remains `unsupported`. | No production read/ack claim. Evidence may continue to show the narrower experimental facts. | **Unproven.** Claude `2.1.282` is installed locally, but no live plugin/hook acknowledgement proof was run for it. Hooks can deliver context; a hook firing is not agent acknowledgement. |
| OpenCode `1.17.10` plugin | The installed CLI exposes plugin/server/session surfaces. Current official plugin docs describe prompt/context hooks and session/message events, but this repo contains no retained live proof tied to `releaseId`. | **Unproven**; never show context or acknowledgement from plugin registration alone. | **Unproven** until #142 proves an explicit tool call from the target session and negative correlation cases. |
| Generic `agent_installed_listener` | Capability is experimental with no receipt evidence. `khala listen` writes JSON to stdout, then durably acknowledges its inbox cursor. | At most the existing connector/inbox fact; not “read.” | Possible only if the agent explicitly calls the new tool/command after handling the release. |
| MCP tool-result piggyback | #141 owns whether pending messages become model-visible through a tool result. No proof is present on this branch. | **Unproven** until #141 supplies evidence. | Piggyback may carry the acknowledgement tool, but returning a tool result must not acknowledge its embedded releases automatically. |

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
| `agent_acknowledged` (new) | The bound agent explicitly called `khala_acknowledge` for this release after receiving it. | Agent acknowledged | Comprehension, correctness, or task completion |
| `completed` | The correlated harness turn completed. | Agent turn completed | Successful tools, correct result, or acknowledgement |

These remain a set of facts, not a state machine. `outcome_unknown` may coexist with a later stronger observation, and timestamps order observations only.

### Contract shape

1. Define `DeliveryReceipt` v2 with `agent_acknowledged` and source `agent`. Keep v1 and v2 as an explicit discriminated union during rollout; the v2 decoder requires `agent_acknowledged` if and only if `source === 'agent'`, and v1 is never reinterpreted as agent evidence.
2. Define `HarnessCapabilities` v3 with `acknowledgement: 'unknown' | 'unsupported' | 'explicit_agent_tool'`. Keep v2 and v3 decoding during rollout; an absent v2 field presents as unknown, and no producer emits v3 until its route is proven. This describes the exact route, never a boolean promise.
3. Keep the receipt content-free and release-scoped: stable `receiptId`, `releaseId`, `bindingId`, generation, timestamp, source, and evidence reference. Do not add message bodies, model output, or free-text reasons.
4. Add a closed `AcknowledgementResult` v1 tagged union: `recorded` and `already_recorded` carry only the stable `receiptId`; refusals are `unknown_release`, `not_delivered`, `invalid_ack_token`, `stale_binding`, or `binding_revoked`; failures are `storage_failed` or `outcome_unknown` with an opaque reconciliation ID. A failed acknowledgement is an API result, not a false delivery receipt.
5. Generate the stable receipt ID from `['agent', bindingId, generation, releaseId, 'agent_acknowledged']`. Repeats return the same fact; changed binding generation cannot acknowledge an earlier binding.
6. Stage compatibility before production: RR1 teaches every consumer and store to preserve both versions but emits no new versions; RR2 may then write v2 acknowledgement receipts, and RR3-RR5 may advertise v3 only for proven routes. Persisted v1 rows remain v1 and require no lossy rewrite.

### Agent action and validation

Expose the same operation as `khala acknowledge --release <id>` (token on stdin) and MCP tool `khala_acknowledge({releaseId, acknowledgementToken, bindingId?})`. RR2 defines a versioned agent-delivery envelope, separate from the canonical policy release payload, and adds the token only when materializing delivery to the bound agent. Existing delivery-envelope consumers retain v1 decoding; proven acknowledgement routes consume v2. The connector derives the token as fixed-length unpadded base64url over HMAC-SHA-256 of a canonical length-prefixed tuple `['khala-ack-v1', bindingId, generation, releaseId]`, using a persisted owner-only secret with at least 256 bits of entropy. The connector stores neither the token nor a separate digest; it can regenerate the same token after restart. Recipient-local private inboxes may persist the delivered v2 envelope. The token never appears in argv, Khala logs, errors, receipts, or UI. Possession proves that the caller received that delivery envelope; it still does not prove comprehension.

Every acknowledgement request is authenticated through #138’s agent transport. The server derives the binding and generation from a server-held, binding-scoped principal or capability; an optional `bindingId` only selects among bindings already held by that authenticated principal and never grants authority. The trusted connector/local server records the fact only when all checks pass:

| Check | Reason |
|---|---|
| Caller holds the exact binding and generation. | Prevents one agent acknowledging for another or a revoked instance. |
| `releaseId` belongs to that binding generation. | Prevents arbitrary receipt creation. |
| The canonical, length-bounded token matches the regenerated HMAC using fixed-length timing-safe comparison. | Correlates the action to possession of the delivered envelope and prevents an injected message from naming unrelated backlog. |
| The release is committed for that binding generation; `not_delivered` is returned only when the connector positively knows its delivery envelope was never made available. | Allows a generic listener with no receipt evidence to acknowledge; absence of a delivery receipt is not evidence of non-delivery. |
| Receipt insert is unique by stable receipt ID. | Makes repeats and reconnects idempotent. |
| Request and response contain no content bytes. | Preserves the existing content-free receipt boundary. |

The liveness, revocation, release ownership, token verification, authorization-before-idempotency lookup, and unique receipt insert run in one SQLite write transaction under the same revocation fence. A revocation that serializes first must prevent the insert; an acknowledgement that serializes first may commit its fact before revocation.

The agent integration instructions say: acknowledge only after the release is present in the current working context; do not acknowledge unseen backlog; acknowledgement is optional and failure must not block the reply. An instruction cannot guarantee compliance, which is why the UI calls this an attestation.

### UI

- Replace every “Read by the agent” label for `context_consumed` with “Added to agent context.”
- Show “Agent acknowledged” only for `agent_acknowledged`. Put a keyboard-focusable help control beside it and programmatically associate the status with: “The agent signaled that it handled this release. This does not prove understanding or completion.”
- Render receipt facts as chips/list items per release rather than selecting one latest fact. Sort for presentation only; never derive a progress percentage.
- For a one-event release, show evidence beside that message. For a multi-event release, show one release-evidence group and require every member row to link to it with “View release evidence”; never show a per-message checkmark.
- In the agent panel, render capability `unknown` as “Acknowledgement support not verified,” `unsupported` as “Acknowledgement not supported,” and `explicit_agent_tool` with no receipt as no acknowledgement fact—not an error or unread status.
- Carry that closed capability state through the connector presence snapshot, browser decoder, room port/controller, and panel; never derive it from `lastReceipt` or a route label.

### Alternatives and trade-offs

| Alternative | Decision | Trade-off |
|---|---|---|
| Keep calling `context_consumed` “read.” | Reject | Zero implementation cost, but claims cognition from context insertion and excludes fallback routes. |
| Rename `context_consumed` only; add no agent fact. | Viable minimum, not I8 | Most truthful and simplest, but offers no cross-harness agent-side acknowledgement. |
| Infer read from any assistant reply or completed turn. | Reject | A reply may ignore some or all of a batch; `completed` is explicitly independent. |
| Auto-ack in hooks/plugins/listeners. | Reject | Proves hook/process activity, not an agent action; the existing receipt kinds already describe machine delivery. |
| Explicit acknowledgement tool (recommended). | Choose | Comparable across harnesses and easy to validate, but remains a self-attestation and may be omitted. |

## Risks

| Risk | Mitigation |
|---|---|
| Users interpret acknowledgement as comprehension. | Avoid “read,” document the boundary inline, and never use a double-check/read icon without the label. |
| Prompt injection asks an agent to acknowledge unseen IDs. | Require the per-release token carried only in the agent-delivery envelope plus binding-scoped authentication. This proves envelope possession, not attention or comprehension; keep the UI’s attestation caveat. |
| Harness or provider transcripts retain a model-visible token. | Scope the HMAC token to one release and binding generation, keep it out of Khala observability surfaces, and do not promise deletion from third-party transcripts. |
| Acknowledgement leaks activity in external rooms. | Owner-only internal UI in v1; #146 must make external disclosure an explicit policy. |
| Batch receipts look message-specific. | Group by release and suppress per-message ticks for multi-event releases. |
| Contract version causes partial deployment failures. | RR1 is a read-compatible consumer-first deployment that emits no v2/v3 values. Only later tickets produce the new versions after every deployed consumer can preserve them. |
| Concurrent E09 work edits the same capability and tool surfaces. | Sequence on the ticket dependencies below; do not duplicate #139/#140/#141/#142 composition work. |
| Agents omit the optional acknowledgement. | Show no acknowledgement rather than retrying, nagging, or inferring one. Acceptance measures the supported path, not universal compliance. |

## Non-goals

- Proving attention, comprehension, agreement, correctness, or tool success.
- Treating delivery observations as an ordered progress state.
- Per-token/model-internal telemetry, chain-of-thought, transcript capture, or content-bearing receipts.
- Automatically acknowledging on stdout writes, inbox cursor advances, hook execution, prompt injection, replies, or turn completion.
- External-room receipt visibility or privacy policy; #146 owns that decision.
- Reworking listening modes, Claude hooks, OpenCode push, or MCP piggyback delivery; this design consumes their evidence.

## Ticket contracts

### RR1 — Version receipt contracts and truthful UI labels

| Field | Contract |
|---|---|
| complexity | `3` |
| scope | Define receipt v2 and capability v3, retain explicit legacy v1/v2 decoding, and update every store/consumer, fixture, exhaustive label, review and presence UI before any producer emits the new versions. |
| out-of-scope | Producing acknowledgements; harness/plugin setup; external disclosure. |
| files/packages | `packages/contracts/src/delivery/{receipts,harness,README,index}.ts`, `packages/contracts/fixtures/delivery/`, all capability consumers/producers in `packages/{harnesses,agent-skill}/` and `apps/connector/`, `packages/connector/src/{storage,dispatch}/`, contract/conformance tests, the connector presence projection, and every receipt/capability consumer in `apps/web/src/{composition/human,features/{review,room,agent-controls}}/`. |
| acceptance criteria | v1/v2 receipts and v2/v3 capabilities decode as explicit versions; v1 cannot carry the new kind/source; v2 enforces the bidirectional acknowledgement/agent-source invariant; v2 capability absence presents as unknown; stored v1 receipt rows and embedded dispatch receipts survive restart unchanged; no production producer emits v2/v3 in this ticket; all consumers deploy before later producer tickets; the closed capability state reaches the room panel; UI follows the truthful labels, capability copy, accessible help, and release-group navigation above. |
| tests | Per-version decoder/fixture failures and round trips; invalid acknowledgement/source pairings; mixed-version storage restart; exhaustive capability/label compile tests; strict browser decoding and room integration for unknown/unsupported/supported-without-receipt; keyboard/name/description assertions; one- and multi-event navigation; multiple unordered facts. **Wrong implementation must fail:** a v1 or harness-sourced `agent_acknowledged`, an agent-sourced non-acknowledgement, a `completed`-only release rendered acknowledged/read, a later completion hiding context evidence, and loss or promotion of a stored v1 row. |
| blocked-by | Listening-mode research #139; coordinate because both may version `HarnessCapabilities`. |
| conflict risk | **High** with #139 in `packages/contracts/src/delivery/harness.ts`; **medium** with #138/#146 on room composition; low with #140/#142 if they consume rather than redefine the contract. |

### RR2 — Record explicit agent acknowledgements

| Field | Contract |
|---|---|
| complexity | `4` |
| scope | Add a binding-scoped acknowledgement port, owner-secret-derived per-release tokens, a versioned agent-delivery envelope, durable idempotent storage, authenticated local-server endpoint, CLI command, and `khala_acknowledge` MCP tool with a closed tagged result. |
| out-of-scope | Automatic acknowledgement; harness-specific plugin installation; UI. |
| files/packages | Agent-delivery contracts/fixtures in `packages/contracts/src/delivery/`, delivery materialization in `packages/connector/src/dispatch/`, `packages/agent-cli/src/cli/{app,types,inbox}.ts`, `packages/agent-cli/src/mcp/server.ts`, `packages/connector/src/storage/` and its public facade, plus the local server/agent transport path selected by #138. |
| acceptance criteria | #138’s authenticated agent identity determines the binding; the v2 delivery envelope carries a canonical HMAC-derived token without altering the canonical policy payload; v1 delivery remains decodable; token regeneration works after restart; only the exact live generation with the token can acknowledge it; all checks and insert share the revocation transaction; repeats return the original receipt; tokens/content are absent from argv, Khala logs, errors, receipts, and UI; revoked/stale/unknown/bad-token requests produce the tagged results; `outcome_unknown` is not retried automatically and exposes only its reconciliation ID. |
| tests | CLI/MCP/result schemas; v1/v2 delivery codec and private-inbox restart; HMAC domain separation, canonical length/encoding, oversized-input refusal, and timing-safe comparison seam; storage restart/idempotency; generic-listener valid ack with no prior receipt; authorization-before-idempotency oracle checks; barrier-controlled acknowledgement/revocation in both orders; unauthenticated, forged-binding, stale, cross-binding, missing/wrong-token refusal, and secret-redaction assertions. **Wrong implementation must fail:** agent B acknowledging agent A’s `releaseId`, a superseded generation acknowledging its old release, a revoked binding winning the transaction race, and a prompt naming a previously delivered ID without its token must create no receipt. |
| blocked-by | RR1; local server/SQLite design #138. |
| conflict risk | **High** with #138 on endpoint/storage composition and #141 on MCP tool-result composition; medium with #143 setup packaging. |

### RR3 — Wire Codex acknowledgement support

| Field | Contract |
|---|---|
| complexity | `2` |
| scope | Make `khala_acknowledge` available to supported Codex sessions; advertise `explicit_agent_tool`; add session guidance to acknowledge only after the release is in working context. Preserve native `context_consumed` evidence unchanged. |
| out-of-scope | Synthesizing acknowledgement from `item/started`, queue IDs, replies, or completion; supporting untested Codex versions. |
| files/packages | `packages/harnesses/src/codex/`, Codex setup owned by #143, agent guidance/skill assets, conformance subject. |
| acceptance criteria | Exact tested route advertises `explicit_agent_tool` only after a conformance probe verifies tool registration, authenticated binding identity, release-token delivery, and correlated receipt recording; omission remains neutral; queue-only route never auto-acks. |
| tests | Hosted and native-route capability tests; correlated tool-call conformance. **Wrong implementation must fail:** observing `item/started` without a tool call must yield `context_consumed` but no `agent_acknowledged`. |
| blocked-by | RR2; listening modes #139; setup #143; consume #141 only if piggyback is the chosen tool-delivery path. |
| conflict risk | Medium with #139 in capability records and #143 in setup; low with Claude/OpenCode work. |

### RR4 — Prove and wire Claude acknowledgements

| Field | Contract |
|---|---|
| complexity | `2` |
| scope | In a disposable session, prove the Claude plugin route selected by #140 can explicitly invoke the bound acknowledgement tool after correlated delivery; advertise only the exact proven version/route pair. |
| out-of-scope | Promoting Claude native delivery support; treating hooks as acknowledgement; OpenCode. |
| files/packages | Claude plugin output selected by #140, `packages/agent-skill/` shared instructions/capability tests, `experiments/internal-mode/read-receipts/claude/`. |
| acceptance criteria | Evidence records exact version, release/token correlation, idle/busy behavior, omitted and duplicate ack, wrong binding/generation/token, and reconnect; unproven pairs stay `unknown`/`unsupported`. |
| tests | Offline plugin/tool tests plus an authorized disposable live run. **Wrong implementation must fail:** a hook firing or prompt entering context without the explicit tool call must produce no `agent_acknowledged`. |
| blocked-by | RR2; Claude hooks #140; setup #143. |
| conflict risk | **High** with #140 until its plugin API settles; medium with #143 packaging; low with Codex/OpenCode work. |

### RR5 — Prove and wire OpenCode acknowledgements

| Field | Contract |
|---|---|
| complexity | `2` |
| scope | In a disposable session, prove the OpenCode plugin route selected by #142 can explicitly invoke the bound acknowledgement tool after correlated delivery; advertise only the exact proven version/route pair. |
| out-of-scope | Claude/Codex; treating prompt/context hooks or message events as acknowledgement; changing #142’s push semantics. |
| files/packages | OpenCode plugin output selected by #142, `packages/agent-skill/` shared instructions/capability tests, `experiments/internal-mode/read-receipts/opencode/`. |
| acceptance criteria | Evidence records exact OpenCode/provider versions, release/token correlation, idle/busy behavior, omitted and duplicate ack, wrong binding/generation/token, and reconnect; unproven pairs stay `unknown`/`unsupported`. |
| tests | Offline plugin/tool tests plus an authorized disposable OpenCode + DeepSeek run. **Wrong implementation must fail:** a context hook or message event without the explicit tool call must produce no `agent_acknowledged`. |
| blocked-by | RR2; OpenCode/DeepSeek #142; setup #143. |
| conflict risk | **High** with #142 until its plugin API settles; medium with #143 packaging; low with Codex/Claude work. |

### RR6 — Cross-harness receipt acceptance

| Field | Contract |
|---|---|
| complexity | `3` |
| scope | Extend fake-harness CI and live Aiur acceptance to assert the evidence matrix and UI copy for Codex, Claude, OpenCode, and unsupported routes. |
| out-of-scope | New harness routes, product implementation, external receipt disclosure. |
| files/packages | `tests/conformance/`, `tests/e2e/`, internal-mode Playwright specs from #138, and live-ticket scripts/results from #147. |
| acceptance criteria | CI covers no ack, valid ack including the receipt-less generic listener, duplicate ack, cross-binding/stale/revoked refusal, unordered facts, batch releases, restart-before-delivery, and neutral unsupported UI; live runs report exact capability ceilings. |
| tests | Fake harness and Playwright tests plus opt-in live tickets, including acknowledgement/revocation race barriers and v1/v2 delivery compatibility. **Wrong implementation must fail:** transport write, queue acceptance, inbox cursor advance, completed turn, hook event alone, or a token for another binding/generation must never satisfy the acknowledgement assertion. |
| blocked-by | RR1-RR5; local mode #138; live acceptance #147. |
| conflict risk | High with #147 in live scripts and #138 in Playwright composition; low elsewhere if it consumes public ports only. |

## Recommended order

`RR1 → RR2 → (RR3 ∥ RR4 ∥ RR5) → RR6`. RR4 and RR5 wait for #140 and #142 rather than inventing their plugin APIs. RR6 reuses #147’s test-ticket machinery and should not create a second live harness.
