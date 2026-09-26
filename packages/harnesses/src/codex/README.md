# Codex harness adapter (KHA-118, KHA-150)

## Interactive hook route (E09 `interactive-codex`)

`interactiveCodexCapabilities(version, limits, review)` in `interactive.ts` declares
delivery into the user's own Codex TUI through the native hooks that
`setup-cli-codex` installs (`khala codex-hook`, see `packages/agent-cli/README.md`).
Khala never starts, hosts or signals Codex on this route. The claim is `tested`,
with `existingSession: native_hooks` and every mode `proven`, only when both of these hold:

- the exact version is in `CODEX_INTERACTIVE_VERSIONS` (`0.154.0`, `0.156.1`), the
  versions whose TUI passed every cell under normal trust settings in
  [`interactive-codex.md`](../../../../docs/product/internal-mode/interactive-codex.md#mode-matrix);
- the user has trusted every installed Khala hook in Codex's **Hooks need review**
  dialog.

Otherwise every mode is `unknown`, with the review or version reason. `async` is
additionally `unknown` until the receipt proof below is supplied, because it needs a
returned batch token (`listeningModeView` refuses it while acknowledgement is `unknown`).
The offline proof is derived from the real `khala codex-hook`, the shared inbox and the
next-call token echo in `packages/agent-cli/src/codex/receipt-proof.test.ts`; the live
Codex run stays with the Executor (decision 43).

`acknowledgement` is `batch_token_next_call` only when a `CodexReceiptProof` from
`assessCodexReceiptConformance` (`receipt-conformance.ts`) is passed for that exact
version and the `hook` route. The proof requires a user-started CLI run (a hosted
app-server pass is secondary and never counts), the shared journal/inbox, a delivered
batch, an authenticated binding, the token returned on the next Khala call, a correlated
receipt and CLI/MCP contention that serializes or fails closed. Without it, or when any
step is missing, the value stays `unknown`: queue acceptance, `item/started`, context
insertion and the batch response never establish it, and no later call stays neutral.
Evidence holds booleans and labels only, never token bytes. `steer`
means the next tool boundary, and hard abort is disabled. `immediateNotification`
is `native_cli_queue` only while the idle wake works (`createCodexIdleWake`): for an
idle `steer` or `sync` session it runs `codex queue --thread <sessionId> --message
<constant notice>`, so the same TUI starts a turn and its `UserPromptSubmit` hook does
the shared pull. The argv holds no body, token or peer name; concurrent wakes for one
binding coalesce, `async` is never woken, and no wake starts or continues once Stop
revokes the binding. For an unsupported version or a failed queue command the
capability stays `unknown` and idle agents receive messages only at their next turn;
there is no fallback that launches Codex or types into a screen.

The routes below are the earlier Khala-hosted and notification-only adapters.

`createCodexHarness(deps): HarnessPort` from `@khala/harnesses/codex/index`. It
selects one evidence-backed route during `inspect` and imports the KHA-106 contracts
from `@khala/contracts/delivery/index`.

## Support row

| Field | Value |
| --- | --- |
| Harness | `codex` (codex-cli) |
| Exact version | `0.154.0`, Linux x64. Any other version is reported `unsupported` until it has its own proof run; semver does not promote it. |
| Provider restrictions | None observed. The proof used the fixture's own model, which was left unchanged. |
| Route A: native CLI | For a thread Khala did not start, approved bytes are appended to the KHA-148 local inbox and `codex queue --thread <sessionId> --message <opaque release notification>` wakes the existing thread. [KHA-146](../../../../docs/evidence/codex-native-cli.md#queue-idle) proved the notification route. `--message -` and `@-` are literals, so payload bytes never go to the CLI. |
| Route B: hosted app-server | Khala starts `codex app-server --listen unix://<owner-only dir>/…sock` in the thread's workdir and resumes a dormant thread there (`thread/resume`, no overrides). Delivery calls `thread/queue/add` with `clientUserMessageId = releaseId`. The thread's native `cwd` must equal the host's workdir. [KHA-104](../../../../docs/evidence/codex.md) proves this route. |
| Selection | A matching entry in the Khala host registry selects route B. Otherwise an exact-version Linux x64 native inspection may select route A. A positive decision is held for that immutable binding generation; unsupported and failed inspections are re-probed. `submit` never switches routes. |
| Required agent setup | Route A uses the local `khala listen` inbox installed by KHA-148. Route B needs no human setup; the host starts the app-server and resumes the thread. |
| Busy behaviour | `queue`. Delivery waits for the running turn, then runs as a new turn. `turn/steer` is unproven and never called. |
| Observable receipts | Route A: `harness_queued`, `outcome_unknown`, `failed`. Route B: `transport_written`, `harness_queued`, `context_consumed`, `completed`, `outcome_unknown`, `failed`; consumption and completion come only from the receipt tracker's live notifications. |
| Reconciliation | Route A is `unsupported`: the CLI exposes no queryable release ID, so `null` never authorizes a resend. Route B is `while_queued` through `thread/queue/list`. |
| Cancellation | Not advertised. |

## Ports

The adapter imports no socket, SDK or storage implementation. Composition supplies:

- `client: CodexClientPort`, which opens an initialized WebSocket JSON-RPC connection on
  the host's Unix listener. `request` never throws. It reports `not_sent` only when no
  byte reached the transport, and `lost` (with `written`) otherwise. Only
  `thread/read`, `thread/queue/list` and `thread/queue/add` are typed.
  `thread/resume`, `turn/start`, `turn/steer` and `thread/queue/delete` are not.
- `hosts: CodexHostPort`, the registry of executors Khala started. Each entry records the
  binding generation it serves, its endpoint, whether the endpoint is owner-only, the
  absolute workdir it started the executor in, its `codex --version`, and whether its
  executor holds the thread's writer lock now. The adapter trusts that lock report; the
  only native ownership signal it checks is a `notLoaded` thread.
- Route A additionally takes `nativeCli: CodexNativeCliPort` and
  `nativeInbox: CodexNativeInboxPort` together. The CLI port reports installed version,
  platform, architecture, session presence and the binding generation consumed by
  `khala listen`, then runs adapter-owned argv. A binding mismatch fails closed before
  the inbox is written. The CLI runner must spawn without a shell, pass no
  message-bearing environment variables, keep child stderr out of receipts and logs,
  and terminate the child when the adapter deadline or an external abort is reached;
  `withDeadline` only races the returned promise. The inbox port accepts the exact
  KHA-148 delivery shape. Supplying only one is a type error. When these native ports
  are supplied, `submit` before a successful `inspect` fails closed.
- `codec: ReleaseCodecPort`, the KHA-119 envelope codec. It checks the payload digest
  and the approved event references before anything is sent.
- `clock`, and `evidence: EvidenceSink` (KHA-115) for intermediate observations.
- `limits`, the configured `DeliveryLimits`. There is no default.
- `deadlines: { callMs, closeMs }`. `callMs` bounds every port call: lookup, connect,
  each request, the codec, the sink and a connection close. `closeMs` bounds how long
  `close()` waits for in-flight work. There is no default. An overdue `queue/add` is
  `outcome_unknown` (`timeout`), and no write is recorded.

`createCodexReceiptTracker(binding, clock)` maps notifications from a connection on the
same listener to receipts. Duplicate and out-of-order events yield each receipt once.

## Behaviour that must not be weakened

- **At most one `queue/add` per release per process.** KHA-104 showed that
  `clientUserMessageId` does not deduplicate and that a replayed entry is executed a
  second time. Before adding, the adapter looks the release up in the thread's queue. If
  it is still queued, `harness_queued` is returned and nothing is sent. If the queue
  cannot be read completely, the submit is refused. Concurrent submits of one release
  share one dispatch. A release whose `queue/add` may have reached the listener is never
  added again by the same process; a later submit reports `outcome_unknown`.
- **At most one native notification per release per process.** Route A appends the
  payload before spawning the CLI. A duplicate or uncertain inbox append, non-zero
  process exit, timeout, disconnect or malformed success is `outcome_unknown`; none is
  retried by the adapter. Composition spawns the CLI without a shell or message-bearing
  environment variables, never copies its stderr into receipts or logs, and terminates
  it at the adapter deadline or on abort rather than relying on `withDeadline` to stop
  the child.
- **Deduplication after consumption belongs to the connector (KHA-121).** A consumed
  release has left the queue, and the adapter does not read history, so after a restart
  it cannot tell a consumed release from one never sent. The durable claim must stop that
  submit; the adapter's checks back it up and do not replace it.
- **A lost reply is `outcome_unknown`.** So is a malformed or uncorrelated reply, a port
  that throws mid-request, and a native error reply to `queue/add` (`harness_rejected`):
  KHA-104 observed no such error, so it is not proof that nothing was queued.
  `reconcile` returning `null` means nothing was observed. It never authorizes another
  submit.
- **Only the released bytes are sent.** They must hash to the job's `payloadDigest`,
  pass the codec, and be valid UTF-8 text within the limits.
  Nothing is prepended. Route A copies them into the local inbox and puts only the
  release ID in `argv`; route B puts them only in the request body. Payload bytes never
  appear in process arguments, receipts, endpoints, errors or logs.
- **The durable native queue.** An entry still queued when the host exits is consumed
  by whichever executor loads the thread next. The host owner (KHA-133) must drain or
  delete its own pending entries before releasing an executor. It must also treat a
  change of writer-lock holder as a new executor.

## Evidence status

The tests run route B against `FakeAppServer` and route A against fake CLI and durable
inbox ports. Both routes pass the neutral conformance suite. These are component tests;
the support claims come from the KHA-104 and KHA-146 live evidence linked above, not
from the fakes.
