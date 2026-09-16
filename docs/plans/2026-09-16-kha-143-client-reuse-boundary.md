---
title: "KHA-143 Client reuse boundary experiment - Plan"
type: feat
date: 2026-09-16
topic: client-reuse-boundary
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-brainstorm
deepened: 2026-09-16
execution: code
origin: docs/product/tickets/KHA-143.md
---

# KHA-143 Client reuse boundary experiment - Plan

## Goal Capsule

Choose the smallest maintainable UI foundation that looks and behaves like an Aiur dashboard page.

Authority: current user decisions override the approved ticket scope, which overrides technical recommendations. Scope source is `docs/product/tickets/KHA-143.md`; global requirements: R10, R13, R14. Planning snapshot: Khala `6d4694173eff9b0832f4c3a2cdb90b4281fcccd9` with approved ticket proposal at `d625c19`. Dependency tickets: KHA-141. This plan changes Khala only; sibling Aiur/Archon are read-only design references.

Stop condition: No new product choice is required to compare candidates. KHA141 supplies browser crypto feasibility evidence; KHA102 owns substrate selection; an invalidating result returns to the parent rather than silently choosing another product.

---

## Product Contract

### Summary

Choose the smallest maintainable UI foundation that looks and behaves like an Aiur dashboard page.

### Problem Frame

The ordinary user is collaborating with another human and their already-working agent. Rebuilding generic chat, exposing infrastructure setup, or confusing pending delivery with model consumption undermines that workflow. This ticket owns one bounded part of the shared journey.

### Requirements

- R1. Compare an existing client adaptation and a thin SDK-based interface against the same actual joining and review scenarios.
- R2. A candidate must support the Aiur dashboard content/chrome split and ordinary OAuth without human infrastructure setup.
- R3. Candidate evaluation records real extension boundaries, dependencies, licenses and upgrade burden rather than a screenshot-only judgment.
- R4. The result selects one reusable boundary and exact versions before production UI tickets dispatch.

### Actors and flow

- A1. The authenticated human who owns the current agent connection.
- A2. Other admitted humans and their attributed agents, whose messages are content rather than control authority.
- F1. Build isolated candidate screens, exercise the same human journey/review seam, compare dashboard integration and record a single evidence-backed selection.

### Acceptance examples

- AE1. Covers F1 / R1–R4. A candidate can change logo/colors but cannot remove mandatory homeserver/key setup or separate host chrome; mark it failing instead of treating branding as complete.
- AE2. Covers R3–R4. An unsupported SDK integration or Element extension hook is recorded as unsupported or requiring a patch, never counted as a passing capability or hidden behind a mock.

### Key decisions

- Dashboard-native design is a user directive: Khala should look like a page in Aiur’s left navigation and permit later embedding. It remains independently deployable.
- Keep existing sessions and automated setup (session-settled: user-directed — chosen over manual connector/MCP setup or replacing the session: the person should share a link with the agent already doing the work).
- Connector-gated review (session-settled: user-directed — chosen over separate review/delivery encryption groups: a trusted connector may decrypt pending content, but only approved content reaches the model).

### Scope boundaries

This ticket does not redefine shared contracts, implement sibling-owned services, change Aiur itself, or introduce a second messaging/crypto stack. UI-only tickets demonstrate injected-port behavior; integration tickets own actual composition. Client selection and platform setup belong to their named predecessors. Attachments, retention and automation choices remain with their product/contract owners.

### Outstanding questions

No new product choice is required to compare candidates. KHA141 supplies browser crypto feasibility evidence; KHA102 owns substrate selection; an invalidating result returns to the parent rather than silently choosing another product.

---

## Planning Contract

Product Contract clarification: AE2 now names ticket-specific failure cases without changing approved scope;143 also attributes substrate selection to102 rather than the141 feasibility spike. Remaining Product Contract unchanged. Implementation details below do not settle questions still marked blocking. Prerequisite tickets are dispatch dependencies, not evidence that their runtime experiments already passed.

### Technical recommendation and experiment boundary

KTD1. Prefer a thin React/TypeScript presentation on the SDK proven by KHA141 because Khala is an Aiur dashboard page with specific human-only review controls. This is a recommendation to test, not a Matrix selection or a claim generic chat must be rebuilt. Reuse transport, encryption, synchronization, device storage and safe Markdown libraries. Build only application presentation and the connector gate integration.

