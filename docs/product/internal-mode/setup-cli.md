# One-command agent setup

Status: research complete (2026-09-24)

Deliverable: `setup-cli`

## Summary

Khala should publish `@aiur/khala`, a non-interactive CLI that an agent can run
after receiving “Open a channel with another agent: https://khala.aiur.team”.
It detects Claude Code, Codex, and OpenCode and reconciles only the components
required by each installed, supported harness. The interface is:

```text
npx @aiur/khala setup [--dry-run] [--confirm <plan-digest>]
npx @aiur/khala status [--check]
npx @aiur/khala remove [--dry-run] [--confirm <plan-digest>]
```

All commands return versioned JSON. When `setup` or `remove` plans mutations,
it first returns a readable operation plan and `confirmation_required`; the
agent relays it to the person. Only after the person confirms does the agent
repeat the command with that plan digest. An empty, already-satisfied plan
succeeds without confirmation.
There is no interactive terminal prompt and the person never runs an install
step. `status` retains its existing connection fields and adds a nested
`configuration` report; `--check` is the CI form that returns non-zero for
drift, conflicts, pending Codex hook review, or when every detected harness is unsupported.
`setup` and `remove` share
one deterministic planner, transaction journal, and rollback engine. A dry run
uses the same plan but performs no Khala writes, lock creation, cache
population, or telemetry. `npx` may populate its own cache before Khala starts;
that is outside the CLI's dry-run boundary.

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
| Initiator and consent | The user's existing agent runs the CLI. A mutation requires a digest-bound confirmation from the person, relayed by that agent; setup never asks the person to install anything. |
| Consent boundary | The digest proves that the initiating agent supplied the current confirmed plan, not cryptographic human presence. The initiating agent is a trusted relay; a malicious or compromised agent is out of scope. |
| Harness selection | Configure every detected and supported harness; report absent harnesses without creating their config roots. |
| Unsupported harness | An unsupported detected version blocks setup/upgrade for that harness only: setup leaves it unchanged, reports it unsupported with a `harness_unsupported` warning, and still configures every other detected, supported harness. Setup refuses as `unsupported` only when no detected harness is supported. Manifest-driven recovery or removal stays available when the manifest schema is supported and every managed postimage still matches. A machine with no detected harness is a successful no-op; status still reports every absent/unsupported result. |
| Pre-existing Khala entry | Identical manifest-owned state is reused. Any unowned entry, even if identical, is a conflict; v1 has no `--force` or adopt mode. |
| Vendor mutations | An adapter is supported only when it uses guarded direct edits or confines an exact tested vendor version to declared writable targets. Unconstrained vendor-CLI side effects are `unsupported`, not implicitly owned. |
| Runtime path | Setup copies a self-contained, versioned payload under the XDG data root and points harness entries at a stable owned launcher, never an ephemeral npx cache path. |
| Agent lifecycle | Setup configures the user's own already-started CLI session. Khala does not launch or host Claude, Codex, or OpenCode, and a `khala run <cli>` wrapper is not a v1 default. |
| Immediate continuation | If newly written harness configuration is not effective in the initiating session, the result names an installed CLI fallback that the same agent can use immediately to finish the channel request; it never asks the person to restart or run a command. |
| Runtime discovery | Installed entries resolve the active port and token from the owner-only runtime descriptor on every invocation; setup never embeds either value. |
| Claude hardening | Setup never installs a restricted profile. `setup` and `status` only report the optional hardening check; absence never blocks ordinary delivery (decision 25). |

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
| The fallback skill already names two install roots. | [`packages/agent-skill/README.md`](../../../packages/agent-skill/README.md) documents `~/.codex/skills/khala` and `~/.claude/skills/khala`, and requires both `khala` and `khala-fallback` on `PATH`. | Package reviewed skill assets and stable launchers. Codex installs the skill directly (plus hooks and MCP entry); Claude consumes it only inside the single plugin, replacing the legacy separate Claude skill layout. |

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
| `npm view @khala/agent-cli`; connector/contracts lookups | All returned npm 404. | Workspace dependencies cannot resolve for public consumers today. The operator-selected publish identity is instead `@aiur/khala`. |
| `npm view @aiur/khala` | npm returned 404 on 2026-09-24. | The selected scoped package is not published yet; packaging and release remain implementation work. |
| `npm view khala` | `khala@1.2.7` exists, is unrelated, and is owned by another maintainer. | Use the operator-selected scoped invocation `npx @aiur/khala setup`; do not depend on the unscoped name. |

