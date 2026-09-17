---
title: "KHA-128 Implement device and agent revocation - Plan"
type: feat
date: 2026-09-16
topic: device-agent-revocation
artifact_contract: ce-unified-plan/v1
artifact_readiness: requirements-only
product_contract_source: ce-brainstorm
deepened: 2026-09-16
execution: code
origin: docs/product/tickets/KHA-128.md
---

# KHA-128 Implement device and agent revocation - Plan

## Goal Capsule

Deliver implement device and agent revocation. Authority: latest user decisions, then `docs/product/decisions.md`, the approved scope card, and this contract. Dependencies: KHA-101, KHA-105. Product trace: R06, R14. Open launch gates: G-SUBSTRATE and G-RETENTION; revocation guarantee/SDK key-share semantics.

Implementation belongs to the assigned ticket worker after gates clear. Root dependency changes, integration wiring, tracker publication and executor startup remain with their named owners. This artifact does not claim runtime proof.

---

## Product Contract

### Summary

Allow authorised humans to revoke device or connector authority with SDK-backed future-access semantics. This ticket covers the bounded outcome in `docs/product/tickets/KHA-128.md`.

### Problem Frame

Logging a device out does not erase its existing decryption keys, and silently relabelling a replacement can release queued content to the wrong endpoint.

### Requirements

- R1. Allow authorised humans to revoke device or connector authority with SDK-backed future-access semantics.
- R2. Show control revocation and cryptographic exclusion progress separately.
- R3. Prevent replacement bindings from silently inheriting automatic trust or queued delivery authority.
- R4. Explain that previously disclosed plaintext and retained keys cannot be recalled.

### Actors and flow

A1 is the owning human; A2 is their trusted owner connector; A3 is the model-facing adapter; A4 is the ciphertext delivery/control service. Human identity and agent identity remain distinct.

F1. An authorised actor requests this ticket's operation; the owning module validates current identity/state, returns an explicit result, and downstream consumers retain the narrow meaning of that result. Failures remain visible and retries preserve the original operation identity.

### Acceptance Examples

- AE1. The owner revokes a binding; local disable and protocol/device effects are reported separately and reconcile after retry. Covers R1, R2.
- AE2. An offline endpoint is not reported stopped; a previously decrypted event is not falsely described as remotely erased. Covers R3, R4.

### Key Decisions

Connector-gated review is the confidentiality boundary (session-settled: user-directed — chosen over separate human-only encryption groups: the owner connector may hold pending plaintext). Application code remains TypeScript with OSS reuse (session-settled: user-directed — chosen over building a new custom stack by default: reduce implementation ownership). Netlify is preferred; Railway is acceptable when reuse saves work. Existing sessions remain the target; a fresh replacement conversation is not equivalent.

### Scope Boundaries

Only the scope card's owned paths may change. Production features are not implemented by feasibility tickets. This ticket cannot choose a new recovery promise, add human connector setup, select a provider through a fixture, or redesign the Aiur dashboard shell. KHA-107/143 own its client reuse/navigation decisions.

### Open Questions

G-SUBSTRATE and G-RETENTION; revocation guarantee/SDK key-share semantics.

### Sources

- `docs/product/tickets/KHA-128.md`, `docs/product/repo-layout.md`, `docs/product/decisions.md`.
- `docs/research/04-identity-trust.md`, `docs/research/05-e2ee.md`, `docs/research/08-security-evidence.md`.

---

## Planning Contract

Planning baseline: Khala `6d4694173eff9b0832f4c3a2cdb90b4281fcccd9`; inspected Archon `c7d3254097acaa02eed1e3be6fd8fbf06c0e8128` and Aiur `1f618cddf601a0b6d79bc1197579746b7584a64c`. `docs/evidence/security-planning-sources.json` pins external source reads. Proposed paths are future outputs, not claims of existing implementation. Product requirements preserved; acceptance examples clarified against the same requirements during review.

### Key Technical Decisions

- KTD1. `createRevocationService` implements105 RevocationPort under `packages/messaging/src/revocation/`. Validate authenticated human ownership and expected target generation before any SDK effect. Binding revocation and protocol device deletion are different operations and must report separate completion.
- KTD2. Persist a revocation operation intent via injected storage before remote effects; resume by operation ID. Mark binding disabled before accepting new Khala releases. Reconcile SDK/device result after lost response; never turn transport timeout into success.
- KTD3. Revoke future access according to selected SDK membership/device/key-sharing behavior proven by102/141/142. Device removal does not erase old plaintext, exported keys or another still-valid account credential. Group key rotation and share policy are protocol operations, not custom cryptography.
- KTD4. G-RETENTION must decide removed-member history access and deletion promises. This ticket reports achieved boundaries rather than promising remote erasure.

