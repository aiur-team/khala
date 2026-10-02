# Human web composition

This directory is the browser composition root for the ordinary human flow. It
joins the verified identity, the identity-scoped device lease, room and
admission adapters, route controllers, and optional feature capabilities. A
feature receives its dependencies here; it does not discover a global service
or create another messaging client.

## Capability seam

`registerHumanCapabilities()` is deliberately a finite list of literal imports.
It always returns the `review`, `controls`, and `recovery` slots. Production supplies
the authenticated review and manual-controls clients; a slot without its dependency
reports `state: "unavailable"` and exposes an idempotent no-op disposer. Request URLs,
route parameters, and host input never select a module to import.

Each ready capability will receive a `HumanRouteContext`. That context is the
only extension boundary: it contains approved, identity-scoped ports and the
feature-slot registry needed to mount route content. It must not carry OAuth
credentials, invitation secrets, raw SDK clients, owner authority, or a handle
for mutating the global host.

Capabilities are attached only after identity and device readiness for the
current generation. Their disposers run before observers and device ownership
are released during logout, account switch, route replacement, or application
shutdown. Re-entry creates a fresh attachment for the new route generation;
an old generation must never regain a DOM listener or subscription.

In the hosted browser, the focused tab requests the signed-in owner's device
from another tab over BroadcastChannel. The current tab removes route and
capability authority, closes its Matrix client and crypto store, and releases
the Web Lock before the focused tab can open the store. An inactive tab keeps
the signed-in shell and an inline retry control; focus resumes it. The channel
message contains only the owner identifier and a tab nonce, never credentials.

`screen.tsx` is the route-agnostic application screen: shell chrome, identity
and device status, and the ready route. It imports no route feature and takes
`renderRoute` and `renderSignedOut` from its host. `mount.tsx` binds the hosted
create/join/channel routes and OAuth sign-in to it. The internal browser entry is removed during M1; the frozen internal application
is outside the workspace and build.

Both mount modes render the edge-to-edge Khala frame (`ui/khala/KhalaApp`).
It is one full-viewport card with no topbar, navigation rail or drawer. The
list column starts with the brand row, whose KHALA wordmark links to
`/conversations`. Signed-in owners switch themes and log out from the brand
row's actions. The selected channel fills the main pane, which keeps the
channel header. At 900px and below the card shows one pane. `/channels/<id>`
shows the thread, which has a back control to the list, and every other route
shows the list. Signed-out and account states render in the frame's main
pane. Successful logout
ends the route and Matrix device lease before showing sign-in at `/new`.
After sign-in, the channel index shell appears while the device initializes.
Its channel and create controls stay unavailable until the device is ready;
recoverable device errors show a retry in the index. `/new` also opens the
index; only the `+` action opens channel creation.

## Routes and entry

The site root `/` belongs to the public landing page (`netlify.toml`), so the
application routes live below it: `/new` opens the signed-in index, `/join?invite=…`
admits a shared link, `/agent/confirm?joinId=…` confirms an agent request, `/channels/<id>` opens a channel, and
`/channels/<id>/tools` remains a direct link for recipient review. The SPA entry reads
an optional `?mount=hosted-content` parameter to boot in host-content mode,
then strips it before routing; any other value boots standalone.

The Matrix adapter accepts timeline attribution only after the same-origin
control API maps a canonical local Matrix account to its authenticated Khala
owner and participant ID. It then matches the event's claimed Ed25519 key to a
Matrix device ID. A missing mapping or key match fails closed; sender strings
and display names never become owner authority.

The selected channel's top navigation places conversation settings beside Share.
When an owner-owned, verified agent has pending recipient review, a counted Review
disclosure appears in the same row and reuses the binding-scoped review controller.
The settings disclosure mounts recovery and access actions from the existing
owner-scoped controller. Agent controls stay inside that agent's participant
detail, and Delete conversation stays in the title disclosure. The old tools
route retains recipient review and legacy pause controls as a fallback without a sidebar entry.


## Agent confirmation

An owner opens the agent confirmation link and reviews its label, harness and
channel before pressing **Confirm**. A signed-out visitor uses the existing
**Sign in** button and returns to the same link. While connecting, keep the tab
open: the browser polls status every second and uses its Matrix client to invite
the ready agent with encrypted history. History sharing relies on shared history
visibility and the browser's verified identity. Existing invited or joined members
are treated as success. **Open channel** appears when the invite succeeds.

If connecting times out, **Retry** resumes status checks without confirming again.
If the invite fails, **Retry** attempts only the invite. Closing or navigating away
stops the page's requests and timers; reopening a confirmed link resumes polling.
