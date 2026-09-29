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

`screen.tsx` is the route-agnostic application screen: shell chrome, identity
and device status, and the ready route. It imports no route feature and takes
`renderRoute` and `renderSignedOut` from its host. `mount.tsx` binds the hosted
create/join/channel routes and OAuth sign-in to it. The internal entry
(`apps/web/src/internal`) binds only private create and channel routes, so its
bundle never reaches join, recovery, the Matrix adapter or the control API.

The standalone mount owns Khala chrome. A host-content mount owns only route
content and follows the same authentication and disposal rules, so a future
Aiur host does not create duplicate chrome or alternate authority semantics.
The owner shell links the top logo and KHALA wordmark to `/conversations`. The selected
channel fills the main pane and its title appears in the top navigation. The
sidebar header shows a request count before create only while requests are
pending. Signed-in owners can switch themes and log out from the topbar (or the
content edge in hosted mode). Successful logout
ends the route and Matrix device lease before showing sign-in at `/new`.
After sign-in, the channel index shell appears while the device initializes.
Its channel and create controls stay unavailable until the device is ready;
recoverable device errors show a retry in the index. `/new` also opens the
index; only the `+` action opens channel creation.

## Routes and entry

The site root `/` belongs to the public landing page (`netlify.toml`), so the
application routes live below it: `/new` opens the signed-in index, `/join?invite=…`
admits a shared link, `/channels/<id>` opens a channel, and
`/channels/<id>/tools` opens channel care from the sidebar. The SPA entry reads
an optional `?mount=hosted-content` parameter to boot without standalone chrome,
then strips it before routing; any other value boots standalone.

The Matrix adapter accepts timeline attribution only after the same-origin
control API maps a canonical local Matrix account to its authenticated Khala
owner and participant ID. It then matches the event's claimed Ed25519 key to a
Matrix device ID. A missing mapping or key match fails closed; sender strings
and display names never become owner authority.

The separate channel care page mounts recipient review, agent controls, and the
recovery panel. Closure appears only
when the protected control API returns a capability for the signed-in owner and
current channel. A partial result means local cleanup is still unconfirmed;
the panel keeps the operation identity for inspection. Closure never promises
erasure of transport, other owners' devices, or model provider copies.
