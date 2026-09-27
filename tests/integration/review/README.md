# Review delivery evidence (KHA-134)

KHA-134 wires a human's exact approval to the connector's release ledger and the
bounded dispatcher. This file records what is proven today and what is still
missing before a live run could count as acceptance.

## Proven locally

These tests run in the normal package suites (`pnpm --filter @khala/connector-app test`,
`pnpm --filter @khala/web test`). They use real parts wherever the repository has them:
the on-disk KHA-115 SQLite ledger, the KHA-119 release policy, the KHA-121 dispatcher
and this ticket's handler and registrations. Only the protected transport and the
harness are scripted. The scripted harness records every byte that would have entered
the agent's session.

| Claim | Test |
| --- | --- |
| Queue A and B, approve only B: the session receives B with its author attribution, and A never reaches the session | `apps/connector/src/composition/review/release-flow.test.ts` |
| A duplicate browser command plus a connector restart deliver B once and never leak A | `release-flow.test.ts` |
| A crash after the ledger commit but before the dispatcher handoff resumes the same release once, by its durable ID | `release-flow.test.ts`, `control-handler.test.ts` |
| A crash after the harness write leaves `outcome_unknown` and never submits again (AE1) | `release-flow.test.ts` |
| An ambiguous commit answers `outcome_unknown` with the command ID, and a retry resolves from the journal (AE2) | `control-handler.test.ts` |
| Wrong owner, stale generation, stale policy, edited content, duplicate selection, unknown binding and revocation all refuse before anything is enqueued | `control-handler.test.ts` |
| The same command ID with the same input replays its release IDs; with changed input it is `idempotency_conflict` | `control-handler.test.ts` |
| Owner fields or `human: true` in a request body grant nothing; preview answers another owner exactly like an unknown binding | `control-handler.test.ts` |
| The capability handle exposes no approval entry point. The handler is served only on the protected transport, overlapping starts serve it once, and a stop during recovery keeps it closed | `register.test.ts` |
| A dispatcher that misses the handoff once gets the release again without a restart. A dispatcher conflict is reported, not counted as delivered | `control-handler.test.ts` |
| A committed command that cannot be read back answers `outcome_unknown`, never a definite refusal. A journalled command replays even while policy and membership reads are down | `control-handler.test.ts` |
| The browser sends exact references only, never bodies or owner identity. It shows only digest-exact pending items, drops late old-generation answers, and clears the preview on revocation | `apps/web/src/composition/review/browser-port.test.ts` |
| Approval JSON inside a message body stays inert; closing a browser wait does not cancel the write or change its command ID | `browser-port.test.ts` |

## Production path and remaining proof

The signed-in room fetches owner-scoped active bindings through
`GET /api/human/owner-mailbox/review-bindings`, mounts `ReviewScreen`, and keeps
message bodies inside the browser's room port. The browser registers its current
Matrix device through the protected owner proof routes, then verifies the
connector's server-attested device fingerprint in the SDK and discards its old
outbound session. Review stays unavailable until that trust step succeeds;
previous history is never re-encrypted for the new device. Its client submits only exact
references through the CSRF-protected owner mailbox. The mailbox authenticates
the human, derives authority, and forwards metadata to the connector's real
review handler, ledger and bounded dispatcher. The browser stores an unresolved
command's metadata in session storage and reconciles through the result route
without resubmitting after an unknown write. A response from another command
cannot become success. `review-room.browser.spec.ts` exercises the mounted room,
selection and approval action in Chromium; route and client tests cover their
respective authenticated seams.

These local tests still do not demonstrate a hosted four-actor run. #134 must
repeat selected-only delivery against a deployed protected route, real Matrix
devices, and an already-running supported harness session. A harness queue
receipt alone does not prove that the model consumed the content. The result
must preserve that distinction, and no skipped or fixture-backed live spec may
be reported as acceptance.

## Known limitation

The KHA-115 ledger has no "is this event released" read, and `readApprovalSnapshot`
still returns a released event. A released item therefore stays in the preview until
retention (KHA-130) removes it. Approving it again is refused (`stale_content`), so
nothing is delivered twice. This only affects presentation.

Definite refusals are not journalled, only committed releases. A command ID that
was refused (for example `stale_policy`) can succeed if it is retried after the
state that refused it changes. The browser always mints a new command ID for a new
selection, and every success is still journalled once.

## Live run, once the prerequisites exist

Follow `tests/integration/human/README.md`: disposable identities, a disposable
deployment and an already-running harness session, with synthetic canaries A and B:

```sh
KHALA_E2E_LIVE=1 \
KHALA_E2E_DISPOSABLE_ENV=/absolute/path/to/khala-live.json \
pnpm test:integration tests/integration/review
```

Evidence must not include passwords, access tokens, OAuth cookies, invitation
secrets, or canary bodies. The boundary does not protect against an agent with
unrestricted access to its connector host: that agent can read the ledger, pending
plaintext included (see `packages/connector/src/storage/README.md`).
