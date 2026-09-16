# Proposed repository layout and parallel ownership

Revision 4; proposed directories, not claims that implementation exists. The client reuse experiment KHA-143 can change the web-internal layout before approval of detailed plans. Use a TypeScript workspace with a few packages and feature folders; a ticket is not a reason to create a package or service.

```text
apps/
  web/src/
    brand/                        # 107: sourced Aiur assets, fonts, tokens
    shell/                        # 107: layout slots, no feature imports
    features/
      create-chat/                # 122
      timeline/                   # 123
      join/                       # 124
      review/                     # 125
      agent-controls/             # 126
      recovery/                   # 127
    composition/
      human/                      # 132: app entry, route registration, live ports
      review/                     # 134: installs review capability
      controls/                   # 135: installs trust/status capability
      recovery/                   # 136: installs recovery capability
  control/src/                    # small Netlify functions, not a server daemon
    auth/                         # 110
    invitations/                  # 113
    agent-bootstrap/              # 114
    runtime/                      # 131: Netlify handler adapter and discovery
    composition/human/            # 132
    composition/agent/            # 133
  connector/src/                  # agent-operated owner runtime, never Netlify
    runtime/                      # 133: entry, lifecycle, capability loading
    composition/review/           # 134
    composition/controls/         # 135
    composition/recovery/         # 136
packages/
  contracts/
    src/messaging/                # 105: identity, room, SDK ports, device lifecycle
    src/delivery/                 # 106: approval, trust, dispatch, adapter ports
    fixtures/{messaging,delivery}/
  messaging/src/
    browser-device/               # 111
    rooms/                        # 112
    revocation/                   # 128
    recovery/                     # 129
  connector/src/
    bootstrap/                    # 114
    storage/                      # 115: SDK store adapter + inbox/release ledger
    subscription/                 # 116
    dispatch/                     # 121
    retention/                    # 130
  harnesses/src/{claude,codex}/    # 117, 118
  policy/src/{release,trust}/      # 119, 120; pure functions, no SDK or I/O
infra/{messaging,operations,netlify}/ # 108, 109, 131
experiments/                      # isolated per feasibility ticket
scripts/                          # 101: boundary checker and generic test discovery
tests/
  integration/{human,connector,review,controls,recovery}/
  e2e/{harness,security,collaboration}/
  conformance/
docs/{research,product,plans,evidence,operations}/
```

Tests for a module live beside it (`*.test.ts`), not in a shared growing test file. `tests/` owns cross-component proof only. Every feature carries its own README if needed; final user and adapter guides are consolidated by KHA-140. This minimizes shared indexes without duplicating facts.

## Import and contract rules

- Contracts depend on neither apps nor implementations. Messaging and delivery contract directories do not import each other: opaque IDs and versioned envelopes define their boundary. KHA-101 reserves package subpath exports and primitive conventions; contract owners pin actual shapes and fixtures.
- Feature UI consumes contracts and shell primitives through injected ports. It cannot import sibling feature internals, connector storage, native crypto bindings or server credentials.
- Policy consumes contracts; it is deterministic and has no storage, network or harness imports.
- Messaging, connector and harness implementations consume contracts and OSS libraries. Cross-component behavior calls injected ports rather than importing another worker's unfinished module.
- Composition roots are the only places that bind implementations together. Browser, control functions and owner runtime remain distinct deployment targets.
- No global `types.ts`, `utils.ts`, `store.ts`, feature barrel or giant route file. State lives with the owning subsystem: SDK chat history/keys, connector durable inbox/release ledger, browser UI view state, and minimal authenticated control state. Do not copy the transport log to Blobs.
- Netlify Blobs is a candidate for minimal control state under approved atomicity semantics; it is not prescribed for local agent state or SDK device keys. KHA-105 must pin the control-store port and concurrency behavior.

## Shared-file ownership and green merges

KHA-101 creates package shells, per-package manifests, subpath exports, test scripts, dependency constraints and generic CI discovery. Contract owners 105/106 then fill their own modules and fixtures. Spikes use isolated manifests/lockfiles inside their experiment directories. They never mutate the root lockfile.

The Executor assigns one dependency-maintenance owner after bootstrap. Workers propose required package/dependency changes with exact versions in their workpad; the owner lands those changes before a consumer requires them to build. Only that owner regenerates the root lockfile, root manifests and shared TS/CI settings. Serializing **these edits** does not require serializing entire feature tickets. If a planned ticket actually needs unresolved dependency changes to start, add a real prerequisite instead of hiding it as an informal request.

