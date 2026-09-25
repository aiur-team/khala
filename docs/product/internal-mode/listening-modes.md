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

The product target is the person's own interactive Codex CLI, Claude Code CLI,
or OpenCode TUI. The user starts that sole agent process and points it at a
Khala channel; Khala never launches or hosts an agent. No interactive CLI proves
all three modes today. Existing Codex app-server and Claude SDK-hosted evidence
is secondary research only and cannot make an interactive capability green.
`interactive-codex`, `interactive-claude`, and `interactive-opencode` own the
native-first proofs. A `khala run <cli>` PTY wrapper is not an approved default:
if a mode needs it, the proof reports **Blocked-without-wrapper** for an operator
decision.

Hard cancellation is not a listening mode. Claude `interrupt()` and OpenCode
abort-then-prompt remain separate opt-in capabilities. MCP-only `async` also
remains unproven until `mcp-piggyback-evidence` passes.

The product therefore stores requested and effective mode separately and
renders evidence-scoped support. It never converts an unproven route into a
green capability or silently changes `steer` to `sync`.

## Terms and proof rule

```ts
type ListeningMode = "steer" | "sync" | "async";

type ModeSupport =
  | {
      status: "proven" | "experimental";
      route: string;
      testedVersion: string;
      evidenceRef: string;
      evidenceRevision: string;
      reason: string | null;
    }
  | {
      status: "blocked_without_wrapper";
      route: string;
      testedVersion: string;
      evidenceRef: string;
      evidenceRevision: string;
      reason: string;
    }
  | {
      status: "unsupported" | "unknown";
      route: string;
      testedVersion?: string;
      evidenceRef: string | null;
      evidenceRevision: string | null;
      reason: string;
    };

type AcknowledgementSupport =
  | "unknown"
  | "unsupported"
  | "batch_token_next_call";

type HarnessCapabilities = {
  v: 3;
  // existing exact-route fields remain
  modes: Record<ListeningMode, ModeSupport>;
  acknowledgement: AcknowledgementSupport;
};
```

`unknown` and `unsupported` require a non-null `reason`; `proven` and
`experimental` require the exact tested version, a non-null `evidenceRef`, and
an immutable evidence revision/digest. `blocked_without_wrapper` requires those
same evidence fields plus `reason`, so an operator never decides from an
unaudited assertion. Codecs reject support records that violate those
invariants.

| Term | Meaning |
| --- | --- |
| requested mode | The per-binding value selected by the agent or human; normally defaults to `sync`. An exact **interactive-session** route with proved unsupported `sync` may initialize `async` with an explicit reason rather than perform a later fallback. Secondary hosted evidence cannot trigger this exception. |
| effective mode | The route currently usable for the exact harness, version, and session shape; `null` when none is honest. |
| proven | A retained, reproducible observation exercises the composed Khala route on the named version. |
| experimental | The underlying surface exists, but Khala has not proved the composed behavior. It requires explicit opt-in. |
| unsupported | Negative evidence closes the route for this session shape, or the harness exposes no required primitive. |
| blocked without wrapper | Native routes are exhausted and only a PTY-wrapper design remains; disabled until the operator separately approves that wrapper. |
| unknown | The harness version or session shape has not been inventoried. It is disabled and carries a reason, never borrowed evidence. |

Vendor documentation proves that an endpoint or hook exists. It does not prove
ordering, interruption, correlation, reconnect, or exactly-once behavior in
Khala. Those cells remain **unproven** until a retained spike exercises the
whole route.

## Findings

### Evidence inventory

The local inventory on 2026-09-24 was collected on host `<executor-host>`:

```text
codex --version     -> codex-cli 0.154.0
claude --version    -> 2.1.282 (Claude Code)
opencode --version  -> 1.17.10
```

The Executor host separately reports OpenCode 1.15.6. Evidence from `<executor-host>`
must not be applied to that host/version without a pinned proof. The 1.17.10
binary used here resolves to
`~/.local/share/mise/installs/opencode/1.17.10/opencode`.

