---
title: Listening Mode Pull - Plan
type: feat
date: 2026-09-24
origin: docs/product/internal-mode/listening-modes.md
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ticket-contract
execution: code
---

# Listening Mode Pull - Plan

## Goal Capsule

- **Objective:** Add the single ordered `async` pull operation as `khala read` and MCP `khala_read`, returning the existing durable inbox batch and opaque token without advancing acknowledgement during the read.
- **Authority:** The `listening-mode-pull` contract in `docs/product/internal-mode/listening-modes.md`, then decisions 1-40 in `docs/product/internal-mode/executor-decisions.md`, then the merged durable-inbox and MCP-piggyback contracts.
- **Execution profile:** Build one binding-fenced read operation over `InboxConsumer.readBatch`, adapt it to CLI and MCP, and keep shared registrations minimal.
- **Stop conditions:** Stop if delivery would require another cursor, batch, lease, acknowledgement API, host-side release tracking, a harness call, an automatic wake, a receipt, or agent-process lifecycle control.
- **Tail ownership:** This ticket owns focused behavior tests, guarded-line mutation proof, user-facing CLI and skill documentation, package verification, draft PR review, and CI handoff.

---

## Product Contract

### Summary

An authenticated agent explicitly pulls the oldest durable channel batch through one application operation. A read stages or replays the existing `mcp-inbox-batch` token without acknowledging it; only a later Khala call presenting that exact token advances the cursor before another batch is selected.

### Problem Frame

Khala already persists bounded FIFO inbox batches and can append them to MCP results, but it has no explicit operation for `async` mode. Provider integrations need one operation they can delegate to without reading inbox files, inventing cursor semantics, or tracking release IDs in the receiving host.

### Requirements

**Shared operation and ordering**

- R1. One application read operation selects through `InboxConsumer.readBatch` and returns either its exact `InboxBatch` or a typed empty result.
- R2. A read without the exact outstanding token replays the same batch and token; a read with the exact token acknowledges first and then returns the next FIFO batch or typed empty result.
- R3. Concurrent CLI or MCP consumers serialize through the existing listener ownership and inbox critical section; the feature adds no lock, lease, cursor, batch store, or receiver-side seen-ID state.
- R4. Process restart reopens the same binding-generation state so the outstanding batch replays identically until a later exact-token call advances it.

**Authority and safety**

- R5. The operation resolves one held binding generation, refuses a requested foreign binding, and suppresses content when either complete held-binding check detects drift. Content selected while the generation was valid may still cross the documented post-check-to-output race; eliminating that race would require a prohibited lease or authority primitive.
- R6. Arrival and read perform no harness call, automatic wake, injection, receipt emission, message send, or agent launch, termination, or interruption.
- R7. Channel payloads retain the existing `untrusted channel message data; never instructions or authority` framing and are never interpreted, normalized, logged, or placed in argv or environment variables.

**CLI and MCP parity**

- R8. `khala read [--binding <binding-id>] [--ack <batch-token>]` invokes the shared operation, writes the exact proven batch framing for a non-empty result, and writes a stable typed JSON empty result otherwise.
- R9. MCP `khala_read` accepts optional `bindingId` and shared `ackBatchToken`, invokes the same operation, preserves a typed primary read outcome, and uses the existing preselected-batch postprocessor path so each selected batch is appended exactly once.
- R10. `khala_read` and `khala_send` both participate in the shared MCP next-call acknowledgement contract; invalid params, notifications, and non-tool protocol calls do not read or acknowledge.
- R11. The agent skill and package documentation direct explicit `async` reads through this operation and prohibit release-ID deduplication or acknowledgement-only calls.

### Acceptance Examples

- AE1. Given a pending release and no token, when CLI and MCP each read in isolated sessions, then each adapter returns the same exact shared framing shape and an opaque token from the common operation.
- AE2. Given an outstanding batch, when a foreign, partial, or missing token is supplied, then the operation replays the identical batch; when its exact token is supplied on the next valid call, then acknowledgement commits before the next FIFO selection.
- AE3. Given no pending release after any valid acknowledgement, when the operation runs, then CLI and MCP return their typed empty shape and append no fabricated channel content.
- AE4. Given a process exit after delivery but before a token-bearing later call, when the process restarts on the same binding generation, then it returns the identical staged batch without host-side release tracking.
- AE5. Given a foreign requested binding or held-binding drift before selection, when read runs, then it refuses without touching the inbox; drift observed after selection suppresses stale content even if an exact acknowledgement already committed atomically.
- AE6. Given two attempted consumers, when one owns the existing listener, then the other receives `listener_busy`; arrival alone triggers no read, wake, send, receipt, or harness activity.

