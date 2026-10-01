# Channel page

The hosted channel page renders the timeline and its share action without a detail pane or settings entry in the chat chrome. Its sidebar links to channel care for recipient review, agent controls, and recovery. The local channel page has a local-only tools control for Stop, Make external, and discovery settings. Presence remains a separate feature module.

`ChannelUiPort` is the only presence dependency. It returns generation-tagged agent snapshots, publishes live changes, and provides the one-command onboarding string for agents that have not connected. Its live implementation owns the connection state by combining subscription liveness with receipt evidence and must publish `stale` after its bounded liveness interval; the channel controller does not invent a second liveness clock. `createChannelController` subscribes before its initial read, ignores snapshots from another generation, and prevents a late initial read from rolling a live update back.

`AgentPresencePanel` shows each agent's readable name and owner. Routing and proof-key labels fall back to "Agent"; connection diagnostics stay out of the ordinary participant list. Selecting an agent expands a compact detail inside the participant list; Escape closes that detail and returns focus to its summary. Route, receipt, and batch-token diagnostics remain in their source data and developer evidence surfaces. The panel calls `renderOwnerControls` only when the signed-in owner's ID matches the agent's owner ID.

Rename and onboarding actions appear only in the owning human's agent detail. Commands remain selectable as text and have a copy control with an announced success or failure state. `AgentListeningControls` supplies the compact Steer / Sync / Async control through the existing agent-controls controller. The hosted composition matches the selected agent to the signed-in owner's verified binding before mounting its controls.

The browser harness uses only in-memory fixtures. KHA-153 supplies the live `ChannelUiPort`; KHA-132 owns the browser entry point and router; KHA-134 owns live review wiring.

Run the feature checks with:

```sh
pnpm --filter @khala/web test
pnpm --filter @khala/web test:browser
```
