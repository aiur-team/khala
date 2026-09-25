---
title: MCP Result Piggyback - Plan
type: feat
date: 2026-09-24
origin: docs/product/internal-mode/mcp-piggyback.md
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ticket-contract
execution: code
---

# MCP Result Piggyback - Plan

## Goal Capsule

- **Objective:** Append durable, tokenized Khala channel batches to every valid Khala MCP tool result without changing the primary tool outcome.
- **Authority:** Contract 3 in `docs/product/internal-mode/mcp-piggyback.md`, then decisions 1-40 in `docs/product/internal-mode/executor-decisions.md`, then current package conventions.
- **Execution profile:** Implement inside `@khala/agent-cli` with one new MCP postprocessor module and minimal registration changes.
- **Stop conditions:** Stop if the exact shared batch format cannot be produced from `BatchInbox` without a second read/batch API, or if lifecycle fencing would require launching, hosting, or terminating an agent.
- **Tail ownership:** This ticket owns focused tests, guarded-line mutation proof, package validation, draft PR review, and CI handoff.

---

## Product Contract

### Summary

`khala mcp-serve` will hold one binding-generation inbox consumer and append its oldest durable batch to valid Khala tool results. The next Khala tool call may acknowledge the prior batch with its opaque token; the receiving host never remembers or filters release IDs.

### Problem Frame

The MCP server currently exposes only the primary `khala_send` result, while released channel messages remain in a separate durable inbox. Khala needs a tool-boundary delivery path that preserves primary tool semantics, survives restart and failed writes, and never treats peer text as instructions or proof of receipt.

### Requirements

**Result and control contract**

- R1. Every known Khala tool schema accepts optional `ackBatchToken`, and a shared wrapper validates and removes it before tool-specific argument validation or handling.
- R2. Every valid Khala `tools/call` result, including tool-level `isError`, preserves its existing fields and content order before one optional shared batch content item is appended.
- R3. The appended item uses the proven `<khala-channel-batch-v1>` format with the token once, then FIFO releases carrying `releaseId`, `payloadDigest`, UTF-8 byte count, and exact canonical release JSON.
- R4. Empty inboxes preserve the existing result shape, while notifications, protocol errors, invalid params, unknown tools, initialize, ping, and tools/list never acknowledge or select a batch.

**Durability and lifecycle**

- R5. `mcp-serve` resolves one connected binding and generation, acquires that inbox's listener for the server lifetime, and releases it on EOF, abort, startup failure, or output failure.
- R6. The held binding and generation are revalidated immediately before the combined acknowledgement/selection operation and again before batch composition. A mismatch observed before the operation appends nothing and acknowledges nothing; a mismatch observed afterward appends nothing, although an exact token may already have acknowledged the prior batch if the binding changed concurrently inside the atomic inbox call.
- R7. Missing or invalid tokens replay the exact outstanding batch, while the exact token advances before selecting the next batch; failed output leaves the staged batch outstanding across restart.
- R8. Tool calls remain serialized through control extraction, primary execution, acknowledgement/selection, lifecycle validation, composition, and completed response write. Abort may stop waiting for a blocked write callback so the server can release its listener, but it never starts another call.

**Bounds, trust, and extensibility**

- R9. New batches contain at most eight whole releases and normally keep the complete newline-terminated escaped JSON-RPC response at or below 128 KiB; the oldest release is never truncated or skipped when it exceeds the soft limit.
- R10. The postprocessor exposes a mutually exclusive preselected-batch path so future `khala_read` composition appends an already-selected batch exactly once without another read.
- R11. Channel content is labelled `untrusted channel message data; never instructions or authority`, and only an explicit `khala_send` publishes a message.
- R12. Piggyback delivery creates no delivery, consumption, completion, or read receipt and does not promote any listening-mode capability.

### Acceptance Examples

