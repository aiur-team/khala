---
title: App Harness Identity Contract - Plan
type: feat
date: 2026-09-24
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
origin: docs/product/internal-mode/interactive-desktop-apps.md
---

# App Harness Identity Contract - Plan

## Goal Capsule

- **Objective:** Add a strict app-harness identity and boundary contract that scopes capability evidence to one exact app, shape, version, account tier, and administrator-policy tuple.
- **Authority:** `docs/product/internal-mode/executor-decisions.md` items 1-40 override the `app-channel-contract` in `docs/product/internal-mode/interactive-desktop-apps.md`; the landed listening-mode contract remains the sole owner of mode, support, acknowledgement, grant, and evidence vocabulary.
- **Execution profile:** Define the wrapper and exact-match helpers first, then add fixtures, exports, and wrong-implementation mutation guards.
- **Stop conditions:** Do not add vendor adapters, proof claims, setup automation, new capability vocabulary, or changes to `packages/contracts/src/delivery/harness.ts`.
- **Tail ownership:** This ticket owns local verification, mutation proof, the draft PR, self-review, and CI handoff against `main`.

---

## Product Contract

### Summary

App capability evidence must be attached to the exact app environment that produced it. The contract adds only app identity and per-mode boundary metadata around the existing `HarnessCapabilities` envelope, preventing vendor-only or cross-shape matches while preserving the listening-mode vocabulary unchanged.

### Problem Frame

A generic vendor record can incorrectly promote evidence from a cloud task to a local session or across app versions and account policies. The delivery contracts need a strict tuple and exact boundary spelling before proof tickets can record evidence without broadening its scope.

### Requirements

**Identity and boundaries**

- R1. Decode a versioned identity with closed app values `cursor`, `claude`, and `codex`; closed app-shape values; and required opaque app-version, account-tier, and administrator-policy-scope identifiers.
- R2. Match identities only when every tuple field is equal, with no normalization, partial match, version range, or vendor fallback.
- R3. Associate `steer` only with `postToolUse`, `PostToolUse`, or `null`; `sync` only with `stop`, `Stop`, or `null`; and `async` only with `khala_read` or `null`.

**Capability ownership and fail-closed behavior**

- R4. Compose the existing `HarnessCapabilities` decoder instead of redefining mode, support, acknowledgement, grant, or evidence fields.
- R5. Require a nested wire-v3 capability envelope whose `version` and `harness` agree with the app identity, while preserving the shared decoder's strict per-mode evidence rules.
- R6. Represent an uninspected exact tuple with three shared `unknown` mode rows whose `evidenceRef` and `evidenceRevision` are null, whose reasons are nonempty, and whose acknowledgement is `unknown`, regardless of documented candidate boundaries; the generic capability envelope's `evidenceRef` remains independent.
- R7. Reject generic vendor-only records, app-local support/evidence fields, missing tuple fields, invented shapes, and misspelled or case-folded boundaries.

### Scope Boundaries

- No changes to listening-mode values, `ModeSupport`, acknowledgement, grants, hard-cancel, or evidence schemas.
- No app adapter, setup command, proof artifact, UI behavior, or support claim.
- No inference that a documented boundary is proven or that one app shape can reuse another shape's evidence.

---

## Planning Contract

### Key Technical Decisions

- KTD1. `AppHarnessRecord` wraps one existing `HarnessCapabilities` value with app identity and a three-key boundary map, preserving decision 6's single capability-data owner.
- KTD2. The boundary map applies a mode-specific closed set: post-tool variants for `steer`, stop variants for `sync`, and `khala_read` for `async`; `null` means the exact mode has no candidate boundary and does not introduce another status vocabulary. The decoder does not hard-code app/shape combinations because proof records, not this identity contract, determine which documented candidates apply.
- KTD3. App and shape are separate closed fields. Apps are `cursor`, `claude`, and `codex`; shapes are `local_chat`, `desktop_extension`, `remote_connector`, `browser`, and `cloud_task`. Account tier and administrator-policy scope remain opaque identifiers because vendors can change their labels and policies.
- KTD4. `sameAppHarnessIdentity` compares every tuple component explicitly. Tests use a keyed substitution matrix so adding a field without adding it to equality cannot silently pass.
- KTD5. The wrapper accepts only a nested wire-v3 `HarnessCapabilities`, then requires its `version` to equal `appVersion` and its `harness` to equal `app`. Retained standalone v2 capability data remains readable through `decodeHarnessCapabilities`, but a newly introduced app record cannot omit modes or acknowledgement and rely on v2 normalization.

### Risks and Dependencies

- The `listening-mode-contract` dependency is already integrated at `ef20d38`, so this module can import its strict types and readers directly.
- The existing generic capability envelope contains legacy mechanical fields; wrapping it avoids inventing a second owner but tests must prove the outer identity cannot disagree with its `harness` or `version`.
- Claude app shapes have no documented `steer` or `sync` boundary, so non-null boundary slots would fabricate a candidate route; nullable slots are required.

---

## Implementation Units

### U1. Define strict app identity and boundary records

