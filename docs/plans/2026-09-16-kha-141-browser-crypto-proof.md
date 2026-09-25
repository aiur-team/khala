---
title: "KHA-141 Prove browser SDK crypto and UI seams - Plan"
type: feat
date: 2026-09-16
topic: browser-crypto-proof
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-brainstorm
deepened: 2026-09-16
execution: code
origin: docs/product/tickets/KHA-141.md
---

# KHA-141 Prove browser SDK crypto and UI seams - Plan

## Goal Capsule

Deliver prove browser sdk crypto and ui seams. Authority: latest user decisions, then `docs/product/decisions.md`, the approved scope card, and this contract. Dependencies: None. Product trace: R06, R10, R13, R14. Open launch gates: No product blocker for isolated proof; candidate Matrix is an experiment, not selected substrate.

Implementation belongs to the assigned ticket worker after gates clear. Root dependency changes, integration wiring, tracker publication and executor startup remain with their named owners. This artifact does not claim runtime proof.

---

## Product Contract

### Summary

Produce reproducible browser encryption and persistence evidence on pinned OSS SDK versions. This ticket covers the bounded outcome in `docs/product/tickets/KHA-141.md`.

### Problem Frame

WASM compilation and an in-memory demo do not establish reliable encrypted browser channel or usable device recovery.

### Requirements

- R1. Produce reproducible browser encryption and persistence evidence on pinned OSS SDK versions.
- R2. Distinguish restart with retained storage from true key loss and show resulting decryptability.
- R3. Identify real UI-facing lifecycle and verification seams needed by the Aiur dashboard page.
- R4. Keep the experiment isolated and report negative results without changing product scope.

### Actors and flow

A1 is the owning human; A2 is their trusted owner connector; A3 is the model-facing adapter; A4 is the ciphertext delivery/control service. Human identity and agent identity remain distinct.

F1. An authorised actor requests this ticket's operation; the owning module validates current identity/state, returns an explicit result, and downstream consumers retain the narrow meaning of that result. Failures remain visible and retries preserve the original operation identity.

### Acceptance Examples

- AE1. A pinned real browser SDK retains its device and decrypts a known old event after full process restart with the same profile. Covers R1, R2.
- AE2. Clearing the actual crypto store yields observed key-loss behavior; an in-memory mock cannot satisfy persistence evidence. Covers R3, R4.

### Key Decisions

Connector-gated review is the confidentiality boundary (session-settled: user-directed — chosen over separate human-only encryption groups: the owner connector may hold pending plaintext). Application code remains TypeScript with OSS reuse (session-settled: user-directed — chosen over building a new custom stack by default: reduce implementation ownership). Netlify is preferred; Railway is acceptable when reuse saves work. Existing sessions remain the target; a fresh replacement conversation is not equivalent.

### Scope Boundaries

Only the scope card's owned paths may change. Production features are not implemented by feasibility tickets. This ticket cannot choose a new recovery promise, add human connector setup, select a provider through a fixture, or redesign the Aiur dashboard shell. KHA-107/143 own its client reuse/navigation decisions.

### Open Questions

No product blocker for isolated proof; candidate Matrix is an experiment, not selected substrate.

### Sources

- `docs/product/tickets/KHA-141.md`, `docs/product/repo-layout.md`, `docs/product/decisions.md`.
- `docs/research/04-identity-trust.md`, `docs/research/05-e2ee.md`, `docs/research/08-security-evidence.md`.

---

## Planning Contract

Planning baseline: Khala `6d4694173eff9b0832f4c3a2cdb90b4281fcccd9`; inspected Archon `c7d3254097acaa02eed1e3be6fd8fbf06c0e8128` and Aiur `1f618cddf601a0b6d79bc1197579746b7584a64c`. `docs/evidence/security-planning-sources.json` pins external source reads. Proposed paths are future outputs, not claims of existing implementation. Product requirements preserved; acceptance examples clarified against the same requirements during review.

### Key Technical Decisions

- KTD1. This is an isolated feasibility experiment, not a product substrate decision. First candidate is `matrix-js-sdk` Rust/WASM crypto because maintained OSS supplies lifecycle, encrypted rooms and history. Source anchor: commit `0e84500cc1f270e07b548b94e4a9991267d76bcb`, `src/client.ts`, captured in security-planning-sources.json. Use an exact installable release resolved to its source revision in the experiment lockfile; never substitute moving latest as evidence.
- KTD2. Use a persistent browser profile with IndexedDB. Verify a full browser-process stop/start with the same profile, not reload or fake-indexeddb. The inspected SDK disallows concurrent clients over one crypto store; test exclusive browser lock and follower observation separately.
- KTD3. Keep tokens and crypto state at the endpoint. Disposable local test service credentials may be supplied via excluded environment files. If an external service/account is required, record prerequisite and stop the affected live test until supplied; do not provision paid infrastructure implicitly.
- KTD4. UI evidence records subscription, timeline pagination, local echo/ack reconciliation, abort/disposal and styling seams, without choosing an entire client or rebuilding Aiur. KHA-143/107 own reuse decision.

### Experiment result schema