The local Node runtime was `24.18.0`, while the repository pins `22.23.2`;
release proof must run on the pinned version. Package tests passing on Node 24
do not replace that gate.

### Primary vendor evidence

| Harness | Documented integration surface | Design use |
| --- | --- | --- |
| Claude Code | [Plugins](https://code.claude.com/docs/en/plugins) can bundle skills, hooks, and MCP configuration. | Install the single producer-owned user-scope plugin containing the skill, hooks, and MCP entry. Snapshot every registry/config path the supported CLI version mutates. |
| Codex | Codex exposes skill and MCP configuration surfaces in the inspected CLI. | Install the Khala skill, the native Khala hooks (PreToolUse/PostToolUse, Stop/UserPromptSubmit), and the MCP entry. Codex needs no Khala plugin. Hook config entries are removed exactly, while hook trust remains owned by Codex and the person using its native review dialog. |
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
  "ok": false,
  "changed": false,
  "state": "confirmation_required",
  "planDigest": "sha256:…",
  "confirmation": {"required": true, "confirmed": false},
  "harnesses": [],
  "operations": [],
  "diagnostics": []
}
```

When confirmation is required, the versioned `confirmation` object contains the
command, detected harnesses, component-level actions, affected paths,
backup/restore behavior, current-session effect or restart warnings, the
immediately usable fallback route, `planDigest`, and a concise approval request.
The agent relays this summary; an opaque digest alone is never an adequate plan.
The object excludes file contents, tokens, credentials, and backup bytes.

`khala status` preserves its existing top-level `v`, `connected`, `binding`,
`route`, `sourceCursor`, and `inbox` fields and adds `configuration` with the
same harness model. Component states are `absent`, `ready`,
`awaiting_hook_review`, `drifted`, `conflict`, or `unsupported`. Executable
presence, supported version, per-harness component states, and tested route
support are separate facts.

| Exit | Meaning |
| ---: | --- |
| 0 | Command completed and all selected harnesses reached the requested state; bare status remains informational. |
| 2 | Invalid invocation or input. |
| 3 | Safe refusal: conflict, drift, unsupported detected version, or `status --check` not ready. |
| 4 | Indeterminate result: apply or rollback failed and final state could not be proven. |
| 5 | Confirmation required: no mutation occurred; relay this plan or the replacement plan to the person. |

For `status`, absent harnesses are reported but excluded from readiness. Bare
status remains informational; `--check` enforces the table below.

| Observed state | Top-level state / `ok` | Agent next action | Bare / `--check` exit |
| --- | --- | --- | --- |
| No harness detected | `no_harness` / true | None; setup is a successful no-op | 0 / 0 |
| Configured and effective | `ready` / true | Use the native route | 0 / 0 |
| Codex hooks installed, native approval pending | `awaiting_hook_review` / false | The person reviews the hooks in Codex's native dialog; setup does not approve them | 0 / 3 |
| Configured, current session ineffective | `configured_restart_required` / true | Use the named CLI fallback now; native route activates after restart | 0 / 3 |
| Configured, effectiveness unproven | `configured_effect_unknown` / true | Use the named CLI fallback; do not claim native readiness | 0 / 3 |
| Ready, optional Claude hardening absent | `ready` / true | Continue normally; report hardening as absent | 0 / 0 |
| Drift or conflict | `drifted` or `conflict` / false | Preserve user state and report remediation | 0 / 3 |
| Unsupported detected version, no supported harness | `unsupported` / false | Refuse setup/upgrade; retain manifest-driven remove | 0 / 3 |
| Unsupported detected version beside a supported harness | the supported harnesses' state | Report the unsupported harness per harness; it never gates the others | per that state |
| Recovery required or final state unknown | `recovery_required` / false | Run bounded recovery; do not claim readiness | 0 / 4 |

Plans are stable-sorted by harness, component, and path. The plan digest omits
timestamps, random transaction IDs, temporary paths, and backup contents, so
two dry runs against identical state are byte-for-byte equal. Dry run remains
strictly zero-write: it refuses an active transaction, reads an optimistic
snapshot, and revalidates every observed identity/hash before returning. A
mutation without `--confirm` returns the same plan for the agent to relay. An
apply replans under the mutation lock and proceeds only when the supplied digest
matches; changed state returns a new plan and requires fresh human confirmation.
Confirmation authorizes exact operations, not a reservation or blanket approval.

### Runtime descriptor boundary

Setup installs stable launchers and static harness entries, never a live port or
bearer token. At execution time the launcher reads the 0600 runtime descriptor
owned by `authenticated-loopback-server`, validates owner, mode, and schema,
then uses its current port (4870 or the next free port) and token. A missing,
unsafe, or stale descriptor is a structured unavailable result and never causes
setup to rewrite harness configuration. No secret appears in argv, plans,
manifests, backups, or status output.

### State and transaction model

| Location | Contents | Ownership |
| --- | --- | --- |
| `$XDG_DATA_HOME/khala/versions/<version>/` | Self-contained CLI runtime plus reviewed plugin/skill assets | Installer-owned; directories 0700, regular files 0400, executables 0500; immutable after commit |
| `$XDG_DATA_HOME/khala/bin/` | Stable `khala` and `khala-fallback` launchers, plus `opencode.js`: the stable copy of the packaged OpenCode plugin (`dist/opencode.js`) that the OpenCode config imports by file URL | Installer-owned; directory 0700, launchers 0500, `opencode.js` 0400 |
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
rollback. While a journal exists, `setup` and `remove` plan only its recovery:
a confirmable plan whose digest covers the journal bytes. Once that plan is
confirmed, the executor recovers under the lock and then relays the next plan.
Read-only status reports `recovery_required`. A committed journal is safe to
finalize, while an unknown state or newer schema is a safe refusal.

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
| Claude Code | One user-scope plugin containing the skill, hooks, and MCP entry | `claude-plugin-hooks`, `claude-plugin-dispatch`, `mcp-result-piggyback` | Delivery targets the normal user-started Claude session. Optional hardening is reported separately and never gates readiness. |
| Codex | Khala skill, native hooks (PreToolUse/PostToolUse, Stop/UserPromptSubmit), and MCP entry; no plugin | `mcp-result-piggyback`, `listening-mode-pull`, `interactive-codex` | Preserve existing config; never write or remove `hooks.state` or `trusted_hash`; keep the installed hook command and path stable across upgrades; route support remains a separate capability label. |
| OpenCode | OpenCode plugin, global skill, and MCP entry | `opencode-session-bridge`, `opencode-delivery-contract`, `mcp-result-piggyback` | Use a guarded direct config edit for removal unless a tested exact vendor removal surface appears. |
| Cursor (app) | The `khala` MCP entry in `~/.cursor/mcp.json` only; no hooks | `cursor-channel-adapter` | Every Cursor mode is unproven, so no hook is installed and status reports `cursor_delivery_unproven`. Removal restores the recorded pre-Khala bytes. |

The Claude producer-owned plugin ships in a versioned local Khala marketplace
catalog inside the immutable payload. Its adapter models marketplace
registration, plugin selection, conflicts, status, rollback, and removal as
declared operations; registration is not an invisible prerequisite. Codex has
no plugin or marketplace step. If Claude marketplace registration cannot be
proven complete for a harness version, that version remains unsupported.

Support certification is bounded and falsifiable; observing synthetic homes is
not proof that a vendor command has no conditional side effects. An adapter may
mutate only through a guarded direct edit or a vendor command constrained by a
deny-by-default filesystem sandbox whose writable paths are exactly the planned
targets. Certification pins an exact harness version and traces clean,
populated, conflicting, failure, and interrupted runs; every observed write
must be planned and repeated runs must be deterministic. A command that cannot
be constrained this way remains unsupported. A version range expands only
after every included version passes the same matrix.

### Packaging and upgrade behavior

`@aiur/khala` should build before packing, publish only the runtime bundle,
license, README, and reviewed assets, and contain no `workspace:*` runtime
resolution. A fresh-prefix tarball test must invoke the bin outside the
monorepo. Releases use the repository's pinned Node version and a pinned npm
package version in automation. The consumer tarball and bundled runtime closure
must have no `preinstall`, `install`, or `postinstall` hook. Publishing uses npm
trusted publishing from the protected repository workflow, short-lived OIDC,
npm provenance, and commit-pinned third-party actions rather than a long-lived
npm token.

Setup stages a new immutable payload, plans harness pointer changes, and commits
the manifest only after all pointers verify. Old payloads/backups remain until
the new transaction commits and may then be garbage-collected only when no
manifest references them. Downgrade follows the same transaction. Cross-major
manifest migration is out of scope for v1; an unknown manifest version is a
safe refusal. A clean remove deletes the manifest, unreferenced backups, and
owned runtime after restoring foreign files. It never deletes connection
identity, inbox state, channel data, or harness credentials. Status reports
`configured` separately from `effective`, because a running harness may require
a restart before loading new configuration. Only backups referenced by the
active manifest or a recoverable journal are retained; startup recovery deletes
unreferenced transaction backups after a proven commit or rollback. Status
verifies owned payload hashes, ownership, and modes before reporting ready.
An upgrade or downgrade inherits every managed foreign target's original
pre-Khala preimage or absence marker from the active manifest; it replaces only
the expected managed postimage and carries that baseline into the new manifest.
Later removal therefore restores the user's state from before the first setup,
not the prior Khala version.

Codex upgrades retain the same installed hook command and path so a previously
approved hook does not require review again. Setup and removal never write or
delete Codex's native hook-trust records; only the person can change that trust
through Codex's review dialog.

When configuration requires a harness restart, the setup result reports both
the deferred native route and the exact installed CLI route that is usable in
the current agent session. This is a command fallback, not a process wrapper:
Khala still never launches or hosts the agent.

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
| Users confuse the unrelated unscoped package with Khala. | Publish and document only `@aiur/khala`; never suggest `npx khala`. |
| Vendor CLIs change undocumented registry files. | Version-gate support, prove the mutation footprint in synthetic homes, and fail closed on unknown versions. |
| Foreign config contains secrets. | Backups are owner-only; output contains hashes/paths, never contents; fixtures include sentinel-secret leak tests. |
| Concurrent setup/remove corrupts the journal. | Exclusive lock and stable busy diagnostic; only one process may mutate a state root. |
| A process dies between file mutation and manifest publication. | Write-ahead operation journal plus startup recovery; acceptance tests kill after each mutation boundary. |
| npm prompts before Khala can present its plan. | The agent may use `npx --yes @aiur/khala@<version>`; Khala's separate digest confirmation still gates every harness write. |
| A plan is confirmed after local state changes. | Replan under the mutation lock and require a new confirmation whenever the digest differs. |
| Runtime credentials leak into persistent harness config. | Static entries read the 0600 descriptor at call time; tests reject port/token bytes in config, argv, output, manifests, and backups. |
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
- Launching, hosting, or replacing the user's Claude, Codex, or OpenCode
  process; delivery is into the user's own CLI session.
- Implementing plugin, MCP, listening, or bridge behavior owned by the other E09
  research areas.
- Claiming a working Khala delivery route merely because configuration exists.

## Ticket contracts

Contracts are ordered to serialize the shared CLI surface and keep each ticket
finishable by one agent in one PR.

### 1. Publish a self-contained agent CLI

`slug: setup-cli-package`

`title: Publish @aiur/khala as a self-contained agent CLI`

`complexity:4`

| Field | Contract |
| --- | --- |
| Scope | Rename and publish the existing agent CLI as `@aiur/khala`; migrate live workspace consumers from `@khala/agent-cli`; bundle its runtime dependency closure; add prepack/build metadata, a strict files allowlist, and version/license/repository/publish/provenance metadata. |
| Out of scope | npm credentials, release execution, unscoped-name transfer, setup behavior, publishing connector/contracts separately. |
| Files/packages | `packages/agent-cli/**`; `packages/agent-skill/{package.json,README.md,src/**/*.ts}`; other live source/test references; `pnpm-lock.yaml`; release workflow/docs. |
| Acceptance | `npm pack` from a clean checkout contains the bin and allowlisted runtime/assets only; a fresh-prefix install on Node 22.23.2 runs `npx @aiur/khala status`; no runtime import resolves to the workspace; package metadata names `@aiur/khala`; no live manifest/source/test import retains the old identity; trusted publishing emits provenance without a long-lived npm token. |
| Tests | Pack-content assertion; reject consumer lifecycle hooks in the package and bundled runtime closure; install the tarball in an empty temp prefix and execute the bin; audit live references to the old package name. **Wrong implementation killer:** inject a transitive `postinstall` script and prove the package gate fails before release. |
| `blocked-by` | None. |
| Conflict risk | **High** with setup-planner work in `package.json`, CLI entrypoint, and README; land this contract first. Do not edit producer-owned plugin behavior. |

### 2. Add setup discovery, planning, and status

`slug: setup-cli-plan`

`title: Add setup discovery, confirmation planning, and status`

`complexity:3`

| Field | Contract |
| --- | --- |
| Scope | Define setup/configuration result schemas, exit codes, XDG path resolution, executable/version discovery, observed/desired state, deterministic setup/remove plans, digest-bound human confirmation relayed by the agent, additive configuration `status`, `status --check`, both dry runs, and the side-effect-free adapter interface. Register new modules through minimal diffs to the shared CLI files. |
| Out of scope | Applying mutations, journal/backups, real harness adapters, force/adopt, text UI, route capability implementation. |
| Files/packages | `packages/agent-cli/src/cli/{app,main,types}.ts`; new `packages/agent-cli/src/setup/{types,paths,detect,plan}.ts`; adjacent tests; CLI README. |
| Acceptance | Existing connection-status fields remain compatible; HOME/XDG/PATH are injectable; the status truth table is exact; repeated plans are byte-identical; setup/remove dry runs are zero-write; mutation without confirmation performs no writes; the confirmation payload contains every required field; a stale digest returns a replacement plan; the result names an immediately usable CLI route when native config is not yet effective; secrets never appear in output; adapters cannot mutate. |
| Tests | Synthetic homes, fake PATH/version runner, byte/mtime snapshots, confirmation-summary and status truth-table cases, schema/exit-code tests. **Wrong implementation killer:** confirm plan A, mutate an observed target, and assert apply refuses with plan B and no writes. |
| `blocked-by` | `setup-cli-package`, `listening-mode-pull`, `authenticated-loopback-server`. The shared CLI landing order is `mcp-inbox-batch` → `mcp-result-piggyback` → `listening-mode-pull` → this contract. |
| Conflict risk | **High** with every later ticket at CLI/schema seams. Land the planner and adapter interface first. |

### 3. Execute setup plans transactionally

`slug: setup-cli-transaction`

`title: Execute setup plans transactionally`

`complexity:4`

| Field | Contract |
| --- | --- |
| Scope | Apply planner operations under an exclusive lock; implement owner-only write-ahead journal/backups, per-operation preconditions, no-follow path handling, atomic replacement, constrained vendor-command execution, postimage verification, rollback, startup recovery, manifest commit, exact removal, drift refusal, and backup cleanup; wire non-dry setup/remove. |
| Out of scope | Harness-specific mutation discovery, force/adopt, text UI, route behavior, manifest major-version migration. |
| Files/packages | New `packages/agent-cli/src/setup/{manifest,transaction,filesystem}.ts`; setup/remove wiring in CLI composition; adjacent tests; CLI README. |
| Acceptance | Second setup is zero-change; a detected unsupported harness refuses setup/upgrade before mutation but manifest-matching recovery/removal remains available; all-selected-harness failure rolls back; drift refuses the whole removal; crash recovery is deterministic; concurrent mutation returns a stable busy result; modes/ownership/hashes are verified; upgrades retain the original pre-Khala baseline. |
| Tests | Inject failure or termination after every mutation boundary; modify a later target between planning and apply; swap symlinks; corrupt journals; run competing processes; exercise setup v1 -> upgrade v2 -> remove. **Wrong implementation killer:** after that upgrade sequence, assert removal restores the original bytes/absence rather than the v1 managed postimage. |
| `blocked-by` | `setup-cli-plan`. |
| Conflict risk | **High** with adapters that emit operation types. Freeze the executor vocabulary before adapter work lands. |

### 4. Add the Claude Code setup adapter

`slug: setup-cli-claude`

`title: Add the Claude Code setup adapter`

`complexity:3`

| Field | Contract |
| --- | --- |
| Scope | Detect/version Claude Code; inspect and plan a versioned local Khala marketplace registration plus user-scope installation/removal for the single producer-owned plugin containing its skill, hooks, and MCP entry; enumerate the complete mutation footprint. Report the optional hardening check as a separate state without installing any profile. Check that the plugin's `/khala <verb>` commands do not collide with existing user or plugin commands. |
| Out of scope | Authoring plugin hooks/slash commands, Claude authentication, project/local scope, direct mutation outside the transaction executor, installing a restricted profile, or making hardening a delivery/readiness gate. |
| Files/packages | New `packages/agent-cli/src/setup/adapters/claude.ts` and tests; packaged Claude asset references; support matrix docs. |
| Acceptance | Absent Claude is reported without creating `~/.claude`; supported versions install exactly one user-scope plugin; the normal user-started session can be ready when optional hardening is absent; status reports the hardening check separately; a `/khala <verb>` name collision is detected and fails the plan; unknown versions fail closed; remove restores exact preimages; the installed entry reads port/token from the descriptor at runtime. |
| Tests | Observe writes across clean, populated, hardened, and conflicting synthetic homes (including a pre-existing `/khala` command); assert every changed path is present in the plan and config contains no runtime port/token. **Wrong implementation killer:** remove the optional hardening profile and assert delivery remains ready while hardening reports absent, and that setup writes no profile; an implementation that gates delivery or installs a profile fails. |
| `blocked-by` | `setup-cli-transaction`, `claude-plugin-hooks`, `claude-plugin-dispatch`, `mcp-result-piggyback`. |
| Conflict risk | **Medium** with Claude artifact producers; consume their exports and avoid editing their behavior or manifests. |

### 5. Add the Codex setup adapter

`slug: setup-cli-codex`

`title: Add the Codex setup adapter`

`complexity:3`

| Field | Contract |
| --- | --- |
| Scope | Detect/version Codex; inspect and plan global Khala skill, native hook config entries (PreToolUse/PostToolUse, Stop/UserPromptSubmit), and MCP registration with no plugin or marketplace; observe native hook approval without mutating its trust records; keep the installed hook command/path stable across upgrades; enumerate and test the complete mutation footprint; retain capability-honest route labels. |
| Out of scope | Changing Codex notification/listening semantics, Codex login, project scope, or reimplementing the MCP server. |
| Files/packages | New `packages/agent-cli/src/setup/adapters/codex.ts` and tests; packaged skill assets; support matrix docs. |
| Acceptance | Codex 0.154.0 fixture has a proven skill + hooks + MCP plan (no plugin); hook entries are removed exactly and unrelated hooks survive byte-exact; setup, upgrade, and removal leave `hooks.state` and every `trusted_hash` byte unchanged; hook command/path identity survives upgrades; readiness remains false with `awaiting_hook_review` until the person approves through Codex's native dialog; absent/unknown versions are distinct; existing unrelated config survives byte-exact setup/remove; MCP command success without the expected postimage is not ready; the installed entry reads port/token from the descriptor at runtime. |
| Tests | Observe writes across clean, populated, and conflicting `.codex` trees; fake command runner; pre/post byte assertions. **Wrong implementation killer:** seed sentinel `hooks.state`/`trusted_hash` bytes, run setup -> upgrade -> remove, and assert they never change; before simulated native approval assert `awaiting_hook_review`, false readiness, and bare/`--check` exits 0/3, then approve natively and assert ready without changing the installed hook command/path. Also fake exit 0 while omitting the MCP postimage and assert setup fails and rolls back; leave a hook entry behind on remove and assert the byte-exact preimage check fails. |
| `blocked-by` | `setup-cli-transaction`, `mcp-result-piggyback`, `interactive-codex`. |
| Conflict risk | **Medium** with MCP/listening producers and the shared Codex config; adapter owns lifecycle only and must not introduce a plugin manifest. |

### 6. Add the OpenCode setup adapter

`slug: setup-cli-opencode`

`title: Add the OpenCode setup adapter`

`complexity:3`

| Field | Contract |
| --- | --- |
| Scope | Detect/version OpenCode; plan installation of the producer-owned plugin, global skill, and MCP entry; use a guarded config edit and exact backup restore where no proven remove CLI exists. |
| Out of scope | Authoring the OpenCode bridge, vendor auth, project scope, speculative use of an undocumented remove command. |
| Files/packages | New `packages/agent-cli/src/setup/adapters/opencode.ts` and tests; packaged OpenCode asset references; support matrix docs. |
| Acceptance | Version 1.17.10 fixture configures all three components; absent OpenCode creates nothing; comments/formatting and unrelated config bytes return exactly after removal; unsupported schema/version refuses safely; the installed entry reads port/token from the descriptor at runtime. |
| Tests | Synthetic XDG config/skill roots with unusual formatting and sentinel secrets. **Wrong implementation killer:** remove via parse-and-reserialize and assert the final file differs from its byte-exact preimage, failing the test. |
| `blocked-by` | `setup-cli-transaction`, `opencode-session-bridge`, `opencode-delivery-contract`, `mcp-result-piggyback`. |
| Conflict risk | **Medium** with bridge packaging/config work; the adapter must consume, not duplicate, its plugin entrypoint. |

### 7. Gate setup release with cross-harness acceptance

`slug: setup-cli-acceptance`

`title: Gate setup release with cross-harness package acceptance`

`complexity:4`

| Field | Contract |
| --- | --- |
| Scope | Add black-box tests through the packed tarball for mixed installed/absent/unsupported harnesses, agent-relayed confirmation, idempotency, deterministic dry runs, descriptor discovery, rollback/recovery, drift-safe removal, upgrade, concurrency, secret redaction, and CI check semantics; wire the release gate and concise operator docs. |
| Out of scope | The live cross-agent runs owned by `live-acceptance-runner`, vendor accounts, npm publishing, acquiring the unscoped name, UI, route semantics, or duplicating unit coverage. Acceptance 2 pairs OpenCode + DeepSeek with Claude, not two DeepSeek agents. |
| Files/packages | Cross-component tests under `tests/` (for example `tests/integration/agent-setup/`), package/release workflow, `packages/agent-cli/README.md`, operator setup docs. |
| Acceptance | A clean synthetic home goes plan -> confirmed setup -> second setup/no change -> ready check -> confirmed exact remove; mixed harness states are correctly reported; kill/restart recovers or safely refuses; every static harness entry resolves a moved runtime descriptor without being rewritten; the installed tarball works outside the monorepo on the pinned Node runtime. |
| Tests | Matrix across adapter fixtures plus representative packed-tarball failure/restart scenarios; exhaustive per-mutation fault injection stays in `setup-cli-transaction`. **Wrong implementation killer:** place a sentinel port/token in the descriptor, run setup, and fail if either byte sequence appears in harness config, argv capture, plan, manifest, backup, or output. |
| `blocked-by` | `setup-cli-package`, `setup-cli-plan`, `setup-cli-transaction`, `setup-cli-claude`, `setup-cli-codex`, `setup-cli-opencode`. The live acceptance contracts are deliberately not dependencies. |
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
