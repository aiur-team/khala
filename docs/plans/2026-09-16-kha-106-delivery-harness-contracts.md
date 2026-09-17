---
title: "KHA-106 Define approval and harness ports - Plan"
type: feat
date: 2026-09-16
topic: delivery-harness-contracts
artifact_contract: ce-unified-plan/v1
artifact_readiness: requirements-only
product_contract_source: ce-brainstorm
execution: code
origin: docs/product/tickets/KHA-106.md
---

# KHA-106 Define approval and harness ports - Plan

## Goal Capsule

Give independent policy, connector, harness and UI workers one precise meaning of approval and delivery. Dependencies: KHA-101, KHA-103, KHA-104. Follow the approved scope card and the units below. A plan is not evidence that the proposed integration works. All implementation surfaces listed here are proposed unless a source explicitly identifies existing code.

## Product Contract

### Summary

Give independent policy, connector, harness and UI workers one precise meaning of approval and delivery.

### Problem Frame

A transport receipt cannot establish model consumption, and successful replay cannot establish exactly-once agent execution. The observable outcome in this ticket must preserve the owner-controlled review boundary and existing session identity across retries and failures.

### Requirements

- R1. Bind each release to immutable event bytes, recipient session generation and policy version.
- R2. Require verified owner authority separately from untrusted command data.
- R3. Represent unknown outcomes and capability limitations without promising exactly-once model execution.
- R4. Permit any model through a harness-neutral contract; claim tested support only with harness/version evidence.

### Actors and flow

A1: owning human. A2: trusted owner connector. A3: existing model session and its harness adapter. A4: ciphertext transport/control service. Human identity, connector device, agent participant and working session are distinct.

F1. A human approves exact event references, the owner connector creates a release, and a capable adapter reports only the delivery evidence it actually observes.

### Acceptance Examples

- AE1. Changing one selected digest or the recipient binding generation invalidates a release. Covers R1 and R2.
- AE2. A timeout after a possible enqueue yields outcome_unknown and never an automatic second model submission. Covers R2 and R3.

### Key Decisions

