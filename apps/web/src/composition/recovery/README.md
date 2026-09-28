# Browser recovery composition (KHA-136)

`createBrowserRecoveryPort` adapts the route context's real `IdentityPort` and `DevicePort` and the
KHA-129 recovery service to the KHA-127 panel's `RecoveryPorts`.

- **Recovery (P14).** No history recovery and no escrow. `beginRecovery` always refuses with
  `unsupported_mode` and never calls the secret callback. A ready device shows `partial` history:
  only what arrived after its own admission. Any other device state shows `unavailable`.
- **Revocation.** Delegated to an optional owner-scoped `BrowserRevocation`, which lists the owner's
  targets with their control-plane generation. Without it, no target is offered and `revoke` answers
  `unavailable`.
- **Closure (P13).** An optional owner-scoped control port supplies the current channel capability,
  executes the typed closure command and inspects retries. Without the registered protected route,
  the capability remains `null`; when the route exists without a protected connector stop mailbox,
  its capability is unavailable. No local storage deletion is used as a substitute.
- **Lifecycle.** Device views from a replaced generation are ignored. `dispose` closes only this
  port's observers and discards identity or capability reads still in flight. The shared device and
  messaging lifecycle stay owned by KHA-132.

`projectRecovery` builds the serialisable status view field by field from an allow-list: operation
ID and kind, device state, history, the recovery refusal and allowed actions. No key, password,
SDK token or principal can reach it.

`registerRecovery({ render, revocation, closure })` is `ready` only when it is given a `render` slot.
The hosted channel room mounts `RecoveryPanel` directly with its owner-scoped browser closure port.
The generic capability slot remains unavailable until it has a separate render host.

## Not wired here

- The generic human capability registry exposes no separate slot to render the panel into.
- The control plane serves no owner revocation route. The binding-side ports exist
  (`lookupBinding`, `disableBinding`, `revokeAdapterCapability` in `@khala/control/agent-bootstrap`);
  a route also needs a Matrix `ProtocolRevocationPort` and a device-key lookup.
- The protected connector stop mailbox must be bound before the production closure capability is offered.

The mounted room panel uses a tab-scoped write-ahead operation reference. It stores only
operation identity (kind, owner, room, device, generation and room revision) before a
closure/revocation request, then inspects that same ID after reload. An initial
unavailable identity read delays inspection until the owner is known; the store is
owner/room scoped, and a different device clears its reference. If tab storage cannot commit the reference, the
controller refuses to start the effectful request. This is UI continuity, not key or
message-history recovery.
