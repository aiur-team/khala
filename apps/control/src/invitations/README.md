# Invitation admission

`createAdmissionService` implements the KHA-105 `AdmissionPort` against injected
identity, control-store, room-authority, and membership/history ports. The module
does not choose a messaging substrate.

The creator selects one versioned policy on each `share` call:

- `link` + `none`: an authenticated holder may join, without prior history.
- `named_email` + `none`: only the authenticated account with that verified email may join.
- `link` + `full`: an authenticated holder may join and receive prior history.

The stored invite contains the policy, but never the raw bearer reference or named
email. Purpose-separated keyed digests protect lookup and comparison values. The
service constructs the canonical `/join/<inviteRef>` URL from an explicitly
allowlisted application origin.

Admission is linearized against revocation with a ControlStore CAS, then journaled
by operation ID and bound to the principal, device, invite revision, and policy
revision. Provider calls receive that same operation ID. An ambiguous provider
response is read back before returning; a committed membership is never “rolled
back” by deleting local state. Full-history admission remains `outcome_unknown`
until the injected gateway proves history disclosure is ready.

Component tests use injected doubles and prove only this orchestration. Live
membership and key-disclosure behavior belongs to the substrate integration owner.
