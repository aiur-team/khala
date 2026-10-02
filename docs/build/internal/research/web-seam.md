# Research 4 — apps/web transport seam for local mode (D4)

All refs are at commit `5ad41c8b` (origin/main). Paths are relative to the repo root unless noted; `web/` = `apps/web/src/`.

## TL;DR

**The seam already exists. It is `HumanApplicationPorts`** (`web/composition/human/application.ts:33-59`). Every screen (owner shell, conversation list, channel, timeline, roster, rename, listening mode, profile/username gate, new-channel popover, invite/add-agent popovers) reads only from the `HumanRouteContext` that `createHumanApplication` builds from those ports (`application.ts:255-272`). **Only `web/main.tsx` imports Matrix (`matrix-browser.ts`) or the hosted control API (`browser-api.ts`).** I grepped every non-test import of `browser-api|matrix-browser|browser-device|hosted-config|tab-handoff`: apart from `main.tsx:3-7` and two harnesses, nothing imports them. `mount.tsx`, `room.tsx`, `screen.tsx`, `application.ts` and all `features/*` never reach `matrix-js-sdk`. `matrix-js-sdk` is imported only at `web/composition/human/matrix-browser.ts:3-20`.

Proof that this works: `web/composition/human/browser-harness/device-loss.tsx:36-73` already runs the real `HumanApplicationScreen` and `createHumanApplication` on fake `IdentityPort`, `DevicePort`, room and conversations ports.

So D4 needs:
1. A **new local composition root**: `web/local-main.tsx` plus `web/composition/local/*`, implementing `HumanApplicationPorts` over HTTP and long-poll to the helper. Its room port should be built by **reusing `createChannelService`** from `@khala/messaging/channels` with a new **`LocalSubstrate implements ChannelSubstrate`** (`packages/messaging/src/channels/substrate.ts:72-93`), exactly as Matrix does with `MatrixSubstrate` (`matrix-browser.ts:528-721`, wired at `:808-819`). Timeline, digests, journals, pending sends and observeEntries then behave identically.
2. **One small edit to `mount.tsx`**: an account-capability prop that hides Log out and sign-in redirect in local mode.
3. **A separate Vite entry** (`vite.local.config.mjs` → `dist-local/`), so the local bundle never contains `matrix-js-sdk`, the rust-crypto WASM, IndexedDB device code or hosted-config gating.

No screens are copied, and almost no existing files change.

---

## 1. Boot path

### 1.1 Chain: `index.html` → `main.tsx` → mount → application → screen

| Step | Ref | What happens |
|---|---|---|
| HTML | `apps/web/index.html:1-16` | `<div id="app">` and `<script type="module" src="/src/main.tsx">`. Google Fonts `<link>` at `:7-9` (needs network). |
| Config gate | `web/main.tsx:22-26` | `readHostedConfig(import.meta.env)` (`hosted-config.ts:39-48`) needs build-time `PUBLIC_APP_ORIGIN` and `PUBLIC_HOMESERVER_ORIGIN`. If either is missing, `mountHostedUnavailable` (`unavailable.tsx:20-22`) renders instead. **The local build must bypass this.** |
| Limits | `main.tsx:29-34` | `decodeContentLimits({maxBodyBytes:32768, maxDisplayNameBytes:255, maxRoomTitleBytes:255})` |
| Entry | `main.tsx:36-37` → `entry.ts:20-27` | `readHumanEntry(location)` reads `?mount=hosted-content`, strips it, and canonicalizes `/new`. |
| Identity + control API | `main.tsx:39` → `browser-api.ts:135` `createHumanBrowserApi` | Returns `{agentJoin, agentNames, profile, identity, admission, channelLinks, credentials, participants}` (`:462`). |
| Device session (Matrix) | `main.tsx:40-45` → `matrix-browser.ts:767` `createMatrixBrowserPorts` | Builds `MatrixRuntime` (`:380-463`; `createClient` `:395`, `initRustCrypto` `:402`, `startMatrixClient` `:417`, cross-signing `:440`), `createBrowserDeviceService` with IndexedDB stores, markers and `createWebLockProvider()` (`:780-787`), `MatrixSubstrate` (`:788`), and the room service (`:802-822`). |
| Application | `main.tsx:46-66` → `application.ts:116` `createHumanApplication(ports, {initialPath, tabHandoff})` | Identity → device lease → `HumanRouteContext`. Tab handoff comes from `createBrowserTabHandoff()` (`tab-handoff.ts:10-36`, BroadcastChannel). |
| Routes | `main.tsx:67` → `routes.ts:52` `createHumanRouteCodec({origin: appOrigin, basePath:'/', allowInsecureLoopback: localDev})` | |
| Mount | `main.tsx:68-79` → `mount.tsx:362-366` `mountKhalaContent` → `HumanApplicationScreen` (`mount.tsx:293-360`) | Binds the routes and `renderRoom: renderHumanRoom` (`room.tsx:54-57`). |
| Screen | `mount.tsx:347-358` → `screen.tsx:85-166` `HumanScreen` | `useSyncExternalStore(application.subscribe, …)` (`:97`), then the phase switch (`:112-151`). |
| History | `main.tsx:75-89` | Wires `pushState` and `popstate` to `application.navigate`. `pagehide` disposes. |

### 1.2 Where each concern is composed

- **Identity (Google OIDC session):** `browser-api.ts:202-225` `identity` (`IdentityPort`).
  - `current`: `GET /api/human/me` (`:156-178`). Stores `csrfToken`.
  - `beginSignIn`: builds the `/api/human/auth/login?return_to=` URL (`:205-210`).
  - `signOut`: `POST /api/human/auth/logout` (`:212-224`).
  - Consumed by `application.ts:166-172` `readIdentity`, `application.ts:339-367` `signOut`, `mount.tsx:108-118` `redirectToSignIn` and `mount.tsx:124-156` `SignInRedirect`.
- **Device session:**
  - `application.ts:129` `createHumanDeviceSession(ports.device)` (`device-session.ts:36-148`) serializes `ensureReady`, `release` and `stop`.
  - Matrix `DevicePort` = `createBrowserDeviceService` plus a `stop` override (`matrix-browser.ts:780-800`). Credentials come from `POST /api/human/messaging/session` (`browser-api.ts:270-317`). The device id lives in localStorage `khala.matrix.device.v1:<owner>` (`browser-api.ts:141-148`), with IndexedDB marker and crypto-store checks (`:145-148`).
  - Web Locks: `createWebLockProvider()` (`matrix-browser.ts:785`). Room journal locks: `room-journal.ts:27-30,66-75`.
  - Tab handoff: `application.ts:204-228,298-316` and `tab-handoff.ts`.
