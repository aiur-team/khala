---
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
---
# Channel owner and quiet removal

## Goal Capsule
Every viewer sees the creator marked OWNER. Only the creator can remove another human and that human's channel agents. Removed humans silently lose the channel; agents retain the existing removed/disconnected signal.

## Decisions
Use the existing server authority record, never infer ownership from the viewing human or roster order. Expose channel administration through an optional room-port capability for compatibility. Select agents using verified ownership records. Preserve unrelated channels and agents. Reject self-removal and non-owner requests on the server. Old invites must not readmit a removed human; links issued by removed members must become unusable. Removal emits one neutral human leave pill.

## Implementation Units
### U1. Hosted administration
Files: apps/control/src/composition/human/{matrix,handlers,production}.ts and corresponding tests; apps/control/src/invitations/ and agent-join as needed.
Expose authenticated creator lookup and owner-only removal. Revoke room membership for the human and agents, and enforce invitation freshness after removal. Handle partial provider failure without reporting success; retry safely. Tests: creator/non-owner/self/unknown cases, two owned agents plus an unrelated agent, old versus new invitations, membership failures.

### U2. Roster and browser adapters
Files: apps/web/src/features/channel/{members,AgentPresencePanel,ChannelScreen}.tsx (members.ts), apps/web/src/composition/human/{room,browser-api,application}.ts(x), and hosted/local composition wiring plus focused tests/browser specs.
Add OWNER pill, owner-only X, anchored confirmation listing agents, cancel/outside/Escape behavior, and removal callback. Route viewers silently to channel list on membership loss. Tests cover every viewing role, cancellation and confirmation, live membership loss, responsive light/dark UI.

### U3. Contract, local parity and integration
Files: packages/contracts/src/messaging/channels.ts; packages/agent/src/local/routes/owner.ts and tests; user docs and integration seams.
Add optional administration capability to the room port. Local remains single-human: label that owner, reject self-removal, retain existing agent removal and token invalidation. Integrate adapters and documentation.

## Verification Contract
Focused Vitest tests and browser tests, then repository typecheck/lint/test/build and applicable visual checks. Inspect actual ownership, invitation, and membership event chains. Review authorization and partial-failure behavior before shipping.

## Definition of Done
Implementation and tests satisfy the requested behavior in hosted/local mode; docs reflect the user surface; reviewed draft PR targets main and passes validate before ready/human-review handoff.
