# Bootstrap and disposable Synapse adapter slice

This stacked change depends on PR #611's corrected bootstrap response-drop bridge.
It advances #609 through real server/store/Matrix adapters, but **does not complete
#609 or #579 installed hosted recovery acceptance**. No production authority is used.

## Command and isolation

```sh
pnpm test:recovery-synapse
```

Standard CI invokes this command explicitly. Requires Docker Compose, Node
22.23.2 or newer, OpenSSL 3 and the installed workspace dependencies. The test has
a 180-second deadline and each source connector child has a 15-second deadline.
The existing Synapse helper starts a unique project using pinned Synapse/Postgres
images, loopback-only host ingress, private registration/password authorities,
and verified memory/CPU/PID limits. It tears down only that project and its volumes.
It never interacts with unrelated Docker containers.

A fresh owner-only temporary directory holds the generated connector proof key,
private client request file and real file-backed control records. The HTTPS
bridge has its own private CA and binds only loopback. The child inherits only
PATH and its fixture CA configuration. Receipts contain typed results and counts;
raw grants, keys, cookies, Matrix tokens and message bodies are not emitted.

## Real components and scope

- `createPairingStore` / `createPairingPolicy` process the request, explicit owner
  approval and one-use grant. The fixture directly invokes owner decisions using
  a disposable owner ID; this is not an OIDC browser or hosted discovery consent.
- `createControlStore` over `createLocalBlobStores` persists actual CAS records on
  disk. Reconstructing the store and bootstrap handler after the dropped response
  proves the binding survives beyond the original in-memory handler instance.
- `createAgentBootstrapHandlers` verifies real DPoP signatures, approved exact
  session/device tuples, one-use grant redemption and sender-constrained binding.
- `createMatrixAgentAdmission` performs real owner membership checks, account
  admission/join and requested-device session issuance against disposable Synapse.
  The fixture separately pre-provisions owner and agent accounts; account creation
  through this adapter is outside this slice. Initial fixture setup without that
  account failed at profile lookup and returned typed `unavailable`.
- Four independent **source connector HTTP client processes**, not installed CLI
  or actual native agents, perform wrong-device, wrong-generation, successful
  redemption with response loss, then replay. Each uses real fetch and a fresh
  signed proof; the bound fixture proof key remains the same.

The first accepted redemption returns `outcome_unknown` to its client because the
bridge destroys the response after the real bootstrap handler commits. The test
reopens the durable control store, finds the original active binding, and starts
another client process. The one-use pairing grant replay returns typed
`ownership_required` and does not mint another grant, binding or requested-device
Matrix session. It does **not** recover a client binding by operation ID: channel
access grant-free resume and its activation journal are not composed here.

Counts established: one durable pairing grant record, one binding ID observed in
successful persisted writes, one Matrix login on the requested agent device,
and four real Matrix logins made by the admission adapter overall. The other
three adapter logins are two owner-control logins and one temporary join-device
login. Fixture account provisioning logins are separate. These counts must not be
summarized as one Matrix login in total.

The test also reads a synthetic human message and sends a reply through direct
Synapse REST calls using the original session retained privately by the fixture
server. The owner reads that reply. This is a real plain Matrix exchange, **not**
recovered native encrypted connector read/send or production evidence.

## Remaining full acceptance

Compose hosted native proof-key approval, discovery credential and channel-access
journal/exchange/grant-free resume with the installed CLI runner. Durably retain
only its pre-redeem journal, drop the server response, restart the installed exact
native session without a binding ID, recover that same original binding, and
verify original grant/device-login counts. Then prove owner-trusted encrypted
native read/send and wrong proof, denied/revoked/expired, ambiguous and replay
refusals against those composed hosted routes. Production acceptance remains a
separate owner-authorized run with its deployed SHA.
