# iOS Messages inline replies: research for Khala (2026-10-23)

Operator request: pressing and holding a message opens an iOS-style popover with
"Reply"; replying shows the reply chain while composing; the sent reply stays in
the main conversation flow as one chain.

Items marked **[unverified]** come from memory of the UI and not from a source.
Check them on a device before treating them as exact.

## What iOS does

### 1. Long-press on a bubble
- Touch and hold a bubble, then tap **Reply**
  ([Apple](https://support.apple.com/en-us/104974)). A preview appears with the
  Tapback row and Copy / More, plus Reply
  ([Gadget Hacks](https://ios.gadgethacks.com/how-to/respond-specific-messages-group-chats-with-inline-replies-ios-14-0321762)).
- iOS 16 added Undo Send (2 minutes) and Edit (15 minutes, up to 5 edits) to the
  same menu, for your own messages
  ([MacRumors](https://www.macrumors.com/guide/ios-16-messages)).
- **[unverified]** The bubble lifts and scales up a little. The rest of the
  conversation blurs and dims (the standard iOS context-menu treatment). The
  Tapback pill sits above the bubble. The action list sits below it: Reply,
  (Undo Send / Edit), Copy, Translate, More…. Tapping outside dismisses it.

### 2. Reply mode
- After Reply, the conversation blurs and only the target message stays clear,
  with a reply field below it
  ([Gadget Hacks](https://ios.gadgethacks.com/how-to/respond-specific-messages-group-chats-with-inline-replies-ios-14-0321762),
  [MacRumors](https://macrumors.com/how-to/swipe-to-reply-messages-iphone)).
- To cancel, tap the blurred background (MacRumors).
- **[unverified]** If the message already has replies, the whole chain shows
  above the composer.

### 3. After sending
- The reply posts as the newest message in the **main** flow. Above it sits the
  original, joined by "a little bracket", with a count of replies
  ([Macworld](https://www.macworld.com/article/234419/ios-14-everything-new-in-the-messages-app.html)).
- The quoted original is drawn as an outlined bubble. The original message
  carries an "N Replies" label. If unrelated messages arrive in between, the
  next reply shows a fresh copy of the quoted original
  ([Gadget Hacks](https://ios.gadgethacks.com/how-to/respond-specific-messages-group-chats-with-inline-replies-ios-14-0321762)).
- **[unverified]** The connector is a thin grey curved line, and the quote is
  smaller and faded.

### 4. Thread view
- Tapping the quoted bubble, the "N Replies" label or the original opens a
  focused view of the whole chain, where you can also reply
  ([MacRumors](https://macrumors.com/2020/06/22/ios-14-imessage-features),
  [MacRumors guide](https://www.macrumors.com/guide/messages/)).
- **[unverified]** You leave it by tapping the blurred background.

### 5. Swipe to reply
- Swipe right on a bubble to reply. This arrived in **iOS 17**; before that,
  Reply was long-press only
  ([iPhoneLife](https://iphonelife.com/content/how-to-reply-to-message-iphone)).
  iPhoneLife notes that it is easy to trigger by accident while scrolling.

### 6. Accessibility, Mac and iPad
- On the Mac, Control-click a message and choose Reply, or swipe right with two
  fingers (macOS Sonoma or later)
  ([Apple Mac guide](https://support.apple.com/en-eg/guide/messages/send-an-inline-reply-icht4a6d29fb/14.0/mac/15.0)).
  No source shows a Cmd+R shortcut for this.
- VoiceOver exposes message actions in the Actions rotor
  ([AppleVis](https://applevis.com/guides/idevice-primer-103-what-rotor-how-do-i-use-it)).
  **[unverified]** Reply is one of those actions.
- **[unverified]** Reduce Motion replaces the lift and scale with a crossfade.

## What Khala builds

| iOS behaviour | Khala | Notes |
|---|---|---|
| Long-press opens a menu | Yes | Pointer or touch hold of about 500 ms, right-click, or the context-menu key / Shift+F10 / Enter on a focused bubble. |
| Lift, and blur the rest | Yes | The bubble is cloned into a focus layer over a blurred, dimmed timeline. |
| Menu: Reply, Copy | Yes | Tapbacks, Edit, Undo Send, Translate and More are out of scope. Khala has no reactions or edits. |
| No text selection or iOS callout on hold | Yes | On coarse pointers only: `user-select: none` and `-webkit-touch-callout: none`. Copy in the menu replaces selection. Desktop keeps text selection. |
| Reply mode shows the chain over a blurred timeline | Yes | The chain sits above the composer. Esc, the close button or tapping the blur cancels. |
| Reply inline in the main flow, with a connector | Yes | A faded quote of the parent sits above every reply bubble, joined by a curved line. |
| "N Replies" under the original | Yes | Counts direct replies. |
| Tap the quote or count to open the thread | Yes | Opens the same focus view as reply mode, showing the whole chain. The composer replies to the tapped message. |
| Swipe right to reply | No | Out of scope. It conflicts with browser back-swipe on iOS Safari and is easy to trigger by accident. Long-press, right-click and keyboard cover the same need. |
| VoiceOver / keyboard | Yes | Bubbles are focusable with `aria-haspopup="menu"`. The menu is `role="menu"` with arrow-key navigation, and focus returns to the bubble. |
| Reduce Motion | Yes | The lift animation is turned off under `prefers-reduced-motion`. |

## Data: `m.in_reply_to`, not `m.thread`

A reply is a standard Matrix rich reply,
`content["m.relates_to"] = { "m.in_reply_to": { "event_id": "$parent" } }`.

- iOS replies stay in the main flow. Matrix `m.thread` events are hidden from
  the main timeline and shown in a separate thread panel by Element and other
  clients, which is the opposite of the request. Rich replies render inline in
  every Matrix client.
- Chains need no extra data. A reply to a reply points to its parent, and Khala
  builds the chain by following parents through the loaded timeline.
- **Reply fallback.** Matrix v1.13 (MSC2781) removed the quoted fallback from
  `body`, so Khala sends no fallback. When a received reply still has a legacy
  fallback (leading `> ` lines and then a blank line), Khala strips it before
  display, as the spec asks.
- **Encryption.** `m.relates_to` is copied to the cleartext of the
  `m.room.encrypted` event so the server can aggregate relations. The server
  therefore learns which event a reply points to, but never the body. Khala
  already exposes the same kind of metadata to the server through read receipts.
- **Digest.** `inReplyTo` is part of the authored content, so the content digest
  covers it. The encoding appends it only when it is present, so the digests of
  existing messages do not change.
- **Agents.** `khala_read` prefixes a reply's body with
  `↪ reply to <author>: <snippet>` when the parent is in the same page, and with
  `↪ reply to an earlier message` otherwise. Channel content stays untrusted data,
  and wakes stay constant nudges. `khala_send` gets no reply-to argument (not
  asked for). Agents need a khala-cli release to see this context.
- **Local mode** works with no extra code. The local helper stores message
  content as it is, and the web local transport shares the same wire codec.