- **Routes:** `routes.ts:52-143`.
  - Paths: `/new` and `/conversations` → `conversations` (`:86-87`). `/agent/confirm?joinId=` (`:88-93`). `/join?invite=` and `/join/<ref>` (`:94-114`). `/channels/<id>` (`:115-127`). Everything else → `not_found`. **`/` is `not_found`** because the site root belongs to the landing page (`:55-57`).
  - Route rendering: `mount.tsx:302-319`.

### 1.3 Snapshot phases → UI

- `application.ts:76-95` defines the phases: `checking_identity`, `initializing_device`, `signed_out`, `disposed`, `inactive`, `navigating`, `unavailable{source,reason,retryable}` and `ready{context}`.
- `screen.tsx:113-151` maps them:
  - `signed_out` → `renderSignedOut` = `SignInRedirect` (`mount.tsx:353`).
  - Device-loss reasons → `LostDevicePanel` (`mount.tsx:162-170,354`, E2EE copy).
  - `inactive` → `InactiveDevice` (`screen.tsx:64-72`). This happens only when `tabHandoff` is supplied.
  - Ready → `renderReadyShell` = `ProfileProvider` + `UsernameGate` + `OwnerShell` (`mount.tsx:331-341`).

---

## 2. Port interfaces consumed by the screens

### 2.1 The bundle: `HumanApplicationPorts` (`web/composition/human/application.ts:33-59`)

```ts
export interface HumanApplicationPorts {
  readonly describeParticipant?: (participantId: string) => Participant | undefined;
  readonly describeMatrixUser?: (matrixUserId: string) => Participant | undefined;
  readonly agentJoin?: AgentJoinPort;
  readonly agentNames?: AgentNamesPort;
  readonly profile?: ProfilePort;
  readonly inviteAgent?: AgentInvitePort;
  readonly listeningMode?: (roomId: RoomId, matrixUserId: string) => ListeningMode;
  readonly subscribeListeningModes?: (roomId: RoomId, listener: () => void) => Disposer;
  readonly setListeningMode?: (roomId: RoomId, matrixUserId: string, mode: ListeningMode, txnId: string) => Promise<'sent' | 'failed'>;
  readonly identity: IdentityPort;
  readonly device: DevicePort;
  readonly room: RoomPort & Partial<Pick<ChannelService, 'observeEntries'>>;
  readonly conversations?: ConversationIndexPort;
  readonly syncStatus?: SyncStatusPort;
  readonly admission: AdmissionPort;
  readonly channelLinks?: HumanChannelLinks;
  readonly limits: ContentLimits;
  readonly participant?: () => ParticipantView | null;
  readonly roomParticipants?: (roomId: RoomId, signal?: AbortSignal) => Promise<readonly ParticipantView[] | null>;
}
```

`HumanRouteContext` (`:61-68`) adds `path`, `generation`, `principal: AuthPrincipal`, `deviceView` (ready, non-null deviceId) and `registerDisposer`.

### 2.2 Each port

The "Local must provide" column says what the HTTP/long-poll adapter needs.

