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
Vitest with `tests/e2e/harness/vitest.config.ts`. That config maps `@khala/contracts`,
`@khala/harnesses`, `@khala/connector` and `@khala/policy` subpaths onto exactly the
targets each package's `exports` names; withheld subpaths do not resolve. A filter
that matches no file fails. `pnpm typecheck` also checks `tests/` through
`tests/e2e/harness/tsconfig.json`.

Live acceptance needs `KHALA_E2E_LIVE=1` and `KHALA_E2E_DISPOSABLE_ENV` naming a
disposable environment. Without them, `describeLive` entries are skipped and the
reason is shown in the name. `KHALA_E2E_LIVE=1` without an environment fails. Never
pass tokens as script arguments.

In live mode, a live case passes only if it returns the manifest of the live scenario it
drove. That manifest must be issued by a scenario, be in a live mode, and hold at least
one record, and a registered driver must have produced every record. An entry fails
unless at least one of its cases did this. Both scripts also load `live-reporter.ts`,
which fails the whole run unless at least one such case passed. It counts only cases
that `describeLive` tagged after checking their evidence, so a test merely named
`live: …` does not count. This covers name filters, file selections and runs with no
live entries. `live-gate.test.ts` runs the fixtures in `fixtures/live-gate/` through
`run.mjs` to prove each of these.

## Modules

- `owners.ts`: `createOwnerFixture(seed, controls)` builds a human, an agent
  participant, a connector device and one existing-session binding, using the
  KHA-105/106 fixture scalars (`owner-b`, `agent-b`, `dev-b`, `bind-b-1`). Every
  control is required. `assertIndependentOwners` refuses shared identities but
  ignores colliding email or display name. `ownerAuthority` is the only way to get
  an `OwnerAuthority`. `nextGeneration` re-arms a binding after revocation.
- `clock.ts`: one clock per owner. Fake clocks move only when advanced. Live
  clocks are monotonic and carry wall-clock provenance. `elapsed` refuses readings
  from different clocks.
- `faults.ts`: the nine faults. Each has one boundary and one oracle in
  `FAULT_SPECS`. Drivers call `checkpoint(boundary, ownerId, operationId)` at the
  boundary. Disconnect and crash faults throw from the checkpoint. The others return
  the fault for the driver to act out natively. An injected fault that never fires
  fails `assertCleanClose`.
- `evidence.ts`: every record has an `EvidenceMode`, holds only identifiers, and names
  the driver that produced it. Each field accepts only its own prefixed shape
  (`owner-…`, `release-…`, `event-…`, dotted kinds), so free text and email addresses
  are refused. Live records require a driver. `requireEvidence` names the modes it
  accepts, so a fake `context_consumed` cannot satisfy a live query.
  `combineManifests` combines only manifests an evidence log issued. It refuses to mix
  modes or versions.
- `scenario.ts`: `createScenarioHarness(config)` checks that owners are independent,
  gives each owner a private state directory and clock, and registers `ScenarioDriver`s.
  A driver must use the scenario's mode. A live scenario needs at least one live
  driver. In live modes `scenario.record`, `faults.checkpoint` and `faults.clear` are
  refused: each driver receives a `DriverHandle` through `attach`, and live evidence
  and fault firings go only through it. `close()` disposes resources in reverse order
  and reports leftovers and unfired faults.
- `live.ts`: `describeLive(entry, liveCase => ...)` for KHA-138/139 entries. A case
  body receives `{ disposableEnv, skip }` and returns its live `EvidenceManifest`.
- `reference.ts`: the fake owner connector and harness adapter used by self-tests and
  conformance. They are `fake-contract` evidence only. Their `defect` options add
  the bugs that the conformance oracles must catch. Every oracle has at least one.
- `internal.ts`: internal-mode composition for acceptance entries. `khala(profile, argv)`
  runs the production `khala` command table. `startLauncher` runs `khala internal` or
  `--resume` until it is closed, and `humanSession` redeems the printed bootstrap URL.
  `installProcessAudit` records every `node:child_process` start, so an entry can
  prove that Khala launched nothing.

## Internal mode (`tests/e2e/internal-mode/`)

Acceptance 1 of `docs/product/internal-mode/acceptance.md`.

- `protocol.test.ts` drives the real launcher, loopback server and SQLite store. Two
  externally started fake CLI sessions (`cli-driver.ts`) take part. The flow covers
  grants, two-way deliberate sends, a human message, batch-token acknowledgement,
  Stop, launcher close and `--resume`.
- `modes.test.ts` covers steer, sync, async and pause over the same real launcher.
  The owner sets the mode and pauses through the owner API. A granted fake Codex
  session fires the exact installed `khala codex-hook` and states its
  released capability claim, because no real Codex is installed.

## Conformance (`tests/conformance/`)

`runHarnessConformance(factory, capabilities, environment)` and
`runDeliveryConformance(factory, environment)` run each check in a fresh scenario
and return a report with `pass`, `fail` or `skip` plus a reason for each check, and
one evidence manifest per check. Receipt kinds that the capabilities do not claim,
and faults that the subject cannot inject, are skipped with a reason. They are never
counted as passes. An adapter that emits a receipt kind its capabilities do not claim
fails the check in which it did so. In a live suite a check passes only if a
registered driver recorded evidence during it.

`acceptLiveHarness(report, { required?, environment? })` refuses:

- a report that `runChecks` did not build
- a report that is not `live-harness`
- a run outside an opted-in live environment
- an empty required set (the default is `CORE_LIVE_HARNESS_CHECKS`)
- any failed check
- any required check that did not pass

A subject for a real adapter or connector implements `HarnessSubject` or
`DeliverySubject`. It declares its own evidence `mode`, and a check fails when that
differs from the suite's. It reports what the model session actually received
(`modelInputs`). A harness subject also reports receipts observed after `submit`
returned (`receipts`, for example a native receipt tracker). Its `settle` lets the
session consume queued work, and checks read consumption only after it. To enact a
fault, a subject lists it in `faults` and calls `checkpoint` at the matching native
seam. `inject(fault)` prepares that seam, for example an app-server reply that is
lost after the write. `codex-subject.ts` does this for the real Codex adapter over its
fake app-server, and `codex.test.ts` grades it with the same suite. Live suites pass
`drivers` in the environment; a live subject records and fires faults through its
driver's handle.

Delivery checks cover owner-specific authority and release, pending events kept out
of model context, refusal of `auto` policy, revocation (a revoked binding generation
blocks approval), no resubmission after an unknown outcome or a crash after intent,
duplicate delivery, delayed keys and reordered receipts.
