# External channel discovery

Owner-authoritative discovery for external channels. `bootstrap/` issues the
short-lived discovery credential; this module consumes it.

- `catalog.ts` holds the lazy catalog. A channel with no entry is `secret`, and
  there is no provider backfill. Only a current owner, proven by the injected
  `ChannelOwnerAuthority`, can register a channel, change its title or
  visibility, or edit its private allowlist. Setting `secret` leaves a
  title-free tombstone, so revisions never repeat. Setting `secret` on a
  channel that was never registered writes nothing. Operation IDs are
  owner-scoped records, so a reused ID never names a second write. Allowlist entries are
  keyed by stable principal and the agent's owner, resolved through the
  owner-only `KnownPrincipalDirectory`. Rebinding a session never edits the
  allowlist.
- `listing.ts` builds snapshot cursors and resolves listing references. The
  first page freezes the caller's eligible channel keys in title order for five
  minutes. It binds them to the caller's owner, principal, session
  generation, origin, and proof key. The snapshot also records each
  channel's revision. A later cursor turns into `cursor_unavailable` on any of
  these:
  - a mutation to a snapshotted channel
  - lost eligibility or lost ownership
  - a binding mismatch
  - expiry

  Changes to channels the caller cannot see stay unobservable. Listings
  and resolution both recheck current channel ownership.
  `resolveListingRef` rechecks current policy and ownership and never writes.
  Listing is limited to 10 requests per session generation per minute, with
  at most 25 items per page.
- `handler.ts` defines the routes:
  - `GET /api/agent/channels`
  - `PUT /api/human/channel-discovery/settings`
  - `POST /api/human/channel-discovery/allowlist`
  - `PUT /api/human/channel-discovery/rollout` (operators only)

  The gateway routes exact paths only, so the channel travels in the request
  body.

## Hosted rollout

`publicDiscovery` is either a static value, used by tests and internal
compositions, or the hosted rollout control from `rollout.ts`. The rollout
control reads one ControlStore record on every request. The record is absent
by default, which means public discovery is disabled. A store failure
also disables public listing. It never affects private listings.

- The operator route requires an authenticated owner mutation plus the
  injected `OperatorAuthority`. Its actions are:
  - `record_drill`: stores a passing drill report
  - `enable` and `disable`: `enable` refuses with `drill_required` unless a
    passing drill is under 30 days old
  - `engage_kill_switch` and `release_kill_switch`
- The kill switch removes public results from listings, cursors and
  listing-reference resolution on the next request. Owner settings still
  work, including setting `public` while the rollout is enabled. Private and
  secret behavior does not change.
- `telemetry.ts` builds events from a fixed set of fields: purpose-tagged
  digests of the account, session and operator, plus result codes and counts.
  Events never carry titles, listing references, cursors, channel URLs, room
  IDs, or raw owner or session identifiers.
- `crawl.ts` counts listing requests per account across all of that account's
  sessions in a 10-minute window. The operator gets one alert per account and
  window through `OperatorAlertSink` when either of these happens:
  - the account makes more than 100 requests
  - 5 of its requests are rate-limited

  Operators can lower either threshold but cannot raise it. A failed delivery
  retries on the next request. `createWebhookAlertSink` posts the alert to one
  HTTPS endpoint and refuses redirects.
- `drill.ts` is the operations drill that runs before enabling. It targets a
  staging composition with public discovery enabled and checks four things:
  - the page cap and the per-session limiter boundary
  - delivery of the crawl alert
  - removal of public results within five minutes of engaging the kill switch
  - private results still listed while the kill switch is engaged

  Its report is the `record_drill` input.

Responses are `no-store`, and nothing in this module logs.

Storage is one `ControlStore` record, because the store cannot enumerate keys.
The record is capped at 2,000 channels and 200 per owner, with 50
allowlisted principals per channel. Snapshots store their listing-reference tokens in plaintext. Those
tokens are useless without the caller's own proof-bound credential.
