# Claude native agent-route proof

KHA-145 feasibility evidence for the route an agent-installed Khala client should use with Claude Code. The
probe is under `experiments/claude-native/`.

**Conclusion: neither candidate qualifies as a native existing-session route.** Route A could not start its child
under the non-interactive permission policy. Route B delivered and acknowledged messages while its hosted process
was alive, including a release written during a tool call, but an interrupted process was not resumable and its
pending release had no acknowledgement. Downstream native capability records must remain `unsupported`; KHA-149
may cite this document as rejection evidence, not as evidence for `support: "tested"`.

Recorded on 2026-09-18 on host `orangekid`, Linux 7.1.4-arch1-1 x86_64, with Node 24.18.0 and npm 11.16.0.
Tested CLI: Claude Code 2.1.276 from `~/.local/share/claude/versions/2.1.276`. This is not a minimum-version claim.
TypeScript is 5.9.3 and `@types/node` is 24.10.1. Exact help/version hashes and the installed-binary frame template
are in `experiments/claude-native/evidence/inventory.json`; sanitized live observations are in
`experiments/claude-native/evidence/live-proof.json`. The isolated lock SHA-256 is
`957e0b7b25e94d2d01a85c2af869bdf08d3bf417b9f0ff5b1f9e315e651721e1`.

## Target and consent

The Executor authorized one fresh disposable session. The managed sandbox could not write the prepared
`~/.cache/khala-disposable/claude-native-target`, so the explicitly authorized fallback was used:
`/home/everdred/.aiur/workspaces/aiur-team/khala/101/.khala-disposable/claude-native-target`. Its UUID was
`118f6a23-92a8-4f67-824c-58e012149e88`. No existing or non-disposable session was attached or messaged.

The first hosted process used `--session-id`; the later process used `--resume` only against that exact UUID and
workdir. The child-socket command was never executed: the session's permission system denied it before launch, so
`DESIGNATED_TARGETS` intentionally remains empty and no registry or messaging socket was opened by the probe.

## Route table

| Route | Installed surface (2.1.276) | Offline result | Live result |
| --- | --- | --- | --- |
| A: agent-started child posts to `CLAUDE_CODE_MESSAGING_SOCKET` | Binary debug template accepts an auth JSON line using `CLAUDE_CODE_MESSAGING_TOKEN`, followed by a user-message JSON line. | Exact frame, one-write behavior, target/registry/ancestry binding, secret redaction and wrong-session refusal pass against a synthetic Unix socket. | **Does not qualify.** The child inspection/launch command required approval and `--permission-prompts none` denied it automatically. There was no live socket, token, acceptance, delivery or consumption observation. |
| B: Khala-hosted streaming session | `claude -p --session-id <uuid> ... --replay-user-messages --permission-prompts none --verbose`; the harness also pins the equivalent `--resume` form. | Stream JSON and receipt classifiers are pinned. | **Useful only while alive; does not qualify as an existing-session route.** Idle and busy writes were replayed and consumed. Duplicates were consumed twice. A pending write at forced disconnect was unacknowledged, and `--resume` then returned `No conversation found with session ID`. |

**Recommendation: neither qualifies.** Route A misses the zero-approval bar and was not live-proven. Route B does
not deliver into an unchanged pre-existing working session, is absent from `claude agents --json`, and did not
survive the required disconnect/resume case. KHA-149 should remain fail-closed and route Claude through the generic
agent-installed fallback owned by KHA-151.

## Receipt levels

The proof treats these as distinct facts:

1. **Transport written:** the complete JSONL frame reached the local socket or hosted process stdin write callback.
2. **User replayed:** Route B re-emitted the stdin user message because `--replay-user-messages` was enabled.
3. **Harness queued or delivered:** Route B exposed `queued_turn_count: 1` for a second input, but this is not a durable queue receipt.
4. **Context consumed:** assistant output contains the one-run nonce.
5. **Completed:** a terminal `result` event follows consumption.

A write callback is not queue acceptance. A replayed user message is not model consumption. If a connection drops
after level 1 without a stronger receipt, the result is `outcome_unknown` and the probe does not resend.

## Setup inventory

| Action | Actor | Evidence/status |
| --- | --- | --- |
| Install/start the Khala child | agent | Attempted once. The command required approval and was denied automatically before execution. |
| Approve a Bash/tool prompt | human | Zero approvals. A safe `sleep` ran; the child inspection command was denied because the hosted session had no approval surface. |
| Authenticate to Route A socket | child process | Not reached. No token was printed or persisted. |
| Start Route B | Khala host | Succeeded with the fixed streaming args and no human approval. |
| Change `crossSessionInbound` | nobody | Not changed. `accept`, `hold`, and `refuse` were not tested because Route A never opened. |

## Failure, duplicate and exit behavior

- **Idle:** `IDLE-NONCE-7F3A` was written, replayed, echoed by the assistant and followed by a successful result. The stronger earlier-process private-marker criterion was not verified.
- **Busy:** while `Bash sleep 12` was running, a second release was written. It was replayed, queued, and consumed after the tool completed; the assistant returned both nonces.
- **Disconnect:** during `Bash sleep 20`, a pending release was written to stdin and the process was interrupted before its replay event. The only honest receipt is `outcome_unknown`; no resend was attempted.
- **Backlog/reconnect:** restarting with `--resume` against the same UUID returned `No conversation found with session ID`. The pending release was not delivered and nothing reconnected automatically.
- **Duplicate:** two identical inputs produced two replay events and two completed results. There is no harness deduplication.
- **Permission:** zero human approvals. A safe sleep was allowed, while the child-inspection command was denied automatically and never executed.
- **Negative token:** no live Route A socket existed, so a real wrong-token exchange was not possible. Offline tests reject malformed tokens and a registry/session mismatch before connection. This remains explicitly unverified live.

`claude agents --json` ran without a TTY but did not enumerate the hosted target, and no matching
`~/.claude/sessions/<pid>.json` entry existed. Consequently the live `status` field could not be used to distinguish
idle from busy for Route B.

## Validation

```sh
npm --prefix experiments/claude-native ci
npm --prefix experiments/claude-native test
npm --prefix experiments/claude-native run typecheck
npm --prefix experiments/claude-native run probe -- --help
npm --prefix experiments/claude-native run probe -- --inventory
```

The offline suite contains sixteen passing tests. The first behavior test was observed failing before `probe.ts`
existed (`ERR_MODULE_NOT_FOUND`), then passed after the socket implementation was added. The suite uses only
synthetic Unix sockets and registries. The live run used only the disposable UUID above.

## Handoff

- **KHA-147:** the contract may still add route vocabulary for other proofs, but this evidence does not justify a tested Claude native-route member.
- **KHA-149:** retain fail-closed native support and point operators to the KHA-151 fallback. Do not describe Route B's live-process-only behavior as `khala_hosted_resume` support.
