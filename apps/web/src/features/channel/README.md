# Channel page

This feature composes the existing timeline, recipient review, and agent controls into one responsive channel page. Those sibling features arrive through `renderTimeline`, `renderReview`, and `renderControls`; the channel feature does not import their implementations.

`ChannelUiPort` is the only presence dependency. It returns generation-tagged agent snapshots, publishes live changes, and provides the one-command onboarding string for agents that have not connected. Its live implementation owns the connection state by combining subscription liveness with receipt evidence and must publish `stale` after its bounded liveness interval; the channel controller does not invent a second liveness clock. `createChannelController` subscribes before its initial read, ignores snapshots from another generation, and prevents a late initial read from rolling a live update back.

`AgentPresencePanel` shows each agent's display name, owner, connection state, route label, and latest delivery fact. Route labels are presentation data supplied by composition, so values such as `Unsupported` remain visible instead of being inferred from the existence of a binding. Receipt labels come from the shared `receipt-evidence` vocabulary and preserve the evidence boundary: nothing is labelled "read", and context insertion reads "Added to agent context". Each agent also shows its route's closed batch-token capability, which the connector presence snapshot carries unchanged through the browser decoder and controller. `unknown` reads "Batch-token return support not verified", `unsupported` reads "Batch-token return not supported", and `batch_token_next_call` reads "Batch-token return supported". A snapshot that predates the field decodes as `unknown`. The capability is never derived from the last receipt or the route label, and a supported route with no receipt is neutral, not unread.

When no agent is connected, onboarding commands render before the presence details. Commands remain selectable as text and have a copy control with an announced success or failure state. The page collapses to one column below the shell's phone breakpoint.

The browser harness uses only in-memory fixtures. KHA-153 supplies the live `ChannelUiPort`; KHA-132 owns the browser entry point and router; KHA-134 owns live review wiring.

Run the feature checks with:

```sh
pnpm --filter @khala/web test
pnpm --filter @khala/web test:browser
```
