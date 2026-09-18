# Claude native agent-route proof

KHA-145 feasibility evidence for the route an agent-installed Khala client should use with Claude Code. The
probe is under `experiments/claude-native/`.

**Conclusion: live proof pending; no route is claimed supported.** Offline validation establishes a fail-closed
designated-target boundary and reproduces the installed binary's child-socket frame. It also pins the documented
hosted streaming flags and receipt classifiers. The canonical proof still requires an explicitly designated
disposable session and live idle, busy, disconnect, backlog, duplicate, permission, and wrong-token cases. Until
those run, downstream capability records must remain `unsupported` or `unknown` and must not cite this document
as tested-route evidence.

Recorded offline on 2026-09-18 on host `orangekid`, Linux 7.1.4-arch1-1 x86_64, with Node 24.18.0 and npm 11.16.0. Tested CLI:
Claude Code 2.1.276 from `~/.local/share/claude/versions/2.1.276`. This is not a minimum-version claim.
TypeScript is 5.9.3 and `@types/node` is 24.10.1. Exact help/version hashes and the installed-binary frame template
are in `experiments/claude-native/evidence/inventory.json`. The isolated lock SHA-256 is
`957e0b7b25e94d2d01a85c2af869bdf08d3bf417b9f0ff5b1f9e315e651721e1`.

## Target and consent

No live target has been opened or messaged. The operator must choose either a fresh isolated target under
`~/.cache/khala-disposable/claude-native-target` or provide a disposable session UUID, absolute workdir, and
Claude process PID. The exact tuple is then compiled into `DESIGNATED_TARGETS` before a live command can read its
single registry record or connect to its socket.

The socket path is also matched against the child's inherited environment, and the designated Claude PID must be
an ancestor of the sending process. A session token from any other registry is refused before connection.

## Route table

| Route | Installed surface (2.1.276) | Offline result | Live result |
| --- | --- | --- | --- |
| A: agent-started child posts to `CLAUDE_CODE_MESSAGING_SOCKET` | Binary debug template accepts an auth JSON line using `CLAUDE_CODE_MESSAGING_TOKEN`, followed by a user-message JSON line. The registry carries the session ID, cwd and socket. | Exact frame, one-write behavior, target/registry/ancestry binding, secret redaction and wrong-session refusal pass against a synthetic Unix socket. | Pending. No claim yet about permission prompts, `crossSessionInbound`, idle/busy delivery, response bytes, queueing or consumption. |
| B: Khala-hosted streaming resume | `claude -p --resume <uuid> --input-format stream-json --output-format stream-json --replay-user-messages --include-hook-events --permission-prompts none` | CLI args and stream JSON are pinned; output classifiers keep replay acknowledgement, hooks, consumption and completion separate. | Pending. No claim yet about mid-run input, busy behavior, reconnect, backlog or duplicates. |

**Current recommendation: neither qualifies until the designated live proof runs.** Route A remains preferred if
it delivers into the unchanged working session without a human permission prompt and exposes an adequate receipt.
Otherwise route B is the candidate floor, but it must first prove mid-run input and correlatable acknowledgement.

## Receipt levels

The probe treats these as distinct facts:

1. **Transport written:** the complete JSONL frame reached the local socket or hosted process stdin write callback.
2. **User replayed:** Route B re-emitted the stdin user message because `--replay-user-messages` was enabled.
3. **Harness queued or delivered:** only a native response/event that says so can establish this level; none is assumed.
4. **Context consumed:** assistant output contains the one-run nonce and a private marker seeded in earlier context.
5. **Completed:** a terminal `result` event follows consumption.

A write callback is not queue acceptance. A replayed user message is not model consumption. If a connection drops
after level 1 without a stronger receipt, the result is `outcome_unknown` and the probe does not resend.

## Setup inventory

| Action | Actor | Evidence/status |
| --- | --- | --- |
| Install/start the Khala child | agent | Live case pending; command and exact target are stdin-bound. |
| Approve a Bash/tool prompt | human | Must be counted in default permission mode; zero is the R01 bar. |
| Authenticate to Route A socket | child process | Inherited token; never printed or persisted by the probe. |
| Start Route B | Khala host | Fixed streaming args; permission prompts are answered by nobody. |
| Change `crossSessionInbound` | nobody | The live matrix must observe `accept`, `hold`, and `refuse`; the probe must not change user settings silently. |

## Failure, duplicate and exit behavior

Live results pending. The required cases are:

- **Idle:** one released nonce reaches the same session and recalls a marker seeded in an earlier process.
- **Busy:** write during a controlled tool call; record interrupt, queue, drop, and consumption latency.
- **Disconnect:** terminate the listener immediately after write; record the receipt boundary and never auto-retry.
- **Backlog:** release while no listener runs, then start it; record lost, once, or duplicate delivery.
- **Duplicate:** submit the same release twice; assume no harness deduplication unless observed.
- **Permission:** count every human approval under default mode.
- **Negative token:** a token/socket bound to another session is refused.

## Offline validation

```sh
npm --prefix experiments/claude-native ci
npm --prefix experiments/claude-native test
npm --prefix experiments/claude-native run typecheck
npm --prefix experiments/claude-native run probe -- --help
npm --prefix experiments/claude-native run probe -- --inventory
```

The current offline suite contains nine passing tests. The first behavior test was observed failing before
`probe.ts` existed (`ERR_MODULE_NOT_FOUND`), then passed after the socket implementation was added. No live model
or unrelated session is touched by the suite.

## Handoff

- **KHA-147:** do not add a tested Claude native-route enum member from this checkpoint; await the final live recommendation.
- **KHA-149:** Route A may be pinned only if the live proof meets the zero-human-approval bar and records its receipt boundary. Otherwise evaluate the proven Route B result; if neither qualifies, retain fail-closed support.
