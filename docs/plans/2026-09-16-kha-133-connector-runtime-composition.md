---
title: "KHA-133 Wire the existing-session connector runtime - Plan"
type: feat
date: 2026-09-16
topic: connector-runtime-composition
artifact_contract: ce-unified-plan/v1
artifact_readiness: requirements-only
product_contract_source: ce-brainstorm
execution: code
origin: docs/product/tickets/KHA-133.md
---

# KHA-133 Wire the existing-session connector runtime - Plan

## Goal Capsule

Compose independently tested bootstrap, crypto/inbox, subscription, dispatch and harness components into one owner-controlled runtime. Dependencies: KHA-114, KHA-115, KHA-116, KHA-117, KHA-118, KHA-121. Follow the approved scope card and the units below. A plan is not evidence that the proposed integration works. All implementation surfaces listed here are proposed unless a source explicitly identifies existing code.

## Product Contract

### Summary

Compose independently tested bootstrap, crypto/inbox, subscription, dispatch and harness components into one owner-controlled runtime.

### Problem Frame

A transport receipt cannot establish model consumption, and successful replay cannot establish exactly-once agent execution. The observable outcome in this ticket must preserve the owner-controlled review boundary and existing session identity across retries and failures.

### Requirements

- R1. Wire real ports with explicit startup/shutdown ordering and one device-state lock.
- R2. Retain the same binding throughout reconnect and preserve review-before-model semantics.
- R3. Expose actionable readiness/offline/unsupported/unknown states without leaking pending plaintext.

### Actors and flow

A1: owning human. A2: trusted owner connector. A3: existing model session and its harness adapter. A4: ciphertext transport/control service. Human identity, connector device, agent participant and working session are distinct.

F1. Storage opens under exclusive lock; bootstrap establishes binding; subscription catches up; dispatch starts only after prerequisites and effective controls are ready.

### Acceptance Examples

- AE1. Restart replays durable pending items without duplicate model submission and reconnects the original session. Covers R1 and R2.
- AE2. Storage or crypto readiness failure blocks dispatch while reporting the exact failed prerequisite. Covers R2 and R3.

### Key Decisions

