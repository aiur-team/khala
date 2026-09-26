# Internal channel discovery (RD8A, #214)

- **Contract:** `docs/product/internal-mode/room-discovery.md` § RD8A `internal-channel-discovery`.
- **Binding decisions:** 14 (every internal agent joins through a request and a human grant), 15, 24, 36, 44.
- **Consumes (merged on `main`):** `channel-discovery-contract`, `channel-access-journal`,
  `channel-access-grant-exchange`, `local-sqlite-channel-store`, `authenticated-loopback-server`, `internal-launcher`.

## Objective

Give an unjoined, user-started agent a discovery-only way into the running internal service. It can list the channels
it is eligible to see, request access by listing reference or channel URL, and submit a create intent. The human
owner decides every request from the browser session. Only the connector, proving its separate key, can exchange an
approved access request for the sealed grant.

## Key decisions

- **One journal, two backends.** The channel-access journal (`policy`, `store`, `service`), the journal-backed
  exchange authority and the grant issuer are transport-neutral `ControlStore` code that sat in `apps/control`.
  `apps/internal` may not import an app, and a second journal would fork its invariants. They move unchanged to
  `@khala/messaging/channel-access/{journal,exchange}`, and hosted composition imports them from there.
  The hosted journal handler keeps its behavior and now depends only on contract ports.
- **SQLite is the durable root.** Schema v5 adds a `ControlStore` table pair (records plus operation claims) for the
  shared journal, exchange and grant records. It also adds relational discovery tables: catalog visibility,
  per-principal allowlist, issued discovery agents, and admission operations. Everything lives in the running
  channel store, so a restart keeps it.
- **Visibility.** A channel with no catalog row is `private` with an empty allowlist, so it is listed to nobody.
  `private` means an explicit stable-principal allowlist, with no same-owner fallback. `public` means any active
  discovery agent on this service. `secret` is never listed. A canonical channel URL
  (`<origin>/channels/<id>`) reaches the owner prompt for any existing channel without listing eligibility. An
  unknown channel is `unavailable`.
- **Issuance.** `khala internal discovery --harness <h> --session <id>` reads `active.json` and generates a separate
  Ed25519 connector key. It asks the running server, authenticated by the launch's `transportCapability`, to issue a
  discovery capability. It then writes a 0600 discovery descriptor and a 0600 connector key into a 0700 directory.
  The server stores only the capability digest. Reissuing for the same harness session rotates the capability and
  increments the session generation, which revokes pending requests bound to the old generation.
- **Roles.** Discovery bearer: list, access request, create intent, and status only. Connector route: discovery
  bearer plus a fresh DPoP proof from the registered connector key. Human cookie plus request secret: inbox,
  decisions, mute, visibility, allowlist, and the verified-agent list. A binding capability never reaches a
  discovery or human route.
- **Adapters.** The admission provider records participant, device and `joined` membership, idempotent per provider
  operation. It creates no binding, because activation owns that. The create adapter creates or reconciles one
  `secret` channel per idempotency key. It creates no membership or binding and never claims readiness.

## Units

1. Move the journal and exchange adapters to `packages/messaging`; update hosted composition and handler types.
2. `apps/internal/src/store`: schema v5, SQLite `ControlStore`, discovery catalog, agents, admission and create
   adapters.
3. `apps/internal/src/composition/channel-discovery`: listing snapshots, resolution port, journal and exchange
   composition, and the issuer.
4. `apps/internal/src/server`: discovery, transport and connector principals, plus role-checked agent, connector
   and human routes.
5. `packages/contracts/src/internal`: discovery descriptor format and the `discovery` internal command.
   `packages/agent-cli`: argument parsing, plus descriptor selection and an HTTP client in `composition`.
6. Tests, including the wrong-implementation test and restart integration. Update the CLI reference docs.

## Limits (v1)

Same-uid theft of a discovery descriptor or connector key is the documented v1 boundary. The harness session is
asserted by the same-uid caller, not verified by a launcher/OS presence proof. Listing snapshots and references are
in memory and expire after five minutes or at restart.
