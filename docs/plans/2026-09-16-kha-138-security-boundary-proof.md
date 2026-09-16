---
title: "KHA-138 Prove encryption and approval boundaries - Plan"
type: feat
date: 2026-09-16
topic: security-boundary-proof
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-brainstorm
deepened: 2026-09-16
execution: code
origin: docs/product/tickets/KHA-138.md
---

# KHA-138 Prove encryption and approval boundaries - Plan

## Goal Capsule

Deliver prove encryption and approval boundaries. Authority: latest user decisions, then `docs/product/decisions.md`, the approved scope card, and this contract. Dependencies: KHA-134, KHA-135, KHA-136, KHA-137. Product trace: R04, R05, R06, R14. Open launch gates: Depends on real134/135/136/137 merged integration evidence; no approval for synthetic production claims.

Implementation belongs to the assigned ticket worker after gates clear. Root dependency changes, integration wiring, tracker publication and executor startup remain with their named owners. This artifact does not claim runtime proof.

---

## Product Contract

### Summary

Inspect actual merged-system storage and logs for message bodies and decryption secrets. This ticket covers the bounded outcome in `docs/product/tickets/KHA-138.md`.

### Problem Frame

Unit tests cannot prove that production composition, notification metadata, error paths and history adapters preserve the encryption and release boundaries together.

### Requirements

- R1. Inspect actual merged-system storage and logs for message bodies and decryption secrets.
- R2. Exercise every registered model-facing surface against unreleased content.
- R3. Prove forged approvals, stale bindings and restart/re-arm races cannot bypass the approved connector policy.
- R4. Record scoped reproducible evidence and explicit limits instead of a blanket security certification.

### Actors and flow

A1 is the owning human; A2 is their trusted owner connector; A3 is the model-facing adapter; A4 is the ciphertext delivery/control service. Human identity and agent identity remain distinct.

F1. An authorised actor requests this ticket's operation; the owning module validates current identity/state, returns an explicit result, and downstream consumers retain the narrow meaning of that result. Failures remain visible and retries preserve the original operation identity.

### Acceptance Examples

- AE1. The wired system passes a positive approved-message control while the pending canary is absent from every inventoried model-facing surface. Covers R1, R2.
- AE2. A newly registered untested surface, forged approval or leaked canary causes an explicit failing boundary result. Covers R3, R4.

### Key Decisions

Connector-gated review is the confidentiality boundary (session-settled: user-directed — chosen over separate human-only encryption groups: the owner connector may hold pending plaintext). Application code remains TypeScript with OSS reuse (session-settled: user-directed — chosen over building a new custom stack by default: reduce implementation ownership). Netlify is preferred; Railway is acceptable when reuse saves work. Existing sessions remain the target; a fresh replacement conversation is not equivalent.

### Scope Boundaries

Only the scope card's owned paths may change. Production features are not implemented by feasibility tickets. This ticket cannot choose a new recovery promise, add human connector setup, select a provider through a fixture, or redesign the Aiur dashboard shell. KHA-107/143 own its client reuse/navigation decisions.

### Open Questions

Depends on real134/135/136/137 merged integration evidence; no approval for synthetic production claims.

### Sources

- `docs/product/tickets/KHA-138.md`, `docs/product/repo-layout.md`, `docs/product/decisions.md`.
- `docs/research/04-identity-trust.md`, `docs/research/05-e2ee.md`, `docs/research/08-security-evidence.md`.

---

## Planning Contract

Planning baseline: Khala `6d4694173eff9b0832f4c3a2cdb90b4281fcccd9`; inspected Archon `c7d3254097acaa02eed1e3be6fd8fbf06c0e8128` and Aiur `1f618cddf601a0b6d79bc1197579746b7584a64c`. `docs/evidence/security-planning-sources.json` pins external source reads. Proposed paths are future outputs, not claims of existing implementation. Product requirements preserved; acceptance examples clarified against the same requirements during review.

### Key Technical Decisions

- KTD1. Tests use real wired composition134/135/136/137 and inventory every registered model-facing tool/resource, read/history/search endpoint, notification and error surface. Fail the inventory if a new surface lacks a boundary assertion. Test-only mock ports cannot certify the production wiring.
- KTD2. Seed distinct cryptographically random canaries in pending and approved messages. Inspect reachable responses, adapter calls, logs and owned relay persistence for these exact strings and encoded variants. Canary absence supports the tested paths only; it is not a proof against arbitrary encodings or compromised endpoint code.
- KTD3. Trusted endpoint plaintext is allowed. Relay/control must lack E2EE keys and message plaintext; model surfaces must lack pending text until authorization. Inference provider receives approved content when the harness uses it: transport E2EE does not hide that content from the chosen model service.
- KTD4. Destructive restart/revocation/key-loss tests use isolated test identities and stores. Save evidence with SDK/app SHA, environment, test IDs and redacted outcomes. Never upload real user content, keys, cookies or public working-room invitations.

### Required adversarial matrix