### Operation state

`requested → local_disabled → protocol_pending → completed|partial|failed`. `inspect` exposes each achieved boundary and retryability. A disconnected connector has not acknowledged local disable; show pending enforcement rather than asserting it stopped. Late SDK events carry generation and cannot reactivate a binding. A session rebind creates a new generation and requires its own authority.


---

## Implementation Units

### U1. Validate and persist revocation intent

**Goal:** Validate and persist revocation intent. **Requirements:** R1–R4; F1; applicable KTDs below. **Dependencies:** upstream tickets in Goal Capsule. **Files:** `packages/messaging/src/revocation/{service,operation}.ts`, `operation.test.ts`.

**Approach:** Inject ownership lookup, operation journal, SDK revocation and connector-control ports; no direct control backend import.

**Patterns to follow:** The named contract in KHA-105/106 and the source pattern cited in this Planning Contract; preserve the owned directory boundary.

**Test scenarios:**

- Wrong owner and stale generation reject before effect.
- Same operation ID returns original intent; changed target conflicts.
- Journal write failure prevents unaudited remote effect.

**Verification:** The listed scenarios pass in the owned tests; record the observed result and relevant version/generation. A mocked result proves only module behavior, not a provider capability.

### U2. Reconcile local and protocol boundaries

**Goal:** Reconcile local and protocol boundaries. **Requirements:** R1–R4; F1; applicable KTDs below. **Dependencies:** U1. **Files:** `packages/messaging/src/revocation/reconcile.ts`, `reconcile.test.ts`.

**Approach:** Track protocol and connector acknowledgments independently, following111 generation invalidation.

**Patterns to follow:** The named contract in KHA-105/106 and the source pattern cited in this Planning Contract; preserve the owned directory boundary.

**Test scenarios:**

- Lost SDK response queries status instead of assuming deletion.
- Offline connector leaves partial/pending result.
- Duplicate acknowledgment is harmless; previous-generation callback ignored.

**Verification:** The listed scenarios pass in the owned tests; record the observed result and relevant version/generation. A mocked result proves only module behavior, not a provider capability.

### U3. Publish capabilities and evidence cases

**Goal:** Publish capabilities and evidence cases. **Requirements:** R1–R4; F1; applicable KTDs below. **Dependencies:** U2. **Files:** `packages/messaging/src/revocation/index.ts`, `revocation.integration.test.ts`, `README.md`.

**Approach:** Document substrate-specific forward-access limits for136.

**Patterns to follow:** The named contract in KHA-105/106 and the source pattern cited in this Planning Contract; preserve the owned directory boundary.

**Test scenarios:**

- The revoked device or binding cannot newly access a test event through the revoked capability under the approved sharing policy; a separately authorized remaining device is tested independently.
- Existing decrypted content is still accessible locally, recorded as expected limitation.
- Remaining devices and credentials are accounted for explicitly.

**Verification:** The listed scenarios pass in the owned tests; record the observed result and relevant version/generation. A mocked result proves only module behavior, not a provider capability.

---

## Verification Contract

Planned messaging typecheck/test and `pnpm check:boundaries`; integration target uses isolated accounts with actual selected SDK.136 consumes public operation statuses;138 repeats future-access proof. G-SUBSTRATE/G-RETENTION must be closed before dispatch.

## Definition of Done

Revocation accurately separates local disable, remote device/membership effect and effective acknowledgment; lost responses recover without overstating erasure. Remove abandoned-attempt code and temporary credentials; leave evidence free of message bodies, raw tokens and private keys. Do not change sibling implementations to make this ticket pass; return component defects to the named owner.

### Planning review and remaining confidence

Serial coherence, feasibility, security and adversarial review completed; see `docs/plans/reviews/security-planning-review.md`. This is a planning review, not a runtime security certification. Production implementation must record executed commands and observed evidence.

### Revocation target precision

The105 port targets one device or binding. A binding revocation blocks new Khala release/dispatch authority for that binding; it does not by itself revoke the messaging account or remove room membership. Device revocation tests the selected SDK’s actual future key-sharing/access boundary, not all devices of the participant. Another still-authorized device may receive new events as designed. Participant membership removal requires an independently approved capability and separate test; it is not inferred from this port.