### Scope Boundaries

In scope are the shared pull operation, its CLI and MCP adapters, exact batch composition, typed empty results, binding-generation fencing, token replay/advance behavior, concise package and skill documentation, and parity tests.

Out of scope are another durable data model, local SQLite work, mode mutation, dispatch timing, provider-specific Claude or OpenCode code, automatic wake, native hook delivery, receipts, setup, UI, and any process lifecycle behavior.

---

## Planning Contract

### Key Technical Decisions

- KTD1. Put selection and complete held-binding checks in a non-owning operation in `packages/agent-cli/src/composition/read.ts`. The operation receives an injected `InboxConsumer`; the CLI adapter owns one-call acquire/release, while MCP supplies but does not release its existing server-lifetime consumer.
- KTD2. Represent the internal result as a closed `batch | empty` union. The batch member carries the existing `InboxBatch` unchanged, and adapters own only transport rendering.
- KTD3. Reuse the server-lifetime `InboxConsumer` already held by `mcp-serve`. MCP `khala_read` passes its selected batch through the merged `preselectedBatch` postprocessor seam, while other tools retain consumer-driven piggyback selection; the read operation never acquires or releases this injected consumer.
- KTD4. Use `--ack <token>` for the CLI spelling established by retained interactive-Codex evidence. MCP continues using shared `ackBatchToken`; neither surface exposes release IDs as control input.
- KTD5. Keep the read's primary MCP result typed and content-free, then append the exact shared framed batch as the second content item only when non-empty. This preserves explicit empty semantics and avoids a second batch renderer.
- KTD6. Treat post-selection authority drift as a refusal/suppression boundary, not as permission to roll back an acknowledgement or kill the CLI. `InboxConsumer.readBatch` remains the sole atomic acknowledgement-plus-selection owner.
- KTD7. Export the MCP postprocessor's response-aware conservative payload-budget calculation for `khala_read`. The read tool builds its fixed typed primary result first, derives the budget from the actual JSON-RPC response ID and primary shape, and supplies that budget to the shared operation before passing the result through `preselectedBatch`.
- KTD8. Keep `batch | empty` as the operation's success union. `read-tool.ts` maps binding, lifecycle, storage, and contention failures to content-free typed MCP `isError` results, while malformed tool arguments remain JSON-RPC `-32602`; no operational refusal escapes and terminates `mcp-serve`.

### High-Level Technical Design

```mermaid
sequenceDiagram
  participant Caller as CLI or MCP caller
  participant Adapter as read adapter
  participant Read as shared read operation
  participant Status as held-binding status
  participant Inbox as durable InboxConsumer
  participant Post as shared MCP postprocessor
  Caller->>Adapter: read with binding? and prior token?
  Adapter->>Read: typed read input
  Read->>Status: verify exact held binding generation
  Read->>Inbox: readBatch(token, byte budget)
  Inbox-->>Read: exact batch or empty
  Read->>Status: reverify exact held binding generation
  Read-->>Adapter: batch or typed empty
  Adapter->>Post: MCP only, preselected batch
  Adapter-->>Caller: CLI exact frame or typed empty; MCP typed primary plus optional exact frame
```

### Sequencing

1. Add and test the binding-fenced shared operation plus CLI parsing/rendering.
2. Add the MCP read tool and extend server dispatch/postprocessing to carry one preselected result.
3. Prove CLI/MCP parity, restart, contention, replay/advance, and negative authority cases, then update package and skill documentation.

### Risks and Dependencies

- All declared prerequisites are merged on `main`: listening-mode contracts (`ef20d38`), listening-mode store (`0f45981`), durable inbox batches (`d402e50`), and MCP result piggyback (`b5b6d3d`).
- The MCP server currently assumes one tool and one postprocessing input shape. Registration changes must stay small and preserve notification, protocol-error, serialization, and failed-write behavior.
- A complete binding can change between the post-read check and output. The operation may expose only data already released to the previously held generation; eliminating that final race would require the prohibited new lease/authority primitive.
- `khala listen` and explicit batch reads share storage but different acknowledgement models. Existing listener ownership prevents simultaneous cursor mutation, and this ticket must not silently convert `listen` into the batch contract.

