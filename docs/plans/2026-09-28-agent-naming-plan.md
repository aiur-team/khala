# Agent naming in channels

An owner sends a validated encrypted rename event in the channel timeline. Readers replay events in channel order from stable participant identities, preserving the old label on earlier messages and applying the new label to later messages. Stable IDs, ownership, approval, trust, and permissions remain separate from names.

The browser and agent endpoints resolve room-scoped participant identities through an authenticated directory. A rename is shown only after its encrypted send is confirmed; retries reuse one transaction ID. Local internal mode authorizes against its roster. Agent read includes an ordered metadata event. The example showcase uses a fictional event and the shared row component.

Verify validation, authorization, retry/deduplication, historical projection, hosted and local browser flows, agent read, typecheck, lint, build, and exact-head CI. Run a disposable two-agent proof when the environment permits.