KTD2. Compare that baseline with current Element Module API adaptation using a pinned Element revision. Deprecated build-time modules, an archived matrix-react-sdk package, or private component overrides are not stable extension contracts. Record the exact supported hook for each required action. If navigation/review requires patching private internals, quantify the maintained patch and upgrade burden instead of describing branding configuration as sufficient.

KTD3. Run candidates in isolated experiment packages, never ship Element alongside the thin app merely to claim reuse. The winning result names exact dependency versions, lockfile, license files, transitive bundles, build steps and exported adapter boundaries. Matrix candidates inherit KHA141 crypto/storage proof; no second MatrixClient opens the same IndexedDB crypto store.

### Review fixture and outputs

Own `experiments/client-reuse/sdk/**`, `experiments/client-reuse/element/**`, `experiments/client-reuse/fixtures/**`, and `docs/evidence/client-reuse.md`. Do not alter production routes or root dependencies. Candidate interfaces are fixture-only adapters of105/106; they cannot create a competing protocol. Record this evaluation row for each capability:

```ts
type CapabilityEvidence = {
  candidate: "sdk-ui" | "element-module";
  capability: string;
  result: "supported" | "requires-patch" | "unsupported" | "not-tested";
  sourceRevision: string;
  testPath: string | null;
  limitation: string | null;
};
```

The fixture includes Aiur desktop rail and mobile navigation, light/dark tokens, attributed human/agent messages, a long message, encrypted-unavailable placeholder, invitation authentication return, one selected review batch and an unknown delivery outcome. A synthetic review port is acceptable for presentation comparison but is explicitly not proof of human authority, live model release or actual recovery. KHA144 owns ownership/bootstrap proof;103/104 own attachment feasibility and139 owns the full collaboration proof.

### Selection criteria and licensing evidence

A candidate must support route-content embedding without duplicate chrome, no normal-path Matrix account setup, browser crypto lifecycle integration, accessible keyboard/mobile flows, and a review surface that cannot become an agent tool. Compare amount of local presentation code against private API patches, not raw package count. Reject a candidate that requires per-agent configuration from the human or cannot preserve approval/delivery distinctions.

Inspect upstream LICENSE/COPYING and source headers at pinned revisions. MatrixJS publishes Apache-2.0; Element publishes AGPL-3.0-or-later/GPL-3.0-or-later/commercial alternatives; configuration branding does not grant unrestricted trademark use. Record applicable notices and unresolved distribution/rebranding questions for maintainer review, not legal conclusions. Compound/Hydrogen component reuse may introduce different license obligations from the MatrixJS baseline; do not assume all Matrix ecosystem UI is Apache-2.0.

Version observations and current primary-source links are in `docs/evidence/ui-planning-grounding.md`. Candidate registry versions observed today are discovery data, not a compatible tested lock. Use actual pinned build and browser results to select. If141 fails the prerequisite, report the blocked candidate and retain a truthful comparison rather than invent a substitute messaging backend.

### Shared implementation discipline

Use the selected OSS client/SDK through canonical contracts, not direct imports into UI controllers. `docs/evidence/ui-planning-grounding.md` records source SHAs, inspected dashboard components, external guidance and candidate versions. KHA101 owns package manifests, root lockfile, ESM/TypeScript tooling and generic test discovery; dependency changes go to its integration owner. Test files remain beside owned modules or in this ticket's assigned integration directory. Existing prerequisite exports win over illustrative data below; if they disagree, obtain a reviewed contract amendment rather than add a local compatibility copy.

No implementation or runtime test has run as part of this plan. Browser credentials, decrypted message bodies and invitation secrets must not enter screenshots, logs, telemetry or snapshot fixtures from real users. Use synthetic accounts and message canaries for evidence.

---

## Implementation Units

### U1. Pin candidates and scorecard

**Goal:** Make the reuse decision reproducible.

**Requirements:** R1/R2; KTD1–KTD3. **Dependencies:** KHA141 evidence available.

**Files:** `experiments/client-reuse/sdk/package.json`, `experiments/client-reuse/sdk/pnpm-lock.yaml`, `experiments/client-reuse/element/package.json`, `experiments/client-reuse/element/pnpm-lock.yaml`, `experiments/client-reuse/fixtures/capabilities.ts`, `docs/evidence/client-reuse.md`.

