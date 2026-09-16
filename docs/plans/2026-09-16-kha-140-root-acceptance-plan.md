---
title: "Merged Product Acceptance - Plan"
type: test
date: 2026-09-16
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-brainstorm
execution: code
readiness_condition: predecessor-results-and-listed-external-gates
deepened: 2026-09-16
ticket_id: KHA-140
origin: docs/product/tickets/KHA-140.md
---

# Merged Product Acceptance - Plan

## Goal Capsule

Close the build order only when the actual product meets the agreed cross-owner collaboration contract.

Authority: user decisions in `docs/product/decisions.md` precede this plan; then the approved ticket scope and owning contracts. Tail owner is the Khala Executor. This ticket does not grant authority over sibling Aiur processes or configuration.

Prerequisites and stop conditions: KHA-138 and139 real evidence, selected task, required docs, approved deployment/security behavior. This acceptance plan is executable when predecessors pass; it does not predeclare that they will.

---

## Product Contract

### Summary and problem frame

Close the build order only when the actual product meets the agreed cross-owner collaboration contract. Khala currently has research and proposal documents, so this work must define its own evidence without claiming an existing implemented subsystem.

### Requirements

- R1. Validate the selected collaboration journey on the merged base with real existing sessions.
- R2. Collect separate security, operational and user-experience evidence tied to exact builds.
- R3. Finish user and adapter documentation and record remaining limitations without silently expanding scope.

### Acceptance examples

- AE1. All leaf tickets are closed but third-owner admission has no evidence: root remains unaccepted.
- AE2. Security proof passes while a stale build was used for collaboration: rerun affected proof on the actual release candidate.

### Scope and decisions

Use requirement-to-evidence acceptance matrix and independent security/collaboration reports. The capstone reviews integrated behavior; component defects return to their owners instead of turning this ticket into a rewrite.

Carry forward TypeScript, OSS reuse, Netlify preference, existing-session attachment, connector-gated E2EE review, and dashboard-native design. This ticket cannot add human technical setup or silently change an unresolved product policy.

---

## Planning Contract

Product Contract unchanged. An implementation-ready **plan** is not a claim that prerequisites have passed or that the ticket is dispatchable today. Resolve the named dependency and environment gates before production mutation; bounded local work may proceed where explicitly described.

### Grounding and technical decisions

KTD1. Use requirement-to-evidence acceptance matrix and independent security/collaboration reports. The capstone reviews integrated behavior; component defects return to their owners instead of turning this ticket into a rewrite.

KTD2. Keep platform operations separate from feature policy. Reuse upstream service/SDK behavior and narrow ports; no custom cryptography, replacement session or shared mutable application store is introduced here.

KTD3. Reserve shared manifests/lockfile and app entrypoints for their assigned owner. Components land against real reviewed contracts and isolated fixtures; integration owns binding to live implementations. See `docs/product/repo-layout.md`.

KTD4. User-directed TypeScript and Netlify preference remain constraints; Railway-hosted OSS is acceptable where it saves development. The owner-side continuous subscriber cannot live inside a request-lifetime function. (session-settled: user-directed — chosen over a mandatory custom Hono backend: reduce ongoing backend development and operation.)

### Existing evidence and refreshable implementation pointers

Khala researched base: `6d4694173eff9b0832f4c3a2cdb90b4281fcccd9`; proposed paths below do not exist as app implementation yet. Archon reference: `c7d3254097acaa02eed1e3be6fd8fbf06c0e8128`, especially `netlify.toml`, `package.json`, `netlify/lib/store.mjs`, and `netlify/lib/hosted/record-store.mjs` in that repository. Aiur reference: `1f618cddf601a0b6d79bc1197579746b7584a64c`; its dashboard supplies design language, not the runtime language or service topology. Refresh source/version facts at worker pickup without changing accepted product requirements.

### Proposed owned files

- `docs/product/release-acceptance.md`
- `docs/user-guide.md`
- `docs/adapter-guide.md`

### Worked boundary record

The following is an example record, not an assertion of collected runtime evidence. Fields marked recorded/resolved are required outputs of the implementation proof.

```json
{
  "release_commit": "full-sha",
  "requirements": [
    {
      "id": "R15",
      "result": "pass|fail|unknown",
      "evidence": "artifact-reference"
    }
  ],
  "security": "artifact-reference",
  "collaboration": "artifact-reference",
  "root_acceptance": "blocked-until-proof"
}
```

### Dependencies and limits

Hard ticket prerequisites: KHA-138, KHA-139. Gates: KHA-138 and139 real evidence, selected task, required docs, approved deployment/security behavior. This acceptance plan is executable when predecessors pass; it does not predeclare that they will.

Every proposed verification command below is an implementation-time contract, not a command claimed to run during planning. The owning implementation must add the named script/entrypoint before invoking it. Package-manager and native SDK versions are pinned from actual supported releases at implementation; this plan does not fabricate a tested dependency tuple.

---

## Implementation Units

### U1. Assemble build-specific evidence

**Goal:** Assemble build-specific evidence.

