# Claude harness adapter

`createClaudeHarness({ probe, clock, limits })` from `@khala/harnesses/claude/index`
implements the KHA-106 `HarnessPort`. KHA-133 composes it and supplies the read-only
`ClaudeNativeProbe`.

**Status: fail-closed.** KHA-103 (`docs/evidence/claude.md`) found no Claude route that
meets the no-setup contract. The adapter reports that, and refuses every submission.
It never starts, resumes, restarts or messages Claude, and released bytes never leave
the adapter. A mock-only test pass is component evidence, not a support claim.

## Support row

| Field | Value |
| --- | --- |
| Harness | `claude` (Claude Code) |
| Exact version | `2.1.276` with `@anthropic-ai/claude-agent-sdk` 0.3.276, SDK streaming mode only |
| Support | `unsupported` for the tested version. Every other version is `unsupported`, with each capability `unknown` and no receipt evidence |
| Provider restrictions | Tested on a claude.ai subscription account with `claude-opus-5` only |
| Route | None. The nearest candidate is an agent-armed `Monitor` watch on a connector feed. It needs one human permission approval and expires after 30 minutes, with no reconnect, backlog or dedup. Channels register only at startup (AE2) |
| Required agent setup | Not satisfiable without human configuration |
| Busy behavior | `unknown` in the capability record. One busy run queued the release until the running tool ended |
| Observable receipts | Native: none from this adapter. Evidence recorded the levels write, enqueue (transcript only), dequeue and consumption. The adapter emits only `failed`, sourced from `connector` |
| Reconciliation | `unsupported`. `reconcile` returns `null`, which never licenses a resubmit |
| Cancellation | Not advertised |

## What `submit` checks

These checks run in order. Each returns a content-free `failed` receipt with a
closed error code and a stable ID derived from binding, generation, release and
outcome:

1. The adapter is closed: `harness_unavailable`.
2. The binding was never inspected, or the session is absent or not owned: `session_unavailable`.
3. The binding differs from the one inspected, for example an older generation: `stale_binding`.
4. The payload is over `maxPayloadBytes`: `limit_exceeded`.
5. The payload bytes do not match `job.payloadDigest`: `payload_digest_mismatch`.
6. Otherwise, no route is proven: `harness_unavailable`.

## Unblocking live delivery

Live delivery needs a new proof and a G-HARNESSES decision, not an onboarding step.
The follow-up KHA-103 names is the cross-session inbox with a documented message
format. When a route is proven, add its transport behind the same checks and widen
`capabilities.ts` to the observed evidence only.
