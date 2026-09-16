---
title: "TypeScript Workspace Foundation - Plan"
type: feat
date: 2026-09-16
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-brainstorm
execution: code
readiness_condition: predecessor-results-and-listed-external-gates
deepened: 2026-09-16
ticket_id: KHA-101
origin: docs/product/tickets/KHA-101.md
---

# TypeScript Workspace Foundation - Plan

## Goal Capsule

Let independent Khala workers land green changes without sharing manifests or inventing incompatible package boundaries.

Authority: user decisions in `docs/product/decisions.md` precede this plan; then the approved ticket scope and owning contracts. Tail owner is the Khala Executor. This ticket does not grant authority over sibling Aiur processes or configuration.

Prerequisites and stop conditions: None beyond scoped execution readiness. Frontend framework selection belongs to KHA-143; this scaffold does not invent framework components.

---

## Product Contract

### Summary and problem frame

Let independent Khala workers land green changes without sharing manifests or inventing incompatible package boundaries. Khala currently has research and proposal documents, so this work must define its own evidence without claiming an existing implemented subsystem.

### Requirements

- R1. Provide reproducible installation, type checking, lint, tests and builds for all app/package boundaries.
- R2. Prevent browser code from importing connector storage, native crypto, control secrets or unfinished sibling implementations.
- R3. Give contracts and each feature a separate write surface with one owner for dependency updates.

### Acceptance examples

- AE1. A new feature adds files under its owned directory; root CI discovers its tests without workflow edits.
- AE2. A browser import of owner-side storage fails the boundary check before merge.

### Scope and decisions

Use a small pnpm workspace with explicit exports; reject one package per ticket because it multiplies manifests and build glue. Prefer standard package scripts over a bespoke orchestration service.

Carry forward TypeScript, OSS reuse, Netlify preference, existing-session attachment, connector-gated E2EE review, and dashboard-native design. This ticket cannot add human technical setup or silently change an unresolved product policy.

---

## Planning Contract

Product Contract unchanged. An implementation-ready **plan** is not a claim that prerequisites have passed or that the ticket is dispatchable today. Resolve the named dependency and environment gates before production mutation; bounded local work may proceed where explicitly described.

### Grounding and technical decisions

KTD1. Use a small pnpm workspace with explicit exports; reject one package per ticket because it multiplies manifests and build glue. Prefer standard package scripts over a bespoke orchestration service.

KTD2. Keep platform operations separate from feature policy. Reuse upstream service/SDK behavior and narrow ports; no custom cryptography, replacement session or shared mutable application store is introduced here.

KTD3. Reserve shared manifests/lockfile and app entrypoints for their assigned owner. Components land against real reviewed contracts and isolated fixtures; integration owns binding to live implementations. See `docs/product/repo-layout.md`.

KTD4. User-directed TypeScript and Netlify preference remain constraints; Railway-hosted OSS is acceptable where it saves development. The owner-side continuous subscriber cannot live inside a request-lifetime function. (session-settled: user-directed — chosen over a mandatory custom Hono backend: reduce ongoing backend development and operation.)

### Existing evidence and refreshable implementation pointers

Khala researched base: `6d4694173eff9b0832f4c3a2cdb90b4281fcccd9`; proposed paths below do not exist as app implementation yet. Archon reference: `c7d3254097acaa02eed1e3be6fd8fbf06c0e8128`, especially `netlify.toml`, `package.json`, `netlify/lib/store.mjs`, and `netlify/lib/hosted/record-store.mjs` in that repository. Aiur reference: `1f618cddf601a0b6d79bc1197579746b7584a64c`; its dashboard supplies design language, not the runtime language or service topology. Refresh source/version facts at worker pickup without changing accepted product requirements.

### Bootstrap ownership

The initial scaffold owns each `package.json` and local `tsconfig.json` for `apps/web`, `apps/control`, `apps/connector`, `packages/contracts`, `packages/messaging`, `packages/connector`, `packages/harnesses`, and `packages/policy`, plus their initial compiler/build/test configuration. This is a one-time bootstrap exception before feature owners begin; later manifest/lock changes use the named dependency owner. Initial test collectors must discover owned adjacent test files and exclude proof experiments from production builds.

### Proposed owned files

- `package.json`
- `pnpm-workspace.yaml`
- `pnpm-lock.yaml`
- `tsconfig.base.json`
- `.github/workflows/ci.yml`
- `scripts/check-boundaries.mjs`
- `scripts/check-boundaries.test.mjs`
- `tests/integration/playwright.config.ts`
- `docs/development.md`

### Worked boundary record

The following is an example record, not an assertion of collected runtime evidence. Fields marked recorded/resolved are required outputs of the implementation proof.

```json
{
  "packages": [
    "@khala/web",
    "@khala/control",
    "@khala/connector-app",
    "@khala/contracts",
    "@khala/messaging",
    "@khala/connector",
    "@khala/harnesses",
    "@khala/policy"
  ],
  "scripts": [
    "typecheck",
    "lint",
    "check:boundaries",
    "test",
    "test:integration",
    "build"
  ],
  "contracts": [
    "messaging/*",
    "delivery/*"
  ]
}
```

### Dependencies and limits

Hard ticket prerequisites: none. Gates: None beyond scoped execution readiness. Frontend framework selection belongs to KHA-143; this scaffold does not invent framework components.

Every proposed verification command below is an implementation-time contract, not a command claimed to run during planning. The owning implementation must add the named script/entrypoint before invoking it. Package-manager and native SDK versions are pinned from actual supported releases at implementation; this plan does not fabricate a tested dependency tuple.

---

## Implementation Units

### U1. Bootstrap owned package shells

**Goal:** Bootstrap owned package shells.

