# Listening modes across harnesses

Status: research complete for KHA-E09. The canonical values are `steer`,
`sync`, and `async`; `sync` is the default. Implementations use `steer` and
`channel` in contracts, APIs, storage, CLI/MCP surfaces, and UI. Matrix-internal
`RoomId` and wire fields remain unchanged.

## Summary

Listening mode is a versioned setting on one agent binding, changeable by that
agent or the human owner. It controls *when a pending release may be surfaced*;
it does not change admission, trust, approval, pause, receipt, or batch-token
acknowledgement rules.

No harness proves all three modes today. Codex 0.154.0 proves `sync` through a
Khala-owned app-server. Claude has pinned mechanism evidence for after-tool SDK
streaming delivery, but not a retained proof of the composed Khala route.
OpenCode 1.17.10 has evidence for non-abort `promptAsync` steering, while its
`sync` route remains unsupported. Hard cancellation is not a listening mode:
Claude `interrupt()` and OpenCode abort-then-prompt are separate opt-in
capabilities. The generic MCP/skill fallback proves that it cannot provide
`steer`; MCP-only `async` remains unproven until `mcp-piggyback-evidence` passes.

The product therefore stores requested and effective mode separately and
renders evidence-scoped support. It never converts an unproven route into a
green capability or silently changes `steer` to `sync`.

## Terms and proof rule

```ts
type ListeningMode = "steer" | "sync" | "async";

type ModeSupport = {
  status: "proven" | "experimental" | "unsupported" | "unknown";
  route: string;
  testedVersion?: string;
  evidenceRef: string | null;
  evidenceRevision: string | null;
  reason: string | null;
};
```

`unknown` and `unsupported` require a non-null `reason`; `proven` requires a
non-null `evidenceRef` and immutable evidence revision/digest. Codecs reject
support records that violate those invariants.

| Term | Meaning |
| --- | --- |
| requested mode | The per-binding value selected by the agent or human; normally defaults to `sync`. An exact route with proved unsupported `sync` may initialize `async` with an explicit reason rather than perform a later fallback. |
| effective mode | The route currently usable for the exact harness, version, and session shape; `null` when none is honest. |
| proven | A retained, reproducible observation exercises the composed Khala route on the named version. |
| experimental | The underlying surface exists, but Khala has not proved the composed behavior. It requires explicit opt-in. |
| unsupported | Negative evidence closes the route for this session shape, or the harness exposes no required primitive. |
| unknown | The harness version or session shape has not been inventoried. It is disabled and carries a reason, never borrowed evidence. |

Vendor documentation proves that an endpoint or hook exists. It does not prove
ordering, interruption, correlation, reconnect, or exactly-once behavior in
Khala. Those cells remain **unproven** until a retained spike exercises the
whole route.

## Findings

### Evidence inventory

The local inventory on 2026-09-24 was collected on host `orangekid`:

```text
codex --version     -> codex-cli 0.154.0
claude --version    -> 2.1.282 (Claude Code)
opencode --version  -> 1.17.10
```

The Executor host separately reports OpenCode 1.15.6. Evidence from `orangekid`
must not be applied to that host/version without a pinned proof. The 1.17.10
binary used here resolves to
`/home/everdred/.local/share/mise/installs/opencode/1.17.10/opencode`.

