---
title: "KHA-142 Prove TypeScript headless crypto persistence - Plan"
type: feat
date: 2026-09-16
topic: headless-crypto-proof
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-brainstorm
deepened: 2026-09-16
execution: code
origin: docs/product/tickets/KHA-142.md
---

# KHA-142 Prove TypeScript headless crypto persistence - Plan

## Goal Capsule

Deliver prove typescript headless crypto persistence. Authority: latest user decisions, then `docs/product/decisions.md`, the approved scope card, and this contract. Dependencies: None. Product trace: R06, R10, R13, R14. Open launch gates: No product blocker for isolated proof; deployment/SDK selection follows evidence.

Implementation belongs to the assigned ticket worker after gates clear. Root dependency changes, integration wiring, tracker publication and executor startup remain with their named owners. This artifact does not claim runtime proof.

---

## Product Contract

### Summary

Prove a TypeScript owner runtime preserves device identity and decryptability through process restart. This ticket covers the bounded outcome in `docs/product/tickets/KHA-142.md`.

### Problem Frame

The browser SDK's documented non-IndexedDB mode is ephemeral; assuming that example is a durable bot would create a fresh device after every restart.

### Requirements

- R1. Prove a TypeScript owner runtime preserves device identity and decryptability through process restart.
- R2. Record native packaging, supported runtime and verification constraints of the pinned engine/bindings.
- R3. Exercise corruption, duplicate processes and ambiguous shutdown rather than relying on clean-exit persistence.
- R4. Keep encryption keys on the owner machine and avoid inventing a new messaging crypto protocol.

### Actors and flow

A1 is the owning human; A2 is their trusted owner connector; A3 is the model-facing adapter; A4 is the ciphertext delivery/control service. Human identity and agent identity remain distinct.

F1. An authorised actor requests this ticket's operation; the owning module validates current identity/state, returns an explicit result, and downstream consumers retain the narrow meaning of that result. Failures remain visible and retries preserve the original operation identity.

### Acceptance Examples

- AE1. A pinned TypeScript/native SDK process restarts with the same local store and decrypts the pre-restart event using the same device. Covers R1, R2.
- AE2. Unsupported native engine or lost store is reported as a reproducible failure, without substituting a memory store or claiming fresh keys recovered history. Covers R3, R4.

### Key Decisions

Connector-gated review is the confidentiality boundary (session-settled: user-directed — chosen over separate human-only encryption groups: the owner connector may hold pending plaintext). Application code remains TypeScript with OSS reuse (session-settled: user-directed — chosen over building a new custom stack by default: reduce implementation ownership). Netlify is preferred; Railway is acceptable when reuse saves work. Existing sessions remain the target; a fresh replacement conversation is not equivalent.

### Scope Boundaries

Only the scope card's owned paths may change. Production features are not implemented by feasibility tickets. This ticket cannot choose a new recovery promise, add human connector setup, select a provider through a fixture, or redesign the Aiur dashboard shell. KHA-107/143 own its client reuse/navigation decisions.

### Open Questions

No product blocker for isolated proof; deployment/SDK selection follows evidence.

### Sources

- `docs/product/tickets/KHA-142.md`, `docs/product/repo-layout.md`, `docs/product/decisions.md`.
- `docs/research/04-identity-trust.md`, `docs/research/05-e2ee.md`, `docs/research/08-security-evidence.md`.

---

## Planning Contract

Planning baseline: Khala `6d4694173eff9b0832f4c3a2cdb90b4281fcccd9`; inspected Archon `c7d3254097acaa02eed1e3be6fd8fbf06c0e8128` and Aiur `1f618cddf601a0b6d79bc1197579746b7584a64c`. `docs/evidence/security-planning-sources.json` pins external source reads. Proposed paths are future outputs, not claims of existing implementation. Product requirements preserved; acceptance examples clarified against the same requirements during review.

### Key Technical Decisions

- KTD1. Evaluate existing TypeScript `matrix-bot-sdk` with `RustSdkCryptoStorageProvider` before creating a custom bridge. Its source main anchor is `abfc53c5a0404f51a4d9ca4f555369d83e76ee94`; native `matrix-sdk-crypto-nodejs` main anchor `b29219c69b996224d6b8e7c94cb40fb3e4949516` is separately captured. These are source observations, not a tested compatible dependency pair.
- KTD2. Resolve the actual exact npm release and transitive native binding from the lockfile. Bot source observed dependency `^0.4.0` and empty passphrase initialization; do not replace that package with current binding main or assert encrypted SQLite-at-rest. Document actual store protection and machine permissions as a separate threat boundary.
- KTD3. Initial app engine is Node22 LTS per101. Check exact maintained patch against native prebuild/engine support. If incompatible, report compatible supported engine and cost to101; do not silently change the workspace. TypeScript using maintained native binding is allowed; a new Rust service is not implied approved.
- KTD4. A successful Node crypto wrapper must preserve device/account identity, sync/decryption state and verified key-sharing behavior across process restart. SDK credentials alone or a memory-only WASM client cannot satisfy this proof. The owner endpoint holds plaintext keys; Netlify does not.

### Failure and packaging evidence

Persist store in an owner-local directory, acquire a single-writer process lock, close gracefully when possible and test abrupt termination. Record platform/architecture, native artifact provenance, actual package versions, SQLite/store behavior and missing-library failure. Limit initial supported platform claim to platforms actually tested. File permission claims do not imply protection from the same OS user or unrestricted agent host access.


