# One-command agent setup

Status: research complete (2026-09-24)

Deliverable: `setup-cli`

## Summary

Khala should ship one non-interactive CLI that detects Claude Code, Codex, and
OpenCode and reconciles a reviewed plugin, MCP entry, and skill for every
installed, supported harness. The interface is:

```text
khala setup [--dry-run]
khala status [--check]
khala remove [--dry-run]
```

All commands return versioned JSON. `status` retains its existing connection
fields and adds a nested `configuration` report; `--check` is the CI form that
returns non-zero for drift, conflicts, or unsupported detected harnesses.
`setup` and `remove` share one deterministic planner, transaction journal, and
rollback engine. A dry run uses the same plan but performs no Khala writes,
lock creation, cache population, or telemetry. `npx` may populate its own cache
before Khala starts; that is outside the CLI's dry-run boundary.

The publishable package can be `@khala/agent-cli`, whose bin remains `khala`.
The literal `npx khala setup` spelling is **blocked**: npm already has an
unrelated unscoped `khala@1.2.7` package. Until that namespace is transferred,
the honest invocation is `npx --yes @khala/agent-cli@<version> setup`.

## Fixed decisions and assumptions

The operator decisions D1-D12 in the
[internal-mode requirements](https://github.com/aiur-team/khala/blob/6edc181d847354d21eb28bffd4e1b48fd30aec5d/docs/product/internal-mode/requirements.md)
remain fixed. This design consumes rather than reopens them. The companion
[survey](https://github.com/aiur-team/khala/blob/6edc181d847354d21eb28bffd4e1b48fd30aec5d/docs/product/internal-mode/survey.md)
supplied the initial reuse map. Both inputs were read from PR #136 head
`6edc181d` because they were not yet on `main` during this research.

| Item | Assumption used here |
| --- | --- |
| Install scope | v1 configures the current user's global harness scope. Project-local setup is out of scope. |
| Output | JSON is the default and only required v1 renderer. No command prompts. |
| Existing `status` | Its current connection/inbox fields and zero-exit informational behavior remain compatible; configuration is additive and `--check` supplies CI failure semantics. |
| Harness selection | Configure every detected and supported harness; report absent harnesses without creating their config roots. |
| Unsupported harness | Any detected unsupported version makes setup/remove refuse before mutation. A machine with no detected harness is a successful no-op; status still reports every absent/unsupported result. |
| Pre-existing Khala entry | Identical manifest-owned state is reused. Any unowned entry, even if identical, is a conflict; v1 has no `--force` or adopt mode. |
| Vendor mutations | An adapter is supported only after its complete mutation footprint is proven for a version range. Unknown vendor-CLI side effects are `unsupported`, not implicitly owned. |
| Runtime path | Setup copies a self-contained, versioned payload under the XDG data root and points harness entries at a stable owned launcher, never an ephemeral npx cache path. |

## Findings and evidence

### Repository evidence

| Finding | Evidence | Consequence |
| --- | --- | --- |
| The CLI is private and not publishable. | [`packages/agent-cli/package.json`](../../../packages/agent-cli/package.json) has `private: true`, version `0.0.0`, a `dist` bin, source exports, and unpublished `workspace:*` runtime dependencies. `packages/agent-skill` is also private and has a workspace dependency. | Publish a self-contained runtime artifact or publish the entire dependency closure. A single bundle has the smaller release and compatibility surface. |
| Setup commands do not exist. | [`runCli`](../../../packages/agent-cli/src/cli/app.ts) dispatches only `connect`, `listen`, `send`, `status`, and `mcp-serve`. | Add setup/remove dispatch and extend, rather than replace, status. |
| `status` is already public behavior. | The existing command returns connection and inbox JSON; tests assert its exact behavior. | Repurposing bare `status` would be a regression. Add `configuration` and a `--check` mode. |
| The executable is not yet connected to a real provider. | [`main.ts`](../../../packages/agent-cli/src/cli/main.ts) composes `createUnavailableClient()`. | Installation readiness and live route support must be reported separately. |
| MCP has a narrow proven surface. | [`server.ts`](../../../packages/agent-cli/src/mcp/server.ts) implements stdio MCP `2025-03-26` with one `khala_send` tool. | Setup may register this server, but cannot claim broader MCP or listening support. |
| Safe file primitives exist, not an installer. | [`inbox.ts`](../../../packages/agent-cli/src/cli/inbox.ts) uses owner-only directories/files, no-follow/exclusive creation, atomic rename, and quarantine. [`backup.ts`](../../../infra/operations/backup.ts) publishes completed artifacts before an atomic manifest. | Reuse these invariants in a new setup transaction module; do not import across the `infra`/package boundary. |
| The fallback skill already names two install roots. | [`packages/agent-skill/README.md`](../../../packages/agent-skill/README.md) documents `~/.codex/skills/khala` and `~/.claude/skills/khala`, and requires both `khala` and `khala-fallback` on `PATH`. | Package reviewed skill assets and install stable launchers; do not duplicate the skill text in adapters. |

### Local proofs

These commands were run in this checkout on 2026-09-24. They prove only the
named version and observed behavior.

| Proof | Observed result | Confidence |
| --- | --- | --- |
| `claude --version`; `claude plugin --help`; `claude mcp --help` | Claude Code `2.1.282`; plugin install/remove and MCP add/remove are exposed, with scopes. | Proven for this version's CLI surface; complete mutated-file footprint remains unproven. |
| `codex --version`; `codex plugin --help`; `codex mcp --help` | Codex CLI `0.154.0`; plugin add/remove and MCP add/remove are exposed. | Proven for this version's CLI surface; complete mutated-file footprint remains unproven. |
| `opencode --version`; `opencode plugin --help`; `opencode mcp --help` | OpenCode `1.17.10`; plugin and MCP add/list/auth/logout surfaces are exposed, but no remove command was shown. | Add/configure surface proven; CLI removal is **unproven**. Plan a guarded config edit and exact restore instead. |
| `pnpm --filter @khala/agent-cli test` | 5 files and 35 tests passed after a frozen install. | Existing CLI/MCP behavior is locally green. |
| `pnpm --filter @khala/agent-cli build`; run built `status` | Build passed; built status emitted the expected unavailable JSON. | Current source builds and its bin starts, but is not a standalone install proof. |
| `npm pack --dry-run` before and after build | Before build, the bin target was absent. After build, `dist` appeared, but source and tests were also packed. | A `prepack` build and `files` allowlist are required. |
| `npm view @khala/agent-cli`; connector/contracts lookups | All returned npm 404. | Workspace dependencies cannot resolve for public consumers today. |
| `npm view khala` | `khala@1.2.7` exists, is unrelated, and is owned by another maintainer. | Exact `npx khala setup` is blocked on external namespace control. |

The local Node runtime was `24.18.0`, while the repository pins `22.23.2`;
release proof must run on the pinned version. Package tests passing on Node 24
do not replace that gate.

### Primary vendor evidence

| Harness | Documented integration surface | Design use |
| --- | --- | --- |
| Claude Code | [Plugins](https://code.claude.com/docs/en/plugins) can bundle skills and MCP configuration; [skills](https://code.claude.com/docs/en/skills) and [MCP](https://code.claude.com/docs/en/mcp) are also independently configurable. | Consume the `claude-plugin` artifact and install it at user scope. Snapshot every registry/config path the supported CLI version mutates. |
| Codex | [Plugins](https://developers.openai.com/plugins/build/plugins) use `.codex-plugin/plugin.json` and can bundle skills and MCP configuration. | Package the reviewed Codex plugin, skill, and MCP server definition as one artifact when producer contracts permit. |
| OpenCode | [Plugins](https://opencode.ai/docs/plugins), [skills](https://opencode.ai/docs/skills), and [MCP servers](https://opencode.ai/docs/mcp-servers) are configured separately; global skills live below `~/.config/opencode/skills`. | Install the producer-owned plugin and skill, and patch the MCP/config entry transactionally. |

Vendor documentation proves supported concepts, not exact rollback behavior.
Each adapter contract therefore includes a synthetic-home mutation-footprint
test before its version range can be marked supported.

## Design

### Command contract

Each setup lifecycle command (`setup`, `remove`, and configuration-bearing
`status`) emits one JSON object to stdout. Existing `listen` and `mcp-serve`
streaming behavior is unchanged. Diagnostics are structured; stderr is reserved
for an invocation failure that prevents a result envelope. Foreign config
contents and credentials are never emitted.

```json
{
  "v": 1,
  "command": "setup",
  "ok": true,
  "changed": false,
  "state": "ready",
  "planDigest": "sha256:…",
  "harnesses": [],
  "operations": [],
  "diagnostics": []
}
```

`khala status` preserves its existing top-level `v`, `connected`, `binding`,
`route`, `sourceCursor`, and `inbox` fields and adds `configuration` with the
same harness model. Component states are `absent`, `ready`, `drifted`,
`conflict`, or `unsupported`. Executable presence, supported version, three
component states, and tested route support are separate facts.

| Exit | Meaning |
| ---: | --- |
| 0 | Command completed and all selected harnesses reached the requested state; bare status remains informational. |
| 2 | Invalid invocation or input. |
| 3 | Safe refusal: conflict, drift, unsupported detected version, or `status --check` not ready. |
| 4 | Indeterminate result: apply or rollback failed and final state could not be proven. |

Plans are stable-sorted by harness, component, and path. The plan digest omits
timestamps, random transaction IDs, temporary paths, and backup contents, so
two dry runs against identical state are byte-for-byte equal. Dry run remains
strictly zero-write: it refuses an active transaction, reads an optimistic
snapshot, and revalidates every observed identity/hash before returning. Apply
always replans under the mutation lock and may return a different digest when
state changed after the preview; a dry-run digest is not a reservation.

### State and transaction model

| Location | Contents | Ownership |
| --- | --- | --- |
| `$XDG_DATA_HOME/khala/versions/<version>/` | Self-contained CLI runtime plus reviewed plugin/skill assets | Installer-owned; directories 0700, regular files 0400, executables 0500; immutable after commit |
| `$XDG_DATA_HOME/khala/bin/` | Stable `khala` and `khala-fallback` launchers | Installer-owned; directory 0700, launchers 0500 |
| `$XDG_STATE_HOME/khala/setup/manifest.v1.json` | Active desired state, selected versions, operation IDs, pre/post hashes, and backup references | Installer-owned, mode 0600 |
| `$XDG_STATE_HOME/khala/setup/transaction.v1.json` | Write-ahead state, operation preconditions, backup references, applied-operation cursor, and recovery state | Installer-owned, mode 0600 |
| `$XDG_STATE_HOME/khala/setup/backups/<transaction>/` | Byte-exact foreign-file preimages and absence markers | Installer-owned directory 0700; files 0600 |
| Harness config/registry paths | Only adapter-declared entries and files | Foreign; never overwritten without a completed preimage backup |

The same pure `discover -> inspect -> plan` pipeline serves all commands.
Apply/remove take an exclusive process lock, finish backup artifacts, execute
stable-ordered operations, verify each postimage, then atomically publish the
manifest. On failure they reverse applied operations and report every operation
as planned, applied, rolled back, or rollback-failed.

Before the first mutation, the executor durably publishes a `prepared` journal
with all preconditions and backup references. It durably advances the journal
after each applied operation, records `rollback_failed` when exact recovery
cannot be proven, and removes it only after manifest commit or a proven complete
rollback. Every command first recovers a prepared/partially-applied journal;
read-only status may instead report `recovery_required`. A committed journal is
safe to finalize, while an unknown state or newer schema is a safe refusal.

Idempotency is byte-level: a second setup on ready state has `changed: false`,
an empty operation list, and changes neither contents nor mtimes. Command exit
success alone never establishes readiness.

### Ownership and exact removal

| Target state | Setup | Remove |
| --- | --- | --- |
| Installer-owned path absent | Create exclusively, record hash. | Delete only if its current hash matches the manifest. |
| Installer-owned path matches | Reuse. | Delete. |
| Installer-owned path drifted | Refuse and report drift. | Refuse; preserve it. |
| Foreign file absent | Record absence, then create through atomic replace. | Delete only if the current postimage hash matches. |
| Foreign file present | Persist byte-exact preimage before atomic replacement; record pre/post hashes. | If current hash equals the recorded postimage, restore the byte-exact preimage. |
| Foreign file changed after setup | Do not overwrite. | Refuse and preserve both user state and backup. |
| Unowned Khala-named entry exists | Refuse as a conflict, including when byte-identical. | Never remove it. |

Opaque vendor CLI side effects cannot satisfy this model. An adapter must name
and verify every possible mutated path for each supported version range; if it
cannot, it must use a documented direct configuration edit or report
`unsupported`. Removal never calls a vendor "remove" command and hopes it was
exact. Before either setup or remove mutates anything, all targets are checked
for escaping symlinks and every selected harness is checked for drift; one
unsafe target refuses the whole transaction without partial cleanup. The
executor also rechecks each foreign target's identity and hash immediately
before replacement. A mismatch rolls back earlier operations and preserves the
new bytes. Backup reads, traversal, replacement, and deletion use no-follow,
race-resistant filesystem primitives rather than relying on preflight checks;
ownership and identity are verified again after every operation.

### Harness adapters

Adapters are data/operation providers: detect executable and version, inspect
the declared roots, and return install/remove primitives. They do not print,
prompt, lock, choose rollback policy, or mutate outside the executor.
Subprocess operations use a resolved absolute executable, an argument array
without a shell, and a minimal environment derived from the inspected HOME,
XDG, and PATH inputs.

| Harness | Desired components | Producer dependency | Adapter constraint |
| --- | --- | --- | --- |
| Claude Code | user-scope Claude plugin containing the skill and MCP entry | `claude-plugin`, `mcp-piggyback` | Support only versions whose plugin registry/config mutation footprint is proven. |
| Codex | Codex plugin containing the skill and MCP entry | `mcp-piggyback`, `listening-modes` | Preserve the established config and plugin registry; route support remains a separate capability label. |
| OpenCode | OpenCode plugin, global skill, and MCP config | `opencode-bridge`, `mcp-piggyback` | Use a guarded direct config edit for removal unless a tested exact vendor removal surface appears. |

Claude and Codex plugin selectors require a marketplace. Their producer-owned
plugin artifacts therefore ship in versioned local Khala marketplace catalogs
inside the immutable payload. Each adapter models marketplace registration,
plugin selection, conflicts, status, rollback, and removal as declared
operations; registration is not an invisible prerequisite. If local
marketplace registration cannot be proven complete for a harness version, that
version remains unsupported.

Support certification observes filesystem writes made by each vendor command
across clean, populated, and conflicting synthetic homes. Any write outside the
declared transaction plan fails certification. Fixtures demonstrate known
paths; they are not treated as proof that an unobserved side effect cannot
exist, so uncertain versions remain unsupported or use guarded direct edits.

### Packaging and upgrade behavior

`@khala/agent-cli` should build before packing, publish only the runtime bundle,
license, README, and reviewed assets, and contain no `workspace:*` runtime
resolution. A fresh-prefix tarball test must invoke the bin outside the
monorepo. Releases use the repository's pinned Node version and a pinned npm
package version in automation.

Setup stages a new immutable payload, plans harness pointer changes, and commits
the manifest only after all pointers verify. Old payloads/backups remain until
the new transaction commits and may then be garbage-collected only when no
manifest references them. Downgrade follows the same transaction. Cross-major
manifest migration is out of scope for v1; an unknown manifest version is a
safe refusal. A clean remove deletes the manifest, unreferenced backups, and
owned runtime after restoring foreign files. It never deletes connection
identity, inbox state, room data, or harness credentials. Status reports
`configured` separately from `effective`, because a running harness may require
a restart before loading new configuration. Only backups referenced by the
active manifest or a recoverable journal are retained; startup recovery deletes
unreferenced transaction backups after a proven commit or rollback. Status
verifies owned payload hashes, ownership, and modes before reporting ready.

## Trade-offs

| Choice | Benefit | Cost |
| --- | --- | --- |
| Self-contained package | One public artifact; fresh installs do not depend on private workspace packages. | Requires a bundle/license audit and a release-specific build path. |
| Additive composite status | Preserves existing automation while satisfying configuration reporting. | The response grows and runtime status remains coupled to setup reporting. |
| Byte-exact backups and drift refusal | Makes "remove undoes it exactly" testable without destroying later user edits. | Uses more state and sometimes requires manual conflict resolution. |
| Version-gated adapters | Never claims safety from executable presence alone. | New harness versions may temporarily report unsupported. |
| All-selected-harness transaction | Avoids a misleading half-configured success. | One failing adapter rolls back otherwise valid changes. |
| JSON-only v1 | Deterministic, agent-native, and CI-friendly. | Less friendly for casual terminal use; a text renderer can be added later from the same model. |

## Risks

| Risk | Mitigation |
| --- | --- |
| The unscoped npm name remains unavailable. | Publish and document the scoped invocation; do not advertise exact `npx khala` until ownership is verified. |
| Vendor CLIs change undocumented registry files. | Version-gate support, prove the mutation footprint in synthetic homes, and fail closed on unknown versions. |
| Foreign config contains secrets. | Backups are owner-only; output contains hashes/paths, never contents; fixtures include sentinel-secret leak tests. |
| Concurrent setup/remove corrupts the journal. | Exclusive lock and stable busy diagnostic; only one process may mutate a state root. |
| A process dies between file mutation and manifest publication. | Write-ahead operation journal plus startup recovery; acceptance tests kill after each mutation boundary. |
| npx prompts before Khala starts. | Automation uses `npx --yes` with a pinned scoped version; npm authentication/consent remains outside Khala. |
| Install readiness is mistaken for route support. | Report detected/configured/supported/tested route facts separately and consume capability evidence from the harness research tickets. |

## Non-goals

- Acquiring or transferring the unscoped npm `khala` package.
- Logging into npm or a harness, elevating OS permissions, or accepting vendor
  consent on the operator's behalf.
- Project-local configuration, Windows support, remote/fleet installation, GUI
  setup, or a v1 human text renderer.
- `--force`, adoption of foreign entries, semantic three-way merge on removal,
  or deleting drifted files.
- Undoing vendor caches, telemetry, update metadata, or configuration retained
  by an already-running harness; exact removal covers declared files and
  installer-owned artifacts.
- Implementing plugin, MCP, listening, or bridge behavior owned by the other E09
  research areas.
- Claiming a working Khala delivery route merely because configuration exists.

## Ticket contracts

Contracts are ordered to serialize the shared CLI surface and keep each ticket
finishable by one agent in one PR.

### 1. Publish a self-contained agent CLI

`slug: setup-cli-package`

`complexity:4`

| Field | Contract |
| --- | --- |
| Scope | Make `@khala/agent-cli` public-ready; bundle its runtime dependency closure; add prepack/build metadata, a strict files allowlist, and version/license/repository/publish metadata. |
| Out of scope | npm credentials, release execution, unscoped-name transfer, setup behavior, publishing connector/contracts separately. |
| Files/packages | `packages/agent-cli/package.json`, build config/scripts under `packages/agent-cli/`, `pnpm-lock.yaml` if needed, package README, release workflow/docs. |
| Acceptance | `npm pack` from a clean checkout contains the bin and allowlisted runtime/assets only; a fresh-prefix install on Node 22.23.2 runs `khala status`; no runtime import resolves to the workspace. Scoped package identity is used until the external name gate clears. |
| Tests | Pack-content assertion; install tarball in an empty temp prefix and execute the bin. **Wrong implementation killer:** remove the bundle's embedded connector module (or point the bin at absent `dist`) and prove the smoke test fails. |
| `blocked-by` | None for the scoped package. Exact `npx khala`: external npm namespace transfer. |
| Conflict risk | **High** with setup-planner work in `package.json`, CLI entrypoint, and README; land this contract first. Do not edit producer-owned plugin behavior. |

### 2. Add setup discovery, planning, and status

`slug: setup-cli-plan`

`complexity:3`

| Field | Contract |
| --- | --- |
| Scope | Define setup/configuration result schemas, exit codes, XDG path resolution, executable/version discovery, observed/desired state, deterministic setup/remove plans, additive configuration `status`, `status --check`, both dry runs, and the side-effect-free adapter interface. |
| Out of scope | Applying mutations, journal/backups, real harness adapters, force/adopt, text UI, route capability implementation. |
| Files/packages | `packages/agent-cli/src/cli/{app,main,types}.ts`; new `packages/agent-cli/src/setup/{types,paths,detect,plan}.ts`; adjacent tests; CLI README. |
| Acceptance | Existing connection-status fields remain compatible; HOME/XDG/PATH are injectable; absent/unsupported/conflict/drift states are distinct; repeated plans are byte-identical; setup/remove dry runs are zero-write; secrets never appear in output; adapters cannot mutate. |
| Tests | Synthetic homes, fake PATH/version runner, byte/mtime snapshots, schema/exit-code tests. **Wrong implementation killer:** run the same dry run twice and fail if stdout differs or any filesystem metadata changes. |
| `blocked-by` | `setup-cli-package`. |
| Conflict risk | **High** with every later ticket at CLI/schema seams. Land the planner and adapter interface first. |

### 3. Execute setup plans transactionally

`slug: setup-cli-transaction`

`complexity:4`

| Field | Contract |
| --- | --- |
| Scope | Apply planner operations under an exclusive lock; implement owner-only write-ahead journal/backups, per-operation preconditions, no-follow path handling, atomic replacement, postimage verification, rollback, startup recovery, manifest commit, exact removal, drift refusal, and backup cleanup; wire non-dry setup/remove. |
| Out of scope | Harness-specific mutation discovery, force/adopt, text UI, route behavior, manifest major-version migration. |
| Files/packages | New `packages/agent-cli/src/setup/{manifest,transaction,filesystem}.ts`; setup/remove wiring in CLI composition; adjacent tests; CLI README. |
| Acceptance | Second setup is zero-change; a detected unsupported harness refuses before mutation; all-selected-harness failure rolls back; drift refuses the whole removal; crash recovery is deterministic; concurrent mutation returns a stable busy result; modes/ownership/hashes are verified. |
| Tests | Inject failure or termination after every mutation boundary; modify a later target between planning and apply; swap symlinks; corrupt journals; run competing processes. **Wrong implementation killer:** change a foreign file after setup and assert remove returns drift without changing one byte; a "restore anyway" implementation fails. |
| `blocked-by` | `setup-cli-plan`. |
| Conflict risk | **High** with adapters that emit operation types. Freeze the executor vocabulary before adapter work lands. |

### 4. Add the Claude Code setup adapter

`slug: setup-cli-claude`

`complexity:3`

| Field | Contract |
| --- | --- |
| Scope | Detect/version Claude Code; inspect and plan a versioned local Khala marketplace registration plus user-scope installation/removal for the producer-owned Claude plugin, bundled skill, and MCP entry; enumerate and test the complete mutation footprint for supported versions. |
| Out of scope | Authoring plugin hooks/slash commands, Claude authentication, project/local scope, direct mutation outside the transaction executor. |
| Files/packages | New `packages/agent-cli/src/setup/adapters/claude.ts` and tests; packaged Claude asset references; support matrix docs. |
| Acceptance | Absent Claude is reported without creating `~/.claude`; supported versions reach ready; unknown versions fail closed; status distinguishes installation from tested route support; remove restores exact preimages. |
| Tests | Observe writes across clean, populated, and conflicting synthetic homes; assert every changed path is present in the transaction plan. **Wrong implementation killer:** simulate a vendor command changing an undeclared registry file and require the adapter proof to fail rather than report ready. |
| `blocked-by` | `setup-cli-transaction`; `claude-plugin`; `mcp-piggyback`. |
| Conflict risk | **Medium** with Claude artifact producers; consume their exports and avoid editing their behavior or manifests. |

### 5. Add the Codex setup adapter

`slug: setup-cli-codex`

`complexity:3`

| Field | Contract |
| --- | --- |
| Scope | Detect/version Codex; inspect and plan a versioned local Khala marketplace registration plus global Codex plugin, skill, and MCP registration; enumerate and test the complete mutation footprint; retain capability-honest route labels. |
| Out of scope | Changing Codex notification/listening semantics, Codex login, project scope, or reimplementing the MCP server. |
| Files/packages | New `packages/agent-cli/src/setup/adapters/codex.ts` and tests; Codex plugin manifest/assets supplied by producer contracts; support matrix docs. |
| Acceptance | Codex 0.154.0 fixture has a proven plan; absent/unknown versions are distinct; existing unrelated config survives byte-exact setup/remove; plugin/MCP command success without expected postimages is not ready. |
| Tests | Observe writes across clean, populated, and conflicting `.codex` trees; fake command runner; pre/post byte assertions. **Wrong implementation killer:** fake exit 0 while omitting the MCP postimage and assert setup fails and rolls back. |
| `blocked-by` | `setup-cli-transaction`; `mcp-piggyback`. |
| Conflict risk | **Medium** with MCP/listening producers and any shared Codex plugin manifest; adapter owns lifecycle only. |

### 6. Add the OpenCode setup adapter

`slug: setup-cli-opencode`

`complexity:3`

| Field | Contract |
| --- | --- |
| Scope | Detect/version OpenCode; plan installation of the producer-owned plugin, global skill, and MCP entry; use a guarded config edit and exact backup restore where no proven remove CLI exists. |
| Out of scope | Authoring the OpenCode bridge, vendor auth, project scope, speculative use of an undocumented remove command. |
| Files/packages | New `packages/agent-cli/src/setup/adapters/opencode.ts` and tests; packaged OpenCode asset references; support matrix docs. |
| Acceptance | Version 1.17.10 fixture configures all three components; absent OpenCode creates nothing; comments/formatting and unrelated config bytes return exactly after removal; unsupported schema/version refuses safely. |
| Tests | Synthetic XDG config/skill roots with unusual formatting and sentinel secrets. **Wrong implementation killer:** remove via parse-and-reserialize and assert the final file differs from its byte-exact preimage, failing the test. |
| `blocked-by` | `setup-cli-transaction`; `opencode-bridge`; `mcp-piggyback`. |
| Conflict risk | **Medium** with bridge packaging/config work; the adapter must consume, not duplicate, its plugin entrypoint. |

### 7. Gate setup release with cross-harness acceptance

`slug: setup-cli-acceptance`

`complexity:4`

| Field | Contract |
| --- | --- |
| Scope | Add black-box tests through the packed tarball for mixed installed/absent/unsupported harnesses, idempotency, deterministic dry runs, rollback/recovery, drift-safe removal, upgrade, concurrency, secret redaction, and CI check semantics; wire the release gate and concise operator docs. |
| Out of scope | Live vendor accounts, npm publishing, acquiring the unscoped name, UI, or duplicating unit coverage. |
| Files/packages | Cross-component tests under `tests/` (for example `tests/integration/agent-setup/`), package/release workflow, `packages/agent-cli/README.md`, operator setup docs. |
| Acceptance | A clean synthetic home goes setup -> second setup/no change -> ready check -> exact remove; mixed harness states are correctly reported; kill/restart recovers or safely refuses; the installed tarball works outside the monorepo on the pinned Node runtime. |
| Tests | Matrix across all adapter fixtures and transaction fault points. **Wrong implementation killer:** fail after the first of three harness mutations and assert every preimage is restored, no committed manifest exists, and the command cannot return `ok: true`. |
| `blocked-by` | `setup-cli-package`, `setup-cli-plan`, `setup-cli-transaction`, `setup-cli-claude`, `setup-cli-codex`, `setup-cli-opencode`, and `acceptance`; route assertions additionally depend on `internal-core`, `listening-modes`, `mcp-piggyback`, `claude-plugin`, and `opencode-bridge`. |
| Conflict risk | **Low** if it owns cross-component tests/docs; **high** if it edits adapter internals. Keep fixes in their owning contracts. |

## Recommended order

```text
public package
    -> discovery/planning/status
        -> transaction engine
            -> Claude adapter ─┐
            -> Codex adapter  ─┼-> cross-harness acceptance/release gate
            -> OpenCode adapter┘
```

The three adapters may proceed in parallel after the planner and executor
interfaces land. The acceptance ticket is the only ticket that should assert
the full packaged flow.
