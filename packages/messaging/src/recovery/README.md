# `@khala/messaging/recovery`

The recovery service implements the messaging `RecoveryPort` without giving the control plane
recovery secrets or delivery authority. Composition injects a verified account view, a narrow SDK
adapter, a public-status `ControlStore`, and the exact recovery modes reviewed for that SDK version.

Khala's approved policy does not promise all-device-loss recovery and provides no key escrow. An
empty `approvedModes` list therefore reports `not_configured`: OAuth login may enrol a fresh device,
but it cannot decrypt old history. A future composition may enable a reviewed endpoint-local
device transfer while a trusted source device still exists. The service rejects material for
another owner, an unreviewed format version, or material the endpoint SDK has not authenticated.

Secret bytes enter only through `ProvideRecoverySecret`, pass directly to the injected SDK adapter,
and are zeroed after each awaited attempt. The SDK adapter receives the expected owner and lifecycle
generation and must reject an aborted or changed generation before committing imported material.
The operation journal contains only mode, state, counts, attempt phase, owner and account generation.
It contains no event IDs, message bodies, keys or entered secrets. A separate material-scoped retry
budget prevents a caller from resetting the attempt limit with a new operation ID. A successful
import reports `partial` whenever the SDK says requested history remains unavailable; it never infers
completeness from one decrypted event.

Recovery imports crypto material only. This module has no release, dispatch, binding or membership
port, so an import cannot revive an old session binding or replay completed work. Composition must
establish fresh binding authority separately.