KD1. Existing-session delivery (session-settled: user-directed — chosen over replacement agents: preserve the human's working context). Any model is supported by protocol extensibility; actual harness support requires evidence.

KD2. Connector-gated review (session-settled: user-directed — chosen over separate review encryption groups: pending plaintext may stay in the trusted owner connector but not model context).

KD3. TypeScript and OSS reuse (session-settled: user-directed — chosen over custom infrastructure by default: reduce development). Netlify is preferred; Railway is acceptable when reuse saves work. Matrix remains a candidate, not a selected dependency.

### Scope Boundaries

- `packages/contracts/src/delivery/`
- `packages/contracts/fixtures/delivery/`

No sibling implementation edits, root package/lockfile changes, provider deployment or production credentials. Root dependency changes go through KHA-101. This ticket does not add human installation/configuration, broaden history disclosure, weaken harness permissions or claim isolation from an unrestricted same-host agent. Integration is explicit, not accomplished by importing unfinished sibling implementations.

### Open Questions

G-AUTOMATION and G-HARNESSES: final busy behavior and configured limits need decisions/proofs; ports may describe alternatives but cannot select defaults.

### Sources

- `docs/product/tickets/KHA-106.md`, `docs/product/decisions.md`, `docs/product/repo-layout.md`.
- `docs/research/01-agent-protocols.md`, `docs/research/02-substrates.md`, `docs/research/07-state-and-transport.md`.

## Planning Contract

Source manifest: `docs/evidence/transport-planning-sources.json` pins local repositories, read-only CLI observations and official documentation checks. No runtime proof is implied.

### Approach and authority

KHA-106 owns the following exports under `@khala/contracts/delivery`. KHA-105 independently owns matching messaging scalar shapes; neither contract subtree imports the other. A conformance fixture compares accepted/rejected JSON examples across both. Existing product gates prevent launch approval; this is a detailed contract checkpoint, not permission to pick an automation default.

Proposed files: `packages/contracts/src/delivery/events.ts`, `binding.ts`, `commands.ts`, `jobs.ts`, `harness.ts`, `receipts.ts`, `decode.ts`, and adjacent tests. Public exports must be reserved by KHA-101; no root barrel edits here. Production decoders reject unknown protocol versions and invalid fields before authority or policy evaluation.

### Canonical shapes

```ts
export type EventRef = Readonly<{
  v: 1; roomId: string; eventId: string;
  authorParticipantId: string; authorDeviceId: string;
  contentDigest: string;
}>;
export type SessionBinding = Readonly<{
  bindingId: string; ownerId: string; agentParticipantId: string;
  deviceId: string; harness: string; sessionId: string; generation: number;
}>;
export type OwnerAuthority = Readonly<{
  ownerId: string; issuer: string; subject: string;
  authenticatedAt: string; authorizationId: string;
}>;
export type ApprovalCommand = Readonly<{
  v: 1; commandId: string; roomId: string; bindingId: string;
  expectedPolicyVersion: number; expectedBindingGeneration: number; selection: readonly EventRef[];
  issuedAt: string;
}>;
export type PolicySetCommand = Readonly<{
  v: 1; commandId: string; roomId: string; bindingId: string;
  peerParticipantId: string; expectedPolicyVersion: number;
  expectedBindingGeneration: number;
  mode: "review" | "auto"; paused: boolean; issuedAt: string;
}>;
export type PolicyAck = Readonly<{
  commandId: string; bindingId: string; generation: number;
  requestedVersion: number | null; effectiveVersion: number | null;
  connectorState: "pending" | "effective" | "offline" | "rejected";
  errorCode: "forbidden"|"stale_policy"|"stale_binding"|
    "idempotency_conflict"|"unavailable"|"outcome_unknown"|null;
}>;
export type ReleasedJob = Readonly<{
  v: 1; releaseId: string; binding: SessionBinding; policyVersion: number;
  events: readonly EventRef[]; payloadRef: string; payloadDigest: string;
  causalRootId: string;
}>;
```

`OwnerAuthority` is a verified composition input, never accepted from a browser JSON body. Structural TypeScript types are not authentication. KHA-110/134 constructs authority after trusted session validation; consumers check owner/room membership and recipient binding. Agent-facing routes never receive owner approval capability. `issuedAt` is audit data, not authorization or replay protection. Commands with the same ID and identical canonical input return the stored result; the same ID with different input returns `idempotency_conflict`. A version conflict returns current version without applying the command. Ordering of `selection` is intentional and preserved; duplicate event identities are rejected, empty selection rejected. One release targets exactly one recipient binding. Both commands require expectedBindingGeneration matching the immutable binding shown during review. Reject stale_binding before changing state when it differs, including recovery/rebinding. Binding IDs cannot silently retarget another session.

IDs are opaque nonempty strings, bounded to 512 UTF-8 bytes as a proposed protocol safety limit; reject NUL/control characters; no URL construction from unchecked IDs. Safe nonnegative integers for versions/generation. Digests are `sha256:` followed by 64 lowercase hex digits. A decoder returns `{ok:true,value:T}` or `{ok:false,code:"invalid_version"|"invalid_field"|"limit_exceeded",field:string}`; it never echoes plaintext input. Selection/payload-size limits are explicit configured capabilities; no unbounded array accepted and no silent truncation. KHA-105 parity fixtures must adopt or reconcile bounds before freezing either public decoder.

`payloadRef` is an opaque owner-local ledger handle, not a filesystem path or transferable fetch credential. `payloadDigest` covers the exact ordered release payload bytes, separately from each event's content digest. KHA-119 owns the deterministic release envelope codec; KHA-121 verifies its digest before adapter submission. Preserve original event identity and human/agent author attribution in the released payload. Rendering is not canonicalization.

```ts
export type HarnessCapabilities = Readonly<{
  harness: string; version: string; adapterVersion: string;
  support: "tested" | "experimental" | "unsupported";
  existingSession: boolean; immediateNotification: boolean;
  busy: "queue" | "steer" | "reject" | "unknown";
  receiptEvidence: readonly ReceiptKind[];
  reconcileByReleaseId: boolean;
  evidenceRef: string | null;
}>;
export type ReceiptKind =
  | "queued" | "dispatching" | "transport_written" | "harness_queued"
  | "context_consumed" | "completed" | "outcome_unknown" | "failed"
  | "cancel_requested" | "cancelled";
export type DeliveryReceipt = Readonly<{
  v: 1; receiptId: string; releaseId: string; bindingId: string;
  generation: number; kind: ReceiptKind; observedAt: string;
  source: "connector" | "harness"; evidenceRef: string | null;
  errorCode: string | null;
}>;
export interface HarnessPort {
  inspect(binding: SessionBinding): Promise<HarnessCapabilities>;
  notify(binding: SessionBinding, hint: {v:1; releaseId:string}): Promise<void>;
  submit(input: {job: ReleasedJob; payload: Uint8Array}): Promise<DeliveryReceipt>;
  reconcile(job: ReleasedJob): Promise<DeliveryReceipt | null>;
  close(): Promise<void>;
}
export interface ApprovalPort {
  approve(authority: OwnerAuthority, command: ApprovalCommand): Promise<
    {ok:true; releaseIds:readonly string[]} |
    {ok:false; code:"forbidden"|"stale_policy"|"stale_content"|
      "stale_binding"|"expired_content"|"idempotency_conflict"|"unavailable"} |
    {ok:false; code:"outcome_unknown"; operationId:string}>;
  setPolicy(authority: OwnerAuthority, command: PolicySetCommand): Promise<PolicyAck>;
}
```

Null version means that no authoritative revision was observed; it must not be replaced with zero or the requested value. PolicyAck fields correlate to the original command and binding generation; a late acknowledgement cannot update another request or recovered binding. `effective` requires null errorCode and an observed matching connector acknowledgement; `rejected` requires a safe non-null code. Ambiguous persistence returns outcome_unknown with the original command identity, never an effective ack.

Candidate backlog decomposition pending G-AUTOMATION: PolicySetCommand changes future-event policy only; selected existing pending events use a separate exact ApprovalCommand. Enabling auto must not implicitly release all pending. The UI must present the approved backlog choice and must not claim atomic success across the two commands.

`notify` is for released work only and carries no pending count, room text, preview, sender name or content-derived hint. It does not authorize a later fetch. If the harness submission itself wakes the session, the adapter may implement notification as an internal signal; composition must not send duplicate model prompts by invoking both as separate submissions. No port promises a universally available cancellation primitive. A future cancel route must be capability-gated; receipt vocabulary only records evidence supplied by a supported integration.

Receipt kinds are facts, not a sortable progress enum. `transport_written` says only that a write returned. `harness_queued` requires actual correlated harness acceptance. `context_consumed` needs observable harness context evidence; a prompt asking the model to echo a nonce is experimental evidence, not cryptographic proof. `completed` needs correlated turn/task evidence and does not attest task correctness. A disconnect after possible submission becomes `outcome_unknown`, never `failed` with implicit retry permission. Cancellation requested does not establish cancellation; in-flight completion may still arrive. Receipt identity deduplicates observations; incompatible terminal claims require reconciliation, not last-writer-wins.

### Worked fixtures and failure boundaries

Use binding `bind-b-1`, owner `owner-b`, agent `agent-b`, device `dev-b`, harness `codex`, session `thread-existing-b`, generation `0`. Room `room-1`, event `event-a-7`, author `agent-a`, device `dev-a`. KHA-105's content body is `Review the API change.\nDo not merge yet.`. Canonical content bytes are UTF-8 of compact JSON `["khala.message.v1","text",body]`, with no Unicode/newline normalization. The literal digest is pinned in fixture evidence below; tests compare literal expected bytes/digest, not the production function to itself.

Changing the body, author, recipient generation or room must invalidate selection binding. Same content text in a new event is a different approval object. SDK edits do not mutate previously approved event references. A verified owner cannot approve for another binding's owner. A forged `ownerId` without verified authority fails before looking up pending plaintext.

## Implementation Units

### U1. Value contracts and strict codecs

Implement scalar shapes, decoders and exact fixture JSON in the owned paths. Depends on KHA-101 and the KHA-103/104 capability evidence. Covers R1/R4. Test missing/extra protocol-critical fields, unsupported versions, unsafe integers, empty and over-limit identifiers, wrong digest, duplicate selection and ordered-event preservation.

### U2. Authority, commands and idempotency semantics

Implement exported command/result types, with examples for authority provenance and per-owner command identity. Depends U1. Covers R1/R2 and AE1. Publish fixtures for same ID/same input, same ID/changed input, stale policy, cross-owner binding and invalid content; implementation belongs to KHA-119/120/134 rather than these pure contracts.

### U3. Harness capability and evidence contract

Implement the neutral port and receipt decoder. Depends U1. Covers R3/R4 and AE2. Pin a capability fixture for each proven route, plus unsupported and unknown cases. No vendor/model allowlist; harness strings are extension identifiers and evidence limits tested claims.

### U4. Consumer conformance and parity

Export fixture-only subpath agreed with KHA-101. Cross-check structural parity with KHA-105 using literal fixtures without production subtree imports. KHA-137 consumes the suite; KHA-133 reconnects real components, KHA-134 binds authority/release and KHA-135 binds policy acknowledgements.

## Verification Contract

After KHA-101 bootstrap, run `pnpm --filter @khala/contracts test`, `pnpm typecheck` and the affected fixture/conformance tests. These are planned commands, not tests executed during planning. All four units need their negative fixtures. Test doubles cannot establish live harness support. KHA-103/104 evidence must distinguish queue/consumption and preserve existing-session identity before their fixtures may use `support: "tested"`.

## Definition of Done

R1–R4 and AE1–AE2 have codec and consumer tests; KHA-105 parity is reviewed; KHA-119/120/121 and UI consumers import these exact shapes; no production implementation is imported by contracts. Unresolved G-AUTOMATION/G-HARNESSES choices are decided and reflected without changing approved product requirements before marking this artifact implementation-ready. Local contract tests are necessary, not a claim of end-to-end or exactly-once execution.

### Literal cross-contract digest evidence

The canonical content fixture has 71 bytes and digest `sha256:f16c1e5a70000f33eebc69c8ecf82d1ab7360fcdd15121ac3293f1afd4d4ea6b`. This value was computed independently with Python hashlib during planning; it is not an SDK interoperability test.