**Requirements:** R1; overall R1–R3, AE1–AE2 constrain the completed ticket.

**Dependencies:** None beyond ticket prerequisites.

**Files:** `docs/product/release-acceptance.md`.

**Approach:** Link138 security,139 collaboration and109 restore evidence to current commit/config/version identifiers. Check required predecessor results and outstanding gates.

**Patterns:** KTD1–KTD4; referenced upstream behavior and owned sibling boundaries.

**Test scenarios:** Missing evidence, wrong SHA or unresolved high-severity finding blocks acceptance; unknown is never rendered as pass.

**Verification:** Record the observed pass/fail result, exact build/environment and sanitized evidence; do not infer runtime success from configuration parsing alone.

### U2. Verify ordinary user journey

**Goal:** Verify ordinary user journey.

**Requirements:** R2; overall R1–R3, AE1–AE2 constrain the completed ticket.

**Dependencies:** U1.

**Files:** `docs/product/release-acceptance.md`.

**Approach:** Observe OAuth/create/name/share-link flow, own-agent auto setup, coworker join, multi-message intros and exact release; add third human/agent. Inspect dashboard-native layout and keyboard/mobile states.

**Patterns:** KTD1–KTD4; referenced upstream behavior and owned sibling boundaries.

**Test scenarios:** No manual install/config appears; full human chat remains distinct from released agent context; third owner has independent review.

**Verification:** Record the observed pass/fail result, exact build/environment and sanitized evidence; do not infer runtime success from configuration parsing alone.

### U3. Publish support and adapter guidance

**Goal:** Publish support and adapter guidance.

**Requirements:** R3; overall R1–R3, AE1–AE2 constrain the completed ticket.

**Dependencies:** U2.

**Files:** `docs/user-guide.md`, `docs/adapter-guide.md`.

**Approach:** Describe supported harness capabilities, busy/unknown outcomes, disconnect/recovery, trust re-arm and encryption boundary. Record supported versions and module/port extension points.

**Patterns:** KTD1–KTD4; referenced upstream behavior and owned sibling boundaries.

**Test scenarios:** A new adapter author can run conformance suite; user troubleshooting does not ask for raw tokens or plaintext chat logs.

**Verification:** Record the observed pass/fail result, exact build/environment and sanitized evidence; do not infer runtime success from configuration parsing alone.

### U4. Apply finite completion boundary

**Goal:** Apply finite completion boundary.

**Requirements:** R3; overall R1–R3, AE1–AE2 constrain the completed ticket.

**Dependencies:** U3.

**Files:** `docs/product/release-acceptance.md`.

**Approach:** Classify findings as contained rework, independent acceptance blockers or deferred nonblocking scope. Confirm experimental/fixture code is excluded from production.

**Patterns:** KTD1–KTD4; referenced upstream behavior and owned sibling boundaries.

**Test scenarios:** Root acceptance names actual observed evidence and reviewer; closing children alone cannot change result; no open blocking gate is ignored.

**Verification:** Record the observed pass/fail result, exact build/environment and sanitized evidence; do not infer runtime success from configuration parsing alone.

---

## Verification Contract

| Check | Expected evidence |
|---|---|
| `pnpm typecheck` | Successful relevant validation after its owning script exists; failed prerequisites remain explicit. |
| `pnpm lint` | Successful relevant validation after its owning script exists; failed prerequisites remain explicit. |
| `pnpm test` | Successful relevant validation after its owning script exists; failed prerequisites remain explicit. |
| `pnpm build` | Successful relevant validation after its owning script exists; failed prerequisites remain explicit. |
| `KHALA_E2E_LIVE=1 pnpm test:e2e -- --scenario first-collaboration` | Successful relevant validation after its owning script exists; failed prerequisites remain explicit. |

KHA-137 owns root `pnpm test:e2e` and `pnpm test:conformance`; its default fake/self-test does not count as live acceptance.

Feature tests must exercise behavior and failure cases rather than mirror constants. Pure docs/config units use schema/config/build and real smoke evidence instead of artificial unit tests. A test double proves a component contract; it cannot prove production identity, crypto persistence, hosted routing or session delivery. Integration owners in the graph supply that proof.

Security checks use synthetic data and disposable identities. Do not publish raw environment dumps, process arguments, token-bearing URLs, database credentials, server signing keys or decrypted participant messages. Failure logs preserve request IDs and reason codes without content.

---

## Definition of Done

All R1–R3 and AE1–AE2 have evidence. All U-IDs satisfy their stated validation; unresolved external gates prevent a pass for dependent outcomes. Owned code/docs land green on current base, no abandoned experiment or fixture is exported into production, and shared file ownership remains intact. The Executor receives exact changed paths, tests run, unavailable checks and remaining limitations.

### Sources



Local context: `docs/product/tickets/KHA-140.md`, `docs/product/repo-layout.md`, `docs/product/decisions.md`, and `docs/research/11-hosting-tradeoffs.md`. Official sources checked 2026-09-16; changing behavior must be rechecked at implementation.
