---
title: "KHA-129 Implement encrypted recovery - Plan"
type: feat
date: 2026-09-16
topic: encrypted-recovery
artifact_contract: ce-unified-plan/v1
artifact_readiness: requirements-only
product_contract_source: ce-brainstorm
deepened: 2026-09-16
execution: code
origin: docs/product/tickets/KHA-129.md
---

# KHA-129 Implement encrypted recovery - Plan

## Goal Capsule

Deliver implement encrypted recovery. Authority: latest user decisions, then `docs/product/decisions.md`, the approved scope card, and this contract. Dependencies: KHA-101, KHA-105. Product trace: R06, R14. Open launch gates: G-RETENTION and G-SUBSTRATE: all-device-loss promise and backup policy.

Implementation belongs to the assigned ticket worker after gates clear. Root dependency changes, integration wiring, tracker publication and executor startup remain with their named owners. This artifact does not claim runtime proof.

---

## Product Contract

### Summary

Recover only the history supported by the approved policy and SDK recovery material. This ticket covers the bounded outcome in `docs/product/tickets/KHA-129.md`.

### Problem Frame

Successful OAuth login can be mistaken for restoration of encrypted history; restoring device snapshots can also replay old work.

### Requirements

- R1. Recover only the history supported by the approved policy and SDK recovery material.
- R2. Distinguish account login recovery from message-key recovery.
- R3. Keep plaintext recovery secrets off backend control and telemetry surfaces.
- R4. Expose unrecoverable history and prevent restore from cloning an active writer or resubmitting old deliveries.

### Actors and flow

A1 is the owning human; A2 is their trusted owner connector; A3 is the model-facing adapter; A4 is the ciphertext delivery/control service. Human identity and agent identity remain distinct.

F1. An authorised actor requests this ticket's operation; the owning module validates current identity/state, returns an explicit result, and downstream consumers retain the narrow meaning of that result. Failures remain visible and retries preserve the original operation identity.

### Acceptance Examples

- AE1. An approved encrypted recovery mechanism restores a designated pre-loss event, with endpoint-only secret handling. Covers R1, R2.
- AE2. OAuth login without recovery material remains locked/unrecoverable and does not replay completed or old-generation releases. Covers R3, R4.

### Key Decisions

Connector-gated review is the confidentiality boundary (session-settled: user-directed — chosen over separate human-only encryption groups: the owner connector may hold pending plaintext). Application code remains TypeScript with OSS reuse (session-settled: user-directed — chosen over building a new custom stack by default: reduce implementation ownership). Netlify is preferred; Railway is acceptable when reuse saves work. Existing sessions remain the target; a fresh replacement conversation is not equivalent.

### Scope Boundaries

Only the scope card's owned paths may change. Production features are not implemented by feasibility tickets. This ticket cannot choose a new recovery promise, add human connector setup, select a provider through a fixture, or redesign the Aiur dashboard shell. KHA-107/143 own its client reuse/navigation decisions.

### Open Questions

G-RETENTION and G-SUBSTRATE: all-device-loss promise and backup policy.

### Sources

- `docs/product/tickets/KHA-129.md`, `docs/product/repo-layout.md`, `docs/product/decisions.md`.
- `docs/research/04-identity-trust.md`, `docs/research/05-e2ee.md`, `docs/research/08-security-evidence.md`.

---

## Planning Contract

Planning baseline: Khala `6d4694173eff9b0832f4c3a2cdb90b4281fcccd9`; inspected Archon `c7d3254097acaa02eed1e3be6fd8fbf06c0e8128` and Aiur `1f618cddf601a0b6d79bc1197579746b7584a64c`. `docs/evidence/security-planning-sources.json` pins external source reads. Proposed paths are future outputs, not claims of existing implementation. Product requirements preserved; acceptance examples clarified against the same requirements during review.

### Key Technical Decisions

- KTD1. `createRecoveryService` implements105 RecoveryPort. Reuse selected SDK encrypted key-backup/device verification APIs; no home-grown wrapping or server-readable recovery escrow. OAuth identity recovery does not itself recover message keys.
- KTD2. `capabilities` reports only modes actually proven141/142 and approved G-RETENTION. Secret input is an endpoint-local callback into SDK crypto, not an HTTP control argument, telemetry field or serialized application store. Browser persistent key security remains bounded by same-origin code trust.
- KTD3. Recovery is resumable by operation ID with safe public status. Enumerate restored versus unavailable history without claiming completeness from one successful decrypt. Backup version/trust mismatch must be surfaced; do not automatically trust a server-provided backup key.
- KTD4. A recovered or replacement connector does not inherit an old session binding/release claim silently. Restore crypto state and then require explicit verified binding generation handling through114/115/121; do not replay released jobs as a consequence of importing keys.