**Approach:** Record upstream revisions/licenses and exact scripts per isolated package. Define the same observable capability checklist and fixture for both candidates.

**Test scenarios:**

1. Every license claim links to the inspected revision file.
2. Unknown capability is not scored as supported.
3. Neither candidate has real credentials or production endpoint defaults.

**Verification:** A second worker can install locked candidates and reproduce the scorecard.

### U2. Build thin SDK dashboard-page probe

**Goal:** Test distinctive UI with minimal custom chat behavior.

**Requirements:** R1/R3; F1; KTD1. **Dependencies:** U1.

**Files:** `experiments/client-reuse/sdk/src/App.tsx`, `experiments/client-reuse/sdk/src/ports.ts`, `experiments/client-reuse/sdk/src/App.test.tsx`, `experiments/client-reuse/sdk/tests/dashboard.spec.ts`.

**Approach:** Use read-only Aiur dashboard source tokens/chrome and experiment-local fixture ports; do not import107, which depends on this experiment. Exercise141 SDK crypto lifecycle separately with disposable accounts. Keep auth/crypto outside presentation components.

**Test scenarios:**

1. Desktop, collapsed rail and narrow viewport preserve usable timeline/review.
2. Keyboard focus returns after review close and long messages do not overflow.
3. Unknown delivery never renders as delivered; device-unavailable state remains explicit.

**Verification:** Screenshots/test output identify synthetic versus real SDK evidence.

### U3. Test current Element extension surface

**Goal:** Measure adaptation cost using supported hooks.

**Requirements:** R1/R2/R4; AE2; KTD2. **Dependencies:** U1.

**Files:** `experiments/client-reuse/element/src/module.ts`, `experiments/client-reuse/element/tests/capabilities.spec.ts`, `experiments/client-reuse/element/PATCHES.md`.

**Approach:** Implement the same bounded fixture using current documented Module API. List unsupported hooks and exact private patches if required; do not silently fork generic chat.

**Test scenarios:**

1. Chrome can be suppressed or evidence states it cannot.
2. Review command preserves event digest, policy and binding generations.
3. Module load and upgrade failure remain visible rather than losing controls.

**Verification:** Supported extension and private patch costs are separately evidenced.

### U4. Select and hand off the smallest maintained boundary

**Goal:** Turn measured results into an actionable UI dependency decision.

**Requirements:** R1–R4; AE1/AE2; KTD1–KTD3. **Dependencies:** U2/U3.

**Files:** `experiments/client-reuse/README.md`, `docs/evidence/client-reuse.md`.

**Approach:** Run locked builds/browser suites, compare bundle and maintained code scope, and replay one available upstream patch upgrade. Name winner/limitations and required107/132 adapter exports; send dependency changes to101 owner. If an upgrade is unavailable, document the untested limitation.

**Test scenarios:**

1. Both candidates evaluated against identical critical capabilities.
2. Selection cannot pass with a failed mandatory flow hidden by mock evidence.
3. Production plan paths still match chosen renderer or receive an explicit reviewed amendment.

**Verification:** Decision evidence makes reuse, constraints and future upgrade work reviewable.

---

## Verification Contract

After each isolated package declares scripts: `pnpm --dir experiments/client-reuse/sdk test`; `pnpm --dir experiments/client-reuse/sdk build`; `pnpm --dir experiments/client-reuse/sdk test:browser`; run the same three scripts in `experiments/client-reuse/element`. Record exact revisions, browser versions, command exit codes and unsupported cases. Do not claim the full live product proof from these probes.
The commands are future verification targets after KHA101 establishes the named scripts, not commands claimed to pass today. Use Node 22 LTS at a version satisfying the pinned packages (at least 22.12 for the candidate toolchain). No skipped/mocked real-service case may be reported as a completed integration. A changed command contract requires updating the owning bootstrap and this plan together.

---

## Definition of Done

A reproducible comparison selects a maintained UI boundary or explains which mandatory capability blocks selection. Aiur dashboard fit, OSS provenance, encrypted client lifecycle and review control extension cost are evidenced. UI owners receive the chosen exports and limits before implementation dispatch.
All owned unit tests and applicable contract checks pass on the merged base. Every acceptance example is linked to test evidence. Remove abandoned experiment code, fixture imports from production, unused subscriptions and dead fallbacks. Preserve scope/file ownership; report dependency defects to their owner instead of patching sibling directories. No deployment or implementation completion is implied by this document.
