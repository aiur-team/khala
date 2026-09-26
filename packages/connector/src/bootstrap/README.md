# `@khala/connector/bootstrap`

Agent-operated link bootstrap (KHA-114). The human pastes a channel link into their existing
agent session. The agent calls `bootstrapAgent` with that link and its own session claim.
The connector does the rest; the human only signs in, if they are not already signed in.
Import from `@khala/connector/bootstrap/index`.

```ts
const result = await bootstrapAgent(
  { channelUrl, session: { harness, sessionId, workdir }, operationId },
  { discovery, sessions, ownership, admission, devices, operations },
);
```

The link is a locator, never proof of ownership. The session claim is untrusted until
`sessions` verifies the native session. Owner, agent participant, device and binding IDs
exist only after verified ownership and admission.

## Flow

1. **Operation.** The operation ledger is read by `operationId`. A different link or session under the
   same ID is `operation_conflict`. A `connected` record whose device is still ready is
   returned as `{ kind: 'connected', reused: true }`.
2. **Discovery.** The link's origin must be a configured trusted origin, and the link must
   carry no credentials. The descriptor always comes from
   `<origin>/api/agent/bootstrap/descriptor?link=…`, requested with manual redirects. A
   redirect must stay on the link's own origin, and there can be at most 3. The body must be
   `application/json`, at most 4 KiB and a strict v1 descriptor. Unknown keys fail, and
   endpoints must be the fixed paths on the answering origin. A descriptor cannot name
   an executable, a command or another origin.
3. **Session.** The harness adapter verifies the native session and reports its capabilities. Missing or
   unsupported harnesses are reported here, before any browser opens or device exists.
   `existingSession` must be evidence-backed (not `unknown` or `unsupported`).
4. **Device reservation.** A device ID is reserved and written to the ledger (`reserved`)
   **before** anything is admitted, so no retry can mint a second device.
5. **Ownership.** The first method both sides support runs. `loopback-browser-v1` (KHA-144)
   opens the owner's browser at the consent page with a loopback redirect, PKCE S256
   and the connector key thumbprint. The owner confirms there. The connector exchanges the
   one-time code, with the same redirect URI and a key proof, for a 60-second grant bound to
   this session generation and device.
6. **Admission.** The grant is redeemed once, with a fresh proof. The returned `SessionBinding`
   must name the reserved device and the exact verified session and generation. The adapter
   capability must carry exactly `publish_own`, `receive_released` and `ack_delivery`, name that
   binding and generation, and not have expired. The ledger then moves to `admitted`.
7. **Device.** The device port creates or resumes the reserved device and hands the adapter its
   capability. `connected` is returned only when the device is ready. On failure the ledger
   keeps `repair_required` with the device and binding (never a secret), and the result is
   `device_unavailable`.

Secrets (the grant and the adapter capability) are never written to the ledger, returned or logged. A port
that throws is treated as `unavailable`, and its message is dropped.

## Results

| Result | Meaning | Agent's next action |
|---|---|---|
| `connected` | The binding is live on a ready device | Report connected. `reused: true` means an earlier attempt had already finished |
| `unavailable` (retryable) | Nothing conclusive happened, or the outcome is unknown | Retry later with the **same** `operationId` |
| `blocked: invalid_request` | Malformed input (operation ID `[A-Za-z0-9_-]{8,64}`, harness, session, workdir) | Fix the call |
| `blocked: invalid_link` | Not a URL, too long, or it carries credentials | Ask the human for the channel link again |
| `blocked: untrusted_origin` | The link, a redirect or an endpoint is off the allowlist | Tell the human this is not a Khala link |
| `blocked: link_unavailable` | The service does not know the link | Ask for a fresh link |
| `blocked: unsupported_descriptor` | The service speaks a protocol version this connector does not | Report that an update is needed |
| `blocked: harness_session_missing` | The harness cannot identify the current session | Report it; never start a fresh session instead |
| `blocked: unsupported_harness` | No evidence-backed existing-session support for this harness | Report it honestly; do not ask the human to configure anything |
| `blocked: ownership_required` | The owner did not finish sign-in, or no browser on this machine | Ask the human to finish in the opened tab, or report that remote agents need the (unbuilt) fallback |
| `blocked: admission_denied` | The owner declined, the invite or policy refused, or the service offered a capability other than the adapter's | Report it |
| `blocked: binding_conflict` | This channel is bound to another session or generation of this owner | Report it; rebinding is an explicit owner flow |
| `blocked: binding_revoked` | The owner revoked this session's binding | Report it. Only a later session generation can bind again; never retry the revoked one |
| `blocked: operation_conflict` | This operation ID was used for other input | Use a new operation ID for new input |
| `blocked: device_unavailable` | Admitted, but the device could not become ready | Retry with the same ID (it resumes the same device), or let the owner revoke it |

## Injection points for KHA-133

| Port | Supplied by |
|---|---|
| `discovery` | `createDiscovery({ trustedOrigins })`: production is `https://khala.aiur.team`; each preview origin is explicit |
| `sessions: SessionInspectionPort` | Harness adapters (KHA-117/118) over KHA-103/104 evidence |
| `ownership` | `createLoopbackOwnership({ signer, openBrowser })`. `openBrowser` comes from the harness adapter |
| `admission` | `createHttpAdmission({ signer })` |
| `signer` | KHA-133 `createBootstrapPersistence(storage)` restores one owner-only PKCS8 Ed25519 key and returns its `ProofSigner` |
| `devices: ConnectorDevicePort` | Messaging device lifecycle (G-SUBSTRATE). `reserve` must be stable per operation, and re-activating resumes. `activate` receives the adapter capability; each request under it needs a fresh proof from `signer` with `ath` |
| `operations: BootstrapOperationStore` | KHA-133 `createBootstrapPersistence(storage)` durable per-operation compare-and-set |

