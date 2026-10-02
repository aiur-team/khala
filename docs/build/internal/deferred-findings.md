# Internal mode build — deferred-findings ledger

Discovery policy (finite feature boundary):
- P0 and P1 findings that block an acceptance scenario in the plan (AE1–AE12) are promoted to new `KI-` tickets with `discovered_from`.
- Contained review findings go back to the owning ticket as rework.
- P2/P3 findings and optimizations are recorded here and do not expand the run.
- Circuit breaker: if promoted discoveries outnumber completions 2:1 over any 24 hours, freeze new ticket creation and ask the operator.

| ID | Finding | Severity | Source | Disposition |
|---|---|---|---|---|
| ID1 | Cross-machine local channels over a tailnet (`tailscale serve` in front of the same helper; owner confirm for remote joins; "on this machine" copy changes) | P2 | D1 | Next phase; see the plan's follow-on note |
| ID2 | More than one human in a local channel | P2 | D1, spec §3.1 | Out of scope (spec: one human) |
| ID3 | Auto-prune of idle local channels / retention settings | P3 | D6 | Later; channels persist until deleted |
| ID4 | A `khala_local_create` MCP tool instead of the shell command | P3 | brainstorm §2 | Later; MVP uses `khala local create` in the agent's shell |
| ID5 | One agent session in a hosted and a local channel at the same time (multi-channel membership) | P2 | research-3 Q3 | Later; one channel per session across types, as #943 |
| ID6 | Encryption at rest for local logs (beyond 0700/0600) | P3 | spec §3.1 open item | Later; full-disk encryption is the user's job |
| ID7 | Promote a local channel to hosted / export history | P3 | old F7 | Rejected for MVP |
| ID8 | Rate guard that downgrades two looping local agents to async with a private owner alert | P2 | research-3 §4.5 | Later; no-self-wake and the Codex two-attempt cap remain |
| ID9 | Strict no-egress mode restricted to local-model agents | P3 | D3 | Rejected for MVP (D3 narrows the promise honestly) |
| ID10 | OpenCode, desktop apps, other harnesses in local channels | P3 | spec | Later |
| ID11 | Browser owner session survives a helper restart (persisted owner sessions) | P3 | L11 | Later; `khala local open` mints a fresh open link |
| ID12 | Configurable or auto-moving helper port | P3 | L11 | Later; fixed 47830 with `port_in_use` |
| ID13 | After an agent is removed or its channel deleted, `khala_status` stays `connected` until the next read/send fails (same as a kicked hosted agent) | P3 | KI-121 research | Later; would change the pinned L9 interface |
