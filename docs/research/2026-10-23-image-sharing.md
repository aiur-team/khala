# Image sharing: research (2026-10-23)

Operator request: "add a + button left of input for humans to upload images, and let agents as well. should appear in the chat like iOS message app, humans should be able to hold it down to save via standard browser save, make sure thats allowed in an ios homepage embed app."

## 1. Matrix E2EE attachments

- An encrypted image is an `m.room.message` with `msgtype: m.image`. The event is Megolm-encrypted like any message. Its `file` is an `EncryptedFile`: `{ v: "v2", url: mxc://…, key: JWK { kty: "oct", alg: "A256CTR", k, key_ops, ext }, iv, hashes: { sha256 } }`. The media itself is encrypted with AES-256-CTR. The IV is a random 64-bit nonce followed by a 64-bit counter that starts at zero. `sha256` is the unpadded base64 hash of the ciphertext, which the receiver checks before decrypting ([spec: Sending encrypted attachments](https://spec.matrix.org/v1.12/client-server-api/#sending-encrypted-attachments)).
- Captions: since Matrix v1.10, `filename` holds the file name, and a `body` that differs from it is the caption ([MSC2530](https://github.com/matrix-org/matrix-spec-proposals/pull/2530)). `info` carries `mimetype`, `size`, `w` and `h`.
- **matrix-js-sdk 42.4 has no attachment crypto.** Element uses the separate `matrix-encrypt-attachment` package. Khala adds no dependency. Instead, `packages/contracts/src/m1/image.ts` implements it in about 25 lines of Web Crypto, which works in browsers and in Node 22. The SDK provides `uploadContent` and `mxcUrlToHttp(…, useAuthentication = true)`.
- **Endpoints and auth.** Upload uses `POST /_matrix/media/v3/upload`. Download uses authenticated media, `GET /_matrix/client/v1/media/download/{server}/{id}` with `Authorization: Bearer` (Matrix v1.11, MSC3916). Synapse 1.161 (our pin) enforces authenticated media by default, so legacy unauthenticated downloads are refused. The live homeserver answers both endpoints: they return 401 `M_MISSING_TOKEN` without a token. It sends `access-control-allow-origin: *` and allows the `Authorization` header, so the browser can `fetch` with the token. An `<img src>` could not send the token anyway, which is one more reason we fetch, decrypt and show a `blob:` URL.
- **Size.** Synapse's default `max_upload_size` is 50M. Our template does not override it. Khala caps images at 10 MB client-side, below that limit and above a typical iPhone JPEG.
- **Netlify.** The browser talks to the homeserver origin directly, and `connect-src` already names it. No media passes through Netlify functions, so there are no function body limits and no credit cost.
- **Ingress note.** `infra/messaging/ingress/Caddyfile` only routes `/_matrix/client/*`. Production evidently does not use that boundary for media (upload answers), so nothing was changed there. A deployment that does use it must add `/_matrix/media/v3/upload`.
- **Server never sees plaintext.** Encryption happens in the composer or CLI before upload. The key lives only inside the Megolm-encrypted event.

## 2. iOS Messages image UX

Images appear as standalone rounded tiles with no bubble fill, at their own aspect ratio inside a maximum box (about 2/3 of the column width). A caption is a separate bubble under the image. Consecutive images group tightly. A tap opens a full-screen viewer, and a long-press opens the context menu (Reply, Copy, Save…). Khala mirrors this: a lone image drops the bubble background, the tile is capped at 240×320 with the aspect kept, a tap opens a full-screen viewer, and the long-press menu keeps Reply and adds Save Image. Grouping into a grid is deferred, so consecutive images stack in the normal run spacing.

## 3. Saving on iOS Safari and Home Screen web apps

- **Native callout.** In Safari, a long-press on an `<img>` shows the image menu ("Save to Photos", "Share", "Copy"), for `blob:` and `data:` sources too. It is suppressed by `-webkit-touch-callout: none`, which Khala sets on bubbles under `pointer: coarse` (#1326) so the press can open the Reply menu. In a Home Screen web app (standalone display), users report that long-press save does nothing or is missing for images that Safari saves fine ([Glide community: "Can't save image on mobile PWA"](https://community.glideapps.com/t/can-t-save-image-on-mobile-pwa/66587), [Ionic forum](https://forum.ionicframework.com/t/how-enable-an-ability-of-saving-images-on-pwa/110362)). WebKit has also had blob-URL regressions specific to standalone mode ([WebKit bug 280262](https://bugs.webkit.org/show_bug.cgi?id=280262)). The callout cannot be relied on in the Home Screen app.
- **Web Share with files.** Safari 15+ supports `navigator.share({ files })`, and `navigator.canShare({ files })` detects it ([MDN](https://developer.mozilla.org/docs/Web/API/Navigator/share)). For an image file, the iOS share sheet lists **Save Image**, which writes to Photos. The same API runs in standalone web apps. It needs transient user activation, so it must be called directly from the tap; WebKit throws `NotAllowedError` otherwise ([WebKit: User Activation API](https://webkit.org/blog/13862/the-user-activation-api/)). Awaiting a download first would lose that activation, so the decrypted Blob must already be in memory.
- **Desktop.** Where file sharing is unsupported (most desktop browsers), an `<a download>` with a `blob:` URL saves the file.

### Decision

There are two save paths, and both use standard platform UI:

1. **Press and hold an image in the thread** opens Khala's menu, the same as any message, so Reply still works on images. It now has **Save Image**, which calls `navigator.share({ files: [File] })` synchronously from the tap with the already-decrypted Blob, so it works in Safari and in the Home Screen app. It falls back to `<a download>`.
2. **Tap for full screen.** The viewer is portalled outside the bubble, so it has `-webkit-touch-callout: default` and no press handler. There, the native long-press callout ("Save to Photos") works wherever WebKit offers it. The viewer also has a **Save Image** button that uses the same share path.

We rejected letting the native callout run on the in-thread image. It would take the long-press away from Reply (#1326), and it is the path that fails in standalone mode. We also rejected a manual "download" link only, because iOS opens a blob download as a preview, not into Photos.

## 4. Manifest, CSP and headers

- **CSP.** `img-src` was `'self' data:`, which blocks `blob:` images. It is now `'self' data: blob:`. No remote image origin is admitted. `connect-src` already admits the homeserver for the media fetch. `worker-src` already had `blob:`.
- **Manifest.** The app ships no web manifest; only `apple-touch-icon` exists. Home Screen launches use iOS defaults. Nothing in a manifest restricts images, sharing or callouts, so none was added.
- **Headers.** `X-Frame-Options: DENY` and `frame-ancestors 'none'` affect iframes only. The Home Screen app is not framed. Nothing else blocks `blob:` images or Web Share.

## 5. Safety

- The type is sniffed from magic bytes (PNG, JPEG, GIF, WebP), never taken from the file name or the sender's `mimetype`. SVG, which can carry script, is never accepted. Receivers re-validate the event and show only encrypted, allowlisted images. The agent re-sniffs the decrypted bytes before writing the file.
- **EXIF/GPS.** The web re-encodes JPEG through `createImageBitmap` and a canvas, which applies orientation and drops all metadata. If that fails, it strips APP1/APP13/COM segments. The agent strips those segments byte-wise. PNG/WebP metadata chunks are left; they rarely carry location.
- **HEIC.** iOS Safari hands HEIC to `accept="image/*"` inputs as JPEG. HEIC files from agents are refused rather than converted.
- **Agents.** Image content is untrusted. Wakes stay constant nudges, and the inbox shows only `[image: name, WxH]` plus any caption. Nothing downloads until the agent calls `khala_read { download }`, which writes to its own session state directory with mode 0600.
- **Local mode.** The local helper accepts only `m.text`/`m.notice` and has no media repo, so images are hosted only.
