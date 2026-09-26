# `@khala/contracts/delivery`

Approval, release, harness-capability and receipt contracts (KHA-106). This is a
default-free contract checkpoint: it defines strict values and ports, but imports no
messaging, policy, connector, SDK or harness implementation.

Import contracts from `@khala/contracts/delivery/index`. There is no fixture export:
the JSON fixtures stay under `packages/contracts/fixtures/delivery/` and never enter
`dist`. The package-level `./delivery/*` reservation from KHA-101 provides the subpath
without a root barrel or lockfile change.

## Approval binds exact inputs

An `ApprovalCommand` names one binding generation, one policy version and an ordered,
nonempty selection of immutable `EventRef` values. Selection size comes from a decoded
`DeliveryLimits` capability; there is no protocol default and no silent truncation.
Duplicate event identities and mixed-channel selections fail decoding. Reordering events
changes the command input.

`OwnerAuthority` is a trusted composition input. There is deliberately no JSON decoder
for it: a browser body that contains an `ownerId` is not authentication. Implementations
must validate owner/channel membership and binding ownership before reading pending
plaintext. `issuedAt` is audit data, not replay protection.

The same command ID with identical canonical input returns its stored result. Reusing an
ID with changed input is `idempotency_conflict`. A stale policy or binding returns the
current state without applying the command. `outcome_unknown` keeps the original command
identity and never licenses a second model submission.

`PolicySetCommand` governs future events only. It is separate from exact approval of
already-pending events; enabling `auto` never implies releasing the backlog, and this
contract makes no atomic-success claim across the two commands. **`mode: 'auto'` is gated
by G-AUTOMATION.** The contract selects no default mode, and no implementation may accept
`auto` before that gate is decided; the value is decodable only so the wire shape need
not change when the gate opens.

## Releases come only from approvals

A `ReleasedJob` records the approval it came from (`approval.commandId`, plus the policy
version and binding generation that approval was reviewed against). It is an opaque
branded type with exactly two constructors:

- `releaseFromApproval({ approval, items, binding, policyVersion, release })` checks
  every item against the approved selection with `sameEventRef`, in order, and checks the
  binding ID, binding generation, policy version and channel. Any difference is a typed
  rejection (`stale_content`, `stale_binding`, `stale_policy`, `binding_mismatch`,
  `room_mismatch`, `selection_mismatch`), never a partial release.
- `verifyReleasedJob(job, approval)` re-verifies a stored or decoded release against the
  approval the caller holds in its own ledger.

`decodeReleasedJob` returns an `UnverifiedReleasedJob`. `HarnessPort.submit` and
`reconcile` accept only a `ReleasedJob`, so a decoded job or an object literal does not
type-check there.

## Harness evidence is scoped

`HarnessCapabilities` carries the exact harness, harness version, adapter version,
evidence link and configured `DeliveryLimits`. `support: tested` requires evidence. A
protocol extension can describe any harness, but only a named version/evidence pair may
claim tested support.

Version 3 also carries an exact `modes` row for each of `steer`, `sync`, and `async`, plus
an independent `acknowledgement` value. Mode rows refer only to the user's interactive
CLI route: hosted app-server/SDK evidence remains secondary and cannot make those rows
`proven`. `unknown` and `unsupported` always explain why; `proven`, `experimental`, and
`blocked_without_wrapper` pin the tested version, evidence reference, and immutable
evidence revision. Mode support never implies batch acknowledgement.

No capability is a boolean. `existingSession`, `immediateNotification` and
`reconcileByReleaseId` are each `unknown` (not investigated), `unsupported` (investigated
and absent), or a value naming the proven scope:

| Capability | Evidence-scoped value | Meaning |
| --- | --- | --- |
| `existingSession` | `khala_hosted_resume` | A dormant session resumed inside a host Khala started keeps its identity. Attaching to a session another process is running is not covered. |
| `existingSession` | `native_cli_queue` | A harness-native CLI queues into a session Khala did not start. The capability record's evidence scopes the supported harness and version. |
| `existingSession` | `agent_installed_listener` | The agent starts a listener inside its session trust boundary. The route remains unsupported until a capability record cites live proof. |
| `existingSession` | `native_hooks` | The harness's own user-trusted lifecycle hooks pull released batches into a session Khala did not start. `modes` names the boundary each listening mode uses. |
| `immediateNotification` | `khala_hosted_idle` | An idle session in a Khala-started host starts a turn for a queued release without a human prompt. Busy handling is `busy`. |
| `immediateNotification` | `native_cli_queue` | A harness-native CLI accepts a notification without a human prompt. Acceptance does not promise immediate model consumption. |
| `immediateNotification` | `agent_installed_listener` | An agent-installed listener accepts a notification without a human prompt; busy behavior remains a separate fact. |
| `reconcileByReleaseId` | `while_queued` | A submission can be found by release ID only while still queued. Deduplication after consumption belongs to the connector. |

The fixtures distinguish current evidence:

