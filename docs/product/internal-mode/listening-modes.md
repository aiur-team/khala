# Listening modes across harnesses

Status: research complete for KHA-E09. The canonical values are `steer`,
`sync`, and `async`; `sync` is the default. The D2 and I10 wording in
[`requirements.md`](requirements.md) predates the ticket terminology update,
so implementations must use `steer` in contracts, APIs, storage, and UI.

## Summary

Listening mode is a versioned setting on one agent binding, changeable by that
agent or the human owner. It controls *when a pending release may be surfaced*;
it does not change admission, trust, approval, pause, receipt, or deduplication
rules.

No harness proves all three modes today. Codex 0.154.0 proves `sync` through a
Khala-owned app-server. Claude has pinned mechanism evidence for after-tool SDK
streaming delivery, but not a retained proof of the composed Khala route.
OpenCode exposes useful abort, prompt, and plugin surfaces, but their
composition is unproven. The generic MCP/skill fallback proves that it cannot
provide `steer`; its existing listener remains experimental and it has no pull
primitive for `async`.

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
};
```

| Term | Meaning |
| --- | --- |
| requested mode | The per-binding value selected by the agent or human; defaults to `sync`. |
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

The local inventory on 2026-09-24 was:

```text
codex --version     -> codex-cli 0.154.0
claude --version    -> 2.1.282 (Claude Code)
opencode --version  -> 1.17.10
```

| Evidence | What it proves | What it does not prove |
| --- | --- | --- |
| [`docs/evidence/codex.md`](../../evidence/codex.md) and [`TurnSteerParams.json`](../../../experiments/codex/evidence/schema/TurnSteerParams.json) | `thread/queue/add` waits for the active turn on Codex 0.154.0; the schema exposes `turn/steer` with `threadId`, `expectedTurnId`, and `input`. | Same-turn steering, failure recovery, and release correlation. |
| [`docs/evidence/codex-native-cli.md`](../../evidence/codex-native-cli.md) | `codex queue` reaches an existing TUI and queues while busy. | A safe payload route: released bytes appear in `argv`, and consumption has no native release correlation. |
| [`docs/evidence/claude.md`](../../evidence/claude.md) | Claude Code 2.1.276 with Agent SDK 0.3.276 consumes a mid-tool streaming input after the tool result. | Interactive-session attachment, hard interruption, or durable reconnect. |
| [`docs/evidence/claude-native-cli.md`](../../evidence/claude-native-cli.md) | Existing-session native support must remain fail-closed; the hosted stream worked only while alive. | A native `steer` or interactive `sync` route. |
| [Claude hooks](https://code.claude.com/docs/en/hooks), [SDK streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode), and [channels](https://code.claude.com/docs/en/channels-reference) | The documented hook lifecycle, SDK interrupt capability, and research-preview channel notification surface exist. | Khala's composed routes. Local 2.1.282 help did not expose the documented development-channel flags. |
| [OpenCode server API](https://opencode.ai/docs/server/) and [plugin API](https://opencode.ai/docs/plugins/) | 1.17.10 documentation exposes session abort, synchronous/asynchronous prompt endpoints, events, and plugin hooks. | Abort-then-continue safety, busy ordering, deduplication, or DeepSeek acceptance. |
| [`packages/agent-skill/SKILL.md`](../../../packages/agent-skill/SKILL.md), [`capabilities.ts`](../../../packages/agent-skill/src/capabilities.ts), and [`server.ts`](../../../packages/agent-cli/src/mcp/server.ts) | The fallback listener is experimental; MCP currently exposes send but no read/pull tool. | A generic host interruption or safe-boundary callback. |

### Delivery matrix

Every route below is explicitly **proven** or **unproven**. `unsupported` is a
proven negative result, not a weaker claim of support.

| Harness | `steer` | `sync` (default) | `async` |
| --- | --- | --- | --- |
| Claude, SDK-hosted stream | **Unproven.** Candidate: SDK `interrupt()`, wait for a terminal interruption signal, then enqueue the release. Hard abort stays opt-in. | **Unproven; mechanism observed.** Claude Code 2.1.276 + Agent SDK 0.3.276 consumed streaming input after a tool result, but the composed Khala adapter route was not exercised. | **Unproven.** Requires the new explicit pull operation; do not write to the stream automatically. |
| Claude, interactive/plugin | **Unproven.** Candidate: research-preview channel notification for boundary delivery. Local 2.1.282 did not advertise the required development-channel flags. | **Unproven.** `PostToolUse` and `Stop` are documented candidates; #140/`claude-plugin` owns the live hook proof and atomic drain. | **Unproven.** `/khala read` is planned by #140 but no shared pull contract exists yet. |
| Codex, Khala-hosted app-server | **Unproven.** Send `turn/steer` only with the observed active `turnId` as `expectedTurnId`; retain pending on refusal or unknown outcome. | **Proven**, exactly on Codex 0.154.0: `thread/queue/add` starts a new turn after the active turn. | **Unproven.** Requires explicit pull; no queue call is allowed merely because a message arrived. |
| Codex, existing TUI | **Unsupported for released bytes.** No proved same-turn attach route. | **Unsupported for released-byte delivery.** A separate notification-only capability is proven on 0.154.0 via `codex queue`, but bytes would appear in process arguments. | **Unproven.** A notification may tell the agent to invoke pull, but notification is not delivery. |
| OpenCode + DeepSeek | **Unproven.** Candidate: abort the active session, observe its terminal state, then call `prompt_async` once. | **Unproven.** Candidate: buffer in the plugin and submit after `tool.execute.after` or `session.idle`; endpoint/event existence alone is insufficient. | **Unproven.** Agent invokes pull; the plugin must not inject on arrival. |
| MCP/skill fallback | **Unsupported.** A harness-neutral MCP server or skill cannot interrupt an arbitrary host loop. | **Unproven/experimental.** The installed listener has `busy: "unknown"`; #141/`mcp-piggyback` may add boundary delivery when the agent already calls a Khala tool, not a timing guarantee. | **Unproven.** Best-fit route is a new `khala_read` MCP tool and CLI command. |

## Design

### State and authority

Keep mutable mode control outside the immutable `SessionBinding`, room policy,
and human-approval policy. Store a versioned control record keyed by
`bindingId` and binding `generation`; a replacement binding starts a fresh
record with `requested: "sync"`:

```ts
type ListeningModeControl = {
  bindingId: BindingId;
  generation: number;
  requested: ListeningMode;       // defaults to "sync"
  version: number;
  experimentalGrants: readonly RouteGrant[];
  hardCancelGrants: readonly RouteGrant[];
};

