# MCP tool-result piggyback delivery

Status: research recommendation, 2026-09-24. Source requirements and survey are on `main` (PR #136, with the D2 `steer` terminology update from PR #148).

## Summary

Implement I2 as a package-local postprocessor for every valid Khala MCP `tools/call` result. It delegates to the single `listening-mode-pull` operation, appends that operation's oldest-first tokenized batch after the tool's normal content, and leaves acknowledgement to the agent's next Khala call. It does not introduce another read, batch, lease, or cursor API.

This is **near-sync only at Khala tool boundaries**. MCP cannot inject after tools owned by another server or wake an idle host. MCP-only `async` and `sync` remain `unproven`; `async` specifically requires `mcp-piggyback-evidence`, while `steer` remains unsupported by this route. Restart safety comes from Khala's durable batch token and next-call acknowledgement, never receiver-side deduplication.

The design preserves D3: the inbound bytes are deliberate channel messages already released under the binding's manual or automatic policy; sending an outbound channel message still requires an explicit `khala_send` call. It does not capture assistant output, transcripts, or arbitrary tool output.

## Findings and evidence

| Finding | Evidence | Status |
|---|---|---|
| MCP currently exposes only `khala_send`; valid tool outcomes return `content` plus the existing send `structuredContent`. | `packages/agent-cli/src/mcp/server.ts` (`handleMessage`, `callTool`, `toolDefinition`) | proven in code |
| Notifications emit no response; initialize, ping, list, invalid params, and unknown tools are protocol paths rather than Khala tool results. | `packages/agent-cli/src/mcp/server.ts`; `packages/agent-cli/src/mcp/server.test.ts` | proven in code/tests |
| The durable inbox deduplicates enqueue by `releaseId`, isolates binding generations, reads FIFO at one persisted cursor, and acknowledges only the current item. | `packages/agent-cli/src/cli/inbox.ts`; `packages/agent-cli/src/cli/inbox.test.ts` | proven in code/tests |
| `khala listen` writes stdout before acknowledging, so a pre-ack crash may replay but must not lose the item. | `packages/agent-cli/src/cli/app.ts`; `packages/agent-cli/README.md` | proven in code |
| The listener lock already enforces one inbox consumer per binding generation. MCP and `khala listen` must reuse it rather than race one cursor. | `packages/agent-cli/src/cli/inbox.ts` (`acquireListener`); lock tests in `inbox.test.ts` | proven in code/tests |
| Released payloads are canonical UTF-8 JSON with ordered event rows containing channel identity (the internal `roomId`), event, author, device, digest, and deliberate body text. | `packages/policy/src/release/codec.ts`; `packages/policy/src/release/README.md` | proven in code/tests |
| Delivery receipts are independent, content-free observations. `context_consumed` and `completed` need harness evidence; an inbox cursor write proves neither. | `packages/contracts/src/delivery/receipts.ts`; `packages/connector/src/storage/ledger.ts`; `packages/harnesses/src/codex/receipts.ts` | proven in code |
| E09 has one pull operation and one tokenized inbox batch API. MCP uses `khala_read`; the agent's next Khala call acknowledges the prior batch on Khala's side. | [Shared E09 decisions recorded by the CODEOWNER](https://github.com/aiur-team/khala/pull/153#issuecomment-5822366740) | fixed operator decision |
| Codex 0.154.0 can configure MCP servers, and official OpenAI documentation says a model uses a tool result to continue. | Local `codex --version` and `codex mcp --help`; [OpenAI MCP server documentation](https://developers.openai.com/plugins/concepts/mcp-server) | CLI/docs only |
| A black-box Codex nonce proof could not run: nested `codex exec --ephemeral` failed while initializing its in-process app-server with `Read-only file system`. | Local command on 2026-09-24 | **unproven** |
| Current MCP, inbox, and CLI behavior remains green independently. | `pnpm --filter @khala/agent-cli exec vitest run --config ../../vitest.config.ts src/mcp/server.test.ts src/cli/inbox.test.ts src/cli/app.test.ts`: 3 files, 31 tests passed | proven locally on Node 24.18.0; repo pins 22.23.2 |

No `CONCEPTS.md` or `docs/solutions/` corpus exists on this branch or `origin/main`; there are no durable learnings to carry forward.

## Assumptions

| Assumption | Consequence if false |
|---|---|
| A canonical release payload is sufficiently model-readable when placed in a clearly delimited text block; no shared decoder is needed for v1. | The format-proof ticket must fail before product implementation, and the design must switch to a strict shared decoder; do not parse the tuple ad hoc in MCP code. |
| Point-in-time `AgentClientPort.status()` revalidation at each Khala tool boundary is sufficient for already-released local inbox bytes. | Instant revocation needs a cross-process lease/cancellation primitive. V1 must disclose that a status change after the final check can allow one already-released response; it must never cross a binding generation or acknowledge after a detected mismatch. |
| The shared `khala_read` operation can expose the same batch through MCP without a second postprocessor read. | If its composition cannot share one selection, the implementation tickets must change the internal seam rather than add another polling tool or batch API. |
| The existing configured `maxPayloadBytes` remains the hard per-release input bound. | Piggyback needs a separate ingress limit or an oversized-release continuation protocol. |

## Design

### Result contract

| Surface | Decision |
|---|---|
| Eligible responses | Every syntactically valid Khala `tools/call` result, including tool-level `isError` results. |
| Ineligible responses | Notifications, JSON-RPC errors, invalid params, unknown tools, `initialize`, `ping`, and `tools/list`; these never consume inbox records. |
| Primary result | Preserve the tool's existing content and `structuredContent` exactly. The primary content stays first. |
| Piggyback content | Append one clearly delimited channel message batch after the primary result. Include the opaque batch token once, then one text block per release with `releaseId`, `payloadDigest`, and the exact canonical UTF-8 release JSON. Label peer text as untrusted channel message data, never instructions or authority. |
| Acknowledgement carrier | Add one shared optional `ackBatchToken` control argument to every Khala MCP tool schema. The wrapper validates and removes it before tool-specific argument handling; tool implementations never interpret it. |
| Pull boundary | Reuse `listening-mode-pull`'s `khala_read` operation and batch format. When `khala_read` is the primary tool, compose its already-selected batch once; never read or append it twice. |
| Empty inbox | Preserve the current response shape byte-for-byte; add no empty wrapper. |

The exact payload is preferred over a package-local tuple parser: it retains provenance and ordering, is already human/model-readable JSON, and avoids a new cross-package codec dependency. A future structured representation must come from a strict shared contract decoder, not duplicated MCP parsing logic.

### Ordering and bounds

| Rule | Contract |
|---|---|
| Ordering | FIFO by durable inbox cursor; tool content first, then whole releases oldest to newest. New arrivals after selection wait for the next Khala tool boundary. |
| Count soft limit | At most **8 releases** per result. |
| Byte soft limit | When first staging a batch, at most **128 KiB** for the complete serialized JSON-RPC response line, measured as UTF-8 after all JSON escaping. An already-outstanding batch replays unchanged even if the next primary result would cross this soft limit. A named harness is compatible only after its pinned proof accepts the escaping-heavy boundary cases. |
| Oversized head | Never truncate or skip it. Include the oldest release alone even when it exceeds the soft limit. |
| Hard limit | One existing valid release plus deterministic MCP/JSON-RPC envelope overhead; the release itself is already bounded by `maxPayloadBytes`. Reject startup if composition cannot calculate and enforce this bound. |
| Remainder | Leave it pending at the same durable cursor for later Khala tool calls. |

The oversized-head exception prevents permanent starvation while keeping the hard bound tied to an existing validated capability. Counting final serialized bytes matters because embedding JSON as text re-escapes quotes, backslashes, and control characters.

### Acknowledgement and deduplication

1. Acquire the existing per-binding-generation listener lock for the MCP server lifetime; `khala listen` and a second MCP consumer receive `listener_busy`.
2. Resolve and fence the held binding/generation before opening the inbox. Revalidate the same connected binding and generation before acknowledgement, selection, and response composition; a mismatch returns no piggyback content and acknowledges nothing.
3. Parse the shared optional `ackBatchToken` before tool-specific validation. Only an exact match for the durable outstanding token and current binding generation advances the cursor. An absent, stale, foreign, partial, or skip-ahead token acknowledges nothing and leaves the outstanding batch available for replay.
4. Compute the primary tool outcome and its remaining serialized byte budget, then invoke the shared pull operation once. If a batch remains outstanding, return its identical token and bytes even when the new primary result crosses the soft limit. Otherwise atomically stage the maximal ordered whole-prefix and its opaque generation-fenced token in durable Khala state before composing response bytes; staging does not move the cursor.
5. Append that exact batch format to the primary outcome and write one JSON-RPC response line. A failed write leaves the staged batch outstanding, so a retry or restart returns the same token and bytes.
6. Serialize Khala tool calls on one MCP connection across acknowledgement, selection, staging, and response write. The next call that echoes the exact token performs step 3 before selecting another batch; restart recovers the outstanding state without asking Codex or another receiving host to remember release IDs or deduplicate content.

The echoed batch token is the acknowledgement boundary; MCP response completion is not. At most one batch is outstanding for a binding generation. Calls without its exact token receive the same outstanding batch; the next call carrying it acknowledges and advances. The implementation proof must demonstrate these transitions under restart, pipelined calls, and injected persistence/write failures without relying on receiver release-ID memory.

Point-in-time status checks cannot close the final check-to-write race: a concurrent revoke may allow one response containing bytes already released to that generation, but it cannot redirect them to a new generation. Instant cancellation requires a separate lease primitive. Batch acknowledgement must not synthesize `context_consumed`, `completed`, or an I8 read receipt. Existing route receipts remain unchanged.

### D2 and D3 behavior

| Requirement | Result |
|---|---|
| D2 `async` | **Unproven** until `mcp-piggyback-evidence` shows a pinned MCP host can call `khala_read`, consume the shared batch, and complete the next-call acknowledgement cycle. |
| D2 `sync` | Unproven for MCP-only harnesses. It needs a pinned live proof that the host reliably invokes a Khala tool at the next turn/tool boundary. |
| D2 `steer` | Unsupported: MCP tool results cannot inject at the next unrelated tool boundary, wake an idle host, or hard-abort an active tool. |
| Restart acceptance | Owned by Khala's durable batch token: a restart recovers the one outstanding batch, and the next Khala call acknowledges through its token before advancing. The receiving host does no deduplication. |
| D3 deliberate send | Preserved: only explicit `khala_send` publishes an agent message. Incoming releases are never automatically forwarded. |
| Trust boundary | Only already-released inbox bytes may appear. Pending-review content, submitted send bodies, logs, errors, status, and diagnostics remain content-free. |

## Trade-offs

| Choice | Benefit | Cost |
|---|---|---|
| Reuse one durable inbox/cursor | No parallel queue, restart semantics, or new dedup domain. | MCP and `khala listen` are mutually exclusive consumers. |
| Next-call token acknowledgement | Keeps delivery and cursor movement on one Khala-owned protocol and removes receiver deduplication. | Holds one batch outstanding until another Khala call and requires durable token recovery. |
| Exact canonical release JSON | Preserves digest-bound provenance and keeps changes package-local. | Less ergonomic than normalized message objects. |
| Soft cap plus one-head exception | Bounded normal results without head-of-line starvation. | A single maximum-size release can produce a larger result. |
| Reuse `khala_read` | Keeps one pull operation and one batch format across CLI, MCP, Claude, and OpenCode. | Couples piggyback delivery to `listening-mode-pull`'s contract and landing order. |

## Risks

| Risk | Mitigation |
|---|---|
| A host treats peer text as instructions. | Delimit and type it as untrusted channel message data; keep D3 guidance in tool descriptions and setup prompts. |
| A token is acknowledged on the response that first carries it. | Require an exact `ackBatchToken` echo on a later Khala call; failure-injection tests must prove the first response never advances its own batch. |
| Concurrent calls cross the acknowledgement boundary. | Serialize each MCP connection through token validation, selection, durable staging, and response write; block a second call until the first write completes. |
| Concurrent consumers reorder or skip. | Reuse the listener lock for the MCP process lifetime. |
| Long-lived MCP process drains an old generation after rebind. | Revalidate binding ID/generation before selection, before write, and before acknowledgement; fail closed on mismatch. Document the remaining check-to-write race for already-released bytes. Dynamic rotation is out of scope. |
| Capability UI overclaims any MCP listening mode. | Keep MCP-only `async` unproven until `mcp-piggyback-evidence`; this route provides no `sync` or `steer` claim. |
| Restart loses or changes the outstanding batch. | Atomically persist the exact batch and token before response emission; replay identical bytes until a later call echoes the token. Proofs must run without receiver-side release-ID memory. |
| Escaping expands the response beyond a payload-only estimate. | Measure the complete serialized UTF-8 line and test escaping-heavy/multibyte bodies. |
| Unreleased plaintext leaks through an error path. | Canary tests across success, refused, protocol-error, status, log, and diagnostic surfaces. |
| A released peer message prompt-injects a tool-capable host. | Treat labeling as defense in depth. The E09 setup/capability ticket must default unattended MCP-only participants to a read-only/sandboxed scratch workdir and require explicit operator opt-in for repository writes before advertising support. |

## Non-goals

- Product-code implementation in this research PR.
- Piggybacking on tools owned by other MCP servers.
- Idle wake, hard interrupt, or claiming `steer`/`sync` without live proof.
- New Khala receipt semantics or receiver-side duplicate suppression; restart safety belongs to the shared Khala batch-token protocol.
- Capturing or forwarding assistant output, transcripts, shell output, or arbitrary tool results.
- Replacing native Claude hooks, Codex queue/app-server delivery, or OpenCode plugin push.
- Adding a shared release decoder solely for prettier MCP output.
- Adding a second polling tool, pull operation, or inbox batch/lease API.

## Ticket contracts

### Contract 1 — Pinned MCP payload-format proof

| Field | Contract |
|---|---|
| Title | Prove the shared MCP batch format |
| Slug | `mcp-piggyback-format-proof` |
| Complexity | `complexity:2` |
| Scope | Use a minimal MCP fixture and Codex 0.154.0 to test `listening-mode-pull`'s proposed tokenized batch format before product implementation. Exercise ordered bodies, channel and author provenance, opaque batch token handling, eight-release results, and an escaping-heavy maximum release. Prove the host needs no release-ID memory or duplicate filter. |
| Out of scope | Durable inbox integration, product MCP changes, capability-registry edits, a second pull operation, receiver-side deduplication, idle wake, or arbitrary-tool injection. |
| Files/packages | `experiments/internal-mode/mcp-piggyback/`, `docs/evidence/mcp-piggyback-format.md`; no product package changes. |
| Acceptance criteria | The pinned harness identifies channel, author, ordered body text, and the batch token from content absent from its prompt; it accepts the 128 KiB soft boundary and one maximum-size oversized head without truncation; a later Khala call echoes the opaque token as `ackBatchToken` without Codex tracking release IDs; exact commands, versions, outputs, and negative claims are recorded. Failure blocks `mcp-result-piggyback` and requires a design amendment to the shared format or a smaller evidenced bound. |
| Tests | Automate the fixture transcript and evidence verifier. **Wrong implementation test:** make success depend on Codex remembering and filtering a repeated `releaseId`; verification fails because the receiver has no deduplication state and Khala must own acknowledgement through the batch token. |
| Blocked-by | `listening-mode-contract`. |
| Conflict risk | Low. It is isolated under `experiments/` and evidence docs, but its result constrains I4 setup/capability advertising and any other E09 MCP response-format research. |

### Contract 2 — Bounded durable inbox batches

| Field | Contract |
|---|---|
| Title | Add durable tokenized inbox batches |
| Slug | `mcp-inbox-batch` |
| Complexity | `complexity:2` |
| Scope | Extend the agent CLI inbox with the one bounded durable batch API: accept the caller's byte budget, atomically stage the maximal prefix of at most eight whole records plus an opaque generation-fenced batch token, retain one outstanding batch across restart, replay it identically until acknowledgement, and advance only for that exact token. Reuse the single-consumer lock and generation-isolated directory; callers serialize the returned shared batch format rather than selecting another prefix. |
| Out of scope | MCP serialization, another batch or lease API, receiver-side deduplication, new receipts, shared release decoding, compaction, multiple simultaneous consumers. |
| Files/packages | `packages/agent-cli/src/cli/inbox.ts`, `packages/agent-cli/src/cli/inbox.test.ts`; `@khala/agent-cli` only. |
| Acceptance criteria | FIFO whole-record prefix by count and caller-supplied byte budget; exact batch and token are durable before response emission; no cursor movement during staging or the response carrying a token; absent or invalid acknowledgement replays identical bytes; only the exact outstanding token for the current generation advances; restart preserves token, batch, and cursor; duplicate enqueue remains one record; lock excludes a second consumer; corrupt or invalid UTF-8 fails closed. |
| Tests | Add unit tests for zero/eight-record and byte-budget boundaries, one oversized head, atomic staging, stable token recovery, exact-token acknowledgement, absent-token replay, arrival after staging, response failure, stale/foreign/partial/skip-ahead refusal, duplicate enqueue, and lock exclusion. **Wrong implementation test:** return a tokenized batch and advance its cursor before a later call echoes the token; the test fails because the first response must leave that batch outstanding. |
| Blocked-by | None. |
| Conflict risk | Low. Shares inbox files with native-listener/retention work; does not touch MCP, setup, receipt contracts, or other E09 harness integrations. |

### Contract 3 — MCP result postprocessor

| Field | Contract |
|---|---|
| Title | Append shared batches to MCP results |
| Slug | `mcp-result-piggyback` |
| Complexity | `complexity:3` |
| Scope | Wire held binding/generation and the shared pull operation into `mcp-serve`; add and strip the shared optional `ackBatchToken` control argument; serialize calls; postprocess every valid Khala tool result with the exact tokenized batch format; reuse `khala_read` without a second selection; acknowledge only an exact echoed token. |
| Out of scope | `khala_read` ownership, another polling tool or batch/lease API, receiver-side deduplication, other MCP servers, idle wake, dynamic rebind rotation, new receipt kinds, setup automation, capability advertising. |
| Files/packages | `packages/agent-cli/src/mcp/server.ts`, `packages/agent-cli/src/mcp/server.test.ts`, `packages/agent-cli/src/cli/app.ts`, `packages/agent-cli/src/cli/app.test.ts`, `packages/agent-cli/src/cli/main.ts`, `packages/agent-cli/README.md`; `@khala/agent-cli` only. |
| Acceptance criteria | Existing primary results remain first and unchanged; released payloads append on success and tool-level `isError`; `khala_read` contains the batch exactly once; every tool accepts the shared optional control argument without exposing it to tool-specific handlers; empty inbox preserves exact old shape; non-tool/protocol paths consume nothing; bounds hold; pending-review and submitted-send canaries never appear; exact token echo acknowledges before selection; absent/invalid tokens replay; restart recovers the identical outstanding batch without host deduplication; concurrent calls serialize; lifecycle mismatches fail closed; no delivery receipt is synthesized; D3 language is present. |
| Tests | MCP+real-inbox integration tests for success, refused send, `khala_read`, shared-argument stripping, no pending data, invalid params/unknown tool/notification/list/ping, output failure, exact-token acknowledgement, absent/invalid-token replay, restart with one outstanding batch, pipelined calls with a blocked first write, multiple boundaries, escaped/multibyte maximums, hard-bound refusal, lifecycle mismatches, listener contention, unreleased secret canary, and abort/EOF lock release. **Wrong implementation test:** deliver a batch, restart, and require Codex to filter a repeated `releaseId`; the test fails because Khala must replay or advance solely from the outstanding batch token. |
| Blocked-by | `mcp-piggyback-format-proof`; `mcp-inbox-batch`; `listening-mode-pull`. |
| Conflict risk | High with `listening-mode-pull` in `cli/app.ts`, `mcp/server.ts`, and README. Put the postprocessor in a new MCP module, reuse the pull operation and batch shape, and keep registration diffs minimal. |

### Contract 4 — Pinned end-to-end MCP delivery evidence

| Field | Contract |
|---|---|
| Title | Prove MCP piggyback end to end |
| Slug | `mcp-piggyback-evidence` |
| Complexity | `complexity:2` |
| Scope | Run two real Codex 0.154.0 MCP proofs with unique queued messages: under the declared async-mode setup, prove the agent itself selects `khala_read`, consumes the shared batch, and echoes its token on a later Khala call; separately prove a valid non-read Khala tool result receives a batch through the result postprocessor and the next call acknowledges it. Distinguish agent-issued calls from fixture-issued protocol calls, require an explicit `khala_send` response, and record exact commands, inventory, outputs, and negative claims for the setup/capability owner. |
| Out of scope | Capability-registry edits, promoting untested Codex versions, proving Claude/OpenCode, idle wake, arbitrary-tool injection, or product setup UX. |
| Files/packages | `experiments/internal-mode/mcp-piggyback/`, `docs/evidence/mcp-piggyback.md`; no capability-registry or receipt schema changes. |
| Acceptance criteria | Clean pinned runs prove queued channel/author/body context absent from the prompt; the async-mode run records an agent-issued `khala_read`, consumption of its shared batch, a later agent-issued `ackBatchToken`, and a deliberate peer-directed `khala_send`; the non-read run records the result postprocessor appending the batch exactly once and a later acknowledgement. A forced restart proves Khala replays the identical outstanding batch until that echo and advances exactly once afterward while the host keeps no release-ID deduplication state; boundary cases remain usable; idle wake and non-Khala boundaries remain unproven; no transcript or assistant-output capture is used. Passing both subproofs is required before MCP-only `async` may be advertised as supported. |
| Tests | Automate the real-inbox protocol fixture and evidence verifier. **Wrong implementation test:** let the fixture invoke `khala_read` directly while the agent never selects it; verification fails because the recorded async proof must distinguish and require agent-issued calls. Also remove Khala's next-call token acknowledgement and add a Codex-side seen-ID set; verification fails because the receiver must remain stateless for deduplication. |
| Blocked-by | `mcp-result-piggyback`. |
| Conflict risk | Medium with I4 setup and D2 capability-matrix research. This ticket owns only evidence; those areas consume it, enforce the sandbox/read-only default, and own advertised support. |

## Recommended sequence

`listening-mode-contract` → `mcp-piggyback-format-proof` plus `mcp-inbox-batch` → `listening-mode-pull` → `mcp-result-piggyback` → `mcp-piggyback-evidence` → setup/capability advertising.

No MCP listening mode is supported by this design alone. Passing end-to-end evidence is the only input that may promote MCP-only `async` for a named harness/version; this route does not establish `sync` or `steer`. The setup/capability owner makes that advertising change and must also enforce the safe-workspace default.