---

## Implementation Units

### U1. Pin TS and native compatibility harness

**Goal:** Pin TS and native compatibility harness. **Requirements:** R1–R4; F1; applicable KTDs below. **Dependencies:** upstream tickets in Goal Capsule. **Files:** `experiments/headless-crypto/{package.json,pnpm-lock.yaml,README.md}`, `src/main.ts`.

**Approach:** Provide scripts build/test/test:live, exact engine/dependency records and disposable configuration. Inspect installed types/source, not assumed current-main signatures.

**Patterns to follow:** The named contract in KHA-105/106 and the source pattern cited in this Planning Contract; preserve the owned directory boundary.

**Test scenarios:**

- Frozen install and import on proposed Node22 patch pass or give reproducible incompatibility.
- Native artifact/version and architecture recorded.
- No production keys or root lockfile touched.

**Verification:** The listed scenarios pass in the owned tests; record the observed result and relevant version/generation. A mocked result proves only module behavior, not a provider capability.

### U2. Prove restart and store ownership

**Goal:** Prove restart and store ownership. **Requirements:** R1–R4; F1; applicable KTDs below. **Dependencies:** U1. **Files:** `experiments/headless-crypto/src/store.ts`, `tests/restart.test.ts`.

**Approach:** Create device with maintained provider, exchange encrypted event, kill/restart process using same persisted store.

**Patterns to follow:** The named contract in KHA-105/106 and the source pattern cited in this Planning Contract; preserve the owned directory boundary.

**Test scenarios:**

- Identity and previous event decrypt survive actual process exit.
- Second writer is rejected before DB mutation.
- Missing/corrupt store produces explicit failure; no replacement keyset masquerades as old device.

**Verification:** The listed scenarios pass in the owned tests; record the observed result and relevant version/generation. A mocked result proves only module behavior, not a provider capability.

### U3. Verify key sharing and browser interoperability

**Goal:** Verify key sharing and browser interoperability. **Requirements:** R1–R4; F1; applicable KTDs below. **Dependencies:** U2. **Files:** `experiments/headless-crypto/tests/interoperability.test.ts`, `experiments/headless-crypto/peer/{index.html,main.ts}`.

**Approach:** Exchange events both ways with an experiment-owned browser peer using the pinned browser SDK, and examine actual verification/share APIs. Keep the peer harness under experiments/headless-crypto/; no dependency on141 implementation or completion.

**Patterns to follow:** The named contract in KHA-105/106 and the source pattern cited in this Planning Contract; preserve the owned directory boundary.

**Test scenarios:**

- Trusted peer decrypts; unsupported/unverified sharing behavior recorded exactly.
- Offline interval and reconnect do not lose durable sync state silently.
- Known prior event remains decryptable after abrupt termination.

**Verification:** The listed scenarios pass in the owned tests; record the observed result and relevant version/generation. A mocked result proves only module behavior, not a provider capability.

### U4. Report bounded verdict and integration contract

**Goal:** Report bounded verdict and integration contract. **Requirements:** R1–R4; F1; applicable KTDs below. **Dependencies:** U3. **Files:** `docs/evidence/headless-crypto.md`.

**Approach:** Record package pins/store custody/platform/verification and setup cost; supply114/115/116/129, not production adapter code.

**Patterns to follow:** The named contract in KHA-105/106 and the source pattern cited in this Planning Contract; preserve the owned directory boundary.

**Test scenarios:**

- Source-only assertions clearly separated from observed proof.
- Failure identifies smallest next experiment or candidate rejection.

**Verification:** The listed scenarios pass in the owned tests; record the observed result and relevant version/generation. A mocked result proves only module behavior, not a provider capability.

---

## Verification Contract

Planned: `pnpm --dir experiments/headless-crypto install --frozen-lockfile`, `pnpm --dir experiments/headless-crypto build`, `pnpm --dir experiments/headless-crypto test`, `pnpm --dir experiments/headless-crypto test:live`. Record distinct process IDs, same persistent identity and pre-restart event ID; package import or unit mocks alone cannot pass. The isolated experiment owns its browser peer and can run without141. After both independent experiments finish, their evidence may be compared; comparison does not block142 completion.

## Definition of Done

Durable TS-compatible endpoint crypto is proven or disproven with exact versions and reproducible commands. Native packaging, trust ceremony and owner-local custody costs are explicit; no SDK compatibility or at-rest-security claim is inferred from repository main. Remove abandoned-attempt code and temporary credentials; leave evidence free of message bodies, raw tokens and private keys. Do not change sibling implementations to make this ticket pass; return component defects to the named owner.

### Planning review and remaining confidence

Serial coherence, feasibility, security and adversarial review completed; see `docs/plans/reviews/security-planning-review.md`. This is a planning review, not a runtime security certification. Production implementation must record executed commands and observed evidence.

### Independent review clarification

This no-predecessor experiment owns its interoperability peer and the browser runner dependencies in its isolated manifest/lockfile. Use the maintained browser SDK source anchor recorded by141 as a research reference, not an import from141 experimental code. The browser peer needs only encrypted send/receive for142 interoperability;141 owns full browser lifecycle/UI feasibility.