type ListeningModeView = ListeningModeControl & {
  effective: ListeningMode | null;
  support: Record<ListeningMode, ModeSupport>; // derived from HarnessCapabilities
};
```

- Admission creates `requested: "sync"`; there is no room-wide default switch.
- Trusted connector composition creates a non-decodable
  `AgentBindingAuthority` bound to the authenticated `bindingId` and
  `generation`. Agent mode-query, mode-change, and pull ports require it and
  reject target or generation mismatches. The human owner may change any
  binding under D10. Both submit `expectedVersion` so simultaneous changes
  cannot silently overwrite one another.
- Experimental-route and hard-cancellation grants are separate, off by default,
  and scoped to the exact binding, route, harness version, and capability
  evidence. `SetListeningMode` accepts either `AgentBindingAuthority` or
  `OwnerAuthority`; separate `GrantExperimentalRoute` and `GrantHardCancel`
  commands require server-constructed `OwnerAuthority` and the browser CSRF
  boundary. Agent authority cannot mint, alter, revoke, or reuse either grant.
  A version or route change invalidates them.
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
| `async` | Arrival only persists and signals availability. The agent explicitly invokes an exclusive per-binding pull. The server returns a stable batch token and ordered cursor without advancing it; acknowledgement atomically commits only a contiguous prefix. | Never inject, wake, or start a turn. A caller crash or expired lease redelivers the same unacknowledged suffix with stable release IDs for client deduplication; an empty pull returns a typed empty result. |

Adapters continue to emit retained `DeliveryReceipt` facts. The connector
dispatcher derives scheduler decisions from receipt kind: `harness_queued` or a
stronger proved observation advances the attempt; `failed` with a rejection
code refuses it; `outcome_unknown` waits for reconciliation; and a missing
capability is unsupported. It never invents a generic `delivered` fact or
infers success from a process write. Release IDs remain stable through batching,
and any retry is driven by reconciliation evidence, never by a missing success
line alone. Each boundary is capped by capability limits equivalent to
`maxSelectionEvents` and `maxPayloadBytes`; the ordered suffix remains pending.

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
and remains off by default.

## `steer` proof spikes

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

### Claude Agent SDK interrupt

| Step | Required observation |
| --- | --- |
| Inventory | Pin Claude Code and Agent SDK; use streaming input and a disposable session with a long synthetic tool. |
| Cases | Call the SDK interrupt method during model output and during the tool, await the terminal event, then enqueue one release. Test permission prompts, duplicate calls, disconnect, resume, and child-process cleanup. |
| Pass | Cancellation reaches a deterministic boundary, no tool child is orphaned, transcript continuity survives, and one correlatable injection observation exists for the stable release ID. Model consumption remains unproven pending #145 or #147. |
| Fail closed | Keep hard abort disabled. The observed after-tool streaming mechanism remains unproven as a composed `sync` route. |

### Claude experimental channel push

| Step | Required observation |
| --- | --- |
| Inventory | First require a CLI version whose help exposes the documented development-channel flag, org policy permits channels, and the MCP server declares `experimental["claude/channel"]`. Local 2.1.282 fails the first gate. |
| Cases | Push `notifications/claude/channel` while idle, generating, and inside a long tool. Repeat after restart and test duplicate/reordered notifications and consent behavior. |
| Pass | One notification observation with the stable release ID reaches the intended session at a repeatable boundary without hidden approval, and reconnect/retry reconciliation never produces a second notification. Model consumption remains unproven pending #145 or #147. |
| Fail closed | Advertise the route as experimental or unsupported for that exact binding. Do not generalize from channel registration alone. |

### OpenCode abort

| Step | Required observation |
| --- | --- |
| Inventory | Pin OpenCode 1.17.10 and DeepSeek configuration; subscribe to session SSE before starting a disposable long synthetic tool. |
| Cases | POST session abort, wait for the terminal status/event, then call `prompt_async` once. Test idle abort, side-effecting-tool fixture, duplicate/retry, disconnect, and attached/local-server forms. |
| Pass | Abort has a deterministic terminal boundary, partial tool effects are visible, and one correlatable `prompt_async` submission occurs for the stable release ID. Model consumption remains unproven pending #145 or #147. |
| Fail closed | Leave `steer` experimental/disabled. The plugin may still pursue `sync` after its independent proof. |

## Trade-offs

| Choice | Benefit | Cost |
| --- | --- | --- |
| Requested/effective split | Preserves agent intent without lying when versions or session shapes change. | Adds state and UI copy. |
| Exact-version proof | Prevents accidental capability promotion across fast-moving CLIs. | Requires recurring evidence refresh. |
| No silent fallback | Makes timing guarantees inspectable and avoids surprising new turns. | A release may wait longer when a route fails. |
| Explicit pull for `async` | Matches agent-controlled attention and works across harnesses. | Adds a shared CLI/MCP surface and batching semantics. |
| Hard abort behind opt-in | Contains tool-side-effect and orphan-process risk. | `steer` remains unavailable on each route until its retained proof passes; hard-abort variants also require separate consent. |

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

- Reopening D1–D12, changing admission/trust policy, or defining room-wide modes.
- Treating transcript capture or ordinary model output as chat messages.
- Proving Claude plugin hooks (#140), MCP piggyback details (#141), OpenCode +
  DeepSeek acceptance (#142), read-receipt semantics (#145), or the full E2E
  acceptance harness (#147) in this document.
- Advertising a minimum supported vendor version from one pinned proof.
- Enabling hard abort by default.

## Ticket contracts

Contract slugs are proposed dependency names for Executor promotion. Each is
sized for one agent and one PR.

### 1. `listening-mode-contract`

| Field | Contract |
| --- | --- |
| Title | Add versioned per-binding listening-mode control and authority |
| Complexity | `complexity:4` |
| Scope | Add `ListeningMode`, versioned control keyed by binding/generation, default `sync`, separate owner-only experimental and hard-cancel grant commands, derived mode support in `HarnessCapabilities`, agent/owner mode commands, authority objects, codecs, and events. |
| Out of scope | Dispatcher timing, harness calls, UI, read receipts, admission, trust, and SQLite persistence. |
| Files/packages | `packages/contracts/src/delivery/{harness,commands,events}.ts`, fixtures/tests; trusted connector composition authority types. Keep immutable `binding.ts` unchanged. |
| Acceptance | A replacement binding starts at `sync`; uninspected versions report `unknown`; support is derived, not stored twice; `AgentBindingAuthority` is non-decodable and generation-bound; stale writes conflict; only server-constructed `OwnerAuthority` can issue or revoke grants; grants invalidate on route/version change. |
| Tests | Contract/codec, cross-binding, stale-generation, stale-version, grant-authority, and grant-invalidation tests. **Wrong-implementation test:** creating a control record with `steer` as its initial value, using authority from a prior generation, or issuing either grant with `AgentBindingAuthority` must fail. |
| Blocked-by | None. |
| Conflict risk | High with #138 persistence schema and #145 receipt/event vocabulary; #138 owns the later SQLite adapter, and this contract must not change receipt semantics. |

### 2. `listening-mode-pull`

| Field | Contract |
| --- | --- |
| Title | Add ordered agent pull for `async` and generic fallback delivery |
| Complexity | `complexity:4` |
| Scope | Add `khala_read` as an exclusive per-binding application operation, CLI command, and MCP tool. Return a stable batch token and cursor without advancing it; atomically acknowledge only a contiguous prefix; expire leases into ordered redelivery with stable release IDs. Integrate piggyback only through #141's result contract. |
| Out of scope | Claude slash-command packaging, read receipts, auto-wake, harness interruption, and message send. |
| Files/packages | `packages/agent-cli/src/{cli,mcp,composition}/`, delivery application port/contracts, `packages/agent-skill/` docs/capabilities. |
| Acceptance | Arrival in `async` performs no harness call; concurrent pulls serialize; retry returns the same unacknowledged suffix; acknowledgement advances only the confirmed prefix; empty pull is typed; wrong binding/generation is refused; no operation emits a read receipt. |
| Tests | CLI/MCP contract tests covering concurrent pulls, lease expiry, partial acknowledgement, empty result, and crash-between-claim-and-ack recovery. **Wrong-implementation test:** posting in `async` must fail if a fake harness is called before `khala_read`, or if a crash loses the leased batch. |
| Blocked-by | `listening-mode-contract`, `internal-core`, `mcp-piggyback`. |
| Conflict risk | High with #140 `/khala read`, #141 MCP result shape, and #145 read terminology; share one operation and never emit a read receipt here. |

### 3. `listening-mode-dispatch`

| Field | Contract |
| --- | --- |
| Title | Extend connector dispatch with mode-aware claiming and budgets |
| Complexity | `complexity:4` |
| Scope | Extend `packages/connector/src/dispatch/` with requested/effective-mode gating, a `modeAtClaim` attempt snapshot, proved-boundary callbacks, ordered batching, `maxSelectionEvents`/`maxPayloadBytes` budgets, and scheduler decisions derived from retained `DeliveryReceipt` kinds. |
| Out of scope | New receipt kinds, harness-specific calls, UI, async pull transport, and read receipts. |
| Files/packages | `packages/connector/src/dispatch/`, delivery attempt/application contracts, dispatch fakes and tests. |
| Acceptance | Pause still wins; unclaimed work observes a mode change while an existing attempt keeps its snapshot; unknown/refused/outcome-unknown work remains pending; every boundary preserves the over-budget suffix; no generic `delivered` receipt is introduced. |
| Tests | Mode-change races, pause, nil capability, receipt mapping, and budget boundaries. **Wrong-implementation test:** a burst exceeding either item or byte budget must fail if all releases are surfaced at one boundary. |
| Blocked-by | `listening-mode-contract`, `internal-core`. |
| Conflict risk | High with #138 substrate dispatch wiring and #145 receipts; extend the existing dispatcher and closed receipt vocabulary rather than creating a parallel scheduler. |

### 4. `codex-listening-routes`

| Field | Contract |
| --- | --- |
| Title | Prove and gate Codex `steer`; expose proven `sync` |
| Complexity | `complexity:4` |
| Scope | Implement the retained `turn/steer` spike above, add an adapter only if it passes, surface exact-version support, and map `thread/queue/add` to `sync`. Preserve native-CLI notification-only constraints. |
| Out of scope | Starting arbitrary TUIs, placing released bytes in `codex queue` arguments, generic pull implementation, and broad minimum-version claims. |
| Files/packages | `experiments/internal-mode/listening-modes/codex/`, `packages/harnesses/src/codex/`, conformance tests, evidence docs. |
| Acceptance | Hosted app-server 0.154.0 reports proven `sync`; `steer` is enabled only by passing injection/reconciliation evidence; stale/refused/unknown steer leaves pending; support becomes `unknown` on uninspected versions; native CLI never transports bytes. |
| Tests | Adapter, capability, reconciliation, and mutation-tested evidence verifier. **Wrong-implementation test:** an active-turn `steer` request must fail if the adapter calls `thread/queue/add` or omits `expectedTurnId`. |
| Blocked-by | `listening-mode-contract`, `listening-mode-dispatch`. |
| Conflict risk | Medium with #147 acceptance and existing Codex receipt tests; retain their no-blind-retry rule. |

### 5. `claude-sdk-listening-route`

| Field | Contract |
| --- | --- |
| Title | Prove and gate Claude SDK-hosted `sync` and interrupt `steer` |
| Complexity | `complexity:4` |
| Scope | Exercise the composed Khala after-tool SDK route, run the retained SDK-interrupt spike, add exact-version/session-shape capability records, and implement only routes whose retained injection/reconciliation proof passes. |
| Out of scope | Interactive hooks, channels, slash commands, native existing-session claims, and default hard cancellation. |
| Files/packages | `experiments/internal-mode/listening-modes/claude-sdk/`, `packages/harnesses/src/claude/`, capabilities/conformance/evidence docs. |
| Acceptance | The existing timing observation remains experimental until the composed adapter passes; hard abort requires a distinct valid grant and proof; child cleanup and reconnect failures preserve pending releases; model consumption is not claimed. |
| Tests | SDK capability matrix, after-tool composition, interrupt cleanup, reconnect, grant, and evidence mutation tests. **Wrong-implementation test:** mechanism-only evidence must fail if the capability reports SDK `sync` as proven. |
| Blocked-by | `listening-mode-contract`, `listening-mode-dispatch`. |
| Conflict risk | Medium with #147 live acceptance and existing Claude receipt tests; this ticket owns only SDK-hosted routes. |

### 6. `claude-interactive-listening-route`

| Field | Contract |
| --- | --- |
| Title | Gate Claude interactive hook and channel routes |
| Complexity | `complexity:4` |
| Scope | Consume #140's proved atomic hook boundaries for interactive `sync`, run the retained channel spike, and expose exact-version/session-shape capability records through the common adapter. |
| Out of scope | Reimplementing plugin hooks or slash commands, SDK-hosted interrupt, bypassing channel consent/org policy, and broad version claims. |
| Files/packages | `experiments/internal-mode/listening-modes/claude-channel/`, `packages/harnesses/src/claude/`, plugin adapter seam selected by `claude-plugin`, conformance/evidence docs. |
| Acceptance | Hook and channel routes report independently; a CLI without the development-channel flag reports unsupported/unknown rather than proven; experimental consent is route-scoped; failures preserve pending releases. |
| Tests | Hook-boundary fakes, CLI inventories, channel consent/reconnect, and evidence mutation tests. **Wrong-implementation test:** an inventory without the development-channel flag must fail if channel `steer` reports proven. |
| Blocked-by | `listening-mode-contract`, `listening-mode-dispatch`, `claude-plugin`. |
| Conflict risk | High with #140 hook ownership and #147 live acceptance; consume the plugin contract without owning its packaging. |

### 7. `opencode-listening-routes`

| Field | Contract |
| --- | --- |
| Title | Integrate proof-gated OpenCode listening modes |
| Complexity | `complexity:4` |
| Scope | Consume #142's plugin/session identity, run the abort spike above, map its proved idle/tool boundary to `sync`, and expose `steer` only if abort-then-continue passes. `async` delegates to shared pull. |
| Out of scope | Plugin installation, DeepSeek provider setup, generic pull implementation, or full Aiur acceptance. |
| Files/packages | `experiments/internal-mode/listening-modes/opencode/`, the OpenCode adapter/plugin package selected by `opencode-bridge`, capability/conformance tests. |
| Acceptance | Session identity is exact; `sync` waits for its proved boundary; abort reaches terminal state before one continuation; failed/unknown abort does not submit; capability is version-scoped. |
| Tests | Fake server/SSE ordering, live disposable proof, disconnect/duplicate cases. **Wrong-implementation test:** delayed abort completion must fail if `prompt_async` is called before the terminal event. |
| Blocked-by | `listening-mode-contract`, `listening-mode-dispatch`, `listening-mode-pull`, `opencode-bridge`. |
| Conflict risk | High with #142; that research owns plugin shape and DeepSeek acceptance, while this ticket owns common mode semantics and proof gating. |

### 8. `listening-mode-ui`

| Field | Contract |
| --- | --- |
| Title | Show requested/effective listening mode and honest support |
| Complexity | `complexity:3` |
| Scope | Add per-agent selector/status in Agent Controls, owner mutation, allowlisted evidence details, separate experimental-route and hard-cancel confirmations, version-conflict recovery, and waiting/error states. |
| Out of scope | Agent-side command authority, harness implementation, global room defaults, and receipt design. |
| Files/packages | `apps/web/src/features/agent-controls/{ports,model,controller,AgentControlsPanel}.ts*`, browser harness, CSS/tests. |
| Acceptance | `sync` renders by default; unsupported/unknown values are disabled with associated reasons; experimental consent enables only that route; hard cancel stays separately off; requested/effective divergence is announced; selector and confirmations are keyboard-operable; conflict refresh preserves focus; stale mutations refresh rather than overwrite; no support leaks between bindings. |
| Tests | Controller/component/browser matrix including keyboard navigation, screen-reader descriptions/status announcements, focus recovery, evidence-link allowlist, and both consents. **Wrong-implementation test:** a second binding on an untested version must not inherit the first binding's proven `steer` badge. |
| Blocked-by | `listening-mode-contract`; harness route tickets provide real capability fixtures, but fakes allow parallel UI work. |
| Conflict risk | Medium with #138 local UI composition and #145 receipt labels; add a separate listening section and reuse neither receipt copy nor owner-only policy authority for agent commands. |

### 9. `listening-mode-agent-controls`

| Field | Contract |
| --- | --- |
| Title | Expose listening-mode inspection and mutation to the bound agent |
| Complexity | `complexity:3` |
| Scope | Add CLI and MCP operations plus skill guidance that read the exact-binding `ListeningModeView` and submit `SetListeningMode { requested, expectedVersion }` under injected `AgentBindingAuthority`. Return the updated view or typed conflict/refusal with actionable support reasons. |
| Out of scope | Experimental-route or hard-cancel grant mutation, owner UI, async release pull, room-wide defaults, and harness delivery. |
| Files/packages | `packages/agent-cli/src/{cli,mcp,composition}/`, `packages/agent-skill/{SKILL.md,src/capabilities.ts}`, listening-mode application ports and tests. |
| Acceptance | The agent can inspect requested/effective/support state, change only its own active binding, refresh after a version conflict, and observe requested/effective divergence without a false delivery claim; neither operation exposes owner authority or grant commands. |
| Tests | CLI/MCP/skill contract tests for query, successful mutation, support reasons, typed conflict/refusal, and composition-injected authority. **Wrong-implementation test:** an agent request targeting another binding or carrying a stale generation/version must fail, and agent authority must not reach either grant command. |
| Blocked-by | `listening-mode-contract`. |
| Conflict risk | High with `listening-mode-pull` and #141 MCP capability discovery; share authentication/composition and capability vocabulary, but keep mode control distinct from release acknowledgement. |

## Integration order

1. Land `listening-mode-contract`, then allow UI and agent-control work against
   fakes.
2. Land `listening-mode-dispatch` after `internal-core`; land
   `listening-mode-pull` after `internal-core` and `mcp-piggyback` settle the
   storage/result contracts.
3. Run harness tickets in parallel, consuming `claude-plugin` and
   `opencode-bridge` rather than duplicating them.
4. Finish `listening-mode-ui` and `listening-mode-agent-controls` against real
   capability projections, then let #147/`acceptance` compose the proven cells.
   Unproven cells remain disabled and are not waived to make the end-to-end
   suite green.
