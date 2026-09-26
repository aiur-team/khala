# Channel requests inbox

The owner's inbox for agent channel-access and channel-creation requests
(RD4B, `channel-access-inbox`, in
`docs/product/internal-mode/room-discovery.md`). It renders the
`channel-access-journal` safe projection and decides through the shared
`../approval-decision` dialog. Per decision 44, this module is self-contained.
The hosted mount (route, menu placement, and deep links) belongs to #298.

- **The inbox is canonical.** A `ChannelAccessNotification` only adds a
  non-modal notice and triggers a refresh. Nothing opens a request except the
  owner pressing "Review request". Closing a dialog never advances to the next
  queued request. Dismissing a notice or a dialog leaves the row where it was.
- **One place to land.** "Show in inbox" on a notice and a direct link
  (`selectedHandle`) both select the same row and move focus to it. Neither one
  opens the row. A batch notice lands on the pending list.
- **Navigation entry.** `ChannelRequestsNavEntry` is always rendered. It shows
  the exact pending count, from `0` up to the hard owner maximum of 50. It works
  inside a host's collapsed menu. It shares the inbox controller, so the host
  creates one controller, calls `start()`, and passes it to both components.
- **Verified first.** Each row and dialog leads with the harness and the
  session fingerprint. Agent-reported name and workspace are marked unverified.
  So is a creation request's proposed title. The dialog shows fixed
  capabilities and `history: none`. Creation approval states that it creates
  exactly one secret channel and admits only the requesting session.
- **Decision is not readiness.** "Your decision" and "Agent connection" are
  separate rows. `approved` reads as waiting for the agent's connector, never as
  connected.
- **Revision-checked writes.** Decisions send the row's revision. A
  `stale_revision` reloads the row and lets the owner decide again. A retryable
  failure keeps the dialog and its projection, announces the failure, and
  refreshes. Retry then resends the same operation ID with the refreshed
  revision, and the journal answers a repeated operation idempotently.
- **Mute scopes.** Access requests mute per requester and channel. Creation
  requests mute per requester and owner. Each mute sends the current mute
  revision, and a stale one reloads without changing anything.
- **Authority.** The port is bound to the signed-in human by the host. A
  `forbidden` result from a wrong or former owner, or from a binding or
  discovery capability, makes the inbox read-only.
- **Retention.** A finished request's details disappear 30 days after it ends.
  This applies even when its dialog is open.
- **Strict decoding.** Every projection and notification passes the contract
  decoders before it renders. Refused rows are counted, never shown.

`ChannelAccessInboxPort` is the only dependency. Its live implementation wraps
the human-cookie routes over `ChannelAccessDecisionPort` in
`apps/control/src/channel-access/`. `fakes.ts` is an in-memory journal for tests
and the browser harness only.

Run the feature checks with:

```sh
pnpm --filter @khala/web exec vitest run --config ../../vitest.config.ts src/features/channel-access
pnpm --filter @khala/web exec node --import tsx --test src/features/channel-access/channel-access.browser.spec.ts
```