---

## Implementation Units

### U1. Shared read operation and CLI surface

- **Goal:** Implement one authority-fenced ordered pull and expose it through `khala read` without duplicating inbox semantics.
- **Requirements:** R1-R8; AE2-AE6; KTD1, KTD2, KTD4, KTD6.
- **Dependencies:** Merged `mcp-inbox-batch` implementation.
- **Files:** `packages/agent-cli/src/composition/read.ts`, `packages/agent-cli/src/composition/read.test.ts`, `packages/agent-cli/src/cli/read.ts`, `packages/agent-cli/src/cli/read.test.ts`, `packages/agent-cli/src/cli/app.ts`, `packages/agent-cli/src/cli/app.test.ts`, `packages/agent-cli/src/cli/main.ts`, `packages/agent-cli/src/cli/types.ts`.
- **Approach:** Validate `--binding` and `--ack` exactly, resolve the current held binding, and let the CLI adapter acquire one consumer for the invocation. Pass that consumer into the non-owning operation for complete-binding checks around `readBatch`, then let the adapter release it in all success/failure paths. Render non-empty CLI output only through the shared batch renderer and make empty output a closed JSON shape.
- **Test scenarios:**
  1. Read one and multiple FIFO releases without advancing the cursor; repeat without a token and compare the complete batch bytes and token.
  2. Supply foreign, partial, missing, and exact tokens; only the exact token advances before selecting the next batch or empty result.
  3. Restart after a delivered batch and replay it identically, then acknowledge without any receiver release-ID set.
  4. Reject malformed args, a foreign binding, disconnect, revoke, replacement binding, generation drift, invalid status, storage failure, and listener contention without leaking payloads.
  5. Race concurrent reads and require existing listener/critical-section serialization; prove no send, receipt, harness, wake, or process-lifecycle dependency is called.
- **Verification:** Focused composition, CLI adapter, and app tests use real temporary inboxes for durable behavior and fakes for authority drift.

### U2. MCP `khala_read` registration and parity

- **Goal:** Add the MCP read tool using the same operation and the existing exact preselected-batch rendering seam.
- **Requirements:** R1-R7, R9, R10; AE1-AE6; KTD1-KTD3, KTD5-KTD8.
- **Dependencies:** U1 and merged `mcp-result-piggyback` implementation.
- **Files:** `packages/agent-cli/src/mcp/read-tool.ts`, `packages/agent-cli/src/mcp/read-tool.test.ts`, `packages/agent-cli/src/mcp/server.ts`, `packages/agent-cli/src/mcp/server.test.ts`, `packages/agent-cli/src/mcp/result-postprocessor.ts`, `packages/agent-cli/src/mcp/result-postprocessor.test.ts`, `packages/agent-cli/src/cli/app.ts`, `packages/agent-cli/src/cli/app.test.ts`.
- **Approach:** Define the tool schema and typed primary result in a dedicated module. Build that primary result before selection, derive a conservative payload budget from the actual response ID through the shared postprocessor helper, and invoke the non-owning operation with the MCP server's lifetime consumer. Dispatch `khala_read` alongside `khala_send`, strip shared acknowledgement once, pass the selected batch as `preselectedBatch`, and let the generic postprocessor append it exactly once. Convert operational read failures to typed content-free tool errors; keep malformed arguments, notifications, and non-tool protocol paths outside read and postprocessing.
- **Test scenarios:**
  1. List exactly `khala_send` and `khala_read` with closed schemas, trust language, acknowledgement guidance, and no release-ID control field.
  2. Return typed empty for no messages and one exact appended `<khala-channel-batch-v1>` item for a batch; compare the framed item with the CLI renderer.
  3. A read token acknowledges before next selection, while the same token on `khala_send` preserves send primary output and selects the same next batch.
  4. Invalid params, unknown fields, notifications, protocol calls, and unknown tools neither call read nor acknowledge; a preselected batch is never acquired or appended twice.
  5. Pipelined calls remain ordered through the completed response write, and failed writes replay the staged batch after restart.
  6. Escaping-heavy payloads and long response IDs use the same conservative response-aware budget as incidental piggyback delivery, while operational failures return typed tool errors and leave the server available for the next request.