`docs/evidence/browser-crypto.md` records candidate/version/source commit, Node/build/browser/OS versions, lockfile hash, store location class, account/device IDs redacted, exact command, scenario, observed result, limitations and reproducibility instructions. Capability rows are pass/fail/not-tested; unsupported browser is not inferred from successful Chromium run.

### Evidence boundary

Memory crypto success does not answer persistence. Decrypting a new event does not answer old history. A trusted second device must create the encrypted pre-restart event, then the persisted browser endpoint must decrypt that exact event after restart. Clearing the crypto store with credentials retained must produce explicit missing-key/lost-device behavior. No automatic server plaintext recovery.


---

## Implementation Units

### U1. Pin isolated browser harness

**Goal:** Pin isolated browser harness. **Requirements:** R1–R4; F1; applicable KTDs below. **Dependencies:** upstream tickets in Goal Capsule. **Files:** `experiments/browser-crypto/{package.json,pnpm-lock.yaml,README.md,vite.config.ts}`, `src/main.ts`.

**Approach:** Define local scripts build/test/test:live, exact dependencies, disposable service configuration and ignored secrets; no root workspace edits.

**Patterns to follow:** The named contract in KHA-105/106 and the source pattern cited in this Planning Contract; preserve the owned directory boundary.

**Test scenarios:**

- Frozen install and production bundle succeed.
- Capture WASM asset loading and browser CSP requirements.
- Missing live service config skips explicitly rather than reports pass.

**Verification:** The listed scenarios pass in the owned tests; record the observed result and relevant version/generation. A mocked result proves only module behavior, not a provider capability.

### U2. Prove persistent crypto lifecycle

**Goal:** Prove persistent crypto lifecycle. **Requirements:** R1–R4; F1; applicable KTDs below. **Dependencies:** U1. **Files:** `experiments/browser-crypto/src/lifecycle.ts`, `tests/persistence.spec.ts`.

**Approach:** Drive real browser profile with SDK initialization, encrypted event exchange, full process restart and key loss.

**Patterns to follow:** The named contract in KHA-105/106 and the source pattern cited in this Planning Contract; preserve the owned directory boundary.

**Test scenarios:**

- Device identity unchanged on restart; known prior event decrypts.
- Cleared store cannot silently reuse old identity with fresh keys.
- Two writer attempts do not mutate shared crypto DB concurrently.

**Verification:** The listed scenarios pass in the owned tests; record the observed result and relevant version/generation. A mocked result proves only module behavior, not a provider capability.

### U3. Measure UI adapter seams

**Goal:** Measure UI adapter seams. **Requirements:** R1–R4; F1; applicable KTDs below. **Dependencies:** U2. **Files:** `experiments/browser-crypto/src/timeline.ts`, `tests/seams.spec.ts`.

**Approach:** Record exact SDK APIs for page/subscription/local echo and disposal; test account switch.

**Patterns to follow:** The named contract in KHA-105/106 and the source pattern cited in this Planning Contract; preserve the owned directory boundary.

**Test scenarios:**

- Send response lost then sync event reconciles by txn/event identity.
- Old observer after dispose does not publish new state.
- Undecryptable history remains explicit.

**Verification:** The listed scenarios pass in the owned tests; record the observed result and relevant version/generation. A mocked result proves only module behavior, not a provider capability.

### U4. Publish candidate verdict

**Goal:** Publish candidate verdict. **Requirements:** R1–R4; F1; applicable KTDs below. **Dependencies:** U3. **Files:** `docs/evidence/browser-crypto.md`.

**Approach:** Separate verified facts, source-only expectations and blockers; supply105/111 exact lifecycle capabilities and143 UI costs.

**Patterns to follow:** The named contract in KHA-105/106 and the source pattern cited in this Planning Contract; preserve the owned directory boundary.

**Test scenarios:**

- Every pass links scenario/log and exact version.
- Failed requirement states whether candidate should be rejected or needs bounded followup.

**Verification:** The listed scenarios pass in the owned tests; record the observed result and relevant version/generation. A mocked result proves only module behavior, not a provider capability.

---

## Verification Contract

Planned isolated commands: `pnpm --dir experiments/browser-crypto install --frozen-lockfile`, `pnpm --dir experiments/browser-crypto build`, `pnpm --dir experiments/browser-crypto test`, `pnpm --dir experiments/browser-crypto test:live`. First authoring install creates lockfile; subsequent evidence uses frozen install. Verify browser process IDs differ across restart and profile/store identity remains the same. No runtime outcomes are claimed by this plan.

## Definition of Done

Browser persistence/history/key-loss and UI seams have repeatable observations, exact pins and bounded limitations;105/111/143 can decide from evidence. A negative verdict is a valid completed experiment. Remove abandoned-attempt code and temporary credentials; leave evidence free of message bodies, raw tokens and private keys. Do not change sibling implementations to make this ticket pass; return component defects to the named owner.

### Planning review and remaining confidence

Serial coherence, feasibility, security and adversarial review completed; see `docs/plans/reviews/security-planning-review.md`. This is a planning review, not a runtime security certification. Production implementation must record executed commands and observed evidence.