| Port / type | Definition | Methods | Implemented today by | Consumed at | Local must provide |
|---|---|---|---|---|---|
| `IdentityPort` | `packages/contracts/src/messaging/identity.ts:137-142`; `IdentityState` `:129-132`; `AuthPrincipal` `:16-24` | `current(opts)`, `beginSignIn(returnPath)`, `signOut(operationId)` | `browser-api.ts:202-225` | `application.ts:168,347`; `mount.tsx:111`; join controller `features/join/controller.ts:64,208`; `CreateChannelScreen.tsx:55` (not routed) | `current` → always `{kind:'signed_in', principal}`. Fabricate `AuthPrincipal {v:1, ownerId:<local owner>, providerIssuer:'khala-local', providerSubject:<owner>, verifiedEmail:'', sessionExpiresAt:<far future>}`. Return `unavailable` if the helper is down. `beginSignIn` → `rejected('invalid_return_path')`. `signOut` → `unavailable` (hidden in UI; see §5). |
| `DevicePort` | `contracts/messaging/devices.ts:41-47`; `DeviceView` `:26-37` | `ensureReady(ownerId)`, `current()`, `observe(l)`, `stop()` | `matrix-browser.ts:780-800` (browser-device service + Matrix engine) | `device-session.ts:56-131`; `room.tsx:71`; join controller `:117`; ChannelService `deviceGate` (`packages/messaging/src/channels/context.ts:36-41`) | `ensureReady` = fetch the helper session (`GET session`), cache `actor`, return `{deviceId:'local_<uuid per tab or fixed>', state:'ready', generation:1, reason:null}`. `current()` returns the cached view: `new` before ready, `ready` after. `observe` notifies on state change (e.g. helper lost → `failed`/`initialization_failed`). `stop` cancels long-polls. **Generation must stay constant while the helper runs**, because ChannelService drops updates when `generation()` changes (`channels/index.ts:84-90`). |
| `RoomPort` (= `ChannelPort`) + `observeEntries` | `contracts/messaging/channels.ts:70-79`; `ChannelService` `packages/messaging/src/channels/index.ts:38-43` | `create`, `prepareIntro`, `resumeIntro`, `send`, `timeline`, `observe`, `observeEntries` | `matrix-browser.ts:824-836` delegates to `createRoomService` (= `createChannelService`, `channels/index.ts:62,208`) over `MatrixSubstrate` | timeline controller `features/timeline/controller.ts:58-60`; `TimelineScreen.tsx:38,382,393` (`send`); `room.tsx:145` (agent_rename send); `NewChannelPopover.tsx:11,77` → create-channel controller `:130` | **Do not reimplement `ChannelPort`.** Implement `ChannelSubstrate` (below) and call `createChannelService({principal, actor, device, substrate, journal, limits})`. Journal: reuse `createBrowserRoomJournal(ownerId)` (`room-journal.ts:59`) or `createMemoryChannelJournal()` (`channels/journal.ts:76`). |
| `ChannelSubstrate` (the real transport seam) | `packages/messaging/src/channels/substrate.ts:72-93`; `SubstrateEvent` `:46-66`; `SubstrateUpdate` `:70` | `createRoom`, `findCreatedRoom`, `room`, `sendEvent`, `timeline`, `subscribe` | `MatrixSubstrate` `matrix-browser.ts:528-721` | `createChannelService` | `createRoom` → `POST channels {operationId,title}`. `findCreatedRoom` → `GET channels?operationId=`. The helper can return a definite `absent`, which Matrix cannot. `room(id)` → `GET channels/:id`. `sendEvent` → `POST channels/:id/events {clientTxnId, content}`, idempotent per (device, clientTxnId), returns `{eventId, authorDeviceId}`. `timeline` → `GET channels/:id/events?cursor&limit`, newest page when `cursor=null`. `subscribe` → long-poll loop that publishes a **full current window** (`SubstrateUpdate{generation, room, events}`), as Matrix does at `:693-705`. Events carry `participant: ParticipantView`, `authorDeviceId`, and `targetParticipant` for `agent_rename` / `agent_name_snapshot` (see `name-targets.ts:5-21`). |
| `ConversationIndexPort` | `web/composition/human/conversations.ts:5-8`; `ConversationSummary` `web/ui/conversation/ConversationList.tsx:16-26` | `snapshot(ownerId, gen)` **synchronous**, returns `[]`, `null` (error) or `undefined` (loading); `subscribe(ownerId, gen, l)` | `matrix-browser.ts:838-851` (`projectJoinedEncryptedRooms` `:204-236`, `subscribeConversationIndex` `:244-275`) | `ConversationIndexRoute.tsx:5-19` `useConversationIndex`; `mount.tsx:261,280-288`; `room.tsx:65-66,107-115` | An in-memory cache filled by long-poll `GET channels?since=<rev>`. Return `undefined` until the first load. Items are `{id,title,preview,timestamp,unreadCount,members:[{id,kind,displayName,ownerId?}],lastSender}`. |
| `SyncStatusPort` | `web/composition/human/sync-status.ts:5-8` | `live(ownerId,gen)`, `subscribe` | `matrix-browser.ts:853-867` | `useLiveSync` (`sync-status.ts:12-20`) — **currently has no UI consumer** (grep). | "Helper long-poll healthy" boolean. Optional. |
| `ProfilePort` | `web/features/profile/ports.ts:4-9` | `get()`, `setUsername(u)`, `setColor(c)` | `browser-api.ts:390-437` | `features/profile/store.ts:26-93` → `ProfileProvider.tsx:29-37` (keyed by `principal.ownerId`, `mount.tsx:335`) → `UsernameGate.tsx:9-17`, `UsernameDialog.tsx:12,54`, `UsernameForm.tsx:77`, `SettingsMenu` username (`mount.tsx:268,278`) | `GET/POST` to the helper's profile file. Same result shapes. `get` must return `{username|null, suggestion, color}`. |
| `AgentNamesPort` | `web/features/channel/ports.ts:45-52` | `rename(matrixUserId, name)` | `browser-api.ts:438-461` (`POST /api/human/agents/rename`) | **No UI consumer.** Only wired at `main.tsx:57` and `application.ts:38`. Renames actually flow through `room.send` (§4). | Omit. |
| `ChannelUiPort` (presence) | `web/features/channel/ports.ts:36-40`; `AgentPresence` `:12-25` | `agents`, `subscribeAgents`, `installCommand` | Built **inside the screen layer** by `hostedPresence(context, …)` `room.tsx:22-52` from `context.roomParticipants` (polls every 5s, `:40-47`) | `createChannelController` (`room.tsx:79-83`) | Nothing new. Provide `roomParticipants` (below). |
| `roomParticipants` | `application.ts:58` | `(roomId, signal) → ParticipantView[] or null` | `matrix-browser.ts:886-899` (joined members → `POST /api/human/messaging/participants`) | `room.tsx:26` | `GET channels/:id/members` → `ParticipantView[]`. |
| `participant` (viewer) | `application.ts:56` | `() → ParticipantView or null` (sync) | `matrix-browser.ts:885` `runtime.active.actor`; displayName = `ownerFirstName(verifiedEmail)` `:434` | `room.tsx:88,116-122` (null shows "Participant attribution is unavailable") | The cached actor from the session fetch in `DevicePort.ensureReady`. `displayName` = profile username. |
| `describeParticipant` / `describeMatrixUser` | `application.ts:34-36`; `Participant` `packages/contracts/src/m1/participants.ts:7-10` | sync lookups | `browser-api.ts:319-323` (cache filled by `participants.resolve`) | `room.tsx:95,138,171`; `features/channel/members.ts:63-97`; `TimelineScreen.tsx:405,436`; `mount.tsx:244-250,280` (harness logos) | A cache filled from the members and conversations responses. **Must fill `matrixUserId`** with the local agent/human id: listening mode is keyed by it (`room.tsx:95-98`). Agent entries need `harness` and `ownerLabel`. |
| Listening modes | `application.ts:41-45`; `ListeningMode` = `'steer'or'sync'or'async'` (`contracts/src/delivery/listening-mode.ts:6,16`) | `listeningMode(roomId,userId)` **sync**, `subscribeListeningModes(roomId,l)`, `setListeningMode(roomId,userId,mode,txnId)` | `matrix-browser.ts:872-884` (read `m.room.member` content key `com.khala.listening_mode` `:736-738`; send event type `com.khala.listening_mode.v1` `:741-750`; subscribe `RoomStateEvent.Events` `:874-882`) | `room.tsx:96-104,150-153`; `listening-modes.ts:13-26` `guardedListeningModeSetter` | Cache the per-member mode from the members long-poll. `setListeningMode` → `POST channels/:id/agents/:userId/mode {mode, txnId}` → `'sent'or'failed'`. Note that the hosted path sends an owner **command** and the agent reports back via its member state. Local can have the helper apply the mode directly or relay it to the agent, but the UI only re-reads `listeningMode()` after `subscribeListeningModes` fires. |
| `AdmissionPort` | `contracts/messaging/admission.ts:43-50` | `share`, `inspect`, `admit` | `browser-api.ts:227-268` | `room.tsx:124-125` (truthy gates the Share and Add-agent popovers); `ChannelSharePanel.tsx:43-58` (`share` only when `channelLinks` is absent); create controller `:150` (only in `shared` mode; the popover uses `on_demand`); join controller `:83,143` | **Required field** (`application.ts:52`). Stub: `share` → `unavailable`, `inspect` → `'unavailable'`, `admit` → `unavailable`. Real links go through `channelLinks.personal`. |
| `HumanChannelLinks` | `web/composition/human/channel-links.ts:4-7`; `PersonalChannelLinkResult` `contracts/messaging/channel-link.ts:47-49` | `resolve(url)`, `personal(roomId)` | `browser-api.ts:358-370` | `ChannelSharePanel.tsx:29,40-48` (Invite and Add agent popovers); join controller (`resolve`) | `personal(roomId)` → `POST channels/:id/link` → `{v:1, kind:'personal_link', shareUrl:<local link the agent's khala_join accepts>, expiresAt:null}`. `resolve` → `{v:1,kind:'unavailable'}`. |
| `AgentJoinPort` / `AgentInvitePort` | `web/features/agent-confirm/ports.ts:3-10` | `view`, `confirm`, `status`; `(roomId, agentUserId) → bool` | `browser-api.ts:371-389`; `matrix-browser.ts:870-871` `inviteWithHistory` | `mount.tsx:87-105` (missing → "Agent confirmation unavailable" page `:96-101`) | Omit both. Local agents join through the helper, not the confirm page. |
| `CreateChannelPorts` (subset `NewChannelPorts`) | `web/features/create-channel/ports.ts:11-17`; `NewChannelPopover.tsx:11` | `room`, `admission`, `limits` | the context itself (`mount.tsx:286 ports={context}`) | `NewChannelPopover.tsx:77` | Satisfied automatically. |
| `JoinPorts` | `web/features/join/ports.ts:9-17` | `identity`, `device`, `admission`, `channelLinks`, `codec`, `navigate` | context (`mount.tsx:49-56`) | `/join` route only | Satisfied by the stubs. `/join` is effectively dead locally. |
| `PendingSendStore` | `web/features/timeline/TimelineScreen.tsx:121`; impl `web/composition/human/pending-send-store.ts:27-51` (sessionStorage, keyed by owner+device+room) | `load`, `save` | created in `room.tsx:72-74` | TimelineScreen | Reused unchanged. Transport-neutral. |
| `RoomJournal` | `packages/messaging/src/channels/journal.ts:55-64`; browser impl `web/composition/human/room-journal.ts:59-110` (localStorage + `navigator.locks`) | `read`, `claim`, `replace` | `matrix-browser.ts:813-817` | ChannelService | Reused unchanged. Needs a secure context: `http://127.0.0.1` qualifies. |
| `TabHandoff` | `web/composition/human/tab-handoff.ts:3-7` | | `createBrowserTabHandoff` | `application.ts:204-228,298-316` | **Omit.** `options.tabHandoff` is optional. Without it the app never enters `inactive`. |
| name targets | `web/composition/human/name-targets.ts:5-21` `attachNameTargets` | helper used by MatrixSubstrate `:645-650` | | | The local substrate can call it, or the helper can send `targetParticipant` pre-resolved. |

