# `@khala/policy/release`

Exact approval release (KHA-119). A pure module: it decides whether one owner
approval releases exactly the selected immutable events to one existing session
generation. It reads no SDK, history or storage and imports only the KHA-106
delivery contract. KHA-134 commits the decision in the KHA-115 ledger; KHA-121
dispatches the payload.

Import from `@khala/policy/release/index`.

## `evaluateApproval(input)`

Trusted composition supplies every input:

- `authority`: a verified `OwnerAuthority`. A browser body is never authority, and
  a user-supplied `human: true` grants nothing.
- `command`: the decoded `ApprovalCommand`.
- `binding` and `policyVersion`: the recipient binding and effective policy as they
  are now.
- `room`: the room ID and its current member participant IDs.
- `pending`: the decrypted pending snapshot. Deleted events are omitted; redacted
  or undecryptable ones are omitted or carry `unavailable` content.
- `release`: releaser-chosen `releaseId`, `payloadRef` and `causalRootId`.

Checks run in this order, and each failure refuses the whole command:

1. Owner matches the binding owner, the command room is the room, and the recipient
   agent is a member (`forbidden`). No pending content is read before these pass.
2. Binding ID and `expectedBindingGeneration` match (`stale_binding`), then the
   policy version (`stale_policy`).
3. The selection is nonempty, single-room and free of duplicate events (`forbidden`).
4. For each selected event, in order: exactly one snapshot record exists and its
   content is available (`expired_content`); its reference equals the selected reference, including
   author and device (`stale_content`); its author is a member (`forbidden`); its
   body is version 1 text whose KHA-105 digest equals `contentDigest`
   (`stale_content`).
5. `payloadRef` is an opaque token of `[A-Za-z0-9._-]` starting alphanumeric, so it
   cannot be a URL, path or query (`unavailable`).

`command.issuedAt` is audit data and is never consulted. Unselected records,
including later arrivals, are never read or released. An edit is a new digest and
needs a new approval. Malformed trusted input returns `unavailable`/`invalid_input`
instead of throwing. `release.causalRootId` is shape-checked only: it is provenance
chosen by KHA-134 and need not be a selected event.

A rejection is `{ ok: false, code, reason, field }`: `code` is the `ApprovalResult`
code, `reason` a finer audit reason and `field` a location. None carries message
text, so rejections are safe to log.

A success is `{ ok: true, decision }` with `commandId`, `releaseId`, `fingerprint`,
the verified `ReleasedJob` (built by the contract's `releaseFromApproval`) and
`payload`, the canonical release bytes. `payload` contains plaintext: keep it in
the connector-local ledger and never log or trace it.

## Release bytes

`encodeReleasePayload` produces UTF-8 of the compact positional JSON array:

```text
["khala.release.v1",releaseId,bindingId,generation,policyVersion,
 [[roomId,eventId,authorParticipantId,authorDeviceId,contentDigest,body],...]]
```

Selection order is kept; bodies are never Unicode- or newline-normalised; string
escaping is exactly `JSON.stringify`, as in the KHA-105 message encoding. Integers
are safe and nonnegative. `job.payloadDigest` is `sha256:` plus lowercase hex over
these bytes, via Web Crypto. `codec.test.ts` pins the plan's literal fixture
(230 bytes, `sha256:99014d34…c243`).

## Retry handoff to KHA-134

`decision.fingerprint` is `decisionFingerprint(command)`. It digests exactly the
command input that `sameApprovalCommandInput` compares: `issuedAt`, the expected
binding generation and policy version, and every selected content digest. It
reads no current state and no releaser-chosen identifiers. The journal can
therefore compute it for a retry before evaluating, even after the binding or
policy has changed.

The journal owns idempotency, not this module:

- Same command ID, same fingerprint: return the committed result without
  re-evaluating against later state.
- Same command ID, different fingerprint: `idempotency_conflict`.
- Ambiguous commit: `outcome_unknown` with the operation ID, never a plain
  retryable rejection and never a second release.

Validation happens before commit. The binding can still change after evaluation,
so KHA-106/121 re-check the binding generation at ledger claim and dispatch
(`verifyReleasedJob`). Pure evaluation cannot make that a distributed transaction
or promise exactly-once harness delivery.