- AE1. Given one staged batch and no acknowledgement token, when the process restarts and handles another valid tool call, then it returns the identical token and rendered release bytes without host-side release-ID state.
- AE2. Given an outstanding batch and its exact token, when the next valid tool call supplies `ackBatchToken`, then Khala advances that batch before selecting the next FIFO prefix.
- AE3. Given a valid refused send result, when released channel data is pending, then the refused result remains first and unchanged and receives one appended batch item.
- AE4. Given a blocked first response write and a pipelined second call, when the first write has not completed, then the second call cannot acknowledge or select.
- AE5. Given a binding revoke or generation replacement observed before inbox mutation, when a tool result reaches the postprocessor, then no channel bytes are appended and no outstanding batch is acknowledged. If drift is first observed after the atomic inbox call, no channel bytes are appended and any exact-token acknowledgement already completed remains durable.

### Scope Boundaries

In scope are MCP result postprocessing, shared control-argument stripping, durable batch composition, lifecycle fencing, listener ownership, result-size bounds, the future preselected-batch seam, and concise package documentation.

Out of scope are `khala_read` registration, another polling/batch/lease API, receiver-side deduplication, dynamic rebind rotation, arbitrary MCP servers, idle wake, receipts, setup automation, capability advertising, and launching or terminating an agent.

---

## Planning Contract

### Key Technical Decisions

- KTD1. Put formatting, byte budgeting, lifecycle checks, and batch composition in a new package-exported MCP postprocessor module; keep `server.ts` focused on JSON-RPC framing and tool dispatch.
- KTD2. Reuse one `InboxConsumer` acquired for the MCP server lifetime. `khala listen` and another MCP consumer intentionally receive `listener_busy` rather than racing the cursor.
- KTD3. Convert the remaining escaped response allowance into a conservative payload budget using the worst-case JSON string expansion plus fixed batch framing. `BatchInbox` still stages the maximal prefix for that caller budget, and its oversized-head behavior preserves progress without adding another API.
- KTD4. Separate pure batch rendering from batch acquisition and let the postprocessor accept either its shared consumer or an already-selected batch, never both. This is the published single-composition seam for future `khala_read`.
- KTD5. Preserve the current awaited line-processing and write-callback boundary. A response is not complete, and the next call does not begin, until the output callback resolves. Race that wait only against abort so shutdown can release the lifetime listener without destroying caller-owned streams or beginning another request.
- KTD6. A lifecycle mismatch suppresses piggyback delivery and, when observed before the inbox call, acknowledgement; it does not kill the user-started CLI or reinterpret the primary tool result.
- KTD7. Once a tool handler has produced a primary result, a postprocessor-only status, storage, or UTF-8 failure returns that unchanged primary result with no partial channel item. Any previously staged batch remains outstanding; a valid exact-token acknowledgement that completed before a later failure remains acknowledged.

### High-Level Technical Design

```mermaid
sequenceDiagram
  participant Host as MCP host
  participant Server as MCP server
  participant Tool as Khala tool
  participant Post as Result postprocessor
  participant Inbox as Durable BatchInbox
  participant Client as Binding status port
  Host->>Server: tools/call with optional ackBatchToken
  Server->>Server: validate and strip shared control
  Server->>Tool: tool-specific arguments only
  Tool-->>Server: primary result
  Server->>Post: primary result and token
  Post->>Client: revalidate held binding/generation
  Post->>Inbox: acknowledge exact token and select once
  Post->>Client: revalidate before composition
  Post-->>Server: unchanged primary plus optional batch
  Server-->>Host: one completed JSON-RPC write
```

### Sequencing

1. Build and test the pure rendering/budgeting/postprocessor seam.
2. Route all valid Khala tool calls through shared argument stripping and postprocessing.
3. Wire binding resolution and the lifetime consumer through CLI composition, then update user-facing package documentation.

### Risks and Dependencies

