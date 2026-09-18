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
| Route | Khala starts `codex app-server --listen unix://<owner-only dir>/…sock` and resumes a dormant thread there (`thread/resume`, no overrides). Delivery is a separate connection on that listener calling `thread/queue/add` with `clientUserMessageId = releaseId`. |
| Required agent setup | None by the human. The host (KHA-133) starts the app-server and resumes the thread. A thread already running in a TUI, `codex exec`, an IDE or another app-server is **not** supported: attaching to it is unproven, and a second writer is refused. |
| Busy behaviour | `queue`. Delivery waits for the running turn, then runs as a new turn. `turn/steer` is unproven and never called. |
| Observable receipts | `transport_written` (the write was seen to flush), `harness_queued` (the correlated `queuedSubmission`), `context_consumed` (a `userMessage` item whose `clientId` is the release ID), `completed` (that turn's `turn/completed` with status `completed`), `outcome_unknown`, `failed`. |
| Reconciliation | `while_queued`, extended with a history read: `thread/queue/list` and `thread/read` turns, both matched on the release ID. |
| Cancellation | Not advertised. |

## Ports

The adapter imports no socket, SDK or storage implementation. Composition supplies:

- `client: CodexClientPort`, which opens an initialized WebSocket JSON-RPC connection on
  the host's Unix listener. `request` never throws. It reports `not_sent` only when no
  byte reached the transport, and `lost` (with `written`) otherwise. Only
  `thread/read`, `thread/queue/list` and `thread/queue/add` are typed.
  `thread/resume`, `turn/start`, `turn/steer` and `thread/queue/delete` are not.
- `hosts: CodexHostPort`, the registry of executors Khala started. Each entry records the
  binding generation it serves, its endpoint, whether the endpoint is owner-only, its
  `codex --version`, and whether its executor holds the thread's writer lock now.
- `codec: ReleaseCodecPort`, the KHA-119 envelope codec. It checks the payload digest
  and the approved event references before anything is sent.
- `clock`, and `evidence: EvidenceSink` (KHA-115) for intermediate observations.
- `limits`, the configured `DeliveryLimits`. There is no default.

`createCodexReceiptTracker(binding, clock)` maps notifications from a connection on the
same listener to receipts. Duplicate and out-of-order events yield each receipt once.

## Behaviour that must not be weakened

- **One `queue/add` per `submit`.** KHA-104 showed that `clientUserMessageId` does not
  deduplicate and that a replayed entry is executed a second time. Before adding, the
  adapter looks the release up in the thread's history and queue. If it is found, that
  state is returned and nothing is sent. If native state cannot be read, the submit is
  refused. This check backs up the durable claim in KHA-121; it does not replace it.
- **A lost reply is `outcome_unknown`.** So is a malformed or uncorrelated reply, or a
  port that throws mid-request. `reconcile` returning `null` means nothing was observed.
  It never authorizes another submit.
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
