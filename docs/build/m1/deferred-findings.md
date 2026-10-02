# M1 build — deferred-findings ledger

Discovery policy:
- P0 and P1 findings that block acceptance are promoted to new `KM-` tickets with `discovered_from`.
- Contained review findings go back to the owning ticket.
- P2/P3 findings and optimizations are recorded here and do not expand the run.
- If promoted discoveries outnumber completions 2:1 over any 24 hours, freeze new ticket creation and ask the operator.

| ID | Finding | Severity | Source | Disposition |
|---|---|---|---|---|
| D1 | Agent key backup, so history survives an agent restart | P2 | M1 plan Key Decision | M2, first ticket |
| D2 | Full history for humans who join late by link | P2 | R4 change | M2 |
| D3 | Steer/Async listener modes, defensive downgrade, admin controls, invite types, agent-first creation | P2 | spec | M2+ |
| D4 | Claude `claude/channel` push as an opt-in wake upgrade | P3 | wake research | M2+ |
| D5 | Internal mode redesign and deletion of `apps/internal` | P2 | operator | after M1 |
| D6 | matrix-js-sdk 43 upgrade | P3 | Node Matrix research | later |