**Requirements:** R1; overall R1–R3, AE1–AE2 constrain the completed ticket.

**Dependencies:** None beyond ticket prerequisites.

**Files:** `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `tsconfig.base.json`.

**Approach:** Create the eight named app/package manifests once, scoped package exports and shared compiler defaults. Pin a supported Node 22 LTS patch and exact pnpm version; freeze versions in lockfile. Reserve exports but do not export pretend production implementations.

**Patterns:** KTD1–KTD4; referenced upstream behavior and owned sibling boundaries.

**Test scenarios:** Clean checkout installs with frozen lockfile; a changed manifest without matching lock update fails. Empty packages do not require fake tests.

**Verification:** Record the observed pass/fail result, exact build/environment and sanitized evidence; do not infer runtime success from configuration parsing alone.

### U2. Enforce deployment and import boundaries

**Goal:** Enforce deployment and import boundaries.

**Requirements:** R2; overall R1–R3, AE1–AE2 constrain the completed ticket.

**Dependencies:** U1.

**Files:** `scripts/check-boundaries.mjs`, `scripts/check-boundaries.test.mjs`.

**Approach:** Implement a narrow import-graph check including dynamic literal imports and TS path aliases; browser/policy cannot reach connector storage or server-only modules. Explicit exceptions live in owned config and require review.

**Patterns:** KTD1–KTD4; referenced upstream behavior and owned sibling boundaries.

**Test scenarios:** Direct, alias and transitive browser-to-native imports fail; contract-to-app import fails; browser-to-contract import passes.

**Verification:** Record the observed pass/fail result, exact build/environment and sanitized evidence; do not infer runtime success from configuration parsing alone.

### U3. Wire package-discovered validation

**Goal:** Wire package-discovered validation.

**Requirements:** R3; overall R1–R3, AE1–AE2 constrain the completed ticket.

**Dependencies:** U2.

**Files:** `.github/workflows/ci.yml`, `tests/integration/playwright.config.ts`, root scripts/lockfile.

**Approach:** Expose `pnpm check:boundaries` as the direct boundary-check command. Root scripts fan out to package scripts using pnpm filters; shared scripts never append ticket IDs. Include a smoke fixture for the boundary checker rather than tests asserting manifest strings. Establish root `test:integration` as `playwright test --config tests/integration/playwright.config.ts`; config `testDir` is its directory and `testMatch` is `**/*.spec.ts`. Pin compatible Playwright in the owned manifest/lockfile. Later suites discover by directory without shared edits. Zero collected cases fails when invoked (do not set passWithNoTests); the bootstrap CI does not run an absent live suite. Live integration invocation requires `KHALA_E2E_LIVE=1` and declared disposable environment; missing configuration fails explicitly rather than skipping green. KHA137 separately owns root `test:e2e` and `test:conformance` Vitest runners via the designated dependency owner.

**Patterns:** KTD1–KTD4; referenced upstream behavior and owned sibling boundaries.

**Test scenarios:** A fixture feature test is discovered; deliberate invalid import makes CI red; normal package graph builds.

**Verification:** Record the observed pass/fail result, exact build/environment and sanitized evidence; do not infer runtime success from configuration parsing alone.

### U4. Document dependency ownership

**Goal:** Document dependency ownership.

**Requirements:** R3; overall R1–R3, AE1–AE2 constrain the completed ticket.

**Dependencies:** U3.

**Files:** `docs/development.md`.

**Approach:** Record package responsibility, contribution commands, single lockfile writer, isolated issue worktrees and contract-change review rules.

**Patterns:** KTD1–KTD4; referenced upstream behavior and owned sibling boundaries.

**Test scenarios:** A cold worker can run named commands without guessing paths; no per-machine secrets or setup paths appear in committed docs.

**Verification:** Record the observed pass/fail result, exact build/environment and sanitized evidence; do not infer runtime success from configuration parsing alone.

---

## Verification Contract

| Check | Expected evidence |
|---|---|
| `pnpm install --frozen-lockfile` | Successful relevant validation after its owning script exists; failed prerequisites remain explicit. |
| `pnpm typecheck` | Successful relevant validation after its owning script exists; failed prerequisites remain explicit. |
| `pnpm lint` | Successful relevant validation after its owning script exists; failed prerequisites remain explicit. |
| `pnpm test` | Successful relevant validation after its owning script exists; failed prerequisites remain explicit. |
| `pnpm build` | Successful relevant validation after its owning script exists; failed prerequisites remain explicit. |

Feature tests must exercise behavior and failure cases rather than mirror constants. Pure docs/config units use schema/config/build and real smoke evidence instead of artificial unit tests. A test double proves a component contract; it cannot prove production identity, crypto persistence, hosted routing or session delivery. Integration owners in the graph supply that proof.

Security checks use synthetic data and disposable identities. Do not publish raw environment dumps, process arguments, token-bearing URLs, database credentials, server signing keys or decrypted participant messages. Failure logs preserve request IDs and reason codes without content.

---

## Definition of Done

All R1–R3 and AE1–AE2 have evidence. All U-IDs satisfy their stated validation; unresolved external gates prevent a pass for dependent outcomes. Owned code/docs land green on current base, no abandoned experiment or fixture is exported into production, and shared file ownership remains intact. The Executor receives exact changed paths, tests run, unavailable checks and remaining limitations.

### Sources

- https://pnpm.io/workspaces
- https://pnpm.io/installation
- https://nodejs.org/en/about/previous-releases

Local context: `docs/product/tickets/KHA-101.md`, `docs/product/repo-layout.md`, `docs/product/decisions.md`, and `docs/research/11-hosting-tradeoffs.md`. Official sources checked 2026-09-16; changing behavior must be rechecked at implementation.