### State semantics

`locked → restoring → restored|partial|unrecoverable|failed`. Wrong secret permits bounded retry according to approved policy, without distinguishing unrelated owners' backups. Interrupted restore may resume the same operation. Logout/account switch stops old callbacks and removes in-memory secrets. Product gate chooses supported recovery story; absence of recoverable keys is an honest unrecoverable state, never a fresh keyset presented as old history.


---

## Implementation Units

### U1. Project supported recovery capabilities

**Goal:** Project supported recovery capabilities. **Requirements:** R1–R4; F1; applicable KTDs below. **Dependencies:** upstream tickets in Goal Capsule. **Files:** `packages/messaging/src/recovery/{service,capabilities}.ts`, `capabilities.test.ts`.

**Approach:** Inject SDK capabilities, verified account and public operation journal.

**Patterns to follow:** The named contract in KHA-105/106 and the source pattern cited in this Planning Contract; preserve the owned directory boundary.

**Test scenarios:**

- Unsupported mode is unavailable, not fabricated wizard success.
- OAuth login without keys remains locked.
- Backup identity/version mismatch blocks restore.

**Verification:** The listed scenarios pass in the owned tests; record the observed result and relevant version/generation. A mocked result proves only module behavior, not a provider capability.

### U2. Restore through endpoint-only crypto

**Goal:** Restore through endpoint-only crypto. **Requirements:** R1–R4; F1; applicable KTDs below. **Dependencies:** U1. **Files:** `packages/messaging/src/recovery/restore.ts`, `restore.test.ts`.

**Approach:** Feed user secret directly to SDK local API and redact failures; persist only nonsecret progress.

**Patterns to follow:** The named contract in KHA-105/106 and the source pattern cited in this Planning Contract; preserve the owned directory boundary.

**Test scenarios:**

- Wrong secret contains no entered value in errors/logs.
- Cancellation/account switch discards late callbacks.
- Partial available history reports partial rather than restored-all.

**Verification:** The listed scenarios pass in the owned tests; record the observed result and relevant version/generation. A mocked result proves only module behavior, not a provider capability.

### U3. Verify restart without delivery replay

**Goal:** Verify restart without delivery replay. **Requirements:** R1–R4; F1; applicable KTDs below. **Dependencies:** U2. **Files:** `packages/messaging/src/recovery/index.ts`, `recovery.integration.test.ts`, `README.md`.

**Approach:** Produce actual lost-store/restore scenario using the approved SDK backup mechanism. Inject a fake ledger/binding port for component-level no-replay and stale-generation tests; do not import or wait for115 implementation. KHA-136 wires and verifies recovery against the real115 ledger.

**Patterns to follow:** The named contract in KHA-105/106 and the source pattern cited in this Planning Contract; preserve the owned directory boundary.

**Test scenarios:**

- Restore recovers designated pre-loss event using real crypto.
- No key means unrecoverable; no plaintext server fallback.
- Restored connector cannot dispatch old-generation jobs or duplicate completed releases.

**Verification:** The listed scenarios pass in the owned tests; record the observed result and relevant version/generation. A mocked result proves only module behavior, not a provider capability.

---

## Verification Contract

Planned messaging typecheck/test, registered real-SDK recovery target, and `pnpm check:boundaries`.136 proves user journey;138 checks server and model surfaces. Backup restore proof must include an event from before loss and a separate unavailable-history example. G-SUBSTRATE/G-RETENTION remain blocking.

## Definition of Done

Recovery capability and limitations match evidence; no secret crosses control API; missing keys stay explicit; history recovery does not reopen delivery authority. Remove abandoned-attempt code and temporary credentials; leave evidence free of message bodies, raw tokens and private keys. Do not change sibling implementations to make this ticket pass; return component defects to the named owner.

### Planning review and remaining confidence

Serial coherence, feasibility, security and adversarial review completed; see `docs/plans/reviews/security-planning-review.md`. This is a planning review, not a runtime security certification. Production implementation must record executed commands and observed evidence.

### Independent review dependency clarification

KHA-115 is the eventual durable ledger producer, not an added129 predecessor.129 component tests use explicit injected ledger/binding snapshots and assert recovery emits no dispatch or authority-transfer effect. KHA-136 owns the live restored-crypto plus real115-ledger composition proof; mocked ledger success cannot certify that integration.
