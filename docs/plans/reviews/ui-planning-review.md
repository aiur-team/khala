# UI planning review

2026-09-16. Scope: KHA107,122–127,132,134–136,143. Requirements-first canonical artifacts were enriched in place using ce-brainstorm and ce-plan; deepening inspected actual Aiur dashboard source/CSS/screenshot, Archon references, primary upstream docs, and canonical105/106 contracts. The source and runtime-access limitations are recorded in `docs/evidence/ui-planning-grounding.md`.

Applied ce-doc-review headless coherence, feasibility, design, security and technical adversarial lenses inline under the four-agent cap. This author review is not independent model corroboration. Transport agent independently reviewed the enriched UI contracts and identified the dependency-cycle and acknowledgment issues below. No external model route or runtime experiment was run for this review. The independent report is `docs/plans/reviews/transport-ui-independent-review.md`; its seven findings were corrected and verified. Parent integration may add additional independent findings.

## Corrections incorporated

| Finding | Evidence before correction | Resolution |
|---|---|---|
| Shell and client comparison acceptance boilerplate |107/143 AE2 mentioned authorization/idempotency unrelated to their outputs |Ticket-specific asset/theme/navigation and unsupported-hook failure examples; explicit Product Contract clarification note |
| Client comparison dependency cycle |143 U2 consumed107 chrome although107 depends143 |Experiment-local fixture from pinned Aiur source; no107 import |
| Invitation route dependency cycle |124 awaited132/131 route implementation while132 depends124 |Injected RouteCodec tested with synthetic fixture;132 later supplies concrete mapping |
| Refresh inferred unavailable room identity |122 suggested navigating already-created room after losing memory journal |Show unresolved outcome without recreation unless confirmed roomId remains available |
| Approval and policy stale-generation seam |125 sample omitted expectedBindingGeneration;126 ack lacked current fields |Aligned106 generation, echoed command identity, nullable effective versions and unknown outcome reconciliation |
| Misleading offline/error fixture |126 used a noncanonical connector_offline error |Offline acknowledgment uses null errorCode; unknown effective policy disables control submission |
| Future registration modules would not compile |132 deferred list edits until134–136 |One-time unavailable placeholders and finite list in132/133; later tickets replace owned modules only |
| Integration runner did not exist |Composition plans invoked an unowned test:integration script |101 owns Playwright config/discovery; suites require live env and cannot skip green |
| Platform handler publication ambiguous |132 had no exact backend registration contract |Aligned parent131 finite handlers factory, generated khala-control entry and route allowlist |

## Readiness and retained decisions

107,122,123,124,125,132,134,143 have implementation-ready plans conditional on predecessor evidence and declared environment gates.126/127/135/136 retain requirements-only readiness because automation and recovery/retention product decisions remain unanswered; detailed candidate units are not dispatch authorization. No product gate was treated as a technical default.

All12 have four bounded units with owned paths, requirements/dependencies, failure scenarios and future verification commands. Structural document checks validate section presence, unit sequencing and JSON examples; `docs/evidence/ui-planning-structure-check.json` records those checks and explicitly does not claim runtime tests. Independent review found no reason to change dashboard-native inheritance, standalone Netlify delivery, existing-session reuse, or accepted connector gate.

Remaining risks are concrete predecessor proofs: Matrix/substrate adoption, supported encrypted browser/headless SDK lifecycle, and real harness attachment. Source screenshot inspection is not a live authenticated dashboard run: local dashboard request returned401, documented in grounding. Future executor must run the actual browser/live integration evidence before reporting completion.

Review complete.
