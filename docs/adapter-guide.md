# Khala adapter guide

A harness adapter connects Khala to one agent harness, such as Claude Code, Codex or
OpenCode, so that released channel messages reach an existing session. This guide
covers the extension points, the rules every adapter keeps, and how to prove an
adapter with the conformance suite. For the full contract, see
[`@khala/contracts/delivery`](../packages/contracts/src/delivery/README.md).

## Supported harnesses and versions

Support is scoped to the exact harness version, adapter version and evidence
reference. A newer version is not supported until its own evidence exists.
Documentation alone never promotes a route to `support: "tested"`.

| Harness and route | Version | State | Evidence |
| --- | --- | --- | --- |
| OpenCode, `@aiur/khala/opencode` plugin (`opencode_plugin`) | 1.17.10 | `tested`; acknowledgement `batch_token_next_call`; five recorded mode keys | [`fixtures/delivery/opencode.json`](../packages/contracts/fixtures/delivery/opencode.json), #180 proof |
| Claude Code CLI, native hooks (`claude-session-adapter-1`) | none proven | Route approved for collaboration (G-HARNESSES). The launcher inspects the installed `claude --version` as setup does. `CLAUDE_INTERACTIVE_PROVEN` is empty, so any inspected version is `experimental`: it delivers with acknowledgement `batch_token_next_call`, and its modes are labelled experimental, never proven. A version that cannot be inspected stays unproven. #231 is the receipt proof | [`claude-native-cli.md`](evidence/claude-native-cli.md) |
| Codex CLI, native queue (`native_cli_queue`) | 0.154.0 | `tested` for notification only; no release-ID reconciliation. Excluded from collaboration until #230 and #266 land. Both are parked on a broken Codex API key and block root acceptance | [`codex-native-cli.md`](evidence/codex-native-cli.md) |
| Codex app-server, Khala-hosted resume | 0.154.0 | `tested` only for a dormant thread Khala resumed itself | [`codex.md`](evidence/codex.md) |
| Claude Code SDK streaming | 2.1.276 | `unsupported` for the no-setup contract | [`claude.md`](evidence/claude.md) |
| Cursor, Claude Desktop and claude.ai, Codex desktop and cloud apps | — | Fail closed: every mode `unknown`. #244 and #245 are parked | [`app-harness.json`](../packages/contracts/fixtures/delivery/app-harness.json) |
| Generic fallback skill (`agent_installed_listener`) | — | `experimental`. Its socket frame was proven only against a synthetic listener | [`packages/agent-skill`](../packages/agent-skill/SKILL.md) |

## Extension points

An adapter has up to three parts, and each part has one owner directory.

1. **Delivery adapter:** `packages/harnesses/src/<harness>/`, exported as
   `@khala/harnesses/<harness>/*`. It implements `HarnessPort` from
   `@khala/contracts/delivery/index`:

   ```ts
   interface HarnessPort {
     inspect(binding: SessionBinding): Promise<HarnessCapabilities>;
     notify(binding: SessionBinding, hint: { v: 1; releaseId: ReleaseId }): Promise<void>;
     submit(input: { job: ReleasedJob; payload: Uint8Array }): Promise<DeliveryReceipt>;
     reconcile(job: ReleasedJob): Promise<DeliveryReceipt | null>;
     close(): Promise<void>;
   }
   ```

   `@khala/harnesses` depends only on `@khala/contracts`, and
   `pnpm check:boundaries` enforces this. Take the probe, clock, transport and
   limits as injected ports, as `createCursorHarness` does. Put test fakes behind an
   export that maps to `null` (for example `"./codex/fakes": null`), so they never
   ship.
2. **Setup adapter:** `packages/agent-cli/src/setup/adapters/<harness>.ts`, registered in
   `packages/agent-cli/src/composition/setup.ts`. It detects the harness, inspects it
   read-only and returns an exact plan of the paths it will change. It also supplies
   the bytes for that plan. Setup backs up and restores only the paths an adapter
   declares, and the adapter owns proof of that footprint.