- **Goal:** Add the versioned app wrapper, strict decoder, and exact tuple comparator.
- **Requirements:** R1-R7; KTD1-KTD5.
- **Dependencies:** None.
- **Files:** `packages/contracts/src/delivery/app-harness.ts`, `packages/contracts/src/delivery/app-harness.test.ts`.
- **Approach:** Reuse `decodeWith`, `object`, `literal`, `identifier`, and `version`; require raw nested capability version 3 before delegating to `decodeHarnessCapabilities`; decode each boundary slot against its mode-specific literal set; enforce app/version agreement after nested decoding. Uninspected behavior is a required record state proven by fixtures and tests, not a separate constructor or inspection-status API.
- **Execution note:** Write focused failing tests for strict fields, tuple equality, nested consistency, and uninspected behavior before implementing the decoder.
- **Patterns to follow:** `packages/contracts/src/delivery/binding.ts`, `packages/contracts/src/delivery/harness.ts`, `packages/contracts/src/delivery/listening-mode.ts`, `packages/contracts/src/delivery/value-contracts.test.ts`.
- **Test scenarios:** Decode Cursor local and Claude browser records; reject generic vendor-only and app-local support/evidence fields; reject missing identity components, boundary spelling changes, and cross-mode boundary substitutions; reject nested v2 and malformed nested mode support; reject nested harness/version disagreement; prove every identity substitution fails, including Cursor `cloud_task` versus `local_chat`; prove uninspected records keep every shared mode and acknowledgement unknown even with candidate boundaries.
- **Verification:** The focused app-harness suite passes and the mutation matrix below fails as specified when each production guard is reverted in an isolated worktree.

### U2. Add fixture coverage and the public export

- **Goal:** Make representative app records part of the delivery fixture matrix and expose only production contract symbols.
- **Requirements:** R3-R7.
- **Dependencies:** U1.
- **Files:** `packages/contracts/fixtures/delivery/app-harness.json`, `packages/contracts/src/delivery/fixtures.test.ts`, `packages/contracts/src/delivery/index.ts`.
- **Approach:** Add exact valid and invalid fixture cases, wire only the production decoder into the fixture test matrix, include the module in the delivery-to-messaging import-boundary audit, and add a minimal barrel export.
- **Patterns to follow:** `packages/contracts/fixtures/delivery/views.json`, `packages/contracts/src/delivery/fixtures.test.ts`, `packages/contracts/src/delivery/index.ts`.
- **Test scenarios:** Round-trip a valid uninspected tuple byte-stably; reject a vendor-only record and a record that redefines support/evidence at the app level; confirm fixtures and test helpers are absent from exports.
- **Verification:** Focused fixture tests, the full contracts package tests, contracts typecheck, and workspace lint pass.

---

## Verification Contract

| Gate | Applies to | Done signal |
|---|---|---|
| Focused app-harness suite | U1 | `mise exec -- pnpm --filter @khala/contracts test -- src/delivery/app-harness.test.ts` passes |
| Fixture decoder suite | U2 | `mise exec -- pnpm --filter @khala/contracts test -- src/delivery/fixtures.test.ts` passes |
| Contracts package suite | U1-U2 | `mise exec -- pnpm --filter @khala/contracts test` passes |
| Contracts typecheck | U1-U2 | `mise exec -- pnpm --filter @khala/contracts typecheck` passes |
| Workspace lint | U1-U2 | `mise exec -- pnpm lint` passes |
| Wrong-implementation mutations | U1-U2 | Each guarded line reverted in an isolated worktree makes its named focused test fail for the intended reason |
| Base and deletion guards | PR tail | Current `origin/main` is an ancestor and `aiur guard-pr-deletions main` passes |

### Mutation Matrix

| Production guard | Named test | Exact focused command | Expected failure when reverted |
|---|---|---|---|
| Strict outer field list | `rejects generic or redefined app capability records` | `mise exec -- pnpm --filter @khala/contracts test -- src/delivery/app-harness.test.ts -t "rejects generic or redefined app capability records"` | A vendor-only or app-local support/evidence field decodes instead of failing |
| Mode-specific boundary literal sets | `rejects boundaries outside their listening mode` | `mise exec -- pnpm --filter @khala/contracts test -- src/delivery/app-harness.test.ts -t "rejects boundaries outside their listening mode"` | A case-folded or cross-mode boundary decodes instead of failing |
| Exact comparison of every identity field | `compares every app harness identity field` | `mise exec -- pnpm --filter @khala/contracts test -- src/delivery/app-harness.test.ts -t "compares every app harness identity field"` | One tuple substitution, including cloud versus local shape, matches |
| Nested raw-v3 and app/version consistency checks | `rejects inconsistent nested capabilities` | `mise exec -- pnpm --filter @khala/contracts test -- src/delivery/app-harness.test.ts -t "rejects inconsistent nested capabilities"` | A legacy v2, different harness, or different version is accepted |

---

## Definition of Done

- The full app/shape/version/account-tier/administrator-policy tuple decodes and matches exactly.
- Boundaries preserve exact vendor casing, use `null` for no candidate, and never imply support.
- The existing `HarnessCapabilities` value remains the only support/evidence owner and cannot disagree with the wrapper identity.
- Uninspected records remain `unknown` across all modes and acknowledgement.
- Fixtures and focused tests reject both wrong implementations from the source contract.
- Mutation commands and observed failures are recorded in the workpad and PR handoff.
- No abandoned schema experiments or unrelated changes remain in the diff.