| Boundary | Positive control | Negative/race evidence |
|---|---|---|
| Relay confidentiality | Both endpoints decrypt intended event | Server records/logs contain neither canary nor crypto secrets |
| Review gate | Exact chosen event reaches intended existing session | Pending neighbor absent from every registered model surface |
| Human authority | Authenticated owner approval accepted | Peer/model/client boolean forgery rejected |
| Recipient binding | Current generation accepts release | Rebind after approval and stale generation before dispatch held |
| Policy | Effective approved auto mode works | Unacknowledged rearm accurately pending; reconnect reconciles latest policy |
| Recovery/revocation | Approved restore recovers prior event | Lost keys never trigger plaintext fallback; revoked actor cannot access new event |
| Delivery ambiguity | Accepted release observed once when knowable | Crash after harness acceptance remains explicit ambiguity, no invented exactly-once |

### Scope and risks

This suite documents unrestricted same-host agent access as outside the connector-gate guarantee. It must not weaken test expectations to hide a defect in a sibling module; report the minimal reproducer to that ticket owner. Missing provider log access is a verification gap, not a successful server-log inspection.


---

## Implementation Units

### U1. Build surface inventory and canary harness

**Goal:** Build surface inventory and canary harness. **Requirements:** R1–R4; F1; applicable KTDs below. **Dependencies:** upstream tickets in Goal Capsule. **Files:** `tests/e2e/security/{inventory,fixtures}.ts`, `inventory.test.ts`.

**Approach:** Discover registered surfaces from actual app manifests/routers and compare checked inventory. Provision disposable participants and separate approved/pending canaries.

**Patterns to follow:** The named contract in KHA-105/106 and the source pattern cited in this Planning Contract; preserve the owned directory boundary.

**Test scenarios:**

- Unlisted surface fails coverage audit.
- Positive control detects deliberate canary leak.
- No test artifact stores a raw credential.

**Verification:** The listed scenarios pass in the owned tests; record the observed result and relevant version/generation. A mocked result proves only module behavior, not a provider capability.

### U2. Prove authority and confidentiality boundaries

**Goal:** Prove authority and confidentiality boundaries. **Requirements:** R1–R4; F1; applicable KTDs below. **Dependencies:** U1. **Files:** `tests/e2e/security/{airlock,relay,forgery}.test.ts`.

**Approach:** Run complete create/join/send/review through real integration; capture model calls and accessible service stores.

**Patterns to follow:** The named contract in KHA-105/106 and the source pattern cited in this Planning Contract; preserve the owned directory boundary.

**Test scenarios:**

- Approved exact item appears; neighbor does not.
- Forged owner/policy mutation and cross-room reference rejected.
- Server persisted ciphertext cannot be decrypted with server configuration alone under tested setup.

**Verification:** The listed scenarios pass in the owned tests; record the observed result and relevant version/generation. A mocked result proves only module behavior, not a provider capability.

### U3. Inject restart and lifecycle faults

**Goal:** Inject restart and lifecycle faults. **Requirements:** R1–R4; F1; applicable KTDs below. **Dependencies:** U2. **Files:** `tests/e2e/security/{restart,revocation,recovery}.test.ts`.

**Approach:** Terminate processes at journal/SDK/harness boundaries and reconcile before retry.

**Patterns to follow:** The named contract in KHA-105/106 and the source pattern cited in this Planning Contract; preserve the owned directory boundary.

**Test scenarios:**

- Crash before/after harness acceptance yields accurate status and no blind retry.
- Revocation and key-loss recovery obey approved boundaries.
- Old-generation callback cannot leak to replacement session.

**Verification:** The listed scenarios pass in the owned tests; record the observed result and relevant version/generation. A mocked result proves only module behavior, not a provider capability.

### U4. Publish bounded acceptance evidence

**Goal:** Publish bounded acceptance evidence. **Requirements:** R1–R4; F1; applicable KTDs below. **Dependencies:** U3. **Files:** `docs/evidence/security-acceptance.md`.

**Approach:** Record each matrix row pass/fail/not-observed with exact command/build/source and remaining limits.

**Patterns to follow:** The named contract in KHA-105/106 and the source pattern cited in this Planning Contract; preserve the owned directory boundary.

**Test scenarios:**

- Missing logs/capability marked not-observed.
- A failed boundary blocks acceptance; documented non-guarantee is not silently converted into pass.

**Verification:** The listed scenarios pass in the owned tests; record the observed result and relevant version/generation. A mocked result proves only module behavior, not a provider capability.

---

## Verification Contract

After integration prerequisites: planned `KHALA_E2E_LIVE=1 pnpm test:e2e -- tests/e2e/security/security.test.ts` (101/137 register the common test:e2e target), `pnpm check:boundaries`, and the suite's inventory check. Require positive leak-detection control, actual existing-session receipt and process-restart evidence. Scripts do not exist yet; creating them outside owned surface is101 coordination, not this worker's edit.

## Definition of Done

Every matrix row has verifiable evidence or explicit blocking failure; model surface inventory is complete for the tested build; no cryptographic/inference/host-isolation guarantee exceeds observed scope. Remove abandoned-attempt code and temporary credentials; leave evidence free of message bodies, raw tokens and private keys. Do not change sibling implementations to make this ticket pass; return component defects to the named owner.

### Planning review and remaining confidence

Serial coherence, feasibility, security and adversarial review completed; see `docs/plans/reviews/security-planning-review.md`. This is a planning review, not a runtime security certification. Production implementation must record executed commands and observed evidence.

### Acceptance runner alignment

Own `tests/e2e/security/security.test.ts` as the common137 runner entry; delegate to the named security scenarios. Live acceptance fails if all cases skip, while missing disposable environment inputs remain explicit blocked evidence. This reuses the shared test:e2e script rather than adding a competing root command.