| Evidence | What it proves | What it does not prove |
| --- | --- | --- |
| [`docs/evidence/codex.md`](../../evidence/codex.md) and [`TurnSteerParams.json`](../../../experiments/codex/evidence/schema/TurnSteerParams.json) | `thread/queue/add` waits for the active turn on Codex 0.154.0; the schema exposes `turn/steer` with `threadId`, `expectedTurnId`, and `input`. | Same-turn steering, failure recovery, and release correlation. |
| [`docs/evidence/codex-native-cli.md`](../../evidence/codex-native-cli.md) | `codex queue` reaches an existing TUI and queues while busy. | A safe payload route: released bytes appear in `argv`, and consumption has no native release correlation. |
| [`docs/evidence/claude.md`](../../evidence/claude.md) | Claude Code 2.1.276 with Agent SDK 0.3.276 consumes a mid-tool streaming input after the tool result. | Interactive-session attachment, hard interruption, or durable reconnect. |
| [`docs/evidence/claude-native-cli.md`](../../evidence/claude-native-cli.md) | Existing-session native support must remain fail-closed; the hosted stream worked only while alive. | A native `steer` or interactive `sync` route. |
| [Claude hooks](https://code.claude.com/docs/en/hooks), [SDK streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode), and [channels](https://code.claude.com/docs/en/channels-reference) | The documented hook lifecycle, SDK interrupt capability, and research-preview channel notification surface exist. | Khala's composed routes. Local 2.1.282 help did not expose the documented development-channel flags. |
| [OpenCode server API](https://opencode.ai/docs/server/) and [plugin API](https://opencode.ai/docs/plugins/) | On `orangekid`, 1.17.10 documentation and #154 evidence expose session-addressed non-abort `promptAsync`, abort, events, and plugin hooks. | Support on the Executor host's 1.15.6, product composition, `sync`, or hard-cancel safety. |
| [`packages/agent-skill/SKILL.md`](../../../packages/agent-skill/SKILL.md), [`capabilities.ts`](../../../packages/agent-skill/src/capabilities.ts), and [`server.ts`](../../../packages/agent-cli/src/mcp/server.ts) | The fallback listener is experimental; MCP currently exposes send but no read/pull tool. | A generic host interruption or safe-boundary callback. |

### Delivery matrix

Every route below is explicitly **proven** or **unproven**. `unsupported` is a
proven negative result, not a weaker claim of support.

| Harness | `steer` | `sync` (default) | `async` |
| --- | --- | --- | --- |
| Claude, SDK-hosted stream | **Unproven; mechanism observed.** After-tool streaming injection is the non-abort `steer` candidate. `interrupt()` is not this route. | **Unproven.** Buffer until the end-of-turn boundary, then write through the composed stream adapter. | **Unproven.** Use the single `khala_read` operation; do not write to the stream automatically. |
| Claude, interactive/plugin | **Unproven here; installed-version mechanism evidence exists in #161.** `PostToolUse` is the non-abort after-tool `steer` boundary. | **Unproven here.** `Stop` is the end-of-turn boundary; the composed route consumes #161's retained proof. | **Unproven.** `/khala read` delegates to the shared `khala_read` operation. |
| Codex, Khala-hosted app-server | **Unproven.** Send `turn/steer` only with the observed active `turnId` as `expectedTurnId`; retain pending on refusal or unknown outcome. | **Proven**, exactly on Codex 0.154.0: `thread/queue/add` starts a new turn after the active turn. | **Unproven.** Requires explicit pull; no queue call is allowed merely because a message arrived. |
| Codex, existing TUI | **Unsupported for released bytes.** No proved same-turn attach route. | **Unsupported for released-byte delivery.** A separate notification-only capability is proven on 0.154.0 via `codex queue`, but bytes would appear in process arguments. | **Unproven.** A notification may tell the agent to invoke pull, but notification is not delivery. |
| OpenCode + DeepSeek | **Mechanism proven only on `orangekid` OpenCode 1.17.10; product route unproven.** Use non-abort session-addressed `promptAsync` at the next safe boundary. | **Unsupported on the proved 1.17.10 shape.** A status-read then submit is racy; initialize this binding at `async` and state why. | **Unproven.** Delegate to the shared `khala_read`; the plugin must not inject on arrival. |
| MCP/skill fallback | **Unsupported.** A harness-neutral MCP server or skill cannot inject at an arbitrary active boundary. | **Unproven/experimental.** `mcp-result-piggyback` may append a batch only when the agent already calls Khala; that is not a timing guarantee. | **Unproven.** `khala_read` is the one pull operation, but support stays disabled until `mcp-piggyback-evidence` passes. |

Hard cancel is advertised separately from the three-mode matrix:

| Harness route | Hard-cancel status |
| --- | --- |
| Claude SDK | **Unproven/experimental.** SDK `interrupt()` requires its own retained spike and binding/version/route grant. |
| OpenCode | **Unproven/experimental.** Abort-then-prompt requires its own retained spike and grant; it never implements `steer`. |
| Codex app-server, Claude interactive, MCP/skill | **Unsupported** until a distinct, evidence-scoped cancellation route exists. |

## Design

### State and authority

Keep mutable mode control outside the immutable `SessionBinding`, channel policy,
and human-approval policy. Store a versioned control record keyed by
`bindingId` and binding `generation`; a replacement binding starts a fresh
record with the capability-selected initial mode, normally `sync`:

```ts
type ListeningModeControl = {
  bindingId: BindingId;
  generation: number;
  requested: ListeningMode;       // normally defaults to "sync"
  version: number;
  experimentalGrants: readonly RouteGrant[];
  hardCancelGrants: readonly RouteGrant[];
};

type ListeningModeView = ListeningModeControl & {
  effective: ListeningMode | null;
  support: Record<ListeningMode, ModeSupport>; // derived from HarnessCapabilities
};
```

- Admission creates `requested: "sync"`; there is no channel-wide default switch.
  The exact OpenCode 1.17.10 route is the explicit exception: because its
  `sync` shape is proved unsupported, admission initializes `requested:
  "async"` and records the reason instead of silently falling back later.
- Trusted connector composition creates a non-decodable
  `AgentBindingAuthority` bound to the authenticated `bindingId` and
  `generation`. Agent mode-query, mode-change, and pull ports require it and
  reject target or generation mismatches. The human owner may change any
  binding under D10. Both submit `expectedVersion` so simultaneous changes
  cannot silently overwrite one another.
- Experimental-route and hard-cancellation grants are separate, off by default,
  and scoped to the exact binding, route, harness version, and immutable
  capability-evidence revision. `SetListeningMode` accepts either `AgentBindingAuthority` or
  `OwnerAuthority`; separate `GrantExperimentalRoute` and `GrantHardCancel`
  commands require server-constructed `OwnerAuthority` and the browser CSRF
  boundary. Agent authority cannot mint, alter, revoke, or reuse either grant.
  A version, route, or evidence-revision change invalidates them.
- A mode change governs releases that have not been claimed. A claimed attempt
  carries `modeAtClaim` and finishes under that snapshot.
- `HarnessCapabilities` is the single evidence authority. Per-mode support is a
  derived projection, not separately persisted state. Capability discovery
  recomputes `effective`; version drift can set it to `null` while per-mode
  support becomes `unknown`, but never rewrites `requested`.
- `pause` wins over all modes. Approval and trust are evaluated before a release
  enters the listening scheduler.
- Mode changes and transport receipts are distinct events. A transport write is
  not a read receipt; #145/`read-receipts` owns the latter.

### Scheduling semantics

| Mode | Scheduler rule | Honest failure behavior |
| --- | --- | --- |
| `steer` | Surface each admitted release at the earliest proved safe boundary in the active turn. Hard cancellation is a separate, explicit per-route opt-in. | On refusal or unknown outcome, keep the release pending and show `requested: steer`, `effective: null` or `waiting`. Never silently queue it as `sync`. |
| `sync` | Buffer while a tool or turn is active, then atomically claim the ordered batch at the route's proved boundary. | If the boundary cannot be observed, leave pending and expose the route error. |
| `async` | Arrival only persists. The agent explicitly invokes the single `khala_read` application operation (`khala read` CLI, `khala_read` MCP), which returns `mcp-inbox-batch`'s bounded ordered batch and stable token without advancing acknowledgement. | Never inject, wake, or start a turn. The agent presents the prior batch token on its next authenticated Khala call for Khala-side acknowledgement before another batch is selected; an empty pull returns a typed empty result. There is no lease API or host-side deduplication requirement. |

Adapters continue to emit retained `DeliveryReceipt` facts. The connector
dispatcher derives scheduler decisions from receipt kind: `harness_queued` or a
stronger proved observation advances the attempt; `failed` with a rejection
code refuses it; `outcome_unknown` waits for reconciliation; and a missing
capability is unsupported. It never invents a generic `delivered` fact or
infers success from a process write. Batch acknowledgement stays on Khala's
side: every consumer reuses the `mcp-inbox-batch` token and format, and the
receiving host never deduplicates releases. Any retry is driven by
reconciliation evidence, never by a missing success line alone. Each boundary
is capped by capability limits equivalent to
`maxSelectionEvents` and `maxPayloadBytes`; the ordered suffix remains pending.

### Local automation and pause/wake

`listening-mode-contract` owns the initial local-only automation profile; it is
an injected value, never a caller option or hosted default. The starting values
are provisional until its retained two-agent acceptance experiment passes:

```ts
const LOCAL_AUTOMATION_LIMITS = {
  maxCausalDepth: 3,
  maxJobsPerCausalRoot: 3,
  maxConcurrentJobs: 1,
  busy: "wait",
} as const;
```

The three-job bound limits one autonomous causal chain, not the lifetime of a
channel. A human-authored message begins a new causal root, so D9 still permits
an indefinitely long channel. Budget exhaustion holds the remaining work until
a human starts a new root or explicitly re-arms it; an agent cannot reset its
own counters. Before promotion, the contract must retain one representative
two-agent exchange that completes inside the profile and one self-sustaining
loop that the profile stops; revise the values if the first cannot complete or
the second is not bounded. `local-automation-fence` injects the approved profile
only into local composition, while hosted `approvedAutomation()` remains
`null`.

Pause and wake use the existing policy and dispatcher boundaries:

1. An owner pause increments policy version. Once effective, no new claim may
   start; an already-claimed attempt finishes under `modeAtClaim`. Hard cancel
   is a separate command and is never implied by pause.
2. Arrival may issue one coalesced, content-free dispatcher wake only for an
   effective, unpaused automatic policy in `steer` or `sync`. `async` arrival
   never wakes a harness.
3. Resume issues one coalesced wake, then rechecks binding generation, policy
   version, mode, capability evidence, and remaining causal budget before a
   claim. Resume does not reset counters or acknowledge a batch.
4. Stop is not pause: `stop-control` owns ending agent sessions while keeping
   the local channel viewable and resumable.

### Honest UI

The agent-control row shows the requested mode, effective mode, and support for
the exact active binding.

| Support state | Control | Copy and detail |
| --- | --- | --- |
| proven | Enabled | `Supported on <harness version> via <route>`; resolve its identifier-like `evidenceRef` through an allowlisted internal evidence registry. Unknown or URL-shaped references are plain text, never links. |
| experimental | Disabled until explicit opt-in | An adjacent `Enable experimental route` action opens a route-specific confirmation, records a grant for this binding/version/route, then enables selection. Show the missing proof. |
| unsupported | Disabled | A concrete reason such as `No interrupt route` or `Payload would enter argv`. |
| version/session unknown | Disabled | `Support unknown for this version/session`; never inherit a green badge from another binding. |

The row renders `Requested: steer · Effective: waiting` when a stored choice is
not currently usable. Runtime failures add a durable, non-green delivery state;
they do not mutate the selector. Humans and agents use the same versioned
mode command, but only the owner-only grant commands can record either consent.
The existing owner-only policy port must not be reused as the agent's authority
boundary. Enabling an experimental route never enables hard cancellation: that
has its own warning and per-route confirmation describing partial tool effects,
and remains off by default. Its grant action is enabled only when the exact
route reports experimental or proven hard-cancel support; unknown and
unsupported routes are disabled with their reasons, binding/version, and
evidence context.

Owners can revoke experimental-route and hard-cancel grants independently.
Revocation refreshes support immediately and never changes the other grant. A
mode-command version conflict never retries automatically: refresh the exact
binding, retain the attempted choice as unsubmitted, announce that another
actor changed the mode, and focus the refreshed selector for explicit retry.

## `steer` and hard-cancel proof spikes

All spikes use disposable sessions and synthetic payloads. A successful surface
call is not enough; the pass criteria require ordering, correlation, and a
recoverable failure story.

### Codex `turn/steer`

| Step | Required observation |
| --- | --- |
| Inventory | Pin Codex and regenerate the app-server schema. Record the active `threadId` and `turnId`; confirm unsupported turn types such as review/compact. |
| Cases | Send during plain generation and a long-running synthetic tool; also test idle, stale `expectedTurnId`, duplicate client ID, disconnect-before-response, and reconnect/readback. |
| Pass | One injection observation with the stable release ID enters the same active turn at a repeatable safe boundary, does not kill the tool, and reconnect/retry reconciliation never produces a second injection. Model consumption remains unproven pending #145 or #147. |
| Fail closed | Any stale/refused/unknown call leaves the release pending. Do not call `thread/queue/add` as an invisible fallback. |

### Claude after-tool `steer`

| Step | Required observation |
| --- | --- |
| Inventory | Pin Claude Code and Agent SDK; use a disposable streaming session with a long synthetic tool. |
| Cases | Enqueue one release during model output and during the tool; inject it only after the tool result. Test duplicate hints, disconnect, resume, and end-of-turn buffering separately. |
| Pass | One correlatable non-abort injection for the stable release ID appears after the active tool and before end-of-turn `sync`; Khala-side batch-token acknowledgement prevents a second handoff after reconnect. Model consumption remains unproven pending read-receipt evidence. |
| Fail closed | Keep `steer` unproven. Never call `interrupt()` as an invisible fallback. |

### Claude Agent SDK hard cancel

| Step | Required observation |
| --- | --- |
| Inventory | Pin Claude Code and Agent SDK; use streaming input and a disposable session with a long synthetic tool. |
| Cases | Under an explicit hard-cancel grant, call the SDK interrupt method during model output and during the tool, await the terminal event, then enqueue one release. Test permission prompts, duplicate calls, disconnect, resume, and child-process cleanup. |
| Pass | Cancellation reaches a deterministic boundary, no tool child is orphaned, transcript continuity survives, and one correlatable post-cancel injection exists for the stable release ID. This proves only the granted hard-cancel capability, not `steer`. |
| Fail closed | Keep hard cancel disabled; ordinary `steer` continues to use after-tool injection. |

### Claude experimental channel push

| Step | Required observation |
| --- | --- |
| Inventory | First require a CLI version whose help exposes the documented development-channel flag, org policy permits channels, and the MCP server declares `experimental["claude/channel"]`. Local 2.1.282 fails the first gate. |
| Cases | Push `notifications/claude/channel` while idle, generating, and inside a long tool. Repeat after restart and test duplicate/reordered notifications and consent behavior. |
| Pass | One notification observation with the stable release ID reaches the intended session at a repeatable non-abort boundary without hidden approval; Khala-side token acknowledgement prevents a second handoff. Model consumption remains unproven. |
| Fail closed | Advertise this alternative route as experimental or unsupported for that exact binding. The primary v1 Claude `steer` route remains after-tool injection. |

### OpenCode hard cancel

| Step | Required observation |
| --- | --- |
| Inventory | Pin OpenCode 1.17.10 and DeepSeek configuration; subscribe to session SSE before starting a disposable long synthetic tool. |
| Cases | Under an explicit hard-cancel grant, POST session abort, wait for the terminal status/event, then call `promptAsync` once. Test idle abort, side-effecting-tool fixture, duplicate/retry, disconnect, and attached/local-server forms. |
| Pass | Abort has a deterministic terminal boundary, partial tool effects are visible, and one correlatable `promptAsync` submission occurs for the stable release ID. This proves only hard cancel, not `steer`. |
| Fail closed | Leave hard cancel disabled. Non-abort `promptAsync` remains the OpenCode `steer` route. |

## Trade-offs

| Choice | Benefit | Cost |
| --- | --- | --- |
| Requested/effective split | Preserves agent intent without lying when versions or session shapes change. | Adds state and UI copy. |
| Exact-version proof | Prevents accidental capability promotion across fast-moving CLIs. | Requires recurring evidence refresh. |
| No silent fallback | Makes timing guarantees inspectable and avoids surprising new turns. | A release may wait longer when a route fails. |
| One explicit pull for `async` | Matches agent-controlled attention and gives every harness one batch/token protocol. | Adds shared CLI/MCP registration and depends on the inbox batch owner. |
| Hard cancel separate from `steer` | Keeps v1 steering non-abort and contains tool-side-effect risk. | Cancellation needs separate evidence, UI, and per-route consent. |

## Risks

- Hard cancellation can leave subprocesses, files, or external side effects in a
  partial state even when the harness reports cancellation.
- A mode change racing a claim can reorder or duplicate releases unless the
  claim records the binding version and `modeAtClaim`.
- Vendor endpoints and experimental flags can disappear between patch versions;
  cached capabilities must be invalidated on version/session changes.
- Reusing delivery receipts as read receipts would overclaim model consumption.
- `steer` traffic can starve ordinary work; batching and a bounded per-boundary
  budget are required even after a route is proven.
- Piggyback delivery depends on an agent calling a Khala tool and therefore
  cannot honestly be presented as generic `sync` latency.

## Non-goals

- Reopening D1–D12, changing admission/trust policy, or defining channel-wide modes.
- Treating transcript capture or ordinary model output as channel messages.
- Proving Claude plugin hooks (#140), MCP piggyback details (#141), OpenCode +
  DeepSeek acceptance (#142), read-receipt semantics (#145), or the full E2E
  acceptance harness (#147) in this document.
- Advertising a minimum supported vendor version from one pinned proof.
- Enabling hard abort by default.

## Ticket contracts

Contract slugs are proposed dependency names for Executor promotion. Each is
sized for one agent and one PR. The original broad control contract is split
between value/capability contracts and `listening-mode-store`; pull remains one
operation because `mcp-inbox-batch` owns batching and acknowledgement.

### 1. `listening-mode-contract`

| Field | Contract |
| --- | --- |
| Slug | `listening-mode-contract` |
| Title | Define listening-mode values, capabilities, and local limits |
| Complexity | `complexity:3` |
| Scope | Add `ListeningMode`, `ModeSupport`, command/result codecs, owner-only grant command shapes, the `HarnessCapabilities` projection, and the locally approved automation profile. `HarnessCapabilities` is the only support-data owner. |
| Out of scope | Persistence, authority construction, dispatcher timing, harness calls, UI, receipts, and SQLite. |
| Files/packages | New `packages/contracts/src/delivery/listening-mode.ts`, delivery index/fixtures/tests, and new `packages/policy/src/listening-mode/limits.ts` with boundary tests. Keep immutable `binding.ts` unchanged. |
| Acceptance | `sync` is the normal initial value; the proved unsupported-sync OpenCode shape explicitly initializes `async` with a reason; uninspected versions report `unknown`; support is derived, not separately stored; evidence revisions invalidate grants; hosted automation remains closed while a retained two-agent completion/loop-stop experiment approves or revises the provisional `{maxCausalDepth:3,maxJobsPerCausalRoot:3,maxConcurrentJobs:1,busy:"wait"}` profile. |
| Tests | Codec/capability matrices, exact-version/evidence-revision invalidation, initial-mode selection, local/hosted boundary, automation-limit tests, and retained two-agent completion plus runaway-loop fixtures. **Wrong-implementation test:** an uninspected route reporting proven support, an unsupported-sync route silently coercing an existing `sync` request, a changed evidence revision retaining consent, or a hosted composition receiving local limits must fail. |
| Blocked-by | None. |
| Conflict risk | High with read-receipt capability vocabulary and the local automation fence; this ticket owns support and limit values, not receipt facts or fence composition. |

### 2. `listening-mode-store`

| Field | Contract |
| --- | --- |
| Slug | `listening-mode-store` |
| Title | Persist versioned listening-mode control through one port |
| Complexity | `complexity:4` |
| Scope | Add a binding/generation-keyed `ListeningModeStore` read/CAS port, mode/grant application service, and hosted adapter embedded in existing `TrustState`. Add an authenticated agent application port and connector handler whose trusted composition constructs non-decodable `AgentBindingAuthority` from the held binding; `SetListeningMode` accepts it or `OwnerAuthority`, while grant commands accept only server-constructed `OwnerAuthority`. |
| Out of scope | The local SQLite adapter, harness delivery, CLI/MCP surfaces, UI, and receipt storage. |
| Files/packages | New `packages/policy/src/listening-mode/{store,hosted}.ts`; focused additions to `packages/policy/src/trust/{types,transitions}.ts`; an agent-facing application contract/handler under `packages/connector/src/agent/`; new trusted composition path `apps/connector/src/composition/agent/listening-mode-authority.ts`; adjacent tests. |
| Acceptance | Hosted restart preserves requested mode, version, and grants in existing policy state while recomputing effective mode from current `HarnessCapabilities`; CAS and idempotency are explicit; replacement generation gets the capability-selected initial value; stale/cross-binding authority fails; only owner authority can create/revoke grants; route/version drift invalidates grants without rewriting requested mode. |
| Tests | Port conformance, hosted restart, CAS race, command idempotency, rebind, grant invalidation, and authority isolation. **Wrong-implementation test:** race two writes at one expected version and require exactly one winner, then prove `AgentBindingAuthority` cannot reach either grant command. |
| Blocked-by | `listening-mode-contract`. |
| Conflict risk | High with `local-sqlite-room-store`, which owns the SQLite adapter for this port; do not add a second local state model or schema here. |

### 3. `listening-mode-pull`

| Field | Contract |
| --- | --- |
| Slug | `listening-mode-pull` |
| Title | Add the single ordered pull operation for `async` |
| Complexity | `complexity:4` |
| Scope | Add one application operation exposed as `khala read` (CLI) and `khala_read` (MCP). It returns the exact `mcp-inbox-batch` format/token; the agent's next Khala call presents that token so Khala acknowledges before selecting another batch. Claude slash commands and OpenCode delegate here. |
| Out of scope | A second cursor/lease/batch API, host-side deduplication, read receipts, auto-wake, harness interruption, and message send. |
| Files/packages | New `packages/agent-cli/src/cli/read.ts`, `packages/agent-cli/src/mcp/read-tool.ts`, and `packages/agent-cli/src/composition/read.ts`; minimal registrations in `cli/{app,main,types}.ts` and `mcp/server.ts`; agent-skill docs/tests. |
| Acceptance | Arrival in `async` performs no harness call; concurrent calls serialize through `mcp-inbox-batch`; the prior token is acknowledged only on the next authenticated Khala call; restart reuses Khala state without receiver dedup; empty pull is typed; wrong binding/generation is refused; no read receipt is emitted. |
| Tests | CLI/MCP operation parity, token acknowledgement, replay before acknowledgement, empty result, cross-binding refusal, and crash/restart. **Wrong-implementation test:** fail if the operation advances the inbox during read, invents a lease/cursor, or requires Claude/Codex/OpenCode to deduplicate a replay. |
| Blocked-by | `listening-mode-contract`, `listening-mode-store`, `mcp-inbox-batch`, `mcp-result-piggyback`. |
| Conflict risk | High in `agent-cli`: land after `mcp-result-piggyback`, keep registrations minimal, and let Claude/OpenCode call this operation rather than fork it. |

### 4. `listening-mode-dispatch`

| Field | Contract |
| --- | --- |
| Slug | `listening-mode-dispatch` |
| Title | Extend connector dispatch with modes, local limits, and pause/wake |
| Complexity | `complexity:4` |
| Scope | Extend `packages/connector/src/dispatch/` with requested/effective gating, `modeAtClaim`, proved-boundary callbacks, ordered budgets, the fixed local automation profile, and the pause/wake contract above. Derive decisions only from retained `DeliveryReceipt` kinds. |
| Out of scope | New receipt kinds, harness-specific calls, pull transport, UI, SQLite schema, and read receipts. |
| Files/packages | `packages/connector/src/dispatch/`, delivery attempt/application contracts, composition fakes, and focused dispatch tests. |
| Acceptance | Pause prevents new claims; in-flight attempts keep their snapshot; `async` arrivals never wake; resume coalesces one wake without resetting budget; causal depth/job/concurrency limits hold; unknown/refused work stays pending; no generic `delivered` fact appears. |
| Tests | Mode/pause races, wake coalescing, async silence, budget exhaustion/re-arm, nil capability, receipt mapping, and item/byte boundaries. **Wrong-implementation test:** resume must fail if it resets causal counters or an `async` arrival invokes the harness. |
| Blocked-by | `listening-mode-contract`, `listening-mode-store`, `local-sqlite-room-store`. |
| Conflict risk | High with `local-automation-fence`, which consumes these limits and pause/wake rules and must itself block on `listening-mode-contract`; this dependency direction breaks the internal-core cycle. |

### 5. `codex-listening-routes`

| Field | Contract |
| --- | --- |
| Slug | `codex-listening-routes` |
| Title | Prove and gate Codex `steer`; expose proven `sync` |
| Complexity | `complexity:4` |
| Scope | Implement the retained `turn/steer` spike, add the adapter only if it passes, surface exact-version support, and map `thread/queue/add` to `sync`. Preserve native-CLI notification-only constraints. |
| Out of scope | Starting arbitrary TUIs, placing released bytes in `codex queue` arguments, pull implementation, hard cancel, and broad minimum-version claims. |
| Files/packages | `experiments/internal-mode/listening-modes/codex/`, `packages/harnesses/src/codex/`, conformance tests, evidence docs. |
| Acceptance | Hosted app-server 0.154.0 reports proven `sync`; `steer` needs injection/reconciliation evidence; stale/refused/unknown calls leave pending; uninspected versions become `unknown`; native CLI never transports bytes. |
| Tests | Adapter, capability, reconciliation, and mutation-tested evidence verifier. **Wrong-implementation test:** an active-turn `steer` request must fail if the adapter calls `thread/queue/add` or omits `expectedTurnId`. |
| Blocked-by | `listening-mode-contract`, `listening-mode-dispatch`. |
| Conflict risk | Medium with acceptance and existing Codex receipt tests; retain no-blind-retry behavior. |

### 6. `claude-sdk-listening-route`

| Field | Contract |
| --- | --- |
| Slug | `claude-sdk-listening-route` |
| Title | Prove Claude SDK non-abort modes and separate hard cancel |
| Complexity | `complexity:4` |
| Scope | Exercise composed after-tool `steer` and end-of-turn `sync`; run the SDK `interrupt()` spike only as a separately granted hard-cancel capability; add exact-version/session-shape records for each route. |
| Out of scope | Interactive hooks, slash commands, native attachment, treating interrupt as `steer`, and default hard cancel. |
| Files/packages | `experiments/internal-mode/listening-modes/claude-sdk/`, `packages/harnesses/src/claude/`, capability/conformance/evidence docs. |
| Acceptance | After-tool and end-of-turn routes report independently; interrupt cannot satisfy `steer`; hard cancel needs a valid route grant and proof; cleanup/reconnect failures preserve pending releases; model consumption is not claimed. |
| Tests | Boundary timing, capability matrix, interrupt cleanup, reconnect, grants, and evidence mutation. **Wrong-implementation test:** fail if ordinary `steer` invokes `interrupt()` or mechanism-only evidence reports a composed route as proven. |
| Blocked-by | `listening-mode-contract`, `listening-mode-dispatch`. |
| Conflict risk | Medium with Claude plugin/read-receipt work; this ticket owns only SDK-hosted route evidence and adapter behavior. |

### 7. `claude-interactive-listening-route`

| Field | Contract |
| --- | --- |
| Slug | `claude-interactive-listening-route` |
| Title | Gate Claude interactive after-tool, end-of-turn, and channel routes |
| Complexity | `complexity:4` |
| Scope | Consume the interactive hook port: map `PostToolUse` to non-abort `steer`, `Stop` to `sync`, and shared `khala_read` to `async`; run the alternative experimental channel-push spike; project exact-version/session support. |
| Out of scope | Reimplementing plugin packaging/slash commands, SDK interrupt, hidden channel consent, and broad version claims. |
| Files/packages | `experiments/internal-mode/listening-modes/claude-channel/`, `packages/harnesses/src/claude/`, a narrow hook-port adapter, conformance/evidence docs. |
| Acceptance | The three routes report independently; `PostToolUse` never claims hard interruption; `Stop` is the end-of-turn boundary; missing development-channel flags remain unknown/unsupported; failures preserve pending releases. |
| Tests | Hook-boundary fakes, CLI inventory, consent/reconnect, token acknowledgement, and evidence mutation. **Wrong-implementation test:** fail if `PostToolUse` is labeled `sync`, `Stop` is labeled `steer`, or a missing channel flag reports proven support. |
| Blocked-by | `listening-mode-contract`, `listening-mode-dispatch`, `listening-mode-pull`. |
| Conflict risk | High with Claude plugin and Claude read-receipt tickets; consume their public ports/evidence without owning packaging or receipt facts. |

### 8. `listening-mode-ui`

| Field | Contract |
| --- | --- |
| Slug | `listening-mode-ui` |
| Title | Show requested/effective listening mode and honest support |
| Complexity | `complexity:3` |
| Scope | Add per-agent selector/status in Agent Controls, owner mutation, allowlisted evidence details, separate grant/revoke flows for experimental routes and hard cancel, explicit version-conflict recovery, and waiting/error states. |
| Out of scope | Agent-side command authority, harness implementation, global channel defaults, and receipt design. |
| Files/packages | `apps/web/src/features/agent-controls/{ports,model,controller,AgentControlsPanel}.ts*`, browser harness, CSS/tests. |
| Acceptance | `sync` normally renders by default; the exact unsupported-sync OpenCode binding initializes `async` and explains why; unsupported/unknown modes and hard cancel are disabled with exact-route reasons; each grant can be revoked without altering the other; conflicts refresh without auto-retry and preserve the attempted choice as unsubmitted; requested/effective divergence is announced; no support leaks between bindings. |
| Tests | Controller/component/browser matrix including keyboard navigation, screen-reader descriptions/status announcements, focus recovery, evidence-link allowlist, independent grant/revoke flows, and conflict refresh. **Wrong-implementation test:** a second binding on an untested version must not inherit the first binding's proven `steer` badge, and revoking experimental delivery must not revoke hard cancel. |
| Blocked-by | `listening-mode-contract`, `listening-mode-store`. |
| Conflict risk | Medium with local UI composition and receipt labels; add a separate listening section and reuse neither receipt copy nor owner-only policy authority for agent commands. |

### 9. `listening-mode-agent-controls`

| Field | Contract |
| --- | --- |
| Slug | `listening-mode-agent-controls` |
| Title | Expose listening-mode inspection and mutation to the bound agent |
| Complexity | `complexity:3` |
| Scope | Add `khala mode get/set` and `khala_listening_mode` plus skill guidance. Call the authenticated agent application port from `listening-mode-store`; trusted connector composition derives authority from the authenticated held binding rather than serializing it. Read the exact-binding view and submit `{requested, expectedVersion}`; return the updated view or typed conflict/refusal with actionable reasons. |
| Out of scope | Grant mutation, owner UI, release pull, channel-wide defaults, and harness delivery. |
| Files/packages | New `packages/agent-cli/src/cli/mode.ts`, `packages/agent-cli/src/mcp/listening-mode-tool.ts`, `packages/agent-cli/src/composition/listening-mode.ts`, and the agent-side client contract for the connector handler; minimal registrations in `cli/{app,main,types}.ts` and `mcp/server.ts`; `packages/agent-skill/{SKILL.md,src/capabilities.ts}` and tests. |
| Acceptance | The agent can inspect requested/effective/support state, change only its own active binding, refresh after a version conflict, and observe requested/effective divergence without a false delivery claim; neither operation exposes owner authority or grant commands. |
| Tests | CLI/MCP/skill contract tests for query, successful mutation, support reasons, typed conflict/refusal, and composition-injected authority. **Wrong-implementation test:** an agent request targeting another binding or carrying a stale generation/version must fail, and agent authority must not reach either grant command. |
| Blocked-by | `listening-mode-contract`, `listening-mode-store`, `listening-mode-pull`. |
| Conflict risk | High in the agent CLI hotspot; land after pull, add modules first, and keep edits to shared registration files minimal. |

## Integration order

1. Land `listening-mode-contract`; `local-automation-fence` may then consume its
   fixed limits. Land `listening-mode-store` so `local-sqlite-room-store` can
   implement the same port rather than create another model.
2. In the `agent-cli` hotspot, preserve this order: `mcp-inbox-batch` ->
   `mcp-result-piggyback` -> `listening-mode-pull` -> setup and other agent
   surfaces. Each owner adds modules and minimally registers them.
3. Land `listening-mode-dispatch` only after `local-sqlite-room-store`; this is
   the reverse edge that breaks the internal-core cycle.
4. Run Codex and Claude route tickets in parallel. OpenCode routes, including
   its server-auth proof and separate hard cancel, stay with the OpenCode bridge
   owner; this document contributes no duplicate OpenCode implementation ticket.
5. Finish UI and agent controls against real capability projections. Acceptance
   owns both fake and live runs. Unproven cells remain disabled and are not
   waived to make the end-to-end suite green.
