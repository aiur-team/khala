# Multi-device E2EE: diagnosis and plan

Kevin's report (2026-11-06, channel "Aiur", 7:20–7:32 PM): after he moved to a second phone and re-added his agents from it, the agents could read each other, but neither phone showed their replies. The new phone showed only his own messages. The old phone showed "Message unavailable on this device" for every new message, including his own messages from the new phone, plus a "Retry history" button.

Line references are to `origin/main` at `f91c6c37`, which is the commit deployed to production.

## What works

Matrix's device fan-out works. Three checks confirmed it:

- **Node SDK check** (matrix-js-sdk 42.4.0). One human ran two devices and added an agent. One device was closed and reopened later with the same crypto store. Every new message decrypted on both devices.
- **Full-stack check.** On the local stack, two browser contexts for one account and real MCP agents passed this test on the deployed code: an agent was added from either device and the old tab was closed, then reopened. The failure appears only once an agent is removed and re-added; see the root cause below.
- **Production room metadata.** Read-only `keys/query` and `/messages`, using an agent's own token, matched expectations:
  - Kevin's account has 4 web devices, and every one has published keys.
  - Only one of them (his first) is signed by his cross-signing key.

The defaults in the code agree:

- The SDK shares room keys with every device of every member, verified or not (`AllDevicesIsolationMode(false)`, matrix-js-sdk `rust-crypto.ts:132`).
- No Khala code changes the isolation mode or blacklists unverified devices.
- Each browser gets its own random device ID (`apps/web/src/composition/human/browser-api.ts:288`).
- Signing in never logs out another device.

## Root cause: one rotated device freezes the whole timeline

The same mechanism causes both symptoms (a) and (b).

1. **Removing an agent deletes its Matrix device.** When an agent's session ends because it was removed, it sets `wipe = true` (`packages/agent/src/matrix/session.ts:242`) and calls `/logout` (`:193`). The control server's removal also runs `logout/all` (`apps/control/src/composition/human/matrix.ts:701`). Synapse then drops that device's keys. At 19:20–19:21 Kevin removed all three agents from the new phone and re-added them. Production `/messages` shows that each agent now sends from a new device (for example, `KH_AGENT_30ee410d` became `KH_AGENT_b8346e37`). `keys/query` no longer lists the old devices.
2. **The browser's projection threw on any message from a device it could not find.** `MatrixSubstrate.events()` looked up the sending device of each decrypted message. When the device was missing, it threw `Matrix author device attribution unavailable` (`apps/web/src/composition/human/matrix-browser.ts:662-665`). Every earlier message from a removed agent's old device hit this throw once the browser refreshed that agent's device list. Only a device that had already decrypted those messages was affected; a device that never had their keys shows them as placeholders and never reaches the device lookup. Two checks reproduced it. In the Node SDK, once an agent's device is logged out and the agent rejoins, its old message reads `UNATTRIBUTED`. In the full stack, `multi-device.spec.ts` ran on the deployed code: an agent added from the old device sent a message, was removed, and was re-added from the new device. The reopened old device then never showed the new device's message.
3. **The failure was silent and covered the whole room.** `subscribe()` dropped the error (`matrix-browser.ts:747`, `.catch(() => undefined)`), so the timeline never updated again. Older pages failed the same way, so the name scan reported a failure and the UI showed **Retry history** (`apps/web/src/features/timeline/controller.ts:271-289`, `TimelineScreen.tsx:930`). Retry runs the same throwing projection, so it cannot help.

Here is how that explains each phone:

- **(a) New phone.** The agents' replies decrypted, but every projection after the removal threw, so none of them rendered and no placeholders appeared. Kevin's own sends still showed, because outgoing messages render from the local send journal. Read receipts ("Seen by") showed too, because they come from a separate subscription (`matrix-browser.ts:306`).
- **(b) Old phone.** It reopened and projected once while the new messages' keys were still arriving, which produced the "Message unavailable on this device" placeholders. Then it learned that the old agent devices were gone. Every later projection threw, including the one triggered when the keys arrived, so the placeholders were never replaced.

Nothing logged out or replaced the old phone. Its device is still listed with keys.

### Less likely contributors (checked)

- **Pre-join hiding.** `isPreJoinUndecryptable` hides events from before the viewer's own join (`matrix-browser.ts:183`). Kevin's join predates the device change, so it does not apply.
- **Catch-up hold.** `isCatchingUp` holds updates during a reconnect (`matrix-browser.ts:271`). It releases on the first sync that carries no to-device events, and the live test showed it releasing.
- **Name-target lookup.** A failed lookup also throws for the whole batch (`apps/web/src/composition/human/name-targets.ts:14`), but only when the control server is unavailable.

## (c) History from before a device existed

A new device cannot read earlier messages today:

- Megolm keys reach only the devices that exist when a message is sent.
- The SDK labels earlier messages `HISTORICAL_MESSAGE_NO_KEY_BACKUP`.
- Khala has no server-side key backup, no secret storage (SSSS), no recovery key and no device verification. Product decision P14 ruled out history recovery (`docs/product/decisions.md:52`).
- Cross-signing bootstraps without UIA only on a user's first device (`matrix-browser.ts:144-180`, contract C13 in `docs/build/m1/contracts.md:263`). Later devices are never signed. They cannot share history with agents through MSC4268, and they cannot obtain the cross-signing private keys.

## Fix (phase 2)

A decrypted message whose sending device is no longer listed now keeps the device ID from its encrypted envelope. That ID serves only as an attribution label: the contract already says devices rotate and history outlives them (`packages/contracts/src/messaging/events.ts:280-284`). The SDK's own verdict stays the gate. When `getEncryptionInfoForEvent` reports `MISMATCHED_SENDER`, meaning the sender does not own the device that created the Megolm session, the message becomes a placeholder. One unattributable message now produces one placeholder instead of an empty timeline. E2EE is unchanged: keys and plaintext never leave the device, and agents gain no access.

Regression tests:

- **Unit test:** `apps/web/src/composition/human/matrix-browser.test.ts`, "device rotation (#1416)".
- **Live test:** `tests/integration/human/multi-device.spec.ts`. It runs two devices; the agent is added from the first, removed, and re-added from the second. It fails on `f91c6c37` and passes with the fix.
