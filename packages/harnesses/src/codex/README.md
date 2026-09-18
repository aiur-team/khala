# Codex harness adapter (KHA-118)

`createCodexHarness(deps): HarnessPort` from `@khala/harnesses/codex/index`. It
implements only the route [KHA-104](../../../../docs/evidence/codex.md) proved and
imports the KHA-106 contracts from `@khala/contracts/delivery/index`.

## Support row

| Field | Value |
| --- | --- |
| Harness | `codex` (codex-cli) |
| Exact version | `0.154.0`, Linux x64. Any other version is reported `unsupported` until it has its own proof run; semver does not promote it. |
| Provider restrictions | None observed. The proof used the fixture's own model, which was left unchanged. |
| Route | Khala starts `codex app-server --listen unix://<owner-only dir>/…sock` in the thread's workdir and resumes a dormant thread there (`thread/resume`, no overrides). Delivery is a separate connection on that listener calling `thread/queue/add` with `clientUserMessageId = releaseId`. The thread's native `cwd` must equal the host's workdir. |
| Required agent setup | None by the human. The host (KHA-133) starts the app-server and resumes the thread. A thread already running in a TUI, `codex exec`, an IDE or another app-server is **not** supported: attaching to it is unproven, and a second writer is refused. |
| Busy behaviour | `queue`. Delivery waits for the running turn, then runs as a new turn. `turn/steer` is unproven and never called. |
| Observable receipts | `transport_written` (a flushed write reported by the client port, or a native reply), `harness_queued` (the correlated `queuedSubmission`, or the entry in `thread/queue/list`), `context_consumed` (a `userMessage` notification whose `clientId` is the release ID), `completed` (that turn's `turn/completed` with status `completed`), `outcome_unknown`, `failed`. `context_consumed` and `completed` come only from the receipt tracker's live notifications. The contract fixture lists the same kinds except `transport_written`, which is the connector's own observation. |
| Reconciliation | `while_queued`: `thread/queue/list` matched on the release ID. Thread history is never read. A release that has left the queue reconciles to `null`. |
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
  Nothing is prepended. The payload travels only in the request body: never in process
  arguments, receipts, endpoints, errors or logs.
- **The durable native queue.** An entry still queued when the host exits is consumed
  by whichever executor loads the thread next. The host owner (KHA-133) must drain or
  delete its own pending entries before releasing an executor. It must also treat a
  change of writer-lock holder as a new executor.

## Evidence status

The tests run the adapter against `FakeAppServer`, which models the native behaviour
KHA-104 observed. That is component evidence only. Live same-session verification
needs KHA-133's WebSocket client and host, and an operator-designated disposable
thread (see `experiments/codex/README.md`). G-HARNESSES remains open.
