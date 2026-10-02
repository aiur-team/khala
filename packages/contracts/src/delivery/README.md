# `@khala/contracts/delivery`

The retained delivery domain provides receipt shapes for the web receipt-evidence
feature and acknowledgement vocabulary for channel presence. Import from
`@khala/contracts/delivery/index` or the `./delivery/*` subpath.

The remaining modules are `decode`, `ids`, `receipts` and `listening-mode`.
They contain data, strict decoders and interfaces, with no SDK, storage or
messaging-domain imports. Scalar brands remain independently declared and
structurally compatible with messaging identifiers.

## Receipt observations

Receipt kinds are observations rather than a sortable progress enum. A transport
write does not prove harness acceptance; harness acceptance does not prove context
consumption; completion does not attest task correctness. A disconnect after possible
submission is `outcome_unknown`, never implicit retry permission.

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

## Listening and acknowledgement vocabulary

`AcknowledgementSupport` distinguishes `unknown`, `unsupported` and
`batch_token_next_call`. Listening-mode support is recorded independently for
`steer`, `sync` and `async`; an evidenced route does not imply acknowledgement.
Mode, route-grant and listening-state decoders retain their existing strict shapes.

## Decoding and fixtures

Decoders return `{ ok: false, code, field }` for invalid input and reject unknown
fields. Identifier values remain nonempty, control-free and capped at 512 UTF-8
bytes. `decodeDeliveryLimits` requires positive safe configured limits and supplies
no defaults.

`fixtures/delivery/exact-release.json` retains its receipt worked values;
`invalid.json` and `views.json` retain receipt cases only. Fixtures are test-only
and are never exported. Conformance tests preserve explicit envelope versions
without promotion or fallback.