3. **Agent surface:** the harness's own mechanism: hooks, an MCP entry or a plugin.
   Use the CLI or MCP route first (P15). If the harness has none, fall back to the
   Khala skill in `packages/agent-skill`.

## Rules every adapter keeps

- **Capabilities are evidence, not booleans.** `existingSession`,
  `immediateNotification` and `reconcileByReleaseId` are each `unknown` (not
  investigated), `unsupported` (investigated and absent), or a value that names the
  proven scope. `support: "tested"` needs an `evidenceRef`. Each mode row
  (`steer`, `sync`, `async`) pins its tested version, and that version must equal the
  harness version. If the harness is unproven, report `unsupported` with every
  capability `unknown`.
- **Only released content reaches the model.** `submit` and `reconcile` accept only a
  verified `ReleasedJob`. `notify` carries a release ID and nothing else. Never put
  pending content into a hint, status, log, error or model-facing surface.
- **Bytes stay out of process metadata.** Released or model-authored bytes never enter
  process arguments, environment variables, logs or errors.
- **Receipts are observations.** A transport write does not prove the harness accepted
  the message. Harness acceptance does not prove the model consumed it. Report only
  the receipt kinds the harness actually shows.
- **Unknown stays unknown.** After a disconnect that may have followed a write, report
  `outcome_unknown` and never submit again. `reconcile` finds a job only where the
  harness supports lookup by release ID. Deduplication after consumption is the
  connector's job.
- **Busy behavior is a fact, not a default.** Report `busy` as `queue`, `steer`,
  `reject` or `unknown`, based on what you observed.
- **Never launch or stop the agent.** Khala attaches to a session the person already
  started. Revoking a binding stops delivery. It does not stop the process.

## Proving an adapter with the conformance suite

The harness conformance suite (`tests/conformance/suites.ts`) runs each check in a
fresh scenario. Each check passes, fails with a reason, or is skipped with a reason.
A skipped check never counts as a pass, and a capability the adapter does not claim
is skipped rather than simulated.

1. Add `tests/conformance/<harness>-subject.ts`. It exports the adapter's
   capabilities, a `SuiteEnvironment` with at least two owners, and a
   `HarnessSubjectFactory`. The subject returns the `HarnessPort`, the inputs the
   session actually received (`modelInputs`), the receipts it observed afterwards,
   `settle`, and any faults it can enact. `cursor-subject.ts` is the smallest
   example.
2. Add `tests/conformance/<harness>.test.ts`. It calls
   `runHarnessConformance(subject, capabilities, environment)` and asserts that no
   check fails. Also add a deliberately broken variant, such as one that pushes a
   release into the chat, and assert that the suite rejects it.
3. Run it:

   ```sh
   pnpm test:conformance -- tests/conformance/<harness>.test.ts
   ```

The checks are `capabilities.declared`, `session.identity_preserved`,
`payload.exact_digest`, `notify.no_pending_hint`, `binding.owner_specific`,
`binding.revoked_blocks`, `receipt.consumption_is_observed`,
`fault.disconnect_after_write`, `fault.session_exit`, `fault.session_busy`,
`support.fail_closed`, and one `receipt.<kind>` check for each claimed receipt kind.

A run against fakes produces `fake-contract` evidence. That evidence proves the
adapter keeps the contract. It does not prove that a live route works. Live evidence
needs a registered driver in an opted-in disposable environment:

```sh
KHALA_E2E_LIVE=1 KHALA_E2E_DISPOSABLE_ENV=<disposable-environment-id> \
  pnpm test:conformance -- tests/conformance/<harness>.test.ts
```

`acceptLiveHarness` accepts only a `live-harness` report from that environment in
which every check in `CORE_LIVE_HARNESS_CHECKS` passed. Never point a live run at
production identities or a person's real session.

## Promoting a route

Record the live run's version, adapter version, sanitized evidence and replay commands
under `docs/evidence/`. Then add the exact version and route pair to the adapter's
proven list, such as `CLAUDE_INTERACTIVE_PROVEN`, or to its contract fixture. Finally,
update the table at the top of this guide. A hook firing, a passing offline test or a
semver range never promotes a version.
