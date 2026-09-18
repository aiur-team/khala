# `@khala/contracts/delivery`

Approval, release, harness-capability and receipt contracts (KHA-106). This is a
default-free contract checkpoint: it defines strict values and ports, but imports no
messaging, policy, connector, SDK or harness implementation.

Import production contracts from `@khala/contracts/delivery/index`. Conformance
consumers may import the explicit fixture-only subpath
`@khala/contracts/delivery/fixtures`. It exports URLs for the literal JSON suites, not
the fixture data in the production module graph. The package-level `./delivery/*`
reservation from KHA-101 provides both subpaths without a root barrel or lockfile change.

## Approval binds exact inputs

An `ApprovalCommand` names one binding generation, one policy version and an ordered,
nonempty selection of immutable `EventRef` values. Selection size comes from a decoded
`DeliveryLimits` capability; there is no protocol default and no silent truncation.
Duplicate event identities and mixed-room selections fail decoding. Reordering events
changes the command input.

`OwnerAuthority` is a trusted composition input. There is deliberately no JSON decoder
for it: a browser body that contains an `ownerId` is not authentication. Implementations
must validate owner/room membership and binding ownership before reading pending
plaintext. `issuedAt` is audit data, not replay protection.

The same command ID with identical canonical input returns its stored result. Reusing an
ID with changed input is `idempotency_conflict`. A stale policy or binding returns the
current state without applying the command. `outcome_unknown` keeps the original command
identity and never licenses a second model submission.

`PolicySetCommand` governs future events only. It is separate from exact approval of
already-pending events; enabling `auto` never implies releasing the backlog, and this
contract makes no atomic-success claim across the two commands.

## Harness evidence is scoped

`HarnessCapabilities` carries the exact harness, harness version, adapter version,
evidence link and configured `DeliveryLimits`. `support: tested` requires evidence. A
protocol extension can describe any harness, but only a named version/evidence pair may
claim tested support.

The fixtures intentionally distinguish current evidence:

- Codex app-server `0.154.0` is `tested` only for a Khala-hosted resumed dormant thread
  using the observed queue route. Attachment to a human-started TUI remains unproven.
- Claude Code `2.1.276` is `unsupported` for the no-human-setup product contract. The
  experiment preserved and promptly notified a resumed SDK-streaming session, but needed
  a permission approval; interactive-session behavior remains unverified. Those observed
  receipt facts remain evidence even though product support is `unsupported`.
- An unproven harness is explicitly `unsupported` with `busy: unknown` and no receipt
  evidence.

`busy` is a capability fact (`queue`, `steer`, `reject` or `unknown`), never a default.
Receipt kinds are observations rather than a sortable progress enum. A transport write
does not prove harness acceptance; harness acceptance does not prove context consumption;
completion does not attest task correctness. A disconnect after possible submission is
`outcome_unknown`, never implicit retry permission. `HarnessPort` deliberately has no
universal cancellation operation.

## Configurable limits

`DeliveryLimits` contains positive safe integers for `maxSelectionEvents` and
`maxPayloadBytes`. Every producer obtains them from configuration or a capability record.
The library exports no default. Decoders fail closed on missing, forged, zero, negative,
fractional or unsafe values.

## Open product gates

**G-AUTOMATION and G-HARNESSES remain open.** This checkpoint does not select unattended
behavior, backlog behavior, busy handling, model-submission limits, or a universal harness
route. Launch remains blocked, and these contracts may be revised after those product
decisions and proofs are complete.

## Fixtures

`packages/contracts/fixtures/delivery/` contains literal accepted/rejected values and
port scenarios. `exact-release.json` repeats the KHA-105 content digest literally and
checks scalar field parity without importing the messaging production subtree. Fixture
limits are examples for conformance tests, not defaults.
