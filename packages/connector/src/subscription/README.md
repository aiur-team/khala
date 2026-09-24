# `@khala/connector/subscription`

Live encrypted subscription with durable catch-up for one owner connector (KHA-116). Import
`startSubscription` from `@khala/connector/subscription/index`. It keeps the owner's pending
store in step with the channel stream. It never notifies a model: ingestion creates pending review
state, and released work is dispatched elsewhere.

## Ports

| Port | Meaning |
|---|---|
| `source` | `SubscriptionSource` in `adapter.ts`: the narrow transport/crypto SDK surface. G-SUBSTRATE is open, so the selected SDK's adapter implements it and the connector runtime (KHA-133) injects it. Cursors are opaque strings that are never compared or ordered |
| `cursors` | `CursorStore`: durable per-stream cursor, committed by compare-and-set on its revision (KHA-115) |
| `ingestion` | `EventIngestionPort`: durable pending store. `duplicate` means the same event and digest are already held. `blocked` covers a changed digest under a known event, and any write it cannot make durable |
| `provenance` | `ProvenancePort`: maps the crypto-verified sending device to its channel participant |
| `lock` | `DeviceLock`: single writer for the connector device state |
| `scheduler`, `random` | Time and jitter, injected so retry and cancellation are deterministic in tests |
| `onState` | Readiness observer for runtime status |

## Behaviour

- **Connect.** Each connection takes the lock (once), loads the committed cursor, rechecks
  authority, attaches live reception, then replays from the cursor. Subscribing before replay
  means an event arriving during catch-up leaves a wake behind.
- **Advance.** A page's cursor is committed only after every event in it is durably handled, in
  order. A crash or reconnect before the commit replays the page, and the store deduplicates it.
  A failed, conflicting or thrown commit reloads the durable cursor. The in-memory cursor never
  moves on its own.
- **Hints.** A live hint carries no event, text, count or sender. Hints only wake a durable read
  and coalesce into one pending wake, so buffering is bounded without dropping events. While a
  retry is backing off, hints do not cut the wait short, except under `missing_keys`.
- **Bounds.** A page holds at most `MAX_PAGE_SIZE` events, whatever `pageSize` asks for. A page
  that is empty, not caught up and leaves the cursor unchanged backs off instead of re-reading.
- **Delayed keys.** `missing_keys` holds the cursor at the undecryptable event and reports
  `blocked: missing_keys`. A hint, such as arriving room keys, or the backoff timer retries.
  Final decryption failures (`withheld`, `withheld_unverified`, `decrypt_failed`,
  `unsupported`) are stored as unavailable placeholders so one event cannot stall the stream.
  The author on such a placeholder is the sender's unverified claim. Once its cursor commits,
  this module never revisits the event. If keys arrive later, the SDK adapter (KHA-133) has to
  deliver the decrypted event again, and the pending store (KHA-115) replaces the placeholder
  with the same `eventId`.
- **Provenance.** The crypto-verified sending device is mapped to its channel participant.
  Decrypted content is stored only when that device is the claimed author device, its
  participant is the claimed author, and the payload bytes match `contentDigest`. Otherwise the
  content never reaches the pending store. It becomes an unavailable `decrypt_failed`
  placeholder attributed to the verified sender, never to the claimed author. Content from a
  device that is not a channel participant is dropped. A provenance lookup that fails or throws
  is retried and never drops the event. `roomId` and `eventId` must come from the authenticated
  transport envelope, not from decrypted plaintext.
- **Failures.** A transport outage is `offline` with a bounded, full-jitter exponential
  `retryAt`, and reconnecting rechecks authority. An `authorize` that throws, reports
  `unavailable` or reports `expired` credentials is retried the same way and never authorizes.
  The adapter refreshes expired credentials on the next `authorize`. Storage failure and a busy
  lock are `blocked: storage_failed` and retried. A revoked device (`authority_lost`),
  `replay_gap` and `unsupported` are terminal: the stream is never labelled live past them,
  and recovery starts a new subscription.
  The store reports a changed digest under a known event as `blocked`, which surfaces as
  `storage_failed` and is retried until the owner repairs the stream.
- **Generations.** Every connection and `stop()` takes a new local generation. Callbacks and
  awaited results from an older one are ignored. Connections run one at a time, so port calls
  must settle once their abort signal fires.
- **Stop.** `stop()` aborts reception, timers and in-flight source, storage and lock calls,
  waits for the connection to finish, then releases the lock. It is idempotent.

## Not proven here

Tests drive fake sources and stores. They are no evidence that any SDK can replay, decrypt late
or recover across a crash. The selected SDK adapter, its recoverable ingestion boundary (KHA-115
and KHA-142) and the live reconnect and delayed-key runs are owned by KHA-133.
