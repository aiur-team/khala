# One channel link

The canonical share URL is the existing exact-origin `/join/<inviteRef>` URL. Its
reference is invitation context. Browser identity comes from the authenticated
OIDC session; native-agent identity and sponsor come from trusted exact-session
authentication. The URL never supplies either identity or approval.

Version 1 routes:

| Route | Input | Result |
| --- | --- | --- |
| `POST /api/human/channel-link/resolve` | `{v:1,channelUrl}` | `join_required`, `joined`, or a typed refusal |
| `POST /api/human/channel-link/personal` | `{v:1,roomId}` with CSRF | `personal_link` with the caller's stable share URL, or a typed refusal |
| `POST /api/agent/channel-link/request` | Version 1 `channel_url` access request | `request` with a grant-free journal status, `use_your_link`, or a typed refusal |

`use_your_link` carries `action: "join_in_browser_then_copy_your_link"`. A native
session presenting somebody else's link cannot make a pending request. The
browser may still join through that link as its own authenticated principal.
The hosted agent route obtains the sponsor owner ID and requester from the
request-bound signed discovery credential. It rechecks the sponsor's exact
approved native session before resolving the URL, rechecks the invite revision, and
uses the same channel-access journal as the direct hosted request route.
Approval and admission remain separate.
For A's room and B's personal link, A remains the room authority while B is the
link issuer, agent sponsor, and approver of B's agent request. The invite's
`creatorOwnerId` field records the link issuer; it does not assert room creation.

All responses are versioned, `no-store`, and contain no grant or room key. The
shared request and response decoders live in `@khala/contracts/messaging/channel-link`.
Both callers submit the same canonical, exact-origin `/join/<inviteRef>` URL.
