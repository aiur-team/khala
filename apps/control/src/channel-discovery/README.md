# External channel discovery

Owner-authoritative discovery for external channels. `bootstrap/` issues the
short-lived discovery credential; this module consumes it.

- `catalog.ts` holds the lazy catalog. A channel with no entry is `secret`, and
  there is no provider backfill. Only a current owner, proven by the injected
  `ChannelOwnerAuthority`, can register a channel, change its title or
  visibility, or edit its private allowlist. Setting `secret` leaves a
  title-free tombstone, so revisions never repeat. Allowlist entries are
  keyed by stable principal and the agent's owner, resolved through the
  owner-only `KnownPrincipalDirectory`. Rebinding a session never edits the
  allowlist.
- `listing.ts` builds snapshot cursors and resolves listing references. The
  first page freezes the caller's eligible channel keys in title order for five
  minutes. It binds them to the caller's owner, principal, session
  generation, origin, and proof key. Any catalog mutation, binding mismatch,
  expiry, or lost eligibility turns a later cursor into `cursor_unavailable`.
  `resolveListingRef` rechecks current policy and ownership and never writes.
  Listing is limited to 10 requests per session generation per minute, with
  at most 25 items per page.
- `handler.ts` defines the routes:
  - `GET /api/agent/channels`
  - `PUT /api/human/channel-discovery/settings`
  - `POST /api/human/channel-discovery/allowlist`

  The gateway routes exact paths only, so the channel travels in the request
  body.

Public listing requires `publicDiscovery: 'enabled'`. Hosted deployments keep it
disabled until the rollout ticket enables it. Responses are `no-store`, and
nothing in this module logs.

Storage is one `ControlStore` record, because the store cannot enumerate keys.
The record is capped at 2,000 channels, with 50 allowlisted principals per
channel. Snapshots store their listing-reference tokens in plaintext. Those
tokens are useless without the caller's own proof-bound credential.
