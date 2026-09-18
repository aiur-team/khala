# Multi-owner acceptance harness (KHA-137)

Test-only building blocks for cross-component proof. Nothing here ships in a package
export, selects a provider, or starts a daemon.

## Running

| Command | Selects |
| --- | --- |
| `pnpm test:conformance` | `tests/conformance/**/*.test.ts` |
| `pnpm test:e2e` | `tests/e2e/**/*.test.ts` (harness self-tests plus acceptance entries) |
| `pnpm test:e2e -- tests/e2e/security/security.test.ts` | one acceptance entry |

Both go through `run.mjs`, which drops the `--` that pnpm forwards. It then runs
Vitest with `tests/e2e/harness/vitest.config.ts`, which maps `@khala/contracts/*`
onto the package's own `exports` targets. A filter that matches no file fails. `pnpm typecheck` also
checks `tests/` through `tests/e2e/harness/tsconfig.json`.

Live acceptance needs `KHALA_E2E_LIVE=1` and `KHALA_E2E_DISPOSABLE_ENV` naming a
disposable environment. Without them, `describeLive` entries are skipped and the
reason is shown in the name. `KHALA_E2E_LIVE=1` without an environment fails. In live
mode an entry fails unless at least one live case ran to completion. Never pass
tokens as script arguments.

## Modules

- `owners.ts`: `createOwnerFixture(seed, controls)` builds a human, an agent
  participant, a connector device and one existing-session binding, using the
  KHA-105/106 fixture scalars (`owner-b`, `agent-b`, `dev-b`, `bind-b-1`). Every
  control is required. `assertIndependentOwners` refuses shared identities but
  ignores colliding email or display name. `ownerAuthority` is the only way to get
  an `OwnerAuthority`.
- `clock.ts`: one clock per owner. Fake clocks move only when advanced. Live
  clocks are monotonic and carry wall-clock provenance. `elapsed` refuses readings
  from different clocks.
- `faults.ts`: the nine faults. Each has one boundary and one oracle in
  `FAULT_SPECS`. Drivers call `faults.checkpoint(boundary, ownerId, operationId)`.
  Disconnect and crash faults throw from the checkpoint. The others return the fault
  for the driver to act out. An injected fault that never fires fails
  `assertCleanClose`.
- `evidence.ts`: every record has an `EvidenceMode` and holds only identifier tokens.
  `requireEvidence` names the modes it accepts, so a fake `context_consumed` cannot
  satisfy a live query. `combineManifests` refuses to mix modes or versions.
- `scenario.ts`: `createScenarioHarness(config)` checks that owners are independent,
  gives each owner a private state directory and clock, and registers `ScenarioDriver`s.
  A driver must use the scenario's mode, and live faults need a driver that can enact
  them. `close()` disposes resources in reverse order and reports leftovers and
  unfired faults.
- `live.ts`: `describeLive(entry, liveCase => ...)` for KHA-138/139 entries.
- `reference.ts`: the fake owner connector and harness adapter used by self-tests and
  conformance. They are `fake-contract` evidence only. Their `defect` options add
  the bugs that the conformance oracles must catch.

## Conformance (`tests/conformance/`)

`runHarnessConformance(factory, capabilities, environment)` and
`runDeliveryConformance(factory, environment)` run each check in a fresh scenario
and return a report with `pass`, `fail` or `skip` plus a reason for each check.
Receipt kinds that the capabilities do not claim, and faults that the subject
cannot inject, are skipped with a reason. They are never counted as passes.
`acceptLiveHarness(report, required)` refuses a fake report, any failed check, and
any required check that was skipped.

A live driver for a real adapter or connector implements `HarnessSubject` or
`DeliverySubject`. It reports what the model session actually received
(`modelInputs`) and lists the faults it can inject.