| Evidence | What it proves | What it does not prove |
| --- | --- | --- |
| [`docs/evidence/codex.md`](../../evidence/codex.md) and [`TurnSteerParams.json`](../../../experiments/codex/evidence/schema/TurnSteerParams.json) | A secondary Khala-hosted app-server can use `thread/queue/add`; its schema exposes `turn/steer`. | Delivery into the user's own Codex TUI; this evidence cannot satisfy a product mode. |
| [`docs/evidence/codex-native-cli.md`](../../evidence/codex-native-cli.md) | `codex queue` reaches an existing TUI and queues while busy. | A safe payload route: released bytes appear in `argv`, and consumption has no native release correlation. |
| [`docs/evidence/claude.md`](../../evidence/claude.md) | A secondary SDK-hosted Claude process consumes streaming input after a tool result. | Delivery into the user's own Claude Code CLI; the SDK-hosted process is not a product route. |
| [`docs/evidence/claude-native-cli.md`](../../evidence/claude-native-cli.md) | Existing-session native support must remain fail-closed; the hosted stream worked only while alive. | A native `steer` or interactive `sync` route. |
| [Claude hooks](https://code.claude.com/docs/en/hooks), [SDK streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode), and [channels](https://code.claude.com/docs/en/channels-reference) | The documented hook lifecycle, SDK interrupt capability, and research-preview channel notification surface exist. | Khala's composed routes. Local 2.1.282 help did not expose the documented development-channel flags. |
| [OpenCode server API](https://opencode.ai/docs/server/) and [plugin API](https://opencode.ai/docs/plugins/) | On `<executor-host>`, 1.17.10 documentation and retained OpenCode bridge evidence expose session-addressed non-abort `promptAsync`, abort, events, and plugin hooks. | Support on the Executor host's 1.15.6, delivery into the user's TUI, `sync`, or hard-cancel safety. |
| [`packages/agent-skill/SKILL.md`](../../../packages/agent-skill/SKILL.md), [`capabilities.ts`](../../../packages/agent-skill/src/capabilities.ts), and [`server.ts`](../../../packages/agent-cli/src/mcp/server.ts) | The fallback listener is experimental; MCP currently exposes send but no read/pull tool. | A generic host interruption or safe-boundary callback. |

### Delivery matrix

Every primary row targets the already-running, user-started CLI. No current row
is proven end to end; the per-CLI research slugs below own the retained proof and
must end each cell as **Proven**, **Unsupported**, or
**Blocked-without-wrapper**.

| User-owned interactive CLI | `steer` | `sync` (default) | `async` | Proof owner |
| --- | --- | --- | --- | --- |
| Codex CLI/TUI | **Proven** on 0.154.0 and 0.156.1 under normal trust: native `PreToolUse`/`PostToolUse` hooks at the next tool boundary; idle via a content-free `codex queue` wake. See [`interactive-codex.md`](interactive-codex.md). | **Proven**: native `Stop`, plus `UserPromptSubmit` for the next prompt or an idle wake. | **Proven**: hooks stay silent; the agent's explicit read. | `interactive-codex` |
| Claude Code CLI | **Unproven here.** `claude-plugin-hooks` owns `PostToolUse` after-tool delivery into the existing session; no restricted profile is required. | **Unproven here.** `claude-plugin-hooks` owns `Stop` end-of-turn delivery into the existing session. | **Unproven.** `/khala read` delegates to `khala_read`; any explicit async wake belongs to the plugin runtime, while arrival alone remains silent. | `interactive-claude` |
| OpenCode TUI + DeepSeek | **Unproven as a product route.** Prove that non-abort `promptAsync` or a plugin boundary targets the user's existing TUI session. | **Unproven.** The prior 1.17.10 status-read/submission shape was racy; the new proof must supply an idle/plugin boundary or report blocked. | **Unproven.** Delegate to `khala_read`; arrival does not inject. | `interactive-opencode` |
| Harness-neutral MCP/skill | **Unsupported by itself.** It cannot choose an arbitrary active tool boundary. | **Experimental mechanism only.** `mcp-result-piggyback` can append a batch on an existing Khala call, not promise latency. | **Unproven.** Support remains disabled until `mcp-piggyback-evidence` passes. | Shared fallback evidence |

Native hooks, plugins, MCP, and CLI-owned servers are tried first. If a mode can
work only by launching the CLI under `khala run <cli>`, its primary cell is
`blocked_without_wrapper`; the wrapper is presented as an operator option and
is never enabled, installed, or advertised as the default by this plan.

Hosted-only observations remain useful for mechanism research but are
secondary and never feed the primary capability projection:

| Secondary route | Status and permitted use |
| --- | --- |
| Khala-hosted Codex app-server | `thread/queue/add` is proven on 0.154.0 and `turn/steer` exists in schema. Retain as evidence for `interactive-codex`; do not ship a Khala-launched agent or mark the TUI supported. |
| SDK-hosted Claude stream | After-tool streaming was observed. Retain as comparative evidence and for the required `interrupt()` hard-cancel spike; do not ship an SDK-hosted agent or project support onto Claude Code CLI. |
| Desktop/browser agents | Secondary target owned by `desktop-apps`; it cannot block interactive CLI delivery. |

Hard cancel is advertised separately. Claude `interrupt()` and OpenCode
abort-then-prompt prove cancellation only when they operate on the user's own
session; otherwise they remain secondary mechanism evidence. Each needs an
exact-route grant and never implements ordinary `steer`.

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
  Only a proved negative for the exact user-owned interactive route may
  initialize `requested: "async"` and record the reason. The prior OpenCode
  server-shape observation does not qualify until `interactive-opencode`
  proves that it describes the user's TUI session.
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
- A hard-cancel grant authorizes only the trusted dispatcher to invoke the
  exact granted route; neither agent authority nor released content can issue a
  cancel command. Immediately before actuation, the dispatcher revalidates the
  binding generation, owner grant revision, route/version, and evidence
  revision. Revocation or drift before actuation fails closed and keeps the
  release pending.
- A mode change governs releases that have not been claimed. A claimed attempt
  carries `modeAtClaim` plus the binding generation, route, harness version,
  capability-evidence revision, and correlated interactive-session identity.
  Immediately before the delivery boundary, dispatch revalidates that exact
  route identity. Drift fails closed and returns the release to pending without
  acknowledgement; a mode change alone does not rewrite the claim snapshot.
- `HarnessCapabilities` is the single evidence authority. Per-mode support is a
  derived projection, not separately persisted state. Capability discovery
  recomputes `effective`; version drift can set it to `null` while per-mode
  support becomes `unknown`, but never rewrites `requested`. Its
  `acknowledgement` field is independently one of `unknown`, `unsupported`, or
  `batch_token_next_call`; mode support never implies acknowledgement support.
  `effective` is the conjunction of exact-route mode support and the route's
  required acknowledgement support. Every route that hands off an
  `mcp-inbox-batch` requires `batch_token_next_call`; otherwise `effective` is
  `null` with an acknowledgement-specific reason.
- `pause` wins over all modes. Approval and trust are evaluated before a release
  enters the listening scheduler.
- Mode changes and transport receipts are distinct events. A transport write is
  not a read receipt; receipt facts name the user's interactive session, never
  a secondary hosted process. The read-receipt contracts own consumption.

### Session entry and trust boundary

The user starts the only agent process. They either point that running agent at
a Khala channel URL, or ask it to create a channel through the human-confirmed
`khala channels create` / `khala_create_channel` flow owned by
`channel-access-cli-mcp`. `/khala join <channel-url>` goes through
`channel-access-journal` and `channel-access-inbox`; no command silently admits
an agent or another participant.

Claude setup installs one user-scope plugin containing the skill, hooks, and
MCP entry. There is no separate `/khala` skill install beside it. Codex setup
installs its MCP entry and Khala skill without a plugin; OpenCode uses the
layout selected by its interactive proof and bridge contracts.

Released channel text is framed as untrusted content before it reaches the
normal interactive session. Delivery never requires a restricted profile.
`setup` may report an optional hardening check, but its result cannot gate any
mode or change support state.

Each supported interactive CLI must ultimately expose all three mode cells.
Partial proof remains visible per mode but does not satisfy the product target.
If native routes cannot fill a cell, the proof must stop at
`blocked_without_wrapper` until the operator approves or rejects the wrapper
option.

Every native attach proof also authenticates the endpoint before a capability
turns green: a Unix socket must have the expected owner and restrictive
permissions; a local server must be loopback-only and require a setup-managed
credential; both must correlate process and session ownership. Unknown
ownership, unauthenticated access, or broader network exposure fails closed.

Across all three interactive proof owners, adversarial channel payloads must
enter only a structured user-content field. Retained fixtures cover newlines,
delimiters, JSON fragments, shell metacharacters, and terminal escapes, and
prove that bytes never become process arguments, shell commands, environment or
config values, JSON-RPC method metadata, or terminal control sequences.

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
the second is not bounded. `local-automation-fence` injects `maxCausalDepth`
through the existing automatic-release policy; listening dispatch receives only
`maxJobsPerCausalRoot`, `maxConcurrentJobs`, and `busy`. Both layers consume the
same approved profile in local composition, while hosted `approvedAutomation()`
remains `null`.

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
the exact active binding. Its visible identity is `<CLI name> <version> ·
<binding-short-id>`, where the short identifier is a collision-resistant,
human-readable derivation of the immutable binding ID and expands if two active
bindings would share it. Grant confirmations, evidence detail, runtime
failures, and delivery receipts repeat the same label so concurrent sessions of
one CLI cannot be confused.

| Support state | Control | Copy and detail |
| --- | --- | --- |
| proven | Enabled | `Supported on <harness version> via <route>`; resolve its identifier-like `evidenceRef` through an allowlisted internal evidence registry. Unknown or URL-shaped references are plain text, never links. |
| experimental | Disabled until explicit opt-in | An adjacent `Enable experimental route` action opens a route-specific confirmation, records a grant for this binding/version/route, then enables selection. Show the missing proof. |
| unsupported | Disabled | A concrete reason such as `No interrupt route` or `Payload would enter argv`. |
| blocked without wrapper | Disabled, non-actionable | `Native delivery unavailable; wrapper-based support is awaiting product-operator approval.` Link the retained proof; only a later capability-evidence update can change availability. Agent Controls never offers a wrapper action. |
| version/session unknown | Disabled | `Support unknown for this version/session`; never inherit a green badge from another binding. |
| no active interactive session | Disabled, read-only | Retain the last binding label and requested mode, show effective mode as `none`, disable mode and grant actions, and direct the owner to resume or rejoin the CLI. Never retain a green badge after disconnect. |
| experimental consent expired | Disabled pending fresh confirmation | Name the changed route, harness version, or evidence revision. Show the updated evidence before offering a new owner confirmation; never reuse the prior grant automatically. |

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

Every badge names the exact user-owned interactive session. Secondary hosted
evidence is visible only in evidence detail and can never enable a mode, satisfy
a default, or produce a green badge.

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
| Inventory | `interactive-codex` pins the user's TUI and inventories native attach/server/socket surfaces before consulting the secondary app-server schema. Record whether the observed `threadId` and `turnId` belong to that already-running TUI. |
| Cases | Send during plain generation and a long synthetic tool; also test idle, stale `expectedTurnId`, duplicate client ID, disconnect-before-response, and reconnect/readback in the same user session. |
| Pass | One injection observation with the stable release ID enters the user's active TUI turn at a repeatable safe boundary, does not kill the tool, and Khala-side acknowledgement prevents a second handoff. An isolated Khala-hosted app-server does not pass. |
| Fail closed | Leave the interactive cell unproven. If only `khala run codex` works, report `blocked_without_wrapper`; do not silently call `thread/queue/add` or enable the wrapper. |

### Claude interactive after-tool `steer`

| Step | Required observation |
| --- | --- |
| Inventory | `interactive-claude` pins Claude Code; `claude-plugin-hooks` owns the installed user-scope `PostToolUse`/`Stop` runtime. Use the normal interactive session with a long synthetic tool; no restricted profile is required. |
| Cases | Enqueue one release during model output and during the tool; inject through `PostToolUse` only after the tool result. Test duplicate hints, disconnect, resume, and `Stop` end-of-turn buffering separately. |
| Pass | One correlatable non-abort injection appears in the user's existing CLI after the tool and before end-of-turn `sync`; next-call batch-token acknowledgement prevents a second handoff. |
| Fail closed | Keep `steer` unproven. Never substitute SDK hosting or call `interrupt()` as an invisible fallback. |

### Claude Agent SDK hard cancel

| Step | Required observation |
| --- | --- |
| Inventory | Pin Claude Code and Agent SDK; first determine whether `interrupt()` can target the user's existing CLI. A separately launched SDK process is secondary evidence only. |
| Cases | Under an explicit hard-cancel grant, call the SDK interrupt method during model output and during the tool, await the terminal event, then enqueue one release. Test permission prompts, duplicate calls, disconnect, resume, and child-process cleanup. |
| Pass | Cancellation reaches a deterministic boundary in the user's own session, no tool child is orphaned, transcript continuity survives, and one correlatable post-cancel injection exists. This proves only the granted hard-cancel capability, not `steer`. |
| Fail closed | Keep interactive hard cancel disabled. A result against an SDK-hosted process remains secondary; ordinary `steer` continues through plugin after-tool delivery. |

### Claude experimental channel push

| Step | Required observation |
| --- | --- |
| Inventory | First require a CLI version whose help exposes the documented development-channel flag, org policy permits channels, and the MCP server declares `experimental["claude/channel"]`. Local 2.1.282 fails the first gate. |
| Cases | Push `notifications/claude/channel` while idle, generating, and inside a long tool. Repeat after restart and test duplicate/reordered notifications and consent behavior. |
| Pass | One notification observation with the stable release ID reaches the user's intended existing CLI session at a repeatable non-abort boundary without hidden approval; Khala-side token acknowledgement prevents a second handoff. Model consumption remains unproven. |
| Fail closed | Advertise this alternative route as experimental or unsupported for that exact binding. The primary v1 Claude `steer` route remains after-tool injection. |

### OpenCode hard cancel

| Step | Required observation |
| --- | --- |
| Inventory | Pin OpenCode 1.17.10 and DeepSeek configuration; subscribe to session SSE before starting a disposable long synthetic tool. |
| Cases | Under an explicit hard-cancel grant, abort the user's own TUI session through its built-in server, wait for the terminal status/event, then call `promptAsync` once. Test idle abort, side-effecting-tool fixture, duplicate/retry, disconnect, and attached/local-server forms. |
| Pass | The user's TUI reaches a deterministic terminal boundary, partial tool effects are visible, and one correlatable `promptAsync` submission occurs. This proves only hard cancel, not `steer`. |
| Fail closed | Leave hard cancel disabled. A result against a separate server session does not prove the interactive route. |

## Trade-offs

| Choice | Benefit | Cost |
| --- | --- | --- |
| Requested/effective split | Preserves agent intent without lying when versions or session shapes change. | Adds state and UI copy. |
| Exact-version proof | Prevents accidental capability promotion across fast-moving CLIs. | Requires recurring evidence refresh. |
| No silent fallback | Makes timing guarantees inspectable and avoids surprising new turns. | A release may wait longer when a route fails. |
| User-owned session only | Preserves the person's existing CLI context and avoids a second hidden agent. | Hosted app-server/SDK mechanisms become secondary, so every CLI needs its own attachment proof. |
| Wrapper requires a new decision | Prevents setup from silently changing how the user launches an agent. | A mode may remain blocked even when a PTY proof works. |
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
- A native API may address a different process or session than the visible TUI;
  every proof must correlate the exact user-owned session before support turns
  green.
- Plugin and MCP delivery places untrusted channel text into a normal interactive
  session. Framing and optional setup hardening reduce risk, but a restricted
  profile cannot be required as a delivery precondition.

## Non-goals

- Reopening D1–D12, changing admission/trust policy, or defining channel-wide modes.
- Treating transcript capture or ordinary model output as channel messages.
- Implementing the routes owned by `interactive-codex`, `interactive-claude`,
  `interactive-opencode`, `claude-plugin-hooks`, or
  `claude-plugin-dispatch`; implementing `mcp-result-piggyback`; or owning the
  fake/live acceptance runs.
- Advertising a minimum supported vendor version from one pinned proof.
- Enabling hard abort by default.

## Ticket contracts

Contract slugs are proposed dependency names for Executor promotion. Each is
sized for one agent and one PR. The original broad control contract is split
between value/capability contracts and `listening-mode-store`; pull remains one
operation because `mcp-inbox-batch` owns batching and acknowledgement. This
document does not promote harness route implementations: `interactive-codex`,
`interactive-claude`, and `interactive-opencode` own the primary proofs and the
route contracts that follow from them; `claude-plugin-hooks` and
`claude-plugin-dispatch` own the Claude runtime.

### 1. `listening-mode-contract`

| Field | Contract |
| --- | --- |
| Slug | `listening-mode-contract` |
| Title | Define listening-mode values, capabilities, and local limits |
| Complexity | `complexity:4` |
| Scope | Add `ListeningMode`, `ModeSupport` including `blocked_without_wrapper`, command/result codecs, owner-only grant command shapes, and the locally approved automation profile. Migrate `HarnessCapabilities` from v2 to v3 with the derived per-mode projection and `acknowledgement: unknown | unsupported | batch_token_next_call`; retained v2 values decode compatibly with acknowledgement `unknown`, while every producer emits v3. Update all capability producers, consumers, and fixtures in the same change. `HarnessCapabilities` is the only support-data owner. |
| Out of scope | Persistence, authority construction, dispatcher timing, harness calls, UI, receipts, and SQLite. |
| Files/packages | New `packages/contracts/src/delivery/listening-mode.ts`; `packages/contracts/src/delivery/{harness,index}.ts`, delivery fixtures/tests and README; capability producers/tests in `packages/harnesses/src/{codex,claude}/`, `packages/agent-skill/src/capabilities.ts`, and connector runtime/composition/dispatch fixtures; affected `packages/agent-cli` and `apps/web` capability consumers/fixtures; new `packages/policy/src/listening-mode/limits.ts` with boundary tests. Keep immutable `binding.ts` unchanged. |
| Acceptance | `sync` is the normal initial value; only an exact interactive route's proved negative may initialize `async` with a reason; uninspected versions report `unknown`; support and acknowledgement are independent derived fields; v2 decodes with acknowledgement `unknown` and all producers emit v3; hosted-only evidence never projects primary support; evidence revisions invalidate grants; hosted automation remains closed while a retained two-agent completion/loop-stop experiment approves or revises the provisional `{maxCausalDepth:3,maxJobsPerCausalRoot:3,maxConcurrentJobs:1,busy:"wait"}` profile. |
| Tests | v2-to-v3 decoder compatibility, v3 producer/consumer fixtures, codec/capability matrices, acknowledgement independence, exact-version/evidence-revision invalidation, initial-mode selection, primary/secondary route separation, local/hosted boundary, automation-limit tests, and retained two-agent completion plus runaway-loop fixtures. **Wrong-implementation test:** rejecting a retained v2 capability, emitting v2 after migration, accepting `blocked_without_wrapper` without reason/evidence revision, a hosted app-server proof making the Codex TUI green, a mode result implying batch acknowledgement, a changed evidence revision retaining consent, or a hosted composition receiving local limits must fail. |
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
| Conflict risk | High with `local-sqlite-channel-store`, which owns the SQLite adapter for this port; do not add a second local state model or schema here. |

### 3. `listening-mode-pull`

| Field | Contract |
| --- | --- |
| Slug | `listening-mode-pull` |
| Title | Add the single ordered pull operation for `async` |
| Complexity | `complexity:4` |
| Scope | Add one application operation exposed as `khala read` (CLI) and `khala_read` (MCP). It returns the exact `mcp-inbox-batch` format/token; the agent's next Khala call presents that token so Khala acknowledges before selecting another batch. The single user-scope Claude plugin and OpenCode integration delegate here. |
| Out of scope | A second cursor/lease/batch API, host-side deduplication, read receipts, auto-wake, harness interruption, and message send. |
| Files/packages | New `packages/agent-cli/src/cli/read.ts`, `packages/agent-cli/src/mcp/read-tool.ts`, and `packages/agent-cli/src/composition/read.ts`; minimal registrations in `cli/{app,main,types}.ts` and `mcp/server.ts`; agent-skill docs/tests. |
| Acceptance | Arrival in `async` performs no harness call or automatic wake; concurrent calls serialize through `mcp-inbox-batch`; the prior token is acknowledged only on the next authenticated Khala call; restart reuses Khala state without receiver dedup; empty pull is typed; wrong binding/generation is refused; no read receipt is emitted. |
| Tests | CLI/MCP operation parity, token acknowledgement, replay before acknowledgement, empty result, cross-binding refusal, and crash/restart. **Wrong-implementation test:** fail if the operation advances the inbox during read, invents a lease/cursor, or requires Claude/Codex/OpenCode to deduplicate a replay. |
| Blocked-by | `listening-mode-contract`, `listening-mode-store`, `mcp-inbox-batch`, `mcp-result-piggyback`. |
| Conflict risk | High in `agent-cli`: land after `mcp-result-piggyback`, keep registrations minimal, and let Claude/OpenCode call this operation rather than fork it. |

### 4. `listening-mode-dispatch`

| Field | Contract |
| --- | --- |
| Slug | `listening-mode-dispatch` |
| Title | Extend connector dispatch with modes, local limits, and pause/wake |
| Complexity | `complexity:4` |
| Scope | Extend `packages/connector/src/dispatch/` with requested/effective gating, `modeAtClaim`, proved-boundary callbacks, ordered job/concurrency/busy budgets, and the pause/wake contract above. Consume only `maxJobsPerCausalRoot`, `maxConcurrentJobs`, and `busy` from the approved local profile; the existing automatic-release policy remains the sole `maxCausalDepth` enforcer. Derive decisions only from retained `DeliveryReceipt` kinds tied to the user's interactive session. |
| Out of scope | New receipt kinds, harness-specific calls, pull transport, UI, SQLite schema, and read receipts. |
| Files/packages | `packages/connector/src/dispatch/`, delivery attempt/application contracts, composition fakes, and focused dispatch tests. |
| Acceptance | Pause prevents new claims; in-flight attempts keep their mode snapshot but revalidate binding generation, route, harness version, evidence revision, and interactive-session identity before delivery; drift returns the release to pending without acknowledgement; `async` arrivals never wake; resume coalesces one wake without resetting budget; automatic release enforces causal depth while dispatch enforces job, concurrency, and busy limits; unknown/refused work stays pending; no generic `delivered` fact appears. |
| Tests | Mode/pause races, route/evidence/session drift after claim, wake coalescing, async silence, budget exhaustion/re-arm, fence composition across both enforcement layers, nil capability, receipt mapping, and item/byte boundaries. **Wrong-implementation test:** fail if a claimed release reaches a replacement session, dispatch requires or derives `maxCausalDepth`, resume resets causal counters, or an `async` arrival invokes the harness. |
| Blocked-by | `listening-mode-contract`, `listening-mode-store`, `local-sqlite-channel-store`. |
| Conflict risk | High with `local-automation-fence`, which consumes these limits and pause/wake rules and must itself block on `listening-mode-contract`; this dependency direction breaks the internal-core cycle. |

### 5. `listening-mode-ui`

| Field | Contract |
| --- | --- |
| Slug | `listening-mode-ui` |
| Title | Show requested/effective listening mode and honest support |
| Complexity | `complexity:3` |
| Scope | Add per-agent selector/status in Agent Controls, binding-specific session labels, owner mutation, allowlisted evidence details, separate grant/revoke flows for experimental routes and hard cancel, explicit version-conflict recovery, and waiting, stopped-session, expired-consent, and error states. |
| Out of scope | Agent-side command authority, harness implementation, global channel defaults, and receipt design. |
| Files/packages | `apps/web/src/features/agent-controls/{ports,model,controller,AgentControlsPanel}.ts*`, browser harness, CSS/tests. |
| Acceptance | `sync` normally renders by default; an exact interactive route with proved unsupported `sync` may initialize `async` and explains why; every active row, grant, evidence detail, failure, and receipt repeats the CLI/version/binding-short-id label; unsupported, unknown, and blocked-without-wrapper modes are disabled with exact-route reasons; a stopped session retains read-only context with effective `none`; invalidated consent is named and requires fresh evidence review; secondary hosted evidence never enables a control; each grant can be revoked without altering the other; conflicts refresh without auto-retry and preserve the attempted choice as unsubmitted; requested/effective divergence is announced; no support leaks between bindings. |
| Tests | Controller/component/browser matrix including keyboard navigation, screen-reader descriptions/status announcements, focus recovery, concurrent same-CLI binding labels, stopped-session stale-badge prevention, expired-consent re-confirmation, evidence-link allowlist, primary/secondary evidence separation, non-actionable blocked-without-wrapper copy, independent grant/revoke flows, and conflict refresh. **Wrong-implementation test:** a hosted Codex proof must not turn the TUI badge green, a disconnected session must not retain a green badge, and revoking experimental delivery must not revoke hard cancel. |
| Blocked-by | `listening-mode-contract`, `listening-mode-store`, `interactive-codex`, `interactive-claude`, `interactive-opencode`. |
| Conflict risk | Medium with local UI composition and receipt labels; add a separate listening section and reuse neither receipt copy nor owner-only policy authority for agent commands. |

### 6. `listening-mode-agent-controls`

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
   approved limits. Land `listening-mode-store` so `local-sqlite-channel-store` can
   implement the same port rather than create another model.
2. In the `agent-cli` hotspot, preserve this order: `mcp-inbox-batch` ->
   `mcp-result-piggyback` -> `listening-mode-pull` -> setup and other agent
   surfaces. Each owner adds modules and minimally registers them.
3. Land `listening-mode-dispatch` only after `local-sqlite-channel-store`; this is
   the reverse edge that breaks the internal-core cycle.
4. Run `interactive-codex`, `interactive-claude`, and `interactive-opencode` in
   parallel. They try native routes first, emit their own route contracts, and
   report `blocked_without_wrapper` rather than approving `khala run`. Claude
   runtime work stays with `claude-plugin-hooks`/`claude-plugin-dispatch`;
   OpenCode runtime work stays with its bridge contracts.
5. Finish UI against the primary interactive capability projections, then let
   acceptance own fake and live runs. Hosted-only results remain secondary and
   unproven cells are never waived to make the suite green.
