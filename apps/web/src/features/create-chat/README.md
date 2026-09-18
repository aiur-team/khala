# create-chat

`CreateChatScreen` lets an authenticated human create an optionally named chat,
draft several introduction messages, and copy the resulting share link. It is a
thin dashboard work panel: it holds no room/admission logic of its own beyond
the local operation journal in `controller.ts`.

## Ports

`CreateChatPorts` (`ports.ts`) bundles the injected contracts from
`@khala/contracts/messaging`:

- `identity: IdentityPort` — gates the screen on sign-in state.
- `device: DevicePort` — gates the screen on local device readiness.
- `room: RoomPort` — `create`, `prepareIntro`.
- `admission: AdmissionPort` — `share`.
- `limits: ContentLimits` — the substrate's title/body byte limits, already
  decoded through `decodeContentLimits` by the host before injection. The
  controller validates title and intro bodies against it locally (trimming,
  rejecting empty or oversized content) before ever calling `room.create` or
  `room.prepareIntro`; the server remains authoritative for every rule it
  enforces regardless.

KHA132 supplies the production ports (backed by the selected messaging SDK)
and mounts `<CreateChatScreen ports={ports} />` directly; no fixture adapter
from this directory is part of that import graph (`pnpm check:boundaries`
enforces this — production code cannot import a `*.test.*` file or anything
under a `fixtures/` path).

## Setup and disposal

`CreateChatScreen` owns its `createChatController` instance via `useMemo` and
disposes it on unmount. A pre-built controller can be injected through the
(test-only) `controller` prop — used by `CreateChatScreen.test.tsx` to render
the screen at a specific, already-driven phase without waiting on real ports.

## Operation identity

`controller.ts` generates one `operationId` per room, one `batchId` per intro
batch, and one `shareOperationId` per share request — each created once and
reused across every retry. Retrying `create` or `share` therefore always
resumes the same transport-level operation. An intro retry always re-calls
`room.prepareIntro` with the same `batchId` and the same frozen message bytes
(never `resumeIntro`), since the room command treats an identical re-prepare as
a resume — including when the prior attempt was rejected before it ever
reached the journal (for example an oversized body), where `resumeIntro` would
find nothing. This never duplicates an already-accepted room, intro message, or
share grant, satisfying R3 (KHA-122).

A `rejected` intro batch result, once the room already exists, reopens the
intro drafts for editing instead of dead-ending on Retry; the next attempt
mints a fresh `batchId` so edited content never collides with the old batch's
journal entry. The room and its title are already committed at that point and
stay locked.

## Testing

- `controller.test.ts` — the operation journal against fake `RoomPort` /
  `AdmissionPort` implementations (unit).
- `share-link.test.ts` — the clipboard adapter's success/denied/unavailable
  outcomes (unit).
- `CreateChatScreen.test.tsx` — static markup assertions (`react-dom/server`)
  for accessible names, disabled states, and error/retry wiring.
- `fixtures.test.ts` — controller-level fixture adapters proving distinct
  states (partial acceptance, unknown outcome, full failure, empty chat) stay
  distinguishable from `ready`.
- `create-chat.browser.spec.ts` — a real Chromium run (via
  `browser-harness/`) against fabricated, in-memory ports: keyboard
  reachability, focus retention on remove, the full create → share → copy
  flow, and narrow-viewport/zoom layout.

This package has no `jsdom`/testing-library dependency, so interactive and
focus-sensitive behavior is proven in the browser test rather than a
DOM-emulated unit test.
