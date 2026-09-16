---
title: "KHA-114 Bootstrap an agent from its chat link - Plan"
type: feat
date: 2026-09-16
topic: agent-link-bootstrap
artifact_contract: ce-unified-plan/v1
artifact_readiness: requirements-only
product_contract_source: ce-brainstorm
execution: code
origin: docs/product/tickets/KHA-114.md
---

# KHA-114 Bootstrap an agent from its chat link - Plan

## Goal Capsule

Let the agent perform secure connection setup from the link the human already shared. Dependencies: KHA-101, KHA-105, KHA-106. Follow the approved scope card and the units below. A plan is not evidence that the proposed integration works. All implementation surfaces listed here are proposed unless a source explicitly identifies existing code.

## Product Contract

### Summary

Let the agent perform secure connection setup from the link the human already shared.

### Problem Frame

A transport receipt cannot establish model consumption, and successful replay cannot establish exactly-once agent execution. The observable outcome in this ticket must preserve the owner-controlled review boundary and existing session identity across retries and failures.

### Requirements

- R1. Treat the chat link as discovery/admission context, never proof that its holder owns a human identity.
- R2. Bind an admitted owner to the actual existing session and a distinct connector device.
- R3. Let the agent perform technical setup and report unsupported harnesses honestly without delegating configuration to the human.

### Actors and flow

A1: owning human. A2: trusted owner connector. A3: existing model session and its harness adapter. A4: ciphertext transport/control service. Human identity, connector device, agent participant and working session are distinct.

F1. The agent resolves a trusted bootstrap descriptor, proves the approved ownership method, creates or reuses its device, and returns an immutable session binding.

### Acceptance Examples

- AE1. Retrying setup for the same verified owner and binding returns the same result without duplicate device admission. Covers R1 and R2.
- AE2. A forwarded link or forged email cannot claim another owner's agent. Covers R2 and R3.

### Key Decisions