- Codex CLI `0.154.0` is `tested` for `native_cli_queue` as a notification-only
  route into a live or dormant TUI thread. KHA-146 found no stdin payload form and no
  release-ID reconciliation, so released bytes still use the Khala-hosted app-server
  route and reconciliation is `unsupported`.
- `agent_installed_listener` names the generic listener route, but KHA-145 only proved
  its socket frame against a synthetic listener. The fixture is therefore
  `unsupported`; it does not claim live delivery into a Claude session.
- Codex app-server `0.154.0` is `tested` only for a Khala-hosted resumed dormant thread
  using the observed queue route (`khala_hosted_resume`, `khala_hosted_idle`,
  `while_queued`). A Codex executor Khala did not start is `unknown` on every capability.
- Claude Code `2.1.276` is `unsupported` for the no-human-setup product contract,
  including `existingSession`: the experiment resumed an SDK-streaming session, needed a
  permission approval, and did not attach to a running interactive session. The observed
  receipt facts remain evidence even though product support is `unsupported`.
- An unproven harness is `unsupported` with every capability `unknown` and no receipt
  evidence.

`busy` is a capability fact (`queue`, `steer`, `reject` or `unknown`), never a default.
Receipt kinds are observations rather than a sortable progress enum. A transport write
does not prove harness acceptance; harness acceptance does not prove context consumption;
completion does not attest task correctness. A disconnect after possible submission is
`outcome_unknown`, never implicit retry permission. `HarnessPort` deliberately has no
universal cancellation operation.

`Clock` and `EvidenceSink` are shared delivery contracts exported from
`@khala/contracts/delivery/index`. Harness adapters may re-export them for compatibility,
but must not declare adapter-specific copies.

A receipt `errorCode` comes from the closed `RECEIPT_ERROR_CODES` list and never carries
free text. Only `failed` and `outcome_unknown` receipts carry a code, and `failed` always
does. `DeliveryReceiptV1` preserves this original vocabulary. `DeliveryReceiptV2` adds
exactly one paired observation: `kind: 'agent_acknowledged'` if and only if
`source: 'agent'`; it requires a shared, non-secret `evidenceRef` and has no error code.

Existing UI, harness capability, and producer APIs intentionally keep importing the
v1-only `DeliveryReceipt`, `ReceiptKind`, and `decodeDeliveryReceipt` compatibility
names. Durable consumers opt in to `DeliveryReceiptTransport` and
`decodeDeliveryReceiptTransport`, which preserve either explicit version without
promotion or fallback. This package defines no v2 producer.

## Configurable limits

`DeliveryLimits` contains positive safe integers for `maxSelectionEvents` and
`maxPayloadBytes`. Every producer obtains them from configuration or a capability record.
The library exports no default. Decoders fail closed on missing, forged, zero, negative,
fractional or unsafe values.

## Decoding and versioning

Decoders are total: they return `{ ok: false, code, field }` and never echo input.
Decoders reject unknown fields, so the browser, control functions and connector deploy
in lockstep for a given contract version. Every envelope carries `v` (`EventRef`,
`SessionBinding`, `ApprovalCommand`, `PolicySetCommand`, `PolicyAck`, `ReleasedJob`,
`DeliveryReceipt` and `HarnessCapabilities`); incompatible shape or semantic changes
bump its `v`. A bump is a reviewed change on both producer and consumer. `EventRef` and
`SessionBinding` mirror the messaging shapes and bump together with them.

`HarnessCapabilities` is currently v3. Producers always emit v3. Retained v2 values
decode into a conservative v3 view whose interactive mode rows and acknowledgement are
`unknown`; legacy hosted/mechanical evidence is never reinterpreted as primary mode
support. Version 1 remains rejected. Delivery receipts instead expose explicit
`decodeDeliveryReceiptV1` and `decodeDeliveryReceiptV2` decoders plus the
storage/transport union decoder. Each version-specific decoder rejects the other version
and the union fails closed on an unknown or missing discriminator.

## Open product gates

**G-AUTOMATION and G-HARNESSES remain open.** This checkpoint does not select unattended
behavior, backlog behavior, busy handling, model-submission limits, or a universal harness
route. Launch remains blocked, and these contracts may be revised after those product
decisions and proofs are complete.

## Fixtures

`packages/contracts/fixtures/delivery/` follows the messaging layout:

- `exact-release.json` holds the worked values. `releasedJob` is exactly what
  `releaseFromApproval` produces from the worked approval, and `eventRef.contentDigest`
  repeats the KHA-105 digest literally.
- `invalid.json` holds decoder failures and peers: well-formed values that a comparison
  or the release guard must still refuse.
- `views.json` holds port views: the capability routes, receipts, acknowledgements and
  approval results.

Fixture tests run every case through a decoder or guard, and a names test pins the plan
peers. Messaging parity is checked by decoding the messaging worked `binding` and
`eventRef` with the delivery decoders. Fixture limits are examples for conformance tests,
not defaults.