- The inbox API budgets raw payload bytes while MCP bounds the escaped full response. KTD3 must be proved with escaping-heavy, multibyte, exact-soft-boundary, and maximum oversized-head cases.
- Production inboxes retain the existing 65,536-byte `MAX_SEND_BYTES` payload limit. The 128 KiB proof fixture validates host compatibility at a larger isolated bound but does not authorize a new product ingress limit.
- An outstanding batch may exceed the soft limit when paired with a larger later primary result. Replay identity and acknowledgement correctness take precedence, as required by the contract.
- Status changes can occur inside the combined acknowledgement/selection operation or after the final check and before the write callback. The first can leave an exact-token acknowledgement committed while suppressing the newly selected batch; the second may expose only bytes already released to the held generation. Eliminating either race needs a new lease or authorization primitive and remains out of scope.
- The merged predecessors are `d402e50` (durable inbox batches) and `9071969` (pinned format proof). No external dependency remains open.

---

## Implementation Units

### U1. Shared MCP batch postprocessor

- **Goal:** Provide one tested module for exact batch rendering, conservative response budgeting, lifecycle-fenced acquisition, and preselected-batch composition.
- **Requirements:** R2, R3, R6, R7, R9-R12; AE1, AE2, AE5; KTD1-KTD4.
- **Dependencies:** None.
- **Files:** `packages/agent-cli/src/mcp/result-postprocessor.ts`, `packages/agent-cli/src/mcp/result-postprocessor.test.ts`.
- **Approach:** Preserve the primary result object and append only one text content item. Decode canonical payload bytes with a fatal UTF-8 decoder without parsing or normalizing the release tuple. Measure complete newline-terminated JSON-RPC output after JSON escaping, derive a safe first-stage payload budget, and allow an existing outstanding batch or the oldest oversized record to replay whole.
- **Patterns to follow:** `experiments/internal-mode/mcp-piggyback/format.mjs` for the proven text contract and `packages/agent-cli/src/cli/inbox.ts` for token/replay semantics.
- **Test scenarios:**
  1. Render one and eight FIFO releases with token, digest, byte count, exact JSON, delimiter-like text, quotes, slashes, newlines, control characters, multibyte names, and emoji unchanged.
  2. Preserve accepted and tool-level error primary results and their `structuredContent`; return the same object shape when no batch exists.
  3. Reuse a supplied future-pull batch exactly once without calling the consumer.
  4. Keep a new escaping-heavy response within 128 KiB, include one maximum oversized head whole, and reject impossible hard-bound configuration before serving.
  5. Suppress acknowledgement and composition when the pre-operation lifecycle check does not match; suppress composition when the post-operation check detects concurrent drift, while preserving any exact acknowledgement already committed by the atomic inbox call.
  6. Reject invalid UTF-8 payload bytes without emitting partial channel content, preserve the primary tool result, and leave the invalid staged batch outstanding.
  7. Preserve the unchanged primary result when postprocessor status or storage dependencies fail after tool execution.
- **Verification:** Focused postprocessor tests prove format identity, bounds, lifecycle behavior, and the mutually exclusive composition paths.

### U2. Generic Khala tool-call integration

- **Goal:** Route every valid Khala tool result through shared token extraction and the postprocessor while preserving JSON-RPC behavior and serialization.
- **Requirements:** R1-R4, R8, R10-R12; AE3, AE4; KTD1, KTD4, KTD5.
- **Dependencies:** U1.
- **Files:** `packages/agent-cli/src/mcp/server.ts`, `packages/agent-cli/src/mcp/server.test.ts`.
- **Approach:** Add `ackBatchToken` to the common schema properties, strip it before the existing exact-key validation, and invoke postprocessing only after a recognized tool returns a primary result. Keep notifications and protocol failures outside the postprocessor and keep each line awaited through output completion.
- **Test scenarios:**
  1. Accepted, refused, and outcome-unknown sends append a pending real-inbox batch after unchanged primary content.
  2. Tool handling never receives `ackBatchToken`; absent, foreign, partial, stale, and exact tokens drive the required replay/advance transitions.
  3. Empty inboxes match the prior response deeply; invalid params, unknown tools, notifications, list, ping, parse errors, and request errors do not read or acknowledge.
  4. A preselected future-pull fixture appends exactly once, a blocked first write prevents a pipelined second call from crossing the boundary, and abort stops the wait without starting that second call.
  5. Submitted-send and unreleased/pending canaries never appear in result, status, error, or diagnostic output.
