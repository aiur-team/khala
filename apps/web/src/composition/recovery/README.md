# Browser recovery composition (KHA-136)

`createBrowserRecoveryPort` adapts the route context's real `IdentityPort` and `DevicePort` and the
KHA-129 recovery service to the KHA-127 panel's `RecoveryPorts`.

- **Recovery (P14).** No history recovery and no escrow. `beginRecovery` always refuses with
  `unsupported_mode` and never calls the secret callback. A ready device shows `partial` history:
  only what arrived after its own admission. Any other device state shows `unavailable`.
- **Revocation.** Delegated to an optional owner-scoped `BrowserRevocation`, which lists the owner's
  targets with their control-plane generation. Without it, no target is offered and `revoke` answers
  `unavailable`.
- **Closure (P13).** No approved closure command exists, so `closure` is `null` and `closeRoom`
  answers `unavailable`. Nothing here deletes storage in its place.
- **Lifecycle.** Device views from a replaced generation are ignored. `dispose` closes only this
  port's observers and discards identity or capability reads still in flight. The shared device and
  messaging lifecycle stay owned by KHA-132.

`projectRecovery` builds the serialisable status view field by field from an allow-list: operation
ID and kind, device state, history, the recovery refusal and allowed actions. No key, password,
SDK token or principal can reach it.

`registerRecovery({ render, revocation })` is `ready` only when it is given a `render` slot. The
human route has no recovery slot yet, so `registerHumanCapabilities` keeps it unavailable.

## Not wired here

- The human route exposes no slot to render the panel into.
- The control plane serves no owner revocation route. The binding-side ports exist
  (`lookupBinding`, `disableBinding`, `revokeAdapterCapability` in `@khala/control/agent-bootstrap`);
  a route also needs a Matrix `ProtocolRevocationPort` and a device-key lookup.
- KHA-130 defines no typed closure command.