---

## 3. Where the UI reaches Matrix or the hosted control plane directly

**Only `web/main.tsx`** does. Screens are already port-only. Below are every direct reach and the Matrix/hosted assumptions that leak through ports.

### 3.1 Direct imports, all in `main.tsx`

- `main.tsx:4` `createHumanBrowserApi`, `:7` `createMatrixBrowserPorts`, `:3` `createBrowserTabHandoff`, `:6` `readHostedConfig`.
- `browser-api.ts:35` statically imports `@khala/messaging/browser-device/index` (IndexedDB marker store, `hasOwnerCryptoStore`). `matrix-browser.ts:3-20,43-62` import `matrix-js-sdk`, its crypto API and browser-device.
- Two harnesses also use `createHumanBrowserApi`: `web/features/agent-confirm/browser-harness/main.tsx:2` and `web/features/profile/browser-harness/main.tsx:2`.

### 3.2 `/api/human/*` calls in `browser-api.ts`

All go to `${origin}${path}` with `credentials:'same-origin'`. Mutations are `POST` with JSON and header `x-khala-csrf` (`:180-200`). Timeout is 10s (`:139`).

| Path | Method | Ref | Request | Success shape |
|---|---|---|---|---|
| `/api/human/me` | GET | `:39,156-178` | — | `{principal: AuthPrincipal, csrfToken}`; 401 → signed_out |
| `/api/human/auth/login?return_to=` | navigation | `:40,205-210` | — | (302 OIDC) |
| `/api/human/auth/logout` | POST | `:41,212-224` | `{operationId}` | `{kind:'signed_out'}`; 502 `{code:'outcome_unknown',operationId}` |
| `/api/human/invitations/share` | POST | `:42,228-236` | `{operationId, roomId, policy?}` | `{kind:'ok', value: ShareGrant}` |
| `/api/human/invitations/inspect?invite=` | GET | `:45,238-257` | — | `{state: InviteState}` |
| `/api/human/invitations/admit` | POST | `:46,259-267` | `{operationId, inviteRef, deviceId}` | `{kind:'ok', value: Admission}` |
| `/api/human/messaging/session` | POST | `:47,293-316` | `{deviceId}` | `{session:{homeserverOrigin,userId,accessToken,deviceId,publishedFingerprint}}` |
| `/api/human/messaging/participants` | POST | `:48,324-355` | `{userIds, roomId?, deviceId?, matrixAccessToken?, targetParticipantIds?}` | `{participants: Participant[]}` |
| `/api/human/channel-link/resolve` | POST | `:43,359-363` | `{v:1, channelUrl}` | `HumanChannelLinkResult` |
| `/api/human/channel-link/personal` | POST | `:44,364-369` | `{v:1, roomId}` | `PersonalChannelLinkResult` (origin must equal the app origin, `:367`) |
| `humanAgentJoinPath(joinId)` etc. (`contracts/m1/agent-join`) | GET / POST / GET | `:371-389` | `{}` | `AgentJoinView`; 401/403/404/409 codes |
| `/api/human/profile` (`PROFILE_PATH`, `contracts/m1/profile.ts:11`) | GET | `:391-400` | — | `ProfileView {username, suggestion, color}` |
| `/api/human/profile/color` (`colors.ts:5`) | POST | `:401-415` | `{color}` | `{color}`; 400 → invalid_color |
| `/api/human/profile/username` (`profile.ts:12`) | POST | `:416-436` | `{username}` | `{username}`; 409 taken; 400 `{reason}` |
| `/api/human/agents/rename` (`agent-names.ts:5`) | POST | `:438-461` | `{matrixUserId, name}` | `{matrixUserId, name}` |

### 3.3 Matrix and hosted assumptions that leak through ports into screens

These need no transport edit, but the local adapter must satisfy them or the copy is wrong:

1. `room.tsx:95-98`: listening mode is keyed by `describeParticipant(pid)?.matrixUserId`. The local `Participant` must carry a `matrixUserId` string.
2. `room.tsx:114` "You no longer have access to this **encrypted** conversation"; `room.tsx:128` fallback title "**Encrypted** conversation"; Matrix projection `matrix-browser.ts:223`. Local channels are not encrypted, so this copy is misleading.
3. `room.tsx:132`: `viewerEmail={context.principal.verifiedEmail}`. With `''` the email chip hides, because of the falsy check at `ChannelScreen.tsx:109`.
4. `mount.tsx:162-170` `LostDevicePanel` (E2EE keys). It is only reached for device reasons `storage_cleared`, `key_material_missing` and `recovery_required` (`screen.tsx:124-128`), which a local DevicePort never emits.
5. `mount.tsx:124-156` `SignInRedirect` and `:172-218` `useSignOut` / `LogoutAction`. Log out is always offered in the ready shell (`mount.tsx:272-278,337`) and on signed-in failure (`:357`). **Local must hide it** (§5).
6. `screen.tsx:52-54` status copy "Checking your sign-in…" and "Getting this device ready…" shows briefly while the helper session loads. Acceptable, or parametrize.
7. `ui/conversation/ConversationList.tsx:50` "Message unavailable on this device" (`preview===null && timestamp`). Local always sends previews.
8. Viewer display name: hosted uses **email first name** (`matrix-browser.ts:434,639`), not the username. Local would use the username, a small parity divergence. Decide which.
9. `routes.ts:86-128`: `/` → `not_found`. The local entry must canonicalize `/` to `/conversations`.

---