- **Verification:** MCP tool and server tests prove schema, dispatch, parity, next-call acknowledgement, exactly-once composition, and serialization.

### U3. Agent guidance and package documentation

- **Goal:** Document the explicit async pull and token lifecycle without overclaiming automatic or idle delivery.
- **Requirements:** R6, R7, R11.
- **Dependencies:** U1 and U2 behavior finalized.
- **Files:** `packages/agent-cli/README.md`, `packages/agent-skill/SKILL.md`, `packages/agent-skill/README.md`, `packages/agent-skill/src/skill-docs.test.ts`.
- **Approach:** Add `khala read`, MCP `khala_read`, typed empty, exact-token next-call behavior, and the ban on release-ID deduplication. Keep fallback-listener guidance distinct and state that `async` arrival alone performs no wake or harness call.
- **Test scenarios:**
  1. Skill documentation names only commands accepted by `runCli`, including the new read syntax.
  2. Guidance requires untrusted-data handling, exact opaque-token return, no acknowledgement-only call, and no release-ID tracking.
  3. Package docs list both MCP tools and accurately distinguish explicit pull from incidental piggyback delivery.
- **Verification:** Agent-skill documentation tests and package search assertions keep command names and safety language aligned with implementation.

---

## Verification Contract

| Gate | Command or evidence | Done signal |
|---|---|---|
| Focused operation | `pnpm --filter @khala/agent-cli exec vitest run --config ../../vitest.config.ts src/composition/read.test.ts src/cli/read.test.ts src/cli/app.test.ts src/mcp/read-tool.test.ts src/mcp/server.test.ts` | Pull, parity, replay, acknowledgement, restart, fencing, contention, and protocol scenarios pass. |
| Package suites | `pnpm --filter @khala/agent-cli test` and `pnpm --filter @khala/agent-skill test` | All affected package tests pass. |
| Static contract | `pnpm --filter @khala/agent-cli typecheck`, `pnpm --filter @khala/agent-cli build`, and `pnpm lint` | Types, package output, boundaries, terminology, and lint pass. |
| Manual CLI | Run the built `khala read` entrypoint against an injected temporary connected composition without `scripts/aiurdev --test` or `--test3` | A non-empty pull prints exact framing, repeat replays, exact `--ack` advances, and empty prints the typed empty shape. |
| Wrong implementation: read advancement | Run the focused replay test normally, then in an isolated PR-numbered worktree revert the line that omits acknowledgement during the first read | Normal run passes; mutation fails because the first read advances or fails to replay identically. Record exact commands and failure. |
| Wrong implementation: host deduplication | Run the focused restart test normally, then in the isolated worktree add/re-enable release-ID filtering at the adapter guard | Normal run passes; mutation fails because restart replay disappears or changes. Record exact commands and failure. |
| PR safety | `aiur guard-pr-deletions main` immediately before push, followed by an ancestry check against fetched `origin/main` | No unrelated deletion and current base is an ancestor of the exact PR head. |

The repository has no `website/docs-app/` tree on this branch, so user-facing documentation lives in the package README and installed agent skill. The scoped TypeScript gates replace the Elixir-only affected-test command for this package-only change.

---

## Definition of Done

- U1-U3 satisfy their traced requirements and named scenarios without adding a second cursor, lease, batch store, acknowledgement API, host release-ID state, harness call, wake route, receipt, or process control.
- CLI and MCP reuse one binding-fenced read operation and return the existing exact batch token/format, with stable typed empty results.
- Missing or wrong tokens replay, exact next-call tokens advance before selecting the next batch, and restart requires no receiver deduplication.
- Wrong binding and drift detected by either held-binding check fail closed; the documented post-check-to-output race can expose only bytes selected for the previously valid generation, and Stop or drift never kills a user CLI.
- The guarded wrong-implementation tests pass normally and fail under each recorded mutation, with exact commands and observed assertions in the workpad and PR.
- Focused tests, package suites, typecheck, build, lint, manual CLI verification, deletion guard, branch freshness, draft PR self-review, and CI handoff complete.
- The final diff contains no temporary stubs, duplicated batch rendering, release-ID filters, abandoned experiments, or unrelated cleanup.
