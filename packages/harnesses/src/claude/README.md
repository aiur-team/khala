# Claude harness adapter

`createClaudeHarness({ probe, route, clock, limits })` from `@khala/harnesses/claude/index`
implements the KHA-106 `HarnessPort`. KHA-133 composes it and supplies the read-only
`ClaudeNativeProbe`. The injected `ClaudeNativeRoutePort` is the only delivery seam;
neither rejected native candidate is hard-coded into the adapter.

**Status: fail-closed.** KHA-145 (`docs/evidence/claude-native-cli.md`) did not prove a
native existing-session route. The agent-child socket candidate could not be exercised
live, while the hosted stream candidate was not resumable after interruption. The
adapter reports that result and refuses every submission without calling the route
port. It never starts, resumes, restarts or messages Claude, and released bytes never
leave the adapter. A mock-only test pass is component evidence, not a support claim.

## Support row

| Field | Value |
| --- | --- |
| Harness | `claude` (Claude Code) |
| Exact version | Claude Code `2.1.276` |
| Support | `unsupported` for the tested version. Every other version is `unsupported`, with each native capability `unknown`; only connector-side refusal/uncertainty receipt kinds are advertised |
| Provider restrictions | The proof used one disposable local Claude Code session; it makes no account-wide or minimum-version claim |
| Route | None. The child messaging-socket candidate was not live-proven. The hosted stream delivered only while its process was alive and failed the disconnect/resume requirement |
| Required agent setup | Use the generic agent-installed fallback; native delivery is unavailable |
| Busy behavior | `unknown`. The hosted-stream probe accepted a write during a tool call, but that rejected candidate does not establish native-route behavior |
| Observable receipts | Native: none. The adapter emits content-free connector-side `failed` receipts; it never claims native acceptance or consumption |
| Reconciliation | `unsupported`. `reconcile` returns `null`, which never licenses a resubmit |
| Cancellation | Not advertised |

## What `submit` checks

These checks run in order. Each returns a content-free `failed` receipt with a
closed error code and a stable ID derived from binding, generation, release and
outcome:

1. The adapter is closed: `failed` with `harness_unavailable`, because this adapter
   never dispatches and closure is therefore a certain pre-send refusal. An existing
   in-process submission for the same release is still joined before this check.
2. The binding was never inspected, or the session is absent or not owned: `session_unavailable`.
3. The binding differs from the one inspected, for example an older generation: `stale_binding`.
4. The payload is over `maxPayloadBytes`: `limit_exceeded`.
5. The payload bytes do not match `job.payloadDigest`: `payload_digest_mismatch`.
6. Otherwise, no route is proven: `harness_unavailable`, without invoking the injected
   route port.

## Unblocking live delivery

Live native delivery needs a new proof and a G-HARNESSES decision. Until then, KHA-151's
generic agent-installed listener is the fallback. When a Claude route is proven, bind it
to `ClaudeNativeRoutePort` behind the same checks and widen `capabilities.ts` only to the
observed evidence.
