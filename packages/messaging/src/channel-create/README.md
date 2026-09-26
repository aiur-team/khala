# Human-confirmed channel creation

RD9A, `channel-create-workflow` (`docs/product/internal-mode/room-discovery.md`). An agent's create intent is only a
`channel-access-journal` row (`/api/agent/channel-access/create`). Nothing is created until the owner approves it
through the shared human decision route. This module is the journal's `create` fulfillment consumer. It adds no
second request store or inbox.

| Piece | Role |
|---|---|
| `workflow.ts` | `fulfill(requestHandle)` claims the approved row through `claimCreate`, which rechecks owner authority and requester revocation on every call. It then creates exactly one channel through a `ChannelCreateAdapterPort`. |
| `adapter.ts` | Implements `ChannelCreateAdapterPort` over `ChannelSubstrate.createRoom` / `findCreatedRoom`, keyed by a stable idempotency key. |
| `decisions.ts` | Wraps `ChannelAccessDecisionPort`. Approving a `create` row runs `fulfill`, and inbox reads finish approvals whose creation did not complete. |
| `authority.ts` | A create-aware `GrantExchangeAuthority`. The requester's own create operation is admitted into the one channel it created. Every other operation goes to the access authority. |
| `compose.ts` | `composeChannelCreate` returns the decorated decision port for `createChannelAccessHandlers`, plus the `authority` wrapper for `composeChannelAccessExchange`. The hosted adapter helper, `hostedChannelCreateAdapter`, lives in `apps/control/src/composition/agent/channel-create.ts`. |

## Guarantees

- **Nothing before approval.** A pending row makes `fulfill` return `unavailable` with no adapter call, record,
  grant, or catalog write. The connector exchange for an unapproved create operation is also `unavailable`.
- **One channel.** A `channel-create/<digest>` record is written before the adapter is invoked, and it holds a
  two-minute attempt lease. A resumed attempt reconciles first. It creates again with the same idempotency key only
  when the substrate proves the room is `absent` and the lease has ended. The hosted Matrix substrate never proves
  absence, so its `outcome_unknown` stays unresolved until the room is found.
- **Secret by default.** No discovery catalog entry is written, and a channel with no catalog record is `secret`.
- **Only the requester.** The exchange authority locates the row by the connector's authenticated requester,
  origin, session generation and fingerprint. The access-shaped authorization it returns names only the created
  channel and that session, with `history: none`. Other participants still need their own approved access requests.
- **No agent process.** Khala never launches, hosts, or selects an agent here. Creation uses the owner's substrate,
  and admission waits for the requesting session's own connector.
- **Denial, expiry, revocation.** A denied or expired request creates nothing. A provider refusal closes the row as
  `revoked`, with no channel shared with the agent.

The internal composition injects its own adapter, the `createAdapter` from
`apps/internal/src/composition/channel-discovery/service.ts`. No production composition root wires
`composeChannelCreate` yet: hosted channel-access routes are not composed (see `apps/control/src/runtime/discover.ts`),
and the internal discovery service builds its exchange without the create-aware authority.

```sh
pnpm --filter @khala/messaging exec vitest run --config ../../vitest.config.ts src/channel-create
```
