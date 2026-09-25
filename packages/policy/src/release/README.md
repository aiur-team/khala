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
- `binding` and `policyVersion`: the recipient binding as it is now, and the
  connector-**effective** policy version for it. That is the version the connector
  has acknowledged (KHA-120 `applyPolicyAck`), never the requested one.
  Pause and revocation are enforced here only through these values: a pause or
  revoke must advance the effective policy version or the binding generation, or
  replace the binding composition supplies, before this module will refuse.
- `room`: the channel's compatibility-sensitive room ID and its current member participant IDs.
- `pending`: the decrypted pending snapshot. Deleted events are omitted; redacted
  or undecryptable ones are omitted or carry `unavailable` content.
- `release`: releaser-chosen `releaseId`, `payloadRef` and `causalRootId`.

Checks run in this order, and each failure refuses the whole command:

1. Owner matches the binding owner, the command targets the same channel as `room`, and the recipient
   agent is a member (`forbidden`). No pending content is read before these pass.
2. Binding ID and `expectedBindingGeneration` match (`stale_binding`), then the
   policy version (`stale_policy`).
3. The selection is nonempty, belongs to one channel, and is free of duplicate events (`forbidden`).
4. For each selected event, in order: a snapshot record exists (`expired_content`);
   it is the only one and its reference equals the selected reference, including
   author and device (`stale_content`); its author is a member (`forbidden`); its
   content is available (`expired_content`); its body is version 1 text
   (`stale_content`) whose KHA-105 digest equals `contentDigest` (`stale_content`).
5. `payloadRef` is a token of `[A-Za-z0-9._-]` starting alphanumeric
   (`unavailable`). It has no scheme, separator, query or whitespace, so it cannot
   be a URL or multi-segment path. A bare name such as `payload.bin` still passes,
   so consumers must resolve it only as a ledger key, never against a filesystem.

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
fields that `sameApprovalCommandInput` compares: `v`, command, room and binding
IDs, the expected policy version and binding generation, `issuedAt`, and every
selected reference in command order, including its content digest. A retry that
is re-dated or reorders the selection therefore conflicts. It
reads no current state and no releaser-chosen identifiers. The journal can
therefore compute it for a retry before evaluating, even after the binding or
policy has changed.

The journal owns idempotency, not this module:

- Same command ID, same fingerprint: return the committed result without
  re-evaluating against later state.
- Same command ID, different fingerprint: `idempotency_conflict`.
- Ambiguous commit: `outcome_unknown` with the operation ID, never a plain
  retryable rejection and never a second release.

## After evaluation

Validation happens before commit, and the binding or policy can still change after
evaluation. Pure evaluation cannot make that a distributed transaction or promise
exactly-once harness delivery, so consumers must hold two rules:

- `decision.job` must not be dispatched, and no notification sent, before the
  KHA-134 journal commit.
- At dispatch, KHA-121 compares `job.binding` with the current binding using
  `sameSessionBinding`, and `job.policyVersion` with the current effective policy
  version. It refuses on any difference.

`verifyReleasedJob` does not do this. It only checks a job's recorded values
against its recorded approval, so it cannot detect a rebind or policy change
after evaluation.
