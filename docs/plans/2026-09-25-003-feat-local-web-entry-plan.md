---
title: Local web entry over the hosted composition
ticket: 185
contract: docs/product/internal-mode/internal-core.md#3-local-web-entry-over-the-hosted-composition
status: active
---

# Local web entry over the hosted composition

## Goal

Build a second, local-only browser bundle (`apps/web/dist/internal-web/`, the
`INTERNAL_WEB_BUNDLE_DIRECTORY` that #189's launcher serves) that reuses the
human-flow application, shell, timeline and channel service, but talks to the
authenticated loopback API through a browser `HttpRoomSubstrate`. It never
reaches Matrix, recovery, join, sharing or sign-in.

## Decisions

- **Substrate, not a new port.** `packages/messaging/src/local/http/` implements
  the existing `ChannelSubstrate`; the hosted `createChannelService` supplies
  journaling, send dedupe and the projection unchanged. The loopback create is
  idempotent on `operationId`, so `findCreatedRoom` replays the same operation
  instead of inventing an `absent` proof.
- **Hints over `fetch`.** Native `EventSource` cannot carry
  `x-khala-request-secret` (#283 review), so the hint stream is read with
  `fetch` + `ReadableStream`. `ready`/`hint` frames trigger a reread of the
  channel and newest timeline page (walking older pages until it overlaps what
  it already published, bounded).
- **Explicit transport state.** The substrate publishes
  `connecting | live | reconnecting | stopped | auth_failed`. Any 401 is
  terminal (`auth_failed`); stream loss retries with bounded backoff, then
  `stopped` with the channel ID and exact resume command. Sending is blocked
  unless `live`.
- **Identity.** One small server route, `GET /api/v1/session` (human cookie
  only), returns the session's `{ownerId, participantId, deviceId}`. The local
  identity port maps it to an always-signed-in synthetic principal with a
  far-future session; a 401 becomes the terminal relaunch panel, never Sign in.
- **Generic seams in shared code**
  - `composition/human/screen.tsx`: the application screen without hosted route
    imports; takes `renderRoute` and `renderSignedOut`. `mount.tsx` keeps the
    hosted defaults (create/join), so the hosted bundle is unchanged and the
    local graph never imports join.
  - `CreateChannelScreen`/controller `mode: 'private'`: no admission policy, no
    share step; completes after create + intros and opens the channel.
  - `TimelineScreen`: optional `sendBlocked` and a `pendingStore` so pending
    send identities survive reload (retry reuses the same `clientTxnId`, which
    the durable browser journal already froze).
- **Routes.** The local codec accepts only the exact `http://127.0.0.1:<port>`
  origin, `/` (private create) and `/channels/<id>`; everything else, including
  `/join?…`, is not-found.

## Units

1. `HttpRoomSubstrate`, hint stream reader, connection store + unit tests.
2. `GET /api/v1/session` route + server tests.
3. Human composition / feature seams + tests (hosted behavior unchanged).
4. `apps/web/src/internal/**` entry, ports, routes, room renderer with
   announcements; `vite.internal.config.mjs`; `build` emits both bundles.
5. Boundary rule (hosted web graph never reaches `apps/web/src/internal/` or
   `packages/messaging/src/local/`; local entry never reaches Matrix/recovery/
   join) and a real-HTTP browser spec that builds the bundle, drives
   bootstrap→send→observe, asserts `/join?…` is not-found without Join/Sign-in,
   and inspects the built asset graph for Matrix/recovery/join markers.

## Risks

- A channel created from the local create route lives in the launcher's store
  for this run; `khala internal --resume` addresses channels by directory. Noted
  in the PR as a follow-up question, not changed here.