The HTTP clients send `Origin: <service origin>` on POSTs, which the control gateway requires
on state-changing requests. Authority comes from the proof and grant, never that header.

## Channel discovery authorization

`createChannelDiscoveryCredentialClient` is a separate, channel-less bootstrap for an
already-running verified native session. It opens the owner's browser on the exact configured
service origin, receives a one-time code through an ephemeral `127.0.0.1` callback, and exchanges
PKCE S256 plus an Ed25519 DPoP proof for a five-minute discovery credential. That credential has
only `list_channels`, `request_channel_access`, and `request_channel_create`; this flow does not
create or join a channel and does not create a device, binding, admission grant, or adapter
capability.

The client exposes `authorize`, `refresh`, `current`, and `invalidate`. It verifies the native
session before opening a browser and again before refresh. Refresh is DPoP-bound to the current
credential and installs a replacement only after strict audience, scope, origin, requester,
generation, expiry, and proof-key validation. Authoritative rejection or a changed generation
clears local authority. A lost exchange response is reported as `outcome_unknown`, because the
service may already have issued or rotated authority.

Only the proof signer is durable. Discovery credential plaintext lives in the client instance;
restarting the connector starts without discovery authority and requires fresh owner consent.
The trusted-origin list is injected explicitly, so a syntactically valid but unconfigured HTTPS
origin is rejected before browser launch.

## Channel access activation

`channel-access-activation.ts` recovers an owner-approved channel-access request (RD5B). It picks up where
`channel-discovery` hands off: the agent has already requested access with an operation ID.

1. **Journal.** Call `journalChannelAccessRequest` before sending the request. The operation, requester,
   origin, session generation and proof-key thumbprint are durable, so `resumeChannelAccessActivations`
   continues after a restart.
2. **Poll.** `activateChannelAccess` polls requester status. The backoff ceiling doubles from 1 s to a
   60 s cap, the delay is jittered in the ceiling's upper half, and each call makes at most `maxAttempts`
   tries. `pending_owner` returns `pending`. Unknown status stays `unavailable`, and nothing is reserved.
3. **Key before exchange.** On approval, the connector reserves a device and generates a distinct X25519
   recovery keypair with libsodium. The record and the private key commit together before the first
   exchange call.
4. **Open and validate.** The envelope's version, algorithm and recipient thumbprint are checked, and the
   box is opened. `validateSealedGrantPayload` then checks the sealed operation, requester, origin,
   generation, device and both thumbprints. A lost response re-fetches the same stored envelope.
5. **Activate.** The grant is redeemed once. The binding and capability are checked like bootstrap
   admission, the device is activated, and the `review`, unpaused trust baseline is required.
6. **Readiness.** Only an acknowledged readiness moves the record to `connected`. The service then reports
   `connected` and deletes its envelope. The local private key is cleared.

| Result | Meaning |
|---|---|
| `connected` | Readiness was acknowledged. `reused: true` means an earlier call already finished |
| `pending` | The owner has not decided; call again later |
| `unavailable` | Nothing conclusive happened; call again with the same operation |
| `repair_required` | A known local failure. `activateChannelAccess(id, ports, { repair: true })` resumes the same operation and device without a new owner prompt. The exception is `recovery_key_lost` or `grant_expired`: these need a new grant, and the connector never requests one |
| `closed` | Denied, expired, revoked or closed by the service |

A private key lost **before** a result was sealed is rotated, and the service supersedes the old one. After
consumption, the service refuses a new key (`encryption_key_mismatch`) and the operation becomes
`repair_required: recovery_key_lost`. Private key material lives only in the owner-only ledger
(`storage/channel-access.ts`, in its own column). It never enters a record, result or log.

| Port | Supplied by |
|---|---|
| `journal` | `createChannelAccessActivationStore(storage)` |
| `status` | `createHttpChannelAccessStatus({ signer, trustedOrigins, credential })`, using the live discovery credential |
| `exchange` | `createHttpChannelAccessClient({ signer, trustedOrigins })`: exchange and readiness routes with DPoP proofs |
| `redeem` | Grant redemption. Its hosted route is not built yet; it must be idempotent per operation, like `BootstrapAdmissionPort` |
| `devices` | The same `ConnectorDevicePort` bootstrap uses |
| `trust` | Trust initialization for the new binding (`@khala/policy` `initialTrustState` gives the review baseline) |

Khala never launches or terminates the user's agent process in this flow.

## Not proven here

Tests use injected doubles plus a real loopback listener and real Ed25519 signatures, so
they prove module behaviour only. Real owner connection without setup belongs to
KHA-133/139. G-ADMISSION (silent bind versus a visible confirmation), G-SUBSTRATE and
G-HARNESSES remain open. An agent on a different machine from the owner's browser
is unsupported by `loopback-browser-v1`. The connector does not claim isolation from an
unrestricted agent on the same host.
