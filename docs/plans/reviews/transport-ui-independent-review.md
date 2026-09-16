# Independent transport review of UI planning

Reviewed 2026-09-16 by transport_protocols, separate from the UI plan author. Scope: KHA-107,122–127,132,134–136,143. Read Product Contracts, then enriched planning exports, flows, units and verification, with deeper inspection of review/control/composition boundaries. This is a cross-agent review in the same model family, not cross-model corroboration. No browser/runtime tests executed.

## Concrete findings and dispositions

| ID | Severity | Finding | Disposition |
|---|---|---|---|
| UI-T01 | P1 |143 experiment U2 consumed107 chrome contract while107 depends143, creating a hidden implementation cycle | Author replaced with experiment-local fixtures grounded in read-only Aiur source; verified on disk |
| UI-T02 | P1 |124 route parsing waited for132/131 mapping while132 depends124 | Author changed124 to injected RouteCodec with synthetic component fixture;132 later injects concrete131 mapping; verified |
| UI-T03 | P1 | Static composition could import later absent134–136 files and required later shared-entry edits |132/133 bootstrap typed unavailable registration modules once;134–136 replace owned placeholders; unavailable never reports ready. Parent coordinates narrow bootstrap ownership exception |
| UI-T04 | P1 |125 approval sample omitted new106 expectedBindingGeneration and126 ack examples lacked request/generation correlation | Author aligned canonical commands, unknown results, expired content and nullable ack versions; verified |
| UI-T05 | P2 |143 attributed substrate selection to141 and whole existing-session product proof to144 | Author names102 selection,141 browser feasibility,103/104 attachment and139 product acceptance; verified |
| UI-T06 | P2 |122 memory-only operation journal could not always route to an already-created room after refresh/lost acknowledgement | Author preserves unresolved state when room ID/resume reference absent; no automatic recreation; verified |
| UI-T07 | P2 |126 worked ack used connector_offline outside106 error union; projection forced known mode even with null authoritative version | Author corrected and verified: offline is connectorState, with null error for successfully persisted intent; effectiveMode allows unknown/null and disables actions until authoritative snapshot |

## Positive boundaries checked

- 107 shell remains free of auth/feature dependencies and does not require an iframe protocol.
- 123 reuses SDK ordering and separates safe message rendering from native approval controls; no pending plaintext model notification.
- 124 treats URL as locator, uses verified identity and does not introduce human connector/Matrix setup.
- 125/134 preserve exact event refs, owner authority outside request JSON, command identity and uncertain external effects.
- 126/135 distinguish requested/effective controls, busy/queue/consumption and optional cancellation; backlog policy remains an explicit product gate.
- 127/136 preserve local-only recovery secrets, partial/unavailable history and unknown delivery outcomes; no global erasure promise.
- 132/133 own single-device lifecycle and generation guards; later feature registrations stop only their own observers.

Existing substrate/admission/automation/retention/harness gates remain. A document can be structurally complete while its runtime proof is still blocked; no skipped or mocked live case counts as launch evidence. No new product feature requested by this review.

Review complete
