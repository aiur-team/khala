# One channel link

The canonical share URL is the existing exact-origin `/join/<inviteRef>` URL. Its
reference is invitation context. Browser identity comes from the authenticated
OIDC session. The URL never supplies identity or approval.

Version 1 routes:

| Route | Input | Result |
| --- | --- | --- |
| `POST /api/human/channel-link/resolve` | `{v:1,channelUrl}` | `join_required`, `joined`, or a typed refusal |
| `POST /api/human/channel-link/personal` | `{v:1,roomId}` with CSRF | `personal_link` with the caller's stable share URL, or a typed refusal |

All responses are versioned, `no-store`, and contain no grant or room key. The
shared request and response decoders live in `@khala/contracts/messaging/channel-link`.
Browser callers submit the same canonical, exact-origin `/join/<inviteRef>` URL.