## 4. Profile flows (UI → port → transport)

| Concern | UI | Store / logic | Port → transport | Notes |
|---|---|---|---|---|
| Username first-run gate | `UsernameGate.tsx:9-17` (`status==='ready' && username===null` → `UsernameSetupScreen`) wrapped at `mount.tsx:335-340` | `store.ts:35-50` `load()` → `port.get` | `ProfilePort.get` → `GET /api/human/profile` (`browser-api.ts:391-400`) | Fails open: no port or an error lets the app through (`UsernameGate.tsx:1-3`, `store.ts:25-27`). |
| Username save | `UsernameForm.tsx:77-88` (`useProfile().save`); `UsernameSetupScreen.tsx:18`; `UsernameDialog.tsx:29-56` opened from `SettingsMenu` "Username" (`SettingsMenu.tsx:118`, `mount.tsx:270-279`) | `store.ts:66-76` | `setUsername` → `POST /api/human/profile/username` (`browser-api.ts:416-436`) | The error mapping (`invalid_username`+reason, `username_taken`, `signed_out`) must match. |
| Colour | **No UI consumer.** `useProfile().saveColor` exists (`ProfileProvider.tsx:16,43`, `store.ts:77-87`), but nothing calls it. | | `setColor` → `POST /api/human/profile/color` (`browser-api.ts:401-415`) | Rendered hues are **derived, not stored**: `participantHue` (`ui/khala/identity.ts:25-31`). The viewer is always `VIEWER_HUE=214` (`:10`). Other humans use `HUMAN_HUES[fnv1a(ownerId)%8]`, agents `AGENT_HUES[fnv1a(participantId)%4]`. `Participant.color/ownerColor` (`participants.ts:8-9`) is not read in web. So "colour works locally" = deterministic from local ids, with no transport needed. |
| Initials | `ui/khala/identity.ts:51-58` `initials(name)`; `ownerInitials` `:69-77`; viewer shows `'YO'` (`features/channel/members.ts:73`); timeline `TimelineScreen.tsx:430-481`; list `ConversationList.tsx:35` | pure | from `displayName` (participant, roster, conversations members) | Local only needs correct `displayName`s. |
| Agent rename | `AgentPresencePanel.tsx:43-80` `RenameAgent` → `renameAgent(participantId,name,clientTxnId)` → `ChannelScreen.tsx:46,225-229` | `room.tsx:140-149`: `validateAgentName`, owner and joined guards | **`context.room.send({content:{v:1,kind:'agent_rename',agentParticipantId,body:name}})`** → ChannelService → `substrate.sendEvent` → Matrix `m.notice` with `com.khala.agent_participant_id` (`matrix-browser.ts:512-518`). Read back via `projectMatrixTimelineEvent` (`:491-496`) + `attachNameTargets` (`:645-650`) → `projectTimelineNames` (`room.tsx:105`, `features/timeline/names.ts`). | `AgentNamesPort` (`/api/human/agents/rename`) is **not used by UI**. Local: the substrate must persist `agent_rename` and `agent_name_snapshot` content and return it with `targetParticipant`. The helper and packages/agent must treat the latest rename as the agent's name. Pending-name state comes from `timelineData.namesReady` (`room.tsx:136`). |
| Listening mode | `AgentPresencePanel.tsx:142-231` `ModeControl` (viewer-owned agents only, `:231`) → `onSetMode` → `ChannelScreen.tsx:49-51,271` | `room.tsx:96-104` (`modeFor`, `useSyncExternalStore(subscribeModes)`), `room.tsx:151-153` → `listening-modes.ts:13-26` (guards: human viewer, owner, joined, known userId; txn `txn_<uuid>`) | `context.setListeningMode` → Matrix custom event `com.khala.listening_mode.v1` (`matrix-browser.ts:741-750`). Read from member state (`:736-738`). | Local: `POST` mode to the helper; `listeningMode()` reads the cache; `subscribeListeningModes` fires on members long-poll change. |
| Theme | `screen.tsx:98-105` (localStorage) | | none | Works unchanged. |

---

## 5. Proposed seam

### 5.1 Principle

Keep **`HumanApplicationPorts` as the transport seam** (it already is one) and add a local implementation. For channel data, implement at the **`ChannelSubstrate`** level so the existing `createChannelService` (journal, digests, pending, generation fencing, observeEntries) is shared. Do **not** refactor `main.tsx` into an adapter factory. A separate local entry gives zero hosted-behaviour change and a Matrix-free bundle.

### 5.2 TypeScript sketch

```ts
// web/composition/local/boot.ts — boot config the helper injects into dist-local/index.html
export type LocalBootConfig = Readonly<{ v: 1; apiBase: '/api/local'; token: string }>;
export function readLocalBoot(doc: Document): LocalBootConfig | null; // <script type="application/json" id="khala-local-boot">

// web/composition/local/http.ts — the one fetch client (Bearer/x-khala-local token, same-origin, AbortSignal.timeout)
export interface LocalHttp {
  get<T>(path: string, decode: (v: unknown) => Decoded<T>, signal?: AbortSignal): Promise<T | null>;
  post<T>(path: string, body: unknown, decode: (v: unknown) => Decoded<T>, signal?: AbortSignal): Promise<LocalHttpResult<T>>;
  /** Long-poll: resolves on change or after `waitMs`; caller loops. */
  poll<T>(path: string, since: string | null, decode: (v: unknown) => Decoded<T>, signal: AbortSignal): Promise<T | null>;
}

// web/composition/local/session.ts
export function createLocalSession(http: LocalHttp, limits: ContentLimits): Readonly<{
  identity: IdentityPort;            // always signed_in(localPrincipal) or unavailable
  device: DevicePort;                // ensureReady = GET session; caches actor
  participant(): ParticipantView | null;
  principal(): AuthPrincipal | null;
}>;

// web/composition/local/substrate.ts
export class LocalSubstrate implements ChannelSubstrate { /* createRoom, findCreatedRoom, room, sendEvent, timeline, subscribe(long-poll) */ }

// web/composition/local/ports.ts — the single factory local-main.tsx calls
export function createLocalHumanPorts(input: Readonly<{ http: LocalHttp; limits: ContentLimits }>): HumanApplicationPorts & Readonly<{ dispose(): void }>;
// = { identity, device,
//     room: createChannelService({principal, actor, device, substrate: new LocalSubstrate(http, limits), journal: createBrowserRoomJournal(ownerId), limits})
//           (lazily built after device ready, like matrix-browser.ts:802-822),
//     conversations, syncStatus, profile, admission: localAdmissionStub, channelLinks,
//     participant, roomParticipants, describeParticipant, describeMatrixUser,
//     listeningMode, subscribeListeningModes, setListeningMode, limits }
//   (no agentJoin, inviteAgent, agentNames; no tabHandoff)

// web/composition/human/mount.tsx — the only required edit to an existing screen file
export type HumanAccountMode = 'oauth' | 'local_owner';
// HumanApplicationScreenProps gains: account?: HumanAccountMode  (default 'oauth')
```

