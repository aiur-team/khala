---
title: "KHA-137 Build a reusable multi-owner acceptance harness - Plan"
type: feat
date: 2026-09-16
topic: multi-owner-acceptance-harness
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-brainstorm
execution: code
origin: docs/product/tickets/KHA-137.md
---

# KHA-137 Build a reusable multi-owner acceptance harness - Plan

## Goal Capsule

Provide deterministic fixtures and failure injection for independent human/agent owners and honest live conformance. Dependencies: KHA-101, KHA-105, KHA-106. Follow the approved scope card and the units below. A plan is not evidence that the proposed integration works. All implementation surfaces listed here are proposed unless a source explicitly identifies existing code.

## Product Contract

### Summary

Provide deterministic fixtures and failure injection for independent human/agent owners and honest live conformance.

### Problem Frame

A transport receipt cannot establish model consumption, and successful replay cannot establish exactly-once agent execution. The observable outcome in this ticket must preserve the owner-controlled review boundary and existing session identity across retries and failures.

### Requirements

- R1. Represent two human/agent pairs and a third independent owner without conflating identities or authority.
- R2. Support independent clocks, duplicate/reordered delivery, disconnect, busy session and crash injection.
- R3. Separate fake contract proofs from live harness/SDK evidence.

### Actors and flow

A1: owning human. A2: trusted owner connector. A3: existing model session and its harness adapter. A4: ciphertext transport/control service. Human identity, connector device, agent participant and working session are distinct.

F1. A scenario driver creates isolated owners, devices and existing session bindings, then records state/evidence from supplied real or fake ports.

### Acceptance Examples

- AE1. Owner A's approval cannot release an event into B's agent; adding C does not alter B's trust policy. Covers R1 and R2.
- AE2. A fake adapter claiming consumption cannot satisfy live harness conformance acceptance. Covers R2 and R3.

### Key Decisions

