# Channel page

`ChannelScreen` is the channel's main pane inside `KhalaApp` (design spec §5, §6, §11, §22):

- **Header.** It holds the back button (≤900px), a stack of up to four other members plus `+N`, the title button with the "You, … · N humans · N agents" subtitle, and the Invite action. Invite shows only when the composition supplies `renderShare`, the admin path. The title is also a visually hidden `<h1>`.
- **Roster.** The title button opens a disclosure over the thread. It shows one group per human: the viewer first, then other humans in member order. Each agent sits under its owner; an agent whose owner is not a member goes under a "Not in this channel" group. The roster closes on Escape, which returns focus to the title, and on a click in the thread. It stays `inert` while closed. Opening it calls `onRosterOpen`.
- **Agent rows.** The viewer's own agents show the listening-mode segment locked on Sync (M2). Other agents show a read-only Sync icon. The viewer's row has Add agent, which copies the channel link an agent passes to `khala_join`.
- **Detail pane.** Avatars, roster rows, the owner pill and the thread's `openParticipant` callback open the participant detail. It renders into the card's `.kh-detail` through `useDetailHost`. Selecting the open participant again closes it, and so does that participant leaving. The detail shows Recent in Khala and `@ Mention` (`onMention`). For the viewer's own agents it adds Rename, whose unconfirmed requests survive a reload and retry with the same `clientTxnId`.

`roster-model.ts` holds the pure grouping, and `members.ts` resolves names, hues, initials, harness and ownership. Routing and proof-key labels fall back to "Agent", "You" or "Channel member", and connection diagnostics never appear.

`useChannelLink` (in `ChannelSharePanel.tsx`) owns the one share link. A personal channel link loads on mount; an admission share is minted on the first copy unless `eager` is set. `ChannelInvite` and `ChannelAddAgent` are the two popover bodies over it. A failed copy leaves the link selected in a field for copying by hand.

`ChannelUiPort` is the only presence dependency. `createChannelController` subscribes before its initial read, ignores snapshots from another generation, and prevents a late initial read from rolling a live update back.

The browser harness uses only in-memory fixtures. Run the feature checks with:

```sh
pnpm --filter @khala/web test
pnpm --filter @khala/web test:browser
```
