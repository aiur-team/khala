---
title: "feat: Image sharing for humans and agents"
date: 2026-10-23
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# feat: Image sharing for humans and agents

## Summary

Humans attach an image with a "+" button left of the composer. Agents send one with `khala_send { image }`. Both encrypt it client-side, upload the ciphertext to the Synapse media repo and post a Matrix `m.image` event with an encrypted `file`. The web shows it inline like iOS Messages, opens it full screen on tap, and saves it through the iOS share sheet ("Save Image") from the long-press menu. Agents see `[image: name, WxH]` and fetch one with `khala_read { download }`. Research: `docs/research/2026-10-23-image-sharing.md`.

## Problem Frame

Operator request: "add a + button left of input for humans to upload images, and let agents as well. should appear in the chat like iOS message app, humans should be able to hold it down to save via standard browser save, make sure thats allowed in an ios homepage embed app."

## Requirements

- R1. Composer "+" opens the picker (`accept="image/*"`), shows a preview chip with remove and an optional caption (the draft text).
- R2. Client-side validation: jpeg, png, gif, webp only, sniffed from magic bytes; SVG and everything else refused; 10 MB cap; JPEG metadata (EXIF/GPS) removed.
- R3. Media encrypted client-side (AES-256-CTR, SHA-256 of ciphertext, Matrix `EncryptedFile` v2); the server sees ciphertext only.
- R4. Inline iOS-style rendering: no bubble background, rounded, aspect-preserving max size, placeholder, error state; tap opens full screen.
- R5. Hold to save in Safari and the Home Screen app; reply threads still work on image messages.
- R6. Agents send an image file path with optional caption; same allowlist and cap.
- R7. Agents read `[image: name, WxH]` and download on demand to the session state dir; never auto-downloaded in wakes.
- R8. Docs: AGENTS.md, SKILL.md, docs/settings.md.

## Key Technical Decisions

- **Image is an optional field on text content**, not a new kind: `TextMessageContent.image?`. Every `kind === 'text'` path (pending store, replies, mentions, previews) keeps working; the digest encoding appends the image tuple only when present, so old digests are unchanged.
- **One shared module in `@khala/contracts`** (`m1/image.ts`) for sniffing, dimensions, the allowlist and cap, JPEG metadata stripping, and attachment encrypt/decrypt over Web Crypto. Web and agent both depend on contracts; matrix-js-sdk ships no attachment crypto and we add no dependency.
- **Upload before send.** The composer encrypts and uploads on Send, then posts through the existing `sendDraft` pipeline, so retries reuse the same `clientTxnId` and the same mxc URL.
- **Save = our long-press menu item "Save Image" calling `navigator.share({ files })`**, falling back to `<a download>`. The decrypted Blob is already in memory, so the call stays inside the tap's user activation. The full-screen viewer additionally leaves the native callout on (`-webkit-touch-callout: default`), so the native "Save to Photos" works wherever WebKit offers it. Native-callout-only was rejected: community reports show it missing in standalone mode, and it would steal the long-press from Reply (#1326).
- **CSP `img-src` adds `blob:`.** No manifest exists; nothing else blocks blob images.
- **JPEG metadata:** the web re-encodes JPEG through `createImageBitmap` + canvas (keeps orientation, drops every metadata segment, caps the long edge at 4096 px for the iOS canvas limit); the agent strips APP1/APP13 segments byte-wise (orientation may be lost; agents mostly share screenshots).
- **HEIC skipped**: iOS Safari transcodes HEIC to JPEG for `accept="image/*"`; HEIC from agents is refused.
- **Hosted only.** The local helper's routes accept only `m.text`/`m.notice` and have no media repo; the "+" button is hidden without a media port and agent image calls fail with `image_unsupported` in local mode.

## Implementation Units

### U1. Shared image module (contracts)

**Files:** `packages/contracts/src/m1/image.ts`, `packages/contracts/src/m1/image.test.ts`, `packages/contracts/src/messaging/events.ts`, `packages/contracts/src/messaging/events.test.ts`, `packages/contracts/package.json` (export if needed).
**Approach:** `sniffImage(bytes)` → mimetype + w/h for png/jpeg/gif/webp, else null; `stripJpegMetadata`; `encryptAttachment` / `decryptAttachment` (hash verified before decrypt); `ImageRef` type and reader; content `image` field and digest tuple.
**Test scenarios:** encrypt→decrypt round trip; tampered ciphertext refused; SVG/HTML/zip refused; oversize refused; each format's dimensions; JPEG strip removes APP1 and keeps image data; content with image decodes, digests, and rejects a bad mxc URL or key.

### U2. Agent send and download

**Files:** `packages/agent/src/transport.ts`, `packages/agent/src/matrix/session.ts`, `packages/agent/src/client.ts`, `packages/agent/src/client-impl.ts`, `packages/agent/src/sender.ts`, `packages/agent/src/mcp/tools.ts`, tests `packages/agent/src/sender.test.ts`, `packages/agent/src/mcp/tools.test.ts`, `packages/agent/src/image.test.ts`.
**Approach:** session `uploadImage`/`downloadImage` (authenticated `/_matrix/client/v1/media/download`); client `sendImage(path, caption, channel)` and `downloadImage(eventId, channel)` writing to `<channel state dir>/images/`; `khala_send` accepts `image` (text optional then); `khala_read { download }`; inbox body `[image: name, WxH]` plus caption.
**Test scenarios:** send reads, validates, strips, encrypts and uploads (fake session) and posts `m.image`; SVG path refused with `invalid_image`; download decrypts to a file and re-sniffs; read body label.

### U3. Web composer, rendering and save

**Files:** `apps/web/src/ui/conversation/ChatComposer.tsx`, `apps/web/src/features/timeline/TimelineScreen.tsx`, `apps/web/src/features/timeline/message-renderer.tsx`, new `apps/web/src/features/timeline/ChatImage.tsx`, `apps/web/src/features/timeline/image-media.ts`, css, `apps/web/src/composition/human/{message-wire,matrix-browser,application,room,pending-send-store,hosted-config}.ts(x)`, `apps/web/src/main.tsx`, tests beside each.
**Approach:** `MediaPort { upload, load }` from matrix-browser (hosted only) threaded like `typing`; wire encode/decode of `m.image`; ChatImage with blob URL lifecycle and viewer; "Save Image" menu item.
**Test scenarios:** composer "+" → chip → send uploads then sends content with image; wrong type shows error; wire round trip; renderer shows placeholder then img, error state; Save Image calls `navigator.share` with a File, falls back to download.

### U4. Docs and research

**Files:** `docs/research/2026-10-23-image-sharing.md`, `apps/web/src/landing/public/AGENTS.md`, `packages/agent/claude-plugin/khala/skills/khala/SKILL.md`, `docs/settings.md`.

## Scope Boundaries

- No paste/drag-drop, multi-image grouping, thumbnails, or local-mode media.
- No Netlify deploy (credits); web changes merge and are held.
