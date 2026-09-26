---
title: "feat: human-confirmed channel creation workflow (RD9A)"
type: feat
status: active
date: 2026-09-25
ticket: "#216"
contract: docs/product/internal-mode/room-discovery.md#rd9a--add-the-human-confirmed-channel-creation-workflow
---

# RD9A — human-confirmed channel creation workflow

## Problem

`channel-access-journal` already journals agent create intents, lets the owner approve them, and exposes a typed
`claimCreate` / `updateCreate` fulfillment port. Nothing consumes that port. The grant exchange
(`channel-access-grant-exchange`) is also access-only: its authority reads `kind: 'access'` rows and needs an
`AuthorizedChannelRef` that a create request does not have until a channel exists.

## Seams reused (no second request store or modal)

- Journal: `ChannelAccessService.decisions` / `.fulfillment`, `ChannelAccessStore.inspectRequester` / `readContext`.
- Provider seam: `ChannelCreateAdapterPort` (`packages/contracts/src/messaging/discovery.ts`) with
  `HumanAuthorizedWorkflowContext` and `ChannelCreateReconciliation`.
- Creation effect: `ChannelSubstrate.createRoom` / `findCreatedRoom`. The hosted Matrix substrate and the internal
  local-transport substrate both implement it; neither assumes `createRoom` is idempotent.
- Exchange: `GrantExchangeAuthorityPort` is injected into `createGrantExchangeService`, so a create-aware authority
  composes in without touching the transport-neutral state machine.
- Web: `channel-access` inbox and `approval-decision` shell render create rows already.

## Units

> **Revised after #339.** `main` moved the channel-access journal and grant exchange into `@khala/messaging` so the
> hosted and internal backends share them, and the boundary check forbids app-to-app imports and bars app code
> outside a composition root from importing package internals. The backend-neutral creation modules moved next to the
> journal, so `apps/internal` can compose them with its own `createAdapter`. Only the hosted adapter helper stays in
> `apps/control`.

1. **Create record + workflow** — `packages/messaging/src/channel-create/workflow.ts`. One `ControlStore` record per
   request handle, `creating → created | closed`, written before the adapter is invoked. `fulfill(requestHandle)`
   claims the approved row through `claimCreate` with a stable claim operation (idempotent, and it revalidates owner
   and requester on every call), then:
   - `creating` with no prior attempt: `adapter.create` with a stable idempotency key.
   - resumed `creating`: `adapter.reconcile` first; only `pending` (proof of not applied) re-invokes `create` with the
     same key; `outcome_unknown` / `unavailable` stay `unavailable`.
   - `denied`: the journal row becomes `revoked` and nothing is admitted.
   The deadline is rechecked before any effect.
2. **Substrate adapter** — `packages/messaging/src/channel-create/adapter.ts`. `ChannelCreateAdapterPort` over
   `Pick<ChannelSubstrate, 'createRoom' | 'findCreatedRoom'>`; maps `found` to `already_created`, `absent` to
   `pending`, `unknown` to `outcome_unknown`. It never writes a discovery catalog entry, so the channel is `secret`.
   Hosted composition maps the room with `channelKey`; internal composition supplies its own substrate and ref.
3. **Decision decorator** — `packages/messaging/src/channel-create/decisions.ts`. Wraps `ChannelAccessDecisionPort`:
   approving a `create` row runs `fulfill` (failure leaves the durable approval to reconcile); `inbox` reconciles
   approved-but-unfulfilled create rows after a restart. Access rows pass through untouched.
4. **Create-aware exchange authority** — `packages/messaging/src/channel-create/authority.ts`. Locates the requester's own
   `create` row first; otherwise delegates to the access authority. For create, it fulfils (idempotently), then
   returns an access-shaped authorization for the one created channel, bound to the original requester, origin,
   session generation, and fingerprint. `close` / `markConnected` route to `updateCreate`.
5. **Composition** — `packages/messaging/src/channel-create/compose.ts` (`composeChannelCreate`) returns the
   decorated decision port and the authority for `composeChannelAccessExchange` (which gains an optional `authority`);
   the hosted adapter helper lives in `apps/control/src/composition/agent/channel-create.ts`.
6. **Web** — `apps/web/src/features/channel-create/`: the creation operation adapter (decision prompt facts,
   post-approval progress copy, decided message) moves here; `channel-access` delegates create rows to it.
   Copy now states that approval creates the channel and the agent connects later.

## Tests (wrong-implementation first)

- Submit a valid create intent without approval: channel substrate, catalog, grant store, exchange records unchanged.
- Hosted-like (never `absent`) and internal-like (replaying) substrates; lost create response; `outcome_unknown`;
  duplicate approval; restart between record and adapter call; deny / expiry / revocation create nothing; wrong or
  stale owner; hostile origin/session/generation/other-requester exchange; only-requester authorization; secret
  default (no catalog write); untrusted title rendering on the web adapter.

## Risks

- No production composition roots exist for channel-access yet (routes are 503 stubs), and no RD8A internal adapter
  exists; this ticket supplies ports + composition helpers and tests them with real stores and substrate fakes.
- Hosted room creation currently runs in the browser; a server-side hosted substrate is a composition input.