The wire contract types should live in **`packages/contracts/src/m1/local-api.ts`**: paths, request/response types and decoders, shared by the browser adapter and the helper in packages/agent. The boundary checker forbids the browser from importing `packages/agent` (`scripts/check-boundaries.mjs:131`) and lets only `/composition/` import `packages/messaging` (`:117`). A new contracts domain would need a `packages/contracts/package.json` exports entry, so use `m1/`, which is already exported as `./m1/*`.

### 5.3 Proposed local HTTP surface

This is for the helper researcher to reconcile. All paths are under `/api/local`, use a token header, and reject on a Host-header mismatch.

| Method | Path | Body / Query | Response | Backs |
|---|---|---|---|---|
| GET | `/session` | — | `{principal-ish {ownerId}, actor: ParticipantView}` | identity, device, participant |
| GET | `/profile` | — | `ProfileView` | ProfilePort.get |
| POST | `/profile/username` | `{username}` | `{username}`; 400 `{reason}`; 409 | setUsername |
| POST | `/profile/color` | `{color}` | `{color}` | setColor |
| GET | `/channels?since=<rev>&wait=25` | — | `{revision, channels: ConversationSummary-like[]}` | conversations, syncStatus |
| POST | `/channels` | `{operationId, title}` | `ChannelSummary` | substrate.createRoom |
| GET | `/channels?operationId=` | — | `{kind:'found', room} or {kind:'absent'}` | findCreatedRoom |
| GET | `/channels/:id` | — | `ChannelSummary` / 404 | substrate.room |
| GET | `/channels/:id/events?cursor=&limit=` | — | `{events: SubstrateEvent-wire[], nextCursor, revision}` | substrate.timeline |
| GET | `/channels/:id/events/poll?since=<rev>&wait=25` | — | `{revision, room, events}` (window) | substrate.subscribe |
| POST | `/channels/:id/events` | `{clientTxnId, content: MessageContent}` | `{eventId, authorDeviceId}` | substrate.sendEvent (text, agent_rename, agent_name_snapshot) |
| GET | `/channels/:id/members?since=&wait=` | — | `{revision, members: (Participant & {listeningMode})[]}` | roomParticipants, describe*, listeningMode |
| POST | `/channels/:id/agents/:memberId/mode` | `{mode, txnId}` | `{kind:'sent'}` | setListeningMode |
| POST | `/channels/:id/link` | `{v:1}` | `PersonalChannelLinkResult` | channelLinks.personal |

### 5.4 Edits to existing files

| File | Lines | Change | Size |
|---|---|---|---|
| `web/composition/human/mount.tsx` | `26-39` (props type), `207-218` (`LogoutAction`), `220-241` (`PendingOwnerShell` `:233-235`), `252-290` (`OwnerShell` `:272,276-278`), `293-301,335-358` | Add `account?: 'oauth'or'local_owner'`. When `local_owner`: no `onSignOut` / `LogoutAction` / `SignOutStatus`; `renderSignedOut` renders a "Local helper unavailable — restart `khala local serve`" panel instead of `SignInRedirect`; `renderSignedInAction` → null. | ~20–30 LOC + tests in `mount.test.tsx` |
| `web/composition/human/room.tsx` | `114`, `128` | Neutral copy ("You no longer have access to this channel." / "Untitled channel"), or take copy from context. This changes hosted copy, so it is optional. | ~2–4 LOC |
| `web/composition/human/screen.tsx` | `49-62` | Optional: local-friendly status copy via a prop. Can skip. | ~0–10 LOC |
| `apps/web/package.json` | `scripts` `:52-58` | Add `"build:local": "vite build --config vite.local.config.mjs"`. Optionally add `./composition/local/*` to exports (not needed). | 1–2 LOC |
| `web/main.tsx` | none | **Untouched.** | 0 |
| `application.ts`, `screen.tsx` logic, `features/*`, `ui/*` | none | Untouched. | 0 |

New files:
- `web/local-main.tsx`, which mirrors `main.tsx:28-90` without the hosted config gate:
  - `origin = location.origin` with `allowInsecureLoopback: true` (`routes.ts:33-34` already allows `http://127.0.0.1`).
  - Canonicalize `/` to `/conversations`.
  - No `tabHandoff`.
  - `mode: 'standalone'`.
  - Imports `brand/fonts.css` for offline fonts.
- `apps/web/local.html` (or `web/local/index.html`, following the landing pattern), with no Google Fonts links.
- `apps/web/vite.local.config.mjs`.
- `web/composition/local/{boot,http,session,substrate,conversations,members,ports}.ts` plus tests.
- `packages/contracts/src/m1/local-api.ts` plus test.

### 5.5 Selecting the adapter at boot

**Recommended: a separate Vite entry (build-time selection).**

`vite.local.config.mjs` sets `root: apps/web`, `build.rollupOptions.input: local.html`, `outDir: dist-local`, `base: '/'`, `publicDir: false`, and no `netlifyHeaders` plugin. The helper serves `dist-local/` and injects `<script type="application/json" id="khala-local-boot">{"v":1,"apiBase":"/api/local","token":"…"}</script>` into `index.html` per launch. `type=application/json` is a data block, not script, so a strict CSP with `script-src 'self'` still allows it.

Why not a runtime flag in `main.tsx`? `main.tsx` statically imports `matrix-browser.ts` (`:7`) and `browser-api.ts` (`:4`). A flag would need dynamic `import()` of both and would still ship the Matrix chunks in `dist/`. It also mixes the hosted CSP and config gate into local mode. A separate entry reuses `mount`, `application` and `room` with zero duplicated screens.

---

## 6. Build and serving

- **Hosted build:** `apps/web/package.json:56`: `vite build && vite build --config vite.landing.config.mjs`.
  - `vite.config.ts:16-26`: `envPrefix:'PUBLIC_'`, `outDir:'dist'`, the `netlifyHeaders` plugin emits `dist/_headers` CSP (`hosted-config.ts:57-82`; CSP includes `'wasm-unsafe-eval'` and `worker-src blob:` for Matrix crypto).
  - Landing: `vite.landing.config.mjs:10-21` (`root src/landing`, `base:'/landing/'`, `outDir dist/landing`).
  - `netlify.toml:6-9,25-63` and `apps/web/public/_redirects:1-5`: `/api/*` → function; `/` → `/landing/index.html` (forced); `/*` → `/index.html`. Neither applies locally.
