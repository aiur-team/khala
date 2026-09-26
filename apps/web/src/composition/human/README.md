# Human web composition

This directory is the browser composition root for the ordinary human flow. It
joins the verified identity, the identity-scoped device lease, room and
admission adapters, route controllers, and optional feature capabilities. A
feature receives its dependencies here; it does not discover a global service
or create another messaging client.

## Capability seam

`registerHumanCapabilities()` is deliberately a finite list of literal imports.
It always returns the `review`, `controls`, and `recovery` slots. Until their
follow-on composition tickets replace the matching `register.ts` modules, each
slot reports `state: "unavailable"`, attaches no behavior, and exposes only an
idempotent no-op disposer. Request URLs, route parameters, and host input never
select a module to import.

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

## Routes and entry

The site root `/` belongs to the public landing page (`netlify.toml`), so the
application routes live below it: `/new` creates a channel, `/join?invite=…`
admits a shared link, and `/channels/<id>` opens a channel. The SPA entry reads
an optional `?mount=hosted-content` parameter to boot without standalone chrome,
then strips it before routing; any other value boots standalone.

The Matrix adapter accepts timeline attribution only after the same-origin
control API maps a canonical local Matrix account to its authenticated Khala
owner and participant ID. It then matches the event's claimed Ed25519 key to a
Matrix device ID. A missing mapping or key match fails closed; sender strings
and display names never become owner authority.