KD1. Existing-session delivery (session-settled: user-directed — chosen over replacement agents: preserve the human's working context). Any model is supported by protocol extensibility; actual harness support requires evidence.

KD2. Connector-gated review (session-settled: user-directed — chosen over separate review encryption groups: pending plaintext may stay in the trusted owner connector but not model context).

KD3. TypeScript and OSS reuse (session-settled: user-directed — chosen over custom infrastructure by default: reduce development). Netlify is preferred; Railway is acceptable when reuse saves work. Matrix remains a candidate, not a selected dependency.

### Scope Boundaries

- `tests/e2e/harness/`
- `tests/conformance/`

No sibling implementation edits, root package/lockfile changes, provider deployment or production credentials. Root dependency changes go through KHA-101. This ticket does not add human installation/configuration, broaden history disclosure, weaken harness permissions or claim isolation from an unrestricted same-host agent. Integration is explicit, not accomplished by importing unfinished sibling implementations.

### Open Questions

No new product choice; scenario-specific product gates remain the responsibility of the acceptance ticket using the driver.

### Sources

- `docs/product/tickets/KHA-137.md`, `docs/product/decisions.md`, `docs/product/repo-layout.md`.
- `docs/research/01-agent-protocols.md`, `docs/research/02-substrates.md`, `docs/research/07-state-and-transport.md`.

## Planning Contract

Source manifest: `docs/evidence/transport-planning-sources.json` pins local repositories, read-only CLI observations and official documentation checks. No runtime proof is implied.

### Approach and proposed exports

Own `tests/e2e/harness/owners.ts`, `scenario.ts`, `clock.ts`, `faults.ts`, `evidence.ts`, and `tests/conformance/{delivery,messaging,authority}.test.ts`. Export test-only `createScenarioHarness(config): ScenarioHarness`, `createOwnerFixture(seed)`, `runHarnessConformance(adapter, capabilities)`. These never ship in production package exports. KHA-101 reserves test imports/discovery; KHA-105/106 supply literal contract fixtures. Tests consume real public interfaces, not private implementation internals.

```ts
type EvidenceMode = "fake-contract" | "live-sdk" | "live-harness";
type OwnerFixture = {ownerId:string; humanParticipantId:string;
  agentParticipantId:string; deviceId:string; binding:SessionBinding};
type Fault = "disconnect_before_write"|"disconnect_after_write"|
  "crash_after_pending"|"crash_after_intent"|"duplicate_event"|
  "reordered_receipt"|"keys_delayed"|"session_busy"|"session_exit";
interface ScenarioHarness {
  owners:readonly OwnerFixture[];
  inject(fault:Fault,targetOwnerId:string):Promise<void>;
  evidence():ReadonlyArray<{mode:EvidenceMode;kind:string;
    operationId:string;ownerId:string;at:number}>;
  close():Promise<void>;
}
```

### Fixture and oracle design

Create A/B/C with distinct human identity, agent participant, device, binding and independent policy version. Duplicate email/display names are useful adversarial metadata but do not collapse verified owners. Fixed event fixture E7 is authored by A and visible in the channel; B and C each have independent pending/release decisions. B approving E7 cannot release C's copy. Tests assert the observable model-facing output, not only internal policy flags.

Use deterministic fake-clock scheduling for component tests. Keep fake clocks separate per process where the integration models independent time. Live evidence uses monotonic elapsed durations plus wall-clock provenance, no fabricated synchronized latency. Stable operation/release/receipt IDs permit correlation without plaintext logs. Evidence mode is mandatory: a fake reporting context_consumed cannot satisfy a live harness assertion.

### Failure injection and cleanup

Each fault must have a documented injection boundary and expected oracle. `crash_after_intent` kills the process after durable local intent before confirmed external outcome; a subsequent submit is a failure unless reconciliation proves safe. `keys_delayed` blocks decrypt without making the event disappear. `reordered_receipt` verifies receipt facts are not treated as a numeric progress enum. Multiple owner fixtures must not share temporary state directories, tokens or SDK device stores. Cleanup revokes/deletes disposable resources where supported and reports leftovers without destroying unrelated sessions.

## Implementation Units

### U1. Independent owner fixtures and literal contract parity

Build A/B/C factories from KHA-105/106 fixture scalars. Covers R1. Test owner/device/session distinction, stale generation, same event different recipient and messaging/delivery codec parity. No product policy defaults in fixtures: each scenario passes explicit controls.

### U2. Deterministic fault runner and evidence schema

Depends U1. Build clocks, resource disposal and fault hooks. Covers R2/R3 and AE2. Include self-tests proving the fault actually fires at its named boundary; a no-op fault runner must fail its own oracle.

### U3. Reusable neutral conformance suites

Depends U2. Assert authorization separation, exact digest preservation, unknown-outcome behavior, no pending hints and owner-specific release. Covers AE1. Native adapters register capabilities; unsupported receipts are skipped with explicit reason, never synthesized for a green report.

### U4. Live driver interfaces and handoff

Inject actual browser/API/connector/native harness drivers without selecting a provider or running a daemon in the harness module. KHA-138/139 own security/collaboration acceptance scenarios; KHA-133 owns runtime wiring. Produce evidence manifests marking fake/live scope and source versions so consumers cannot mix them.

## Verification Contract

Request exactly two root scripts from KHA-101: `pnpm test:conformance` selects `tests/conformance/**/*.test.ts`; `pnpm test:e2e` selects `tests/e2e/**/*.test.ts`. Use Vitest as the common assertion/driver runner, with browser automation injected by UI drivers. `pnpm test:e2e -- tests/e2e/collaboration/collaboration.test.ts` selects the collaboration entry; `pnpm test:e2e -- tests/e2e/security/security.test.ts` selects the security entry. These are planned paths, not existing passing tests. Run `pnpm test:conformance`, `pnpm test:e2e` and `pnpm typecheck` after scaffold. Live mode requires `KHALA_E2E_LIVE=1`; absent mode runs harness self-tests and explicitly skips live acceptance with a reason. Final acceptance must assert at least one live case ran and fail if all are skipped. No live token is stored in script arguments. Self-test fixtures and fault timing without real credentials; live driver registration requires opt-in disposable environments. At least one deliberately broken fake (cross-owner release, false consumption, repeat submit after unknown) must fail the corresponding oracle. No application/live harness test ran during planning.

## Definition of Done

Reusable test-only interfaces have deterministic self-tests, independent owner identities, reliable failure injection and explicit fake/live evidence tags. No substrate or task decision is silently embedded. Downstream acceptance tickets can compose drivers without editing this harness's shared code for every scenario.
