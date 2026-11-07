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

## History for later joiners (spike, 2026-11-07)

Kevin reported an agent saying "Earlier messages are encrypted and I can't read them, so I'm working from your summary". He ruled "this should not happen", and he wants to "see all conversations connected to my email from any number of machines". This revises P14 (`docs/product/decisions.md`). Two outcomes are required:

- **(a)** An agent added to a channel reads the history that the adding human's device can decrypt.
- **(b)** A human's new device reads earlier history.

The server must never see plaintext or a key that decrypts it.

### Why agents lost history: a regression

The original M1 flow (C13) sent history to agents through MSC4268. The browser's `client.invite()` uploads an encrypted key bundle and sends its key to the invitee over Olm. #1298 (2026-10-22) moved the agent invite to the control server (`inviteAgentAsOwner`, `apps/control/src/composition/human/matrix.ts`) so that the confirm page needs no Matrix client. That server-side device has no crypto, so no bundle has been sent since. Agents still mark a bundle as pending when they join (`client.joinRoom` from the invite, `packages/agent/src/matrix/session.ts`), but none ever arrives. `tests/integration/agent/agent-join-chat.spec.ts` asserts this history, but its confirm step went stale after #1415, so the regression went unnoticed.

### Mechanisms evaluated (matrix-js-sdk 42.4.0, rust crypto)

| Mechanism | SDK support | Verdict |
|---|---|---|
| MSC4268 history sharing | `CryptoBackend.shareRoomHistoryWithUser(roomId, userId)`. `invite()` calls it automatically (the old `shareEncryptedHistory` and `acceptSharedHistory` flags are deprecated no-ops). The joiner accepts a bundle from its inviter within 24 h of joining (`MAX_INVITE_ACCEPTANCE_MS_FOR_KEY_BUNDLE`). The bundle carries only sessions flagged shared-history; Khala rooms are created `history_visibility: shared`. | **Use for (a).** It sends only if the sending device's own identity is verified, and the joiner checks that the sender's device is cross-signed. |
| MSC3061-style key forwarding (`m.room_key_request`) | The rust SDK forwards only to the user's own verified devices; agents are another user. | Rejected. It does not reach agents, and key backup covers own devices better. |
| Server-side key backup | `resetKeyBackup()` (works without secret storage: the key is kept locally and pushed to verified devices), `checkKeyBackupAndEnable()`, `restoreKeyBackup()`. A received `m.megolm_backup.v1` secret is handled by `handleBackupSecretReceived`. | **Use for (b).** The server stores only the encrypted backup. |
| Secret storage (SSSS) / recovery key | Supported. | Not now. It needs a recovery key or passphrase that the user must keep. **Proposed default:** no recovery key, the least ceremony. Losing every device still loses history (P14 keeps this part). |
| QR login / device linking (MSC4108) | `MSC4108SignInWithQR`. | Not now. It needs Synapse's experimental rendezvous endpoint and a camera. Emoji comparison works on any two screens. Can be added later as a second way in. |
| Self-verification (emoji SAS) | `requestOwnUserVerification()`, `CryptoEvent.VerificationRequestReceived`, `VerifierEvent.ShowSas`. When the device with the self-signing key confirms, it cross-signs the new device. `pushSecretToVerifiedDevices(name)` then sends the backup key over Olm. | **Use for (b).** It also fixes C13: an approved device is cross-signed, so it can send MSC4268 history to agents. |

The control server cannot do any of this. It holds no keys, and it must not: if it vouched for a device, it could insert its own device. Whatever trust a new device gets must come from another device of the same human.

### Design

**(a) Agent history, #1419.** `shareHistoryWithAddedAgents` (`apps/web/src/composition/human/matrix-browser.ts`) runs on every browser device once cross-signing maintenance settles. It shares once per page load for each agent this user added. It reacts to the live invite (the control server invites as the owner's Matrix user, so the invite's sender is "me"). On a later load it also reacts to a join less than 24 h old that carries `com.khala.invited_by` set to me, in case no tab was open at invite time. A share that fails can be retried. Agents need no change, since they already accept bundles on join, so no npm release is needed.

Limits: the SDK sends nothing from a device that is not cross-signed (closed by (b)), and an owner's tab must open within 24 h of the agent joining.

**(b) New-device history, #1420.**

1. **Backup.** A device that holds the cross-signing private keys creates a key backup if the server has none (`getKeyBackupInfo()`, then `resetKeyBackup()`). The SDK then uploads every room key it has, encrypted.
2. **Approve.** A device whose own identity is not verified offers "Read earlier messages on this device", which calls `requestOwnUserVerification()`. Every other signed-in device of that user shows the request. Both devices show the same emoji, and the user confirms on each. The verifying device cross-signs the new one and pushes the backup key (`pushSecretToVerifiedDevices('m.megolm_backup.v1')`).
3. **Restore.** The new device enables the backup when the secret arrives and runs `restoreKeyBackup()`. Earlier messages decrypt where they are displayed. The device is now cross-signed, so (a) works from it too.

Ceremony: one tap on the new device, then a comparison of seven emoji on both devices. The user sees no recovery key.

### Verification

- (a) Live: `tests/integration/agent/agent-history.spec.ts`. On a freshly wiped stack (C13: the owner's first device), three messages are sent, then an agent joins and `read` returns all three. The agent log shows `m.room_key_bundle` received and imported. The spec fails without the sharer: the agent marks the bundle pending, and "No key bundle found" is logged.
- (b) Live: `tests/integration/human/device-history.spec.ts`, on a freshly wiped stack. Device 1 sends three messages. Device 2 signs in and shows none of them, plus "Earlier messages are locked on this device". It asks for approval, device 1 approves, and both show the same emoji and confirm. Device 2 then shows all three messages. Device 1 is then closed, and an agent added from device 2 alone reads the three messages (#1419 from an approved later device). The prompt is `apps/web/src/composition/human/device-link.tsx`.
- Not verified live: whether the pushed cross-signing private keys are imported, which would let an approved device approve further devices. The backup key push is verified by the restore.
