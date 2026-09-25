---
title: External channel discovery and privacy controls
type: feat
status: active
date: 2026-09-25
origin: docs/product/internal-mode/room-discovery.md (RD2B, slug `external-channel-discovery`)
issue: 205
---

# External channel discovery and privacy controls

## Problem

RD2A (#275) issues a short-lived, DPoP-bound discovery credential, but no route
consumes it. RD2B adds the external read model and privacy controls:

- a lazy, owner-authoritative catalog
- owner-only visibility and private-allowlist mutations
- eligibility filtering
- listing-reference resolution
- snapshot cursors
- listing rate limits
- an authenticated `no-store` listing route

The work excludes request journaling, admission, UI, CLI/MCP, and the internal
SQLite adapter.

## Decisions

1. **Storage is `ControlStore` only.** The store is a per-key CAS KV with no
   enumeration. The catalog is therefore one index record
   (`channel-discovery:catalog:external`) holding an `epoch` plus per-channel
   entries keyed by an opaque channel key (a purpose-separated SHA-256 of the
   room ID). Every mutation is one CAS on that record. The design caps it at
   2,000 entries and 50 allowlist principals per channel. A single record is
   acceptable for v1 and is documented as the scaling seam.
2. **The catalog is lazy.** A channel with no entry is `secret`. There is no
   provider backfill. Setting `public` or `private` upserts `{roomId, ownerId, title,
   visibility, allowlist, revision}`. Setting `secret` replaces the entry with a
   title-free tombstone. The tombstone keeps the stable allowlist and the
   revision, so revisions stay monotonic and the owner's allowlist is never
   silently dropped. Every mutation bumps `epoch`.
3. **Mutations are owner-only.** A human mutation guard (Origin + session +
   CSRF, injected as `authorizeMutation`) runs first, then an injected
   `ChannelOwnerAuthority.canManage({ ownerId, roomId })`. Revision CAS returns
   `stale_revision`. Operation idempotency uses the entry's last operation
   digest and mutation fingerprint: a same-operation retry returns the applied
   revision, and a different body returns `operation_mismatch`.
4. **Allowlists use stable principals.** Each entry is
   `{ principal, agentOwnerId }`, resolved through an injected
   `KnownPrincipalDirectory.inspect({ ownerId, principal })`. The directory
   covers principals known through the owner's sessions, pairing, or prior
   access. It returns the agent's owner and current generation. At mutation
   time, `expectedSessionGeneration` must equal the current generation, or the
   result is `stale_revision`. An unknown principal returns `forbidden`. At use
   time, eligibility matches both principal and agent owner; the credential
   check has already proven the requester's current generation. A rebind never
   edits the allowlist.
5. **Eligibility:**
   - `private`: the requester's owner is the channel owner, or the pair
     `(principal, requesterOwner)` is on the allowlist.
   - `public`: allowed only when `publicDiscovery === 'enabled'`.
   - `secret`: never.

   The composition root has no production wiring, and the contract keeps
   hosted public discovery disabled. When public discovery is disabled, the
   settings route also refuses `public` with `feature_unavailable`.
6. **Snapshot cursors.** The first page:
   - Computes the eligible keys in stable order: title in code-unit order, then
     the opaque key.
   - Caps the snapshot at 500 items.
   - Mints one random snapshot ID and one random listing-reference token per
     item.
   - Stores the snapshot for five minutes with a requester binding: owner,
     principal, generation, origin, and proof thumbprint.

   The cursor is `dcs_<snapshotId>.<offset>`, and each snapshot item records
   its entry revision. Each later page re-reads the catalog and returns
   `cursor_unavailable` (HTTP 410) if any of these checks fail:
   - A snapshotted entry's revision changed, meaning a title, visibility, or
     allowlist mutation. Review replaced the original global epoch here: with
     an epoch, any tenant's mutation would invalidate every cursor and leak
     changes to invisible channels.
   - The binding differs.
   - The snapshot expired.
   - Any snapshotted item is no longer eligible, or a page item's recorded
     owner no longer owns it.

   Unknown, tampered, and foreign cursors return the same result.
7. **Listing references** are `dlr_<snapshotId>.<token>`. The resolver
   (`resolveListingRef`) reads the snapshot and checks the binding and expiry.
   It then rechecks current catalog eligibility and channel-owner authority. It
   returns only an `AuthorizedChannelRef` (the opaque key) or `unavailable`,
   and it makes no writes.
8. **Rate limit:** 10 list requests per `(owner, principal, generation)` per
   fixed one-minute window, counted with a CAS counter record. Pages are capped
   at 25 (`limit` query 1–25, default 25).
9. **Output** is re-projected through `decodeChannelListingPage`: strict fields,
   normalized titles, `requestState: 'not_requested'`, and `serviceKind:
   'external'`. Responses are `no-store`, and the module logs nothing.
10. **Routes.** The gateway allows exact paths only, so the contract's
    `/api/human/channels/<channel>/discovery` shape moves the channel into the
    body.
    - `GET /api/agent/channels?cursor=&limit=` returns a discovery page.
    - `PUT /api/human/channel-discovery/settings` sets visibility and title.
    - `POST /api/human/channel-discovery/allowlist` allows or revokes a
      principal.
    - Unwired compositions return `503 feature_unavailable` placeholders.

## Units

- `apps/control/src/channel-discovery/catalog.ts` — the catalog record codec,
  keys, eligibility, and owner mutations (the `ChannelPrivateEligibilityPort`
  implementation plus visibility and title settings).
- `apps/control/src/channel-discovery/listing.ts` — rate limiting, snapshots,
  cursors, pages, and `resolveListingRef`.
- `apps/control/src/channel-discovery/handler.ts` — agent and human route
  factories and the request parsing.
- Composition: `composition/{agent,human}/handlers.ts` placeholders and the
  injection seams. Runtime `discover.test.ts` manifest.
- README for the module; `apps/control/package.json` export.

## Tests

- Public/private/secret matrix across two owners and two sessions.
- Allowlist add/remove, rebind, owner removal, and cross-owner denial.
- Lazy registration and tombstones.
- Credential refusal passthrough, plus a real RD2A credential end to end
  (expiry and rebind).
- Resolver requester, expiry, and revocation checks with no writes.
- Cursor invalidation on title, visibility, and allowlist mutation.
- Rate limits.
- JSON and log field hygiene.
- Exact-origin refusal and no-redirect responses.
- Wrong-implementation test: a secret channel beside public ones produces
  byte-identical pages, with deterministic random, as the dataset without it.
  The guarded line is the `secret` exclusion in `isEligible`.