KD1. Existing-session delivery (session-settled: user-directed — chosen over replacement agents: preserve the human's working context). Any model is supported by protocol extensibility; actual harness support requires evidence.

KD2. Connector-gated review (session-settled: user-directed — chosen over separate review encryption groups: pending plaintext may stay in the trusted owner connector but not model context).

KD3. TypeScript and OSS reuse (session-settled: user-directed — chosen over custom infrastructure by default: reduce development). Netlify is preferred; Railway is acceptable when reuse saves work. Matrix remains a candidate, not a selected dependency.

### Scope Boundaries

- `packages/connector/src/bootstrap/`
- `apps/control/src/agent-bootstrap/`

No sibling implementation edits, root package/lockfile changes, provider deployment or production credentials. Root dependency changes go through KHA-101. This ticket does not add human installation/configuration, broaden history disclosure, weaken harness permissions or claim isolation from an unrestricted same-host agent. Integration is explicit, not accomplished by importing unfinished sibling implementations.

### Open Questions

G-SUBSTRATE, G-HARNESSES and the KHA-144 owner-binding proof must clear; the ownership ceremony cannot be invented here.

### Sources

- `docs/product/tickets/KHA-114.md`, `docs/product/decisions.md`, `docs/product/repo-layout.md`.
- `docs/research/01-agent-protocols.md`, `docs/research/02-substrates.md`, `docs/research/07-state-and-transport.md`.

## Planning Contract

Source manifest: `docs/evidence/transport-planning-sources.json` pins local repositories, read-only CLI observations and official documentation checks. No runtime proof is implied.

### Approach and trust boundaries

Separate public discovery from privileged owner/session binding. `packages/connector/src/bootstrap/index.ts` exports `bootstrapAgent(input, ports)`; `apps/control/src/agent-bootstrap/handler.ts` exports the hosted endpoint factory with injected KHA-105 identity/admission ports. Bootstrap accepts a URL, not a shell script to execute. The link resolves a versioned descriptor containing protocol endpoint and supported method identifiers; URLs are validated against configured trusted origin/provider policy, redirects revalidated, credentials stripped and secrets never logged. A fetched document cannot expand shell permissions or select an arbitrary executable.

```ts
type BootstrapInput = { chatUrl:string; session:{harness:string;
  sessionId:string; workdir:string};
  operationId:string };
type BootstrapResult =
  | {kind:"connected"; binding:SessionBinding; reused:boolean}
  | {kind:"blocked"; code:"ownership_required"|"unsupported_harness"|
      "untrusted_origin"|"admission_denied"|"device_unavailable"};
type BootstrapPorts = { discovery:DiscoveryPort; ownership:OwnershipPort;
  admission:AdmissionPort; devices:ConnectorDevicePort;
  sessions:SessionInspectionPort; operations:BootstrapOperationStore };
```

The input session descriptor is an untrusted discovery claim until SessionInspectionPort verifies the actual native session. Owner/device/participant/binding IDs are constructed only after verified ownership and admission; bootstrap does not require an already-authorized SessionBinding as its input.

The port names above are bootstrap-local dependency interfaces wrapping KHA-105/106 exports; they are not replacement identity contracts. `OwnershipPort` must invoke the exact method proven by KHA-144 and return verified owner authority with server-checked expiry/audience and one-time challenge binding. No implementation may infer ownership from email text, link possession, a Matrix display name or an agent claim. Agent setup must not acquire human approval credentials. A short-lived admission/bootstrap grant must be distinct from ongoing room membership and message release authority.

### Worked retry and compensation

Owner B pastes `https://khala.example/chat/room-invite` into session `thread-existing-b`. Public discovery supplies no pending messages or secrets. The proven ownership flow yields an opaque verified owner/session authorization; operation `bootstrap-b-1` records its binding before device admission. If the response is lost after a device is created, retry looks up the operation outcome and reuses the admitted device. If identity admission succeeds but local key storage fails, return blocked and preserve enough non-secret operation state to revoke/repair the incomplete device; never mint devices repeatedly. A conflicting operation ID with changed owner/session input fails. The immutable session generation changes only through an authorized rebinding flow, not on reconnect.

### Alternatives and failure policy

Manual MCP install, human pairing commands and separate Matrix signup conflict with settled onboarding and are rejected. Blind executable instructions fetched from a chat link are rejected. Automatic agent-operated setup is selected, conditional on KHA-144 and KHA-103/104 evidence. Session privileges and existing model stay unchanged; unsupported capability must be visible before admission is advertised connected. Netlify functions can perform bounded bootstrap/control requests, while long-lived subscriptions belong to the actual owner endpoint.

## Implementation Units

### U1. Descriptor parsing and origin-bound discovery

Implement `descriptor.ts`, `discovery.ts` and adjacent tests in bootstrap. Pin strict protocol version and bounded payload. Covers R1. Tests reject redirects to untrusted origins, embedded credentials, unexpected content types, malformed endpoint paths and arbitrary executable directives.

### U2. Ownership and admission choreography

Depends U1 and KHA-144 proof through KHA-105. Implement operation identity, ownership verification and admission in `orchestrator.ts`; hosted handler validates authenticated context and maps safe errors. Covers R1/R2, AE2. Tests forwarded links, expired/replayed grants, cross-owner session ID, forged email and duplicate operation IDs. No human-side technical fallback.

### U3. Device/session binding and compensation

Depends U2. Validate actual harness capabilities, retain immutable binding, persist recoverable partial outcomes and return connected only after ready device state. Covers R2/R3 and AE1. Tests partial admission/local-storage failure and response-loss retry. Inject device/session ports; do not import unfinished storage/harness implementations.

### U4. Wiring contract and setup report

Document machine-readable blocked states and setup actions in `README.md` under bootstrap. KHA-133 binds real storage/subscription/harness; KHA-132/143 UI reports state through their own paths. Component completion requires port-level tests; real no-setup owner connection belongs to KHA-133/139.

## Verification Contract

After KHA-101: `pnpm --filter @khala/connector test`, `pnpm --filter @khala/control test`, `pnpm typecheck`. Fixture tests use synthetic origins, authority and disposable device IDs. Validate every redirect/error/partial-success branch. Live ownership proof comes from KHA-144, not mocked email fields. No runtime tests ran during planning.

### Settled production origin — user amendment

P11 sets the production app origin to `https://khala.aiur.team`. Canonical production share links use that origin; OAuth callback is `https://khala.aiur.team/api/human/auth/callback`. KHA131 owns origin validation/configuration,110 consumes the exact callback and132 composes it. Preview allowlists/credentials stay explicit and separate. This does not assign a Matrix server_name or claim DNS/hosting is already configured. Earlier synthetic `.example` links remain test fixtures, never deployment defaults. This later user decision supplements the preserved Product Contract.

## Definition of Done

R1–R3/AE1–AE2 covered; idempotent retries do not create duplicate devices; non-owners cannot claim bindings; no bootstrap output leaks grant tokens. KHA-133 receives explicit injection points and partial-operation recovery semantics. G-SUBSTRATE/G-HARNESSES and KHA-144 proof must resolve before readiness advances.