- **Local build:** produce `apps/web/dist-local/` (index.html + `assets/*` hashed JS/CSS + woff2 fonts from `brand/fonts.css:9,16,23` `url("./fonts/*.woff2")`). Vite rewrites asset URLs to `/assets/...` with `base:'/'`. That is fine when the helper serves at the origin root of `http://127.0.0.1:<port>`.
- **Serving from packages/agent:**
  - Install is checkout-based and not published to npm (`apps/web/src/landing/public/AGENTS.md:3,29-32`). The helper can read `apps/web/dist-local` by filesystem path, e.g. from `packages/agent/src/local/serve.ts`: `new URL('../../../../apps/web/dist-local/', import.meta.url)`. That is a runtime fs read, not an import, so `check-boundaries` does not object.
  - Needs an install or build step (`pnpm --filter @khala/web build:local`). `packages/agent` already has `vite` as a devDependency (`packages/agent/package.json`), so a lazy programmatic build is possible but adds complexity. Prefer a prebuilt `dist-local` and a clear error.
  - SPA fallback: serve `index.html` (with boot JSON injected) for `/`, `/new`, `/conversations`, `/channels/*`, `/join*`, `/agent/confirm*`. Serve `/assets/*` with immutable cache headers.
  - CSP for local: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'`. No wasm and no Google Fonts.
- **Keeping `matrix-js-sdk` out of the local bundle:** the local entry imports only `composition/human/{application,mount,room,routes,screen,...}` and `composition/local/*`. None of these transitively import `matrix-browser.ts`, `browser-api.ts` or `@khala/messaging/browser-device` (verified by grep, §3.1).
  - `@khala/messaging/channels` imports only contracts (`channels/index.ts:4-11`) plus libsodium-free code paths, so it is safe to include.
  - Add a guard test that the built `dist-local/assets/*.js` contains no `matrix-js-sdk` / `initRustCrypto` / `.wasm`.
- **`index.html` fonts:** the hosted `index.html:7-9` loads Google Fonts. `local.html` should omit them, and `local-main.tsx` should `import './brand/fonts.css'` (the harness at `device-loss.tsx:10` already does).
- **Secure context:** `crypto.randomUUID` (`application.ts:342`, `listening-modes.ts:25`, `ChannelSharePanel.tsx:9`) and `navigator.locks` (`room-journal.ts:28`) need a secure context. `http://127.0.0.1` and `http://localhost` qualify; a LAN IP does not. The helper must bind and advertise 127.0.0.1.
- **Terminology and boundaries:**
  - `scripts/check-terminology.mjs:12,152` flags the words "room" and "chat" in user-visible strings under `apps/web/src` and `packages/agent/src`. New copy must say "channel".
  - `scripts/check-boundaries.mjs:117,122-131`: local adapter code must sit under a `/composition/` path to import `@khala/messaging`. The browser cannot import Node built-ins or `packages/agent`.

---

## 7. Test patterns to copy

**Best template for a full-app local test:**
- `web/composition/human/device-loss.browser.spec.ts:36-60` with `web/composition/human/browser-harness/device-loss.tsx:36-73` (+ `device-loss.html`). It does vite `build` + `preview` of a harness that runs the real `createHumanApplication` + `HumanApplicationScreen` on fake `IdentityPort`, `DevicePort`, room and conversations ports. Playwright drives it via a `window.__lossHarness` API.

**Real-adapter-over-faked-HTTP template:**
- `web/features/profile/browser-harness/main.tsx:1-30` + `web/features/profile/username-setup.browser.spec.ts`: real `createHumanBrowserApi` against Playwright-intercepted `/api/human/*`. Copy this for the local HTTP adapter: intercept `/api/local/*`.

**Fake ChannelPort:**
- `web/features/timeline/browser-harness/fake-channel-port.ts:1-175`, an in-memory `ChannelPort` with observe/entries. Used by `web/features/timeline/browser-harness/main.tsx` and `timeline.browser.spec.ts`.

**Other harnesses and specs:**
- `web/composition/human/browser-harness/tab-handoff.tsx` + `tab-handoff.browser.spec.ts`
- `web/composition/human/browser-harness/personal-links.tsx` (+ `.html`), used by `web/features/join/join.browser.spec.ts`
- `web/composition/human/create-channel-browser-harness/main.tsx`, used by `web/features/create-channel/create-channel.browser.spec.ts`
- `web/features/channel/browser-harness/main.tsx` + `channel.browser.spec.ts` (roster, rename, describeParticipant fake `:48`)
- `web/features/agent-confirm/browser-harness/main.tsx` + `agent-confirm.browser.spec.ts`
- `web/ui/khala/composer-harness/main.tsx` + `composer.browser.spec.ts`
- `web/ui/khala/parity.browser.spec.ts` (927 lines; design-parity screenshots vs `source/Aiur Dashboard.html`, `:142`)
- `web/shell/browser-harness/main.tsx` + `shell.browser.spec.ts`
- `web/ui/conversation/detail.browser.spec.ts`

**Unit-level fakes:**
- `web/composition/human/application.test.ts` (fake ports into `createHumanApplication`)
- `mount.test.tsx`
- `browser-api.test.ts` (fake `fetch`, the pattern for `composition/local/http.test.ts`)
- `matrix-browser.test.ts` (substrate tests, the pattern for `LocalSubstrate`)
- `packages/messaging/src/channels/service.test.ts` + `channels/fixtures` (fake substrate; the fixtures path is not exported, `packages/messaging/package.json` exports `"./channels/fixtures/fakes": null`)

**Runner:**
- `apps/web/package.json:57` `test:browser` = `node --conditions=khala-source --import tsx --test 'src/**/*.browser.spec.ts'`
- Chromium at `CHROMIUM_PATH` or `/usr/bin/chromium` (`device-loss.browser.spec.ts:46`)
- Unit tests: `vitest run --config ../../vitest.config.ts`

---

## 8. Proposed ticket split (web side only)

Each ticket has one owner and disjoint write surfaces. Complexity is 1–3.