Preallocate subpath exports rather than letting every ticket append a shared barrel. KHA-132 owns the browser entry/router and KHA-133 owns the connector entry/lifecycle. Their contracts define a narrow capability-registration interface. Follow-on composition modules export registrations discovered by the platform's supported module loader/build mechanism; pin that mechanism in 101/132/133 so 134–136 need not all edit one entry file. Avoid a general plugin framework. If explicit central registration is simpler for the selected UI stack, assign those small entry edits to the integration owner and record symmetric `serializes_with` edges for overlapping landing work.

Consumer tickets use the real, merged contract with injected fakes. They may not import an unimplemented package or land permanently mocked production behavior. Unwired capabilities remain unavailable behind explicit composition state; fixture modules are excluded from production exports/bundles. Contract checks run at component merge; integration tickets replace fixtures with real implementations and own live proof.

Use isolated per-issue worktrees as Aiur provides. At dispatch, inspect actual planned files; a worker must request an ownership amendment before changing another ticket's directory. Directory separation cannot eliminate semantic conflicts, so new contract changes get review by producer and consumers, not an independent copy of the interface.

## Reconnection ledger: who owns the seams

| Seam implemented independently | Integration owner and real proof |
|---|---|
| OAuth ↔ device keys ↔ rooms ↔ admission ↔ create/join/timeline UI | 132: two humans complete encrypted create/share/chat on real services |
| Bootstrap ↔ key/inbox storage ↔ subscription ↔ bounded dispatch ↔ harnesses | 133: same-session agent connection and reconnect |
| Human preview ↔ authenticated approval ↔ policy ↔ durable release ↔ model projection | 134: exact bytes delivered, every unreleased path closed |
| Trust UI ↔ policy transitions ↔ connector acknowledgment ↔ budgets/pause | 135: effective policy, offline/busy and race evidence |
| Recovery UI ↔ SDK recovery/revocation ↔ inbox reconciliation/cleanup | 136: loss, replacement and closure without silent resubmission |
| All production composition ↔ adversarial scenarios ↔ actual multi-owner task | 138/139 independently; 140 owns merged-base root acceptance |

Each integration ticket owns wiring and its tests, not rewriting sibling implementations. Found component defects return to their owner. New independent scope requires a graph amendment; do not turn the capstone into an unbounded fix ticket.

## Parallelism limits and priorities

The proposal has nine dependency levels. This is a provisional depth, pending user review, not an agreed schedule. The initial feasibility tracks and workspace scaffold can run together; the highest-width level has 20 candidates. No claim is made that 20 agents can run on the current host or under the current fleet ceiling.

Staff KHA-144 (automatic ownership proof), then 105 (messaging ports), and 106 (delivery ports) promptly: they unlock the broadest fan-out. UI/backend/adapter/policy workers then operate on disjoint paths. Do not wait for deployed UI before starting connector adapters, or for production endpoints before building fixture-driven screens. Within available capacity, prioritize real integration preparation so completed modules do not accumulate without a working path.

Contract review, root dependency updates, shared deployment environments and final merges are bounded coordination points. Give integration tests per-worker ephemeral accounts/data/ports, never a shared production room or shared local key store. The deployment owner schedules any destructive restore against a disposable environment.

## Aiur source grounding

Read locally on 2026-09-16:

- [Current planning contract](../../../aiur/.claude/skills/aiur-build/references/planning-contract.md): draft/issue authority, member fields, undispatched containers, validation and runtime paths.
- [Decomposition workflow](../../../aiur/.claude/skills/aiur-build/references/decomposition-workflow.md): contract-first fan-out, antichain phases, exact write surfaces and named reconnection owners.
- [Build Order concept](../../../aiur/website/docs-app/concepts/build-orders.md): only workspace/state-node packs are discovered; docs-only proposals are inert.
- [Prior decomposition lessons](../../../aiur/docs/build-order/01-decomposition-patterns.md): one observable outcome, green PR, integration owner and typed conflicts.

Current runtime guidance supersedes older example manifests that require publication/reconciliation machinery. The enriched proposal graph preserves review metadata; it is not a substitute for the runtime member shape. Publication/daemon/dashboard verification remains a later coordinated action, and no completed planning pack is claimed here.