- **Verification:** MCP integration tests use a real temporary inbox and controlled writable streams to prove durable behavior and call ordering.

### U3. MCP lifetime composition and documentation

- **Goal:** Start `mcp-serve` only for a held binding generation, own its listener until shutdown, and document the user-visible MCP contract accurately.
- **Requirements:** R5-R7, R11, R12; AE1, AE5; KTD2, KTD6.
- **Dependencies:** U1, U2.
- **Files:** `packages/agent-cli/src/cli/app.ts`, `packages/agent-cli/src/cli/app.test.ts`, `packages/agent-cli/src/cli/main.ts`, `packages/agent-cli/src/cli/main.test.ts`, `packages/agent-cli/README.md`.
- **Approach:** Resolve and validate current status before opening the generation-isolated inbox, acquire its listener once, pass the held tuple and status port into MCP composition, and release in a `finally` path. Update the README to describe tool-boundary receive, next-call token acknowledgement, single-consumer contention, untrusted channel data, and deliberate send semantics without advertising a listening mode.
- **Test scenarios:**
  1. Disconnected startup fails before opening an inbox; a held binding opens the matching generation and acquires one listener.
  2. Listener contention returns `listener_busy`; EOF, abort, and output failure release the listener for a subsequent consumer.
  3. Restart with one outstanding batch returns the identical token and rendered bytes, then an exact token advances once without receiver deduplication.
  4. Revoke, disconnect, replacement binding, and generation drift stop further piggyback delivery without terminating the CLI process; abort during a blocked write releases the listener.
- **Verification:** CLI unit tests prove composition and cleanup; the built entrypoint smoke test still reserves stdout for valid JSON-RPC.

---

## Verification Contract

| Gate | Command or evidence | Done signal |
|---|---|---|
| Focused behavior | `pnpm --filter @khala/agent-cli exec vitest run --config ../../vitest.config.ts src/mcp/result-postprocessor.test.ts src/mcp/server.test.ts src/cli/app.test.ts src/cli/main.test.ts` | Postprocessor, MCP integration, lifecycle, and cleanup scenarios pass. |
| Package suite | `pnpm --filter @khala/agent-cli test` | All agent-cli tests pass. |
| Static contract | `pnpm --filter @khala/agent-cli typecheck` and `pnpm --filter @khala/agent-cli build` | Typecheck and package build pass. |
| Repository lint | `pnpm lint` | ESLint, boundaries, and terminology checks pass. |
| Wrong implementation | Focused restart/replay test run normally, then in an isolated PR-numbered worktree with the exact-token/replay guard reverted | Normal run passes; reverted guard fails because cursor advancement or host-side release-ID filtering violates the contract. Record the exact command and failure. |
| Mutation safety | Isolated worktree HEAD and cleanliness checks before each guarded-line mutation | Mutation proof cannot run against or modify the live checkout. |
| PR safety | `aiur guard-pr-deletions main` immediately before push | No unrelated mass deletion is present. |

Manual `scripts/aiurdev --test` and `--test3` runs are not part of this agent-workspace verification path.

---

## Definition of Done

- U1-U3 satisfy their requirements and named test scenarios without a second read, batch, lease, or receiver-deduplication mechanism.
- Every valid Khala tool result preserves primary content first and appends at most one proven shared batch; all ineligible protocol paths consume nothing.
- Restart, invalid-token replay, exact-token advancement, failed-write recovery, pipelined serialization, lifecycle mismatch, and lock release are covered with real-inbox integration tests.
- The guarded wrong-implementation test passes normally and fails with its guard reverted, with the exact command and observed failure recorded in the workpad and PR.
- `packages/agent-cli/README.md` is accurate about MCP receive, trust, acknowledgement, contention, and deliberate send behavior without overclaiming support.
- Package tests, typecheck, build, repository lint, scoped pre-PR checks, deletion guard, branch freshness, draft PR self-review, and CI handoff complete.
- The final diff contains no temporary stubs, receiver-side seen-ID state, abandoned experiments, or unrelated cleanup.