| # | Title | Owner | Cx | Files written | Depends on |
|---|---|---|---|---|---|
| W1 | Local API wire contract | codex | 1 | `packages/contracts/src/m1/local-api.ts`, `.../local-api.test.ts` (paths, types and decoders for §5.3; reuse `decodeProfileView`, `decodeChannelSummary`, `decodeParticipant`, `decodeMessageContent`, `PersonalChannelLinkResult` decoder) | — (co-owned with the helper ticket; the helper consumes it too) |
| W2 | Local HTTP client + session (identity/device/participant) + profile + links/admission stubs | codex | 2 | `web/composition/local/boot.ts`, `http.ts`, `session.ts`, `profile.ts`, `links.ts` + `*.test.ts` (fake fetch, like `browser-api.test.ts`) | W1 |
| W3 | `LocalSubstrate` (ChannelSubstrate over HTTP + long-poll) + channel service wiring | codex | 3 | `web/composition/local/substrate.ts`, `channel-service.ts` (lazy `createChannelService` after device ready, mirroring `matrix-browser.ts:802-836`) + tests (pattern `matrix-browser.test.ts`, `packages/messaging/src/channels/service.test.ts`) | W1, W2 |
| W4 | Conversations index, members cache, listening modes, describeParticipant, syncStatus | codex | 2 | `web/composition/local/conversations.ts`, `members.ts` + tests | W1, W2 |
| W5 | Account-mode seam in mount (hide Log out / sign-in for local owner) + neutral "encrypted" copy | codex (copy review by opus optional) | 1 | `web/composition/human/mount.tsx` (lines in §5.4), `web/composition/human/mount.test.tsx`, optionally `room.tsx:114,128` | — (parallel with W1–W4) |
| W6 | Local entry + build: `local-main.tsx`, `local.html`, `vite.local.config.mjs`, `build:local` script, `/`→`/conversations`, `createLocalHumanPorts` factory, fonts offline, bundle guard test (no matrix-js-sdk / wasm in `dist-local`) | codex | 2 | `web/local-main.tsx`, `apps/web/local.html`, `apps/web/vite.local.config.mjs`, `apps/web/package.json` (scripts only), `web/composition/local/ports.ts`, `web/composition/local/bundle.test.ts` (or a node test script) | W2, W3, W4, W5 |
| W7 | Local full-app browser spec + visual parity | **claude-opus** (UI/visual) | 2 | `web/composition/local/browser-harness/{local.html,main.tsx}`, `web/composition/local/local.browser.spec.ts` (Playwright `page.route('/api/local/**')` fake helper; flows: username setup, create channel, send/receive, agent appears in roster, rename, listening mode, theme; screenshot diff against hosted `parity.browser.spec.ts` states) | W6 |
| W8 (opt.) | Local-mode status/empty-state copy polish (helper down, reconnecting, "local" badge in brand row) | **claude-opus** | 1–2 | `web/composition/human/screen.tsx:49-62` (copy via prop), `mount.tsx` (render-only bits), `ui/khala/KhalaApp.tsx` (badge slot if any) | W5, W6 |

Parallelism:
- Phase A: W1 and W5.
- Phase B: W2.
- Phase C: W3 and W4.
- Phase D: W6.
- Phase E: W7 and W8.

The helper side (static serving of `dist-local`, boot JSON injection, `/api/local/*` handlers, token, Host check, CSP) is a packages/agent ticket outside this list. It depends on W1 and must land before W7 can run against the real helper. W7 itself uses route-faking.

---

## 9. Risks and what makes D4 hard

1. **Synchronous snapshot ports.** `ConversationIndexPort.snapshot`, `listeningMode`, `participant()` and `describeParticipant` are synchronous (`conversations.ts:6`, `application.ts:42,56,34`). Matrix answers them from the SDK's in-memory store. Local needs caches fed by long-poll, and must return `undefined` (loading) rather than `null` (error) before the first fill (`mount.tsx:282`, `room.tsx:107-115`). Otherwise the room shows "Channel access could not be checked."
2. **Generation fencing.**
   - ChannelService drops queued updates whose generation differs from `device.current().generation` (`channels/index.ts:84-90`).
   - `HumanRoom` is keyed by `ownerId:generation:roomId` (`room.tsx:55`).
   - A local DevicePort that bumps its generation on every reconnect remounts rooms and loses state. Keep it constant per page life, and only bump it if the helper identity changes.
3. **The room is a membership gate.** `room.tsx:113-115` hides a channel that is not in the conversations index. The local index must include every channel the owner can open.
4. **Matrix-shaped identifiers.** `matrixUserId` is the listening-mode and rename key (`room.tsx:95`, `AgentNamesPort.rename(matrixUserId…)`, `Participant.matrixUserId`). `describeMatrixUser` drives the harness logos (`mount.tsx:244-250`). Local must reuse the field name with local ids. Renaming the field is a cross-cutting refactor, so don't.
5. **Rename semantics live in the timeline.** Agent names derive from `agent_rename` / `agent_name_snapshot` messages plus a resolved `targetParticipant` (`name-targets.ts`, `names.ts`, `room.tsx:105,140-149`). Until `namesReady` (`room.tsx:136`; `scanNameHistory` pages the full history) the rename UI is disabled. The local helper and agent processes must store and serve these events faithfully and support full-history paging, or names stay "pending".
6. **Sign-in gating.** `SignInRedirect` auto-navigates to `beginSignIn` on any `signed_out` snapshot (`mount.tsx:136-141`). If the local identity ever returns `signed_out`, the page loops or shows "Sign-in is unavailable". Local `identity.current` must return only `signed_in` or `unavailable`. The Log out button must be removed (W5), otherwise clicking it puts the app into `signed_out` (`application.ts:351-360`).
7. **E2EE and device UI.** `LostDevicePanel` (`mount.tsx:162-170`) and `InactiveDevice` (`screen.tsx:64-72`) are unreachable if the local DevicePort never emits those reasons and `tabHandoff` is omitted. The "Encrypted conversation" copy (`room.tsx:114,128`) is still visible locally (W5).
8. **Hosted config gate and routes.**
   - `main.tsx:24-26` blocks boot without PUBLIC_ origins; this is avoided by the separate entry.
   - `routes.ts` requires an exact origin. Pass `location.origin` with `allowInsecureLoopback:true`; only `localhost`, `127.0.0.1` and `[::1]` are accepted (`routes.ts:34`). `/` is not_found, so canonicalize it.
9. **Security of a localhost HTTP API.** Any website can POST to `127.0.0.1:<port>`. The helper must:
   - require the per-launch token (only available via the injected boot JSON, same-origin);
   - verify the `Host` and `Origin` headers (DNS rebinding);
   - set `frame-ancestors 'none'`.

   The hosted CSRF header pattern (`browser-api.ts:180-200`, `x-khala-csrf`) is the precedent.
10. **Bundle leakage.** Any future edit that makes a shared module (`mount.tsx`, `room.tsx`, `application.ts`) import from `matrix-browser.ts` or `browser-api.ts` silently pulls Matrix into `dist-local`. The guard test in W6 is important.
11. **Presence polling.** `hostedPresence` polls `roomParticipants` every 5s per open channel (`room.tsx:40-47`) and reports `connection:'unknown'` for all agents (`:32`). That is fine locally but does not show live agent status. Improving it means editing `room.tsx`, which is shared.
12. **Parity divergences to decide explicitly:**
    - Viewer display name: email-first-name (hosted, `matrix-browser.ts:434,639`) vs username (local).
    - The Share/Invite popover shows a "channel link". In local mode it is only meaningful for local agents.
    - `/join` and `/agent/confirm` routes are effectively dead locally. They render the confirm-unavailable page (`mount.tsx:96-101`) or a join error.
13. **Dist availability.** The checkout-based install means the user must run `build:local`, or the helper must build lazily. If it is missing, `khala local serve` must print an actionable error, not serve a blank page.
14. **Dead ports.** `syncStatus`/`useLiveSync` and `agentNames` have no UI consumer today, and profile `color` is never rendered. Don't spend ticket budget on them beyond stubs.