KD1. Existing-session delivery (session-settled: user-directed — chosen over replacement agents: preserve the human's working context). Any model is supported by protocol extensibility; actual harness support requires evidence.

KD2. Connector-gated review (session-settled: user-directed — chosen over separate review encryption groups: pending plaintext may stay in the trusted owner connector but not model context).

KD3. TypeScript and OSS reuse (session-settled: user-directed — chosen over custom infrastructure by default: reduce development). Netlify is preferred; Railway is acceptable when reuse saves work. Matrix remains a candidate, not a selected dependency.

### Scope Boundaries

- `apps/connector/src/runtime/`
- `apps/control/src/composition/agent/`
- `tests/integration/connector/`

No sibling implementation edits, root package/lockfile changes, provider deployment or production credentials. Root dependency changes go through KHA-101. This ticket does not add human installation/configuration, broaden history disclosure, weaken harness permissions or claim isolation from an unrestricted same-host agent. Integration is explicit, not accomplished by importing unfinished sibling implementations.

### Open Questions

Upstream G-SUBSTRATE, G-HARNESSES, G-AUTOMATION remain inherited; P02 determines browsers-closed runtime availability.

### Sources

- `docs/product/tickets/KHA-133.md`, `docs/product/decisions.md`, `docs/product/repo-layout.md`.
- `docs/research/01-agent-protocols.md`, `docs/research/02-substrates.md`, `docs/research/07-state-and-transport.md`.

## Planning Contract

Source manifest: `docs/evidence/transport-planning-sources.json` pins local repositories, read-only CLI observations and official documentation checks. No runtime proof is implied.

### Composition ownership and lifecycle

This is the integration reconnection owner for KHA-114/115/116/117/118/121. Own `apps/connector/src/runtime/create.ts`, `start.ts`, `stop.ts`, `status.ts`, `registry.ts`; hosted binding glue in `apps/control/src/composition/agent/handlers.ts`; tests in `tests/integration/connector/`. Export `createConnectorRuntime(config, factories): ConnectorRuntime`. Hosted `handlers.ts` exports `registerAgentHandlers(): readonly RouteRegistration[]`, importing the KHA-131 runtime type `{path:string;methods:readonly string[];handle:(request:Request)=>Promise<Response>}`. Restrict entries to `/api/agent/*`;131 owns the single generated Netlify gateway. Module import performs no network/bootstrap work. An absent producer reserves its domain as503; an existing malformed producer fails the build rather than silently disappearing. Factories adapt already-tested package exports; do not duplicate their policy/crypto/transport implementations or rewrite sibling files to hide integration gaps.

```ts
interface ConnectorRuntime {
  start():Promise<void>;
  status():RuntimeStatus;
  stop():Promise<void>;
}
type RuntimeStatus = {binding:SessionBinding|null;
  phase:"starting"|"ready"|"degraded"|"stopping"|"stopped";
  prerequisites:Readonly<Record<string,"ready"|"blocked"|"offline">>;
  effectivePolicyVersion:number|null; errorCode:string|null};
```

Configuration selects the substrate/harness adapter only after their decision/proof gates clear. Explicit factories/registration lists are sufficient; do not build a general plugin framework. KHA-133 owns the finite central list and a one-time bootstrap ownership exception: create unavailable `register.ts` placeholders under `apps/connector/src/composition/{review,controls,recovery}/`. Later KHA-134/135/136 replace only their owned placeholder, keeping the central imports valid from the first build. No future absent-file import, filesystem scan or later central-list edit is needed. Coordinate this narrow bootstrap exception with the parent ownership map.

`runtime/capabilities.ts` exports `ConnectorCapability` with `id: "review"|"controls"|"recovery"`, `state: "unavailable"|"ready"`, `start():Promise<void>`, `stop():Promise<void>`. Each `registerReview`, `registerControls`, `registerRecovery` takes `ConnectorCapabilityContext` and returns that handle. Context contains canonical binding, ConnectorLedger, Dispatcher and clock plus feature-specific protected transport dependencies supplied explicitly at the composition boundary; no untyped service locator. Placeholder start/stop are no-op, state stays unavailable. Required unavailable capabilities block their feature readiness; they never fake success. Feature close stops only its own observers, not the shared SDK. Parallel workers must not all change a shared registry. KHA-131 owns hosted runtime/provider configuration; app runtime consumes it rather than changing deployment setup.

### Startup and shutdown order

1. Validate configuration and open exclusive owner/device state lock. Recover ledger/crypto state using supported SDK semantics.
2. Run/recover the agent bootstrap operation and verify immutable binding/native session capabilities. If bootstrap needs storage, use the already-open scoped store; never open a second crypto machine for the same device.
3. Establish authenticated transport and durable subscription/catch-up. Load effective control state and reconcile unresolved dispatch intents. Missing keys, stale authority or replay gaps block readiness.
4. Start dispatch only when required state/control/harness prerequisites are ready. A public connection icon cannot substitute for readiness. Publish content-free status.
5. On stop/revocation, stop new claims, cancel subscription/reconnect scheduling, drain or mark in-flight outcomes according to observed evidence, flush ledger, close SDK and release lock. Abrupt termination is handled by durable recovery, not this graceful path alone.

Browser closure is not a connector shutdown signal unless P02 explicitly selects a browser-bound runtime. An owner-local agent helper may be long-lived, but setup/install/service ownership and lifecycle must satisfy the no-human-configuration contract. Do not select a background daemon mode silently to make the test pass.

### Worked reconnect

Start owner B in existing session S1 and binding generation0. Receive pending E7 with no model notification. For this base-runtime proof, an injected authenticated test approval fixture creates release R7 through the real ledger contract. KHA-134 later replaces that test-only input with the human browser approval path. Kill the connector after native acceptance but before receipt persistence. Restart opens the same device state, replays E7 once and sees unresolved R7 intent. It reconciles native evidence where supported or presents unknown; it does not mint a fresh device, create session S2 or resubmit R7 automatically. New E8 may continue through review only when the runtime can safely separate its eligibility from blocked R7.

## Implementation Units

### U1. Factories and single-owner lifecycle

Wire actual component exports and explicit config validation. Covers R1. Integration tests assert one SDK/device instance, lock conflict, ordered close and no double subscription. Detect missing required registration at startup rather than falling back to mocks.

### U2. Binding, recovery and readiness barriers

Depends U1 plus all card dependencies. Connect bootstrap result to store, subscription and harness; load controls before dispatch. Covers R1/R2, AE2. Test storage failure, invalid binding, missing keys, unsupported harness, expired authority, replay gap and disconnected control updates.

### U3. Fault-injected real-port path

Depends U2. Exercise pending→authenticated release fixture→dispatch with the actual selected backend/SDK in the integration profile, using approved synthetic content. This base proof has no dependency on later KHA-134/135/136. Their real human review/control/recovery integrations and complete workflow are verified by those tickets and KHA-140. Covers R2/R3 and AE1. Verify no pending data reaches harness and crash/restart preserves unknown state.

### U4. Central feature registration handoff

Create the finite imports and typed unavailable placeholders now; prove the base build succeeds while no later feature implementation exists. KHA-134/135/136 replace their own register modules without central edits or circular imports. Final real-feature composition proof belongs to KHA-140 after their merges. Publish minimal runtime state and diagnostic evidence refs; logs redact tokens, plaintext and owner secrets.

## Verification Contract

After scaffold run `pnpm --filter @khala/connector-app test`, `pnpm --filter @khala/control test`, `pnpm test`, `pnpm typecheck`. Tag/select integration tests through KHA-101's agreed test discovery; document required disposable backend/session inputs and explicit opt-in. Kill/restart tests use real disk and selected SDK, not only fake components. Live sends require designated test sessions. Planning started no runtime and sent no message.

## Definition of Done

Actual base components compose with one device owner, correct startup/control barriers and deterministic teardown; authenticated fixture release is explicitly test-only and is not claimed as human-UI acceptance. AE1/AE2 pass in the selected runtime, support/unknown states remain truthful, and independent component tests still pass. Inherited substrate/harness/automation and P02 gates are resolved before ready status; KHA-140 owns proof of the final fully merged composition.
