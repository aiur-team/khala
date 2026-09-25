# Channel discovery settings

Owner-only discovery settings for one external channel (RD3A in
`docs/product/internal-mode/room-discovery.md`). `ChannelSettingsPanel` lets the
channel's owner choose `secret`, `private`, or `public`. It shows the exact
pre-join listing an eligible agent would receive and manages the private
allowlist through a verified-agent picker.

- **Secret by default.** A channel with no catalog entry reads as `secret`
  with a null revision. Nothing about it is listed.
- **Exact projection.** `projectListing` builds the preview through the
  contract's `decodeChannelListing`, so the title is normalized the same way the
  server normalizes it. The preview shows every `ChannelListing` field and
  nothing else. The per-agent `listingRef` appears only as a description.
- **Confirmation before increasing.** Secret → private → public is ordered, and
  `save()` opens a confirmation for any increase. A decrease saves directly.
  `cancel()` (or Escape) sends nothing and resets the draft to the saved
  settings.
- **Verified-agent picker.** `knownPrincipals()` takes no query. It returns
  only principals the owner already knows through their own sessions, a
  completed pairing, or prior approved access. Each row leads with the
  server-verified fingerprint, and agent-reported names and workspaces are
  labelled unverified. `allow()` accepts only a principal the picker offered,
  bound to the session generation the owner saw. The empty state explains how
  an agent becomes known without Khala launching one.
- **Honest outcomes.** While a request is in flight, every control is disabled
  and the `role="status"` live region announces the change. A stale revision
  reloads the settings and picker, and nothing is saved. `forbidden` makes the
  panel read-only. An unavailable or thrown call keeps the pending edit and its
  operation ID for `retry()`, and the panel never implies success.

`ChannelSettingsPort` is the only dependency. Its live implementation wraps
`PUT /api/human/channel-discovery/settings` and
`POST /api/human/channel-discovery/allowlist` from
`apps/control/src/channel-discovery/`. Those routes authenticate the human and
recheck ownership on every call. The owner-side settings read and the
known-principal source are supplied by the host composition. `fakes.ts` is an
in-memory catalog for tests and the browser harness only.

Run the feature checks with:

```sh
pnpm --filter @khala/web exec vitest run --config ../../vitest.config.ts src/features/channel-settings
pnpm --filter @khala/web exec node --import tsx --test src/features/channel-settings/channel-settings.browser.spec.ts
```
