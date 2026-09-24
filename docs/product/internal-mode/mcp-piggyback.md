# MCP tool-result piggyback delivery

Status: research recommendation, 2026-09-24. Source requirements and survey are on `main` (PR #136, with the D2 `steer` terminology update from PR #148).

## Summary

Implement I2 as a package-local postprocessor for every valid Khala MCP `tools/call` result. It appends an oldest-first, bounded prefix of the held binding's already-released inbox records after the tool's normal content, writes one JSON-RPC response, and advances the durable inbox cursor only after that write succeeds.

This is **near-sync only at Khala tool boundaries**. MCP cannot inject after tools owned by another server or wake an idle host. Until a pinned harness is live-proven to invoke a Khala tool at turn boundaries, MCP-only support must be advertised as `async`, not D2 `sync` or `steer`.

The design preserves D3: the inbound bytes are deliberate room messages already released under the binding's manual or automatic policy; outbound chat still requires an explicit `khala_send` call. It does not capture assistant output, transcripts, or arbitrary tool output.

## Findings and evidence

| Finding | Evidence | Status |
|---|---|---|
| MCP currently exposes only `khala_send`; valid tool outcomes return `content` plus the existing send `structuredContent`. | `packages/agent-cli/src/mcp/server.ts` (`handleMessage`, `callTool`, `toolDefinition`) | proven in code |
| Notifications emit no response; initialize, ping, list, invalid params, and unknown tools are protocol paths rather than Khala tool results. | `packages/agent-cli/src/mcp/server.ts`; `packages/agent-cli/src/mcp/server.test.ts` | proven in code/tests |
| The durable inbox deduplicates enqueue by `releaseId`, isolates binding generations, reads FIFO at one persisted cursor, and acknowledges only the current item. | `packages/agent-cli/src/cli/inbox.ts`; `packages/agent-cli/src/cli/inbox.test.ts` | proven in code/tests |
| `khala listen` writes stdout before acknowledging, so a pre-ack crash may replay but must not lose the item. | `packages/agent-cli/src/cli/app.ts`; `packages/agent-cli/README.md` | proven in code |
| The listener lock already enforces one inbox consumer per binding generation. MCP and `khala listen` must reuse it rather than race one cursor. | `packages/agent-cli/src/cli/inbox.ts` (`acquireListener`); lock tests in `inbox.test.ts` | proven in code/tests |
| Released payloads are canonical UTF-8 JSON with ordered event rows containing room, event, author, device, digest, and deliberate body text. | `packages/policy/src/release/codec.ts`; `packages/policy/src/release/README.md` | proven in code/tests |
| Delivery receipts are independent, content-free observations. `context_consumed` and `completed` need harness evidence; an inbox cursor write proves neither. | `packages/contracts/src/delivery/receipts.ts`; `packages/connector/src/storage/ledger.ts`; `packages/harnesses/src/codex/receipts.ts` | proven in code |
| Codex 0.154.0 can configure MCP servers, and official OpenAI documentation says a model uses a tool result to continue. | Local `codex --version` and `codex mcp --help`; [OpenAI MCP server documentation](https://developers.openai.com/plugins/concepts/mcp-server) | CLI/docs only |
| A black-box Codex nonce proof could not run: nested `codex exec --ephemeral` failed while initializing its in-process app-server with `Read-only file system`. | Local command on 2026-09-24 | **unproven** |
| Current MCP, inbox, and CLI behavior remains green independently. | `pnpm --filter @khala/agent-cli exec vitest run --config ../../vitest.config.ts src/mcp/server.test.ts src/cli/inbox.test.ts src/cli/app.test.ts`: 3 files, 31 tests passed | proven locally on Node 24.18.0; repo pins 22.23.2 |

No `CONCEPTS.md` or `docs/solutions/` corpus exists on this branch or `origin/main`; there are no durable learnings to carry forward.

## Assumptions

| Assumption | Consequence if false |
|---|---|
| A canonical release payload is sufficiently model-readable when placed in a clearly delimited text block; no shared decoder is needed for v1. | The format-proof ticket must fail before product implementation, and the design must switch to a strict shared decoder; do not parse the tuple ad hoc in MCP code. |
| Point-in-time `AgentClientPort.status()` revalidation at each Khala tool boundary is sufficient for already-released local inbox bytes. | Instant revocation needs a cross-process lease/cancellation primitive. V1 must disclose that a status change after the final check can allow one already-released response; it must never cross a binding generation or acknowledge after a detected mismatch. |
| A small `khala_check` tool is acceptable so an active MCP-only agent can request a boundary without sending. | Without it, delivery happens only when the agent sends, and initial or one-way messages may wait indefinitely. |
| The existing configured `maxPayloadBytes` remains the hard per-release input bound. | Piggyback needs a separate ingress limit or an oversized-release continuation protocol. |

## Design

### Result contract

| Surface | Decision |
|---|---|
| Eligible responses | Every syntactically valid Khala `tools/call` result, including tool-level `isError` results. |
| Ineligible responses | Notifications, JSON-RPC errors, invalid params, unknown tools, `initialize`, `ping`, and `tools/list`; these never consume inbox records. |
| Primary result | Preserve the tool's existing content and `structuredContent` exactly. The primary content stays first. |
| Piggyback content | Append one clearly delimited text content block per release. Include `releaseId` and `payloadDigest`, then the exact canonical UTF-8 release JSON. Label peer text as untrusted room-message data, never instructions or authority. |
| Check boundary | Add `khala_check` with no arguments and a small primary result. It uses the same postprocessor; it is not a second read path. |
| Empty inbox | Preserve the current response shape byte-for-byte; add no empty wrapper. |

The exact payload is preferred over a package-local tuple parser: it retains provenance and ordering, is already human/model-readable JSON, and avoids a new cross-package codec dependency. A future structured representation must come from a strict shared contract decoder, not duplicated MCP parsing logic.

### Ordering and bounds

| Rule | Contract |
|---|---|
| Ordering | FIFO by durable inbox cursor; tool content first, then whole releases oldest to newest. New arrivals after selection wait for the next Khala tool boundary. |
| Count soft limit | At most **8 releases** per result. |
| Byte soft limit | At most **128 KiB** for the complete serialized JSON-RPC response line, measured as UTF-8 after all JSON escaping. A named harness is compatible only after its pinned proof accepts the escaping-heavy boundary cases. |
| Oversized head | Never truncate or skip it. Include the oldest release alone even when it exceeds the soft limit. |
| Hard limit | One existing valid release plus deterministic MCP/JSON-RPC envelope overhead; the release itself is already bounded by `maxPayloadBytes`. Reject startup if composition cannot calculate and enforce this bound. |
| Remainder | Leave it pending at the same durable cursor for later Khala tool calls. |

The oversized-head exception prevents permanent starvation while keeping the hard bound tied to an existing validated capability. Counting final serialized bytes matters because embedding JSON as text re-escapes quotes, backslashes, and control characters.

### Acknowledgement and deduplication

1. Acquire the existing per-binding-generation listener lock for the MCP server lifetime; `khala listen` and a second MCP consumer receive `listener_busy`.
2. Resolve and fence the held binding/generation before opening the inbox. Revalidate the same connected binding and generation immediately before each batch selection and again before the response write; a mismatch returns no piggyback content and acknowledges nothing.
3. Peek the maximal ordered whole-prefix under the count/byte rules without moving the cursor.
4. Compute the primary tool outcome, append the selected releases, and write one JSON-RPC response line.
5. After the writable callback succeeds, revalidate once more and atomically acknowledge through the final selected release. A write failure or detected lifecycle mismatch acknowledges nothing.
6. If the write succeeded but cursor persistence failed, replay is allowed. Stable `releaseId` and digest identify the duplicate; loss or skip-ahead is never allowed.

This is at-least-once handoff to the MCP transport, not exactly-once model consumption. Point-in-time status checks cannot close the final check-to-write race: a concurrent revoke may allow one response containing bytes that were already released to that generation, but it cannot redirect them to a new generation. Instant cancellation requires a separate lease primitive. The cursor acknowledgement must not synthesize `context_consumed`, `completed`, or an I8 read receipt. Existing route receipts remain unchanged.

### D2 and D3 behavior

| Requirement | Result |
|---|---|
| D2 `async` | Supported: the agent calls `khala_check` when it chooses. |
| D2 `sync` | Unproven for MCP-only harnesses. It needs a pinned live proof that the host reliably invokes a Khala tool at the next turn/tool boundary. |
| D2 `steer` | Unsupported: MCP tool results cannot inject at the next unrelated tool boundary, wake an idle host, or hard-abort an active tool. |
| D3 deliberate send | Preserved: only explicit `khala_send` publishes an agent message. Incoming releases are never automatically forwarded. |
| Trust boundary | Only already-released inbox bytes may appear. Pending-review content, submitted send bodies, logs, errors, status, and diagnostics remain content-free. |

## Trade-offs

| Choice | Benefit | Cost |
|---|---|---|
| Reuse one durable inbox/cursor | No parallel queue, restart semantics, or new dedup domain. | MCP and `khala listen` are mutually exclusive consumers. |
| Write-then-ack | Prevents loss on output failure. | Post-write ack failure can replay. |
| Exact canonical release JSON | Preserves digest-bound provenance and keeps changes package-local. | Less ergonomic than normalized message objects. |
| Soft cap plus one-head exception | Bounded normal results without head-of-line starvation. | A single maximum-size release can produce a larger result. |
| Separate `khala_check` primitive | Makes MCP-only polling explicit and composable. | Still cannot provide idle wake or arbitrary-tool injection. |

## Risks

| Risk | Mitigation |
|---|---|
| A host treats peer text as instructions. | Delimit and type it as untrusted room-message data; keep D3 guidance in tool descriptions and setup prompts. |
| Cursor advances before bytes leave the server. | Batch peek plus atomic ack-through only after the writable callback; failure-injection tests. |
| Concurrent consumers reorder or skip. | Reuse the listener lock for the MCP process lifetime. |
| Long-lived MCP process drains an old generation after rebind. | Revalidate binding ID/generation before selection, before write, and before acknowledgement; fail closed on mismatch. Document the remaining check-to-write race for already-released bytes. Dynamic rotation is out of scope. |
| Capability UI overclaims `sync`. | Gate advertising on pinned live evidence; default MCP-only route to `async`. |
| Escaping expands the response beyond a payload-only estimate. | Measure the complete serialized UTF-8 line and test escaping-heavy/multibyte bodies. |
| Unreleased plaintext leaks through an error path. | Canary tests across success, refused, protocol-error, status, log, and diagnostic surfaces. |
| A released peer message prompt-injects a tool-capable host. | Treat labeling as defense in depth. The E09 setup/capability ticket must default unattended MCP-only participants to a read-only/sandboxed scratch workdir and require explicit operator opt-in for repository writes before advertising support. |

## Non-goals

- Product-code implementation in this research PR.
- Piggybacking on tools owned by other MCP servers.
- Idle wake, hard interrupt, or claiming `steer`/`sync` without live proof.
- Exactly-once model consumption or I8 read receipts.
- Capturing or forwarding assistant output, transcripts, shell output, or arbitrary tool results.
- Replacing native Claude hooks, Codex queue/app-server delivery, or OpenCode plugin push.
- Adding a shared release decoder solely for prettier MCP output.

## Ticket contracts

### Contract 1 — Pinned MCP payload-format proof

| Field | Contract |
|---|---|
| Slug | `mcp-piggyback-format-proof` |
| Complexity | `complexity:2` |
| Scope | Use a minimal MCP fixture and Codex 0.154.0 to test the proposed delimited canonical release JSON before product implementation. Exercise ordered bodies, room and author provenance, stable `releaseId`/digest, replay identity, eight-release results, and an escaping-heavy maximum release. |
| Out of scope | Durable inbox integration, product MCP changes, capability-registry edits, claiming idle wake or arbitrary-tool injection. |
| Files/packages | `experiments/internal-mode/mcp-piggyback/`, `docs/evidence/mcp-piggyback-format.md`; no product package changes. |
| Acceptance criteria | The pinned harness identifies room, author, ordered body text, and duplicate identity from content absent from its prompt; it accepts the 128 KiB soft boundary and one maximum-size oversized head without truncation; exact commands, versions, outputs, and negative claims are recorded. Failure blocks `mcp-result-piggyback` and requires a design amendment to use a strict shared decoder or a smaller evidenced bound. |
| Tests | Automate the fixture transcript and evidence verifier. **Wrong implementation test:** replace the canonical payload with a static nonce-only result; verification fails because transport visibility does not prove provenance, ordering, duplicate recognition, or boundary-size usability. |
| Blocked-by | None. |
| Conflict risk | Low. It is isolated under `experiments/` and evidence docs, but its result constrains I4 setup/capability advertising and any other E09 MCP response-format research. |

### Contract 2 — Bounded durable inbox batches

| Field | Contract |
|---|---|
| Slug | `mcp-inbox-batch` |
| Complexity | `complexity:2` |
| Scope | Extend the agent CLI inbox with a non-mutating ordered read of at most eight whole records and atomic acknowledge-through operation; reuse the single-consumer lock and generation-isolated directory. MCP serialization owns byte selection. |
| Out of scope | MCP serialization, new receipts, shared release decoding, compaction, multiple simultaneous consumers. |
| Files/packages | `packages/agent-cli/src/cli/inbox.ts`, `packages/agent-cli/src/cli/inbox.test.ts`; `@khala/agent-cli` only. |
| Acceptance criteria | FIFO whole-record prefix by count; no cursor movement during read; acknowledge-through accepts only the exact current prefix; duplicate enqueue remains one record; restart preserves cursor; lock excludes a second listener/MCP consumer; corrupt or invalid UTF-8 record fails closed without acknowledgement. |
| Tests | Add unit tests for the zero/eight-record count boundaries, arrival after selection, write-equivalent failure before ack, ack persistence failure/restart replay, skip-ahead refusal, duplicate enqueue, and concurrent lock exclusion. **Wrong implementation test:** peek a batch, simulate response failure, reopen the inbox, and require the same first `releaseId`; an implementation that acknowledged while collecting the batch fails. |
| Blocked-by | None. |
| Conflict risk | Low. Shares inbox files with native-listener/retention work; does not touch MCP, setup, receipt contracts, or other E09 harness integrations. |

### Contract 3 — MCP result postprocessor

| Field | Contract |
|---|---|
| Slug | `mcp-result-piggyback` |
| Complexity | `complexity:3` |
| Scope | Wire held binding/generation and the existing inbox into `mcp-serve`; acquire the listener lock; add `khala_check`; postprocess every valid Khala tool result with the bounded FIFO release prefix; acknowledge only after the complete response write. |
| Out of scope | Other MCP servers, idle wake, dynamic rebind rotation, new receipt kinds, shared release decoder, setup automation, capability advertising. |
| Files/packages | `packages/agent-cli/src/mcp/server.ts`, `packages/agent-cli/src/mcp/server.test.ts`, `packages/agent-cli/src/cli/app.ts`, `packages/agent-cli/src/cli/app.test.ts`, `packages/agent-cli/src/cli/main.ts`, `packages/agent-cli/README.md`; `@khala/agent-cli` only. |
| Acceptance criteria | Existing primary results remain first and unchanged; released payloads append on success and tool-level `isError`; empty inbox preserves exact old shape; non-tool/protocol paths consume nothing; FIFO/count/serialized-byte/oversized-head rules hold; startup calculates and enforces one maximum valid release plus deterministic JSON-RPC overhead; submitted send body is not echoed; pending-review canary never appears; status is revalidated before selection/write/ack and mismatches fail closed; no `context_consumed`, `completed`, or read receipt is emitted; D3 deliberate-send language is present. |
| Tests | MCP+real-inbox integration tests for success, refused send, `khala_check`, no pending data, invalid params/unknown tool/notification/list/ping, output failure and replay, post-write ack failure and duplicate, multiple boundaries, escaped/multibyte maximums, unenforceable hard-bound startup refusal, lifecycle mismatch at each revalidation point, listener contention, unreleased secret canary, and abort/EOF lock release. **Wrong implementation test:** queue one release, return a refused `khala_send`, and require the release in that tool result while the same release remains pending when the JSON-RPC write is injected to fail. |
| Blocked-by | `mcp-piggyback-format-proof`; `mcp-inbox-batch`. |
| Conflict risk | Medium. `packages/agent-cli/src/mcp/server.ts` and README may overlap I4 setup, I5 tool additions, or other E09 MCP research. Land the generic postprocessor before adding more tools; do not let setup own delivery semantics. |

### Contract 4 — Pinned end-to-end MCP delivery evidence

| Field | Contract |
|---|---|
| Slug | `mcp-piggyback-evidence` |
| Complexity | `complexity:2` |
| Scope | Run a real MCP client and Codex 0.154.0 proof with a unique queued message; prove its room, author, and body enter the same agent context only after a Khala tool call; require an explicit `khala_send` response; record exact commands, inventory, outputs, and negative claims. Produce evidence for the setup/capability owner to consume. |
| Out of scope | Capability-registry edits, promoting untested Codex versions, proving Claude/OpenCode, idle wake, arbitrary-tool injection, or product setup UX. |
| Files/packages | `experiments/internal-mode/mcp-piggyback/`, `docs/evidence/mcp-piggyback.md`; no capability-registry or receipt schema changes. |
| Acceptance criteria | A clean pinned run proves queued room/author/body context absent from the prompt and a deliberate peer-directed response via `khala_send`; a replay run proves stable duplicate identity; boundary cases from the format proof remain usable end to end; evidence states that idle wake and non-Khala tool boundaries remain unproven; no transcript or assistant-output capture is used. |
| Tests | Automate the real-inbox protocol fixture and evidence verifier. **Wrong implementation test:** replace the queued inbox message with a static tool fixture; verification fails because it does not prove durable Khala delivery or deliberate reply behavior. |
| Blocked-by | `mcp-result-piggyback`. |
| Conflict risk | Medium with I4 setup and D2 capability-matrix research. This ticket owns only evidence; those areas consume it, enforce the sandbox/read-only default, and own advertised support. |

## Recommended sequence

`mcp-piggyback-format-proof` and `mcp-inbox-batch` can run in parallel → `mcp-result-piggyback` → `mcp-piggyback-evidence` → setup/capability advertising.

The product ticket can land without claiming `sync`. The end-to-end evidence is the only input that may improve the advertised MCP-only listening mode for a named harness/version; the setup/capability owner makes that advertising change and must also enforce the safe-workspace default.
