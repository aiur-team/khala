# Revision 4 proposal validation

This validates proposal structure, not implementation readiness or a materialized Aiur pack. Detailed contracts, review and runtime rendering remain outstanding after scope sign-off.

- 44 unique leaf IDs; eight undispatched epics; each leaf belongs to exactly one epic.
- 15 requirements have explicit ticket dispositions.
- All dependency references resolve; no cycles; nine computed antichain levels.
- All 44 draft document paths exist and are safe; tracker pointers remain null.
- No identical or parent/child overlaps among proposed primary write surfaces.
- Symmetric conflict invariant holds (no current explicit conflict pairs).
- Current-document local links resolve; historical recovered artifacts excluded.

## Earliest start by lane

| Lane | Earliest level | Blocking basis |
|---|---:|---|
| acceptance | 9 | KHA-138, KHA-139 |
| adapters | 3 | KHA-101, KHA-106 |
| connector | 4 | KHA-101, KHA-105, KHA-106 |
| foundation | 1 | None |
| identity | 4 | KHA-101, KHA-105 |
| integration | 5 | KHA-108, KHA-110, KHA-111, KHA-112, KHA-113, KHA-114, KHA-115, KHA-116, KHA-117, KHA-118, KHA-121, KHA-122, KHA-123, KHA-124, KHA-131 |
| messaging | 4 | KHA-101, KHA-105 |
| platform | 2 | KHA-101, KHA-102 |
| policy | 4 | KHA-101, KHA-105, KHA-106 |
| research | 1 | None |
| verification | 4 | KHA-101, KHA-105, KHA-106 |
| web | 3 | KHA-101, KHA-143 |

## Limits and review disposition

Transport review identified link-to-owner authorization, non-atomic SDK/inbox stores, shared manifest conflicts and a missing runtime composition risk. Revision 4 assigns these to 144/114, 115, the dependency owner, and 133 respectively. All library-to-production seams have named integration owners in the repository layout.

The widest level is 20, not a fleet allocation. Product gates, shared environment availability, review and host capacity reduce practical concurrency. Complexity 2–3 estimates must be rechecked against detailed plans; split any member that develops multiple independent outcomes. No agreed depth budget exists yet.

The bundled Aiur runtime validator is not applied to this enriched proposal graph: it is not a canonical runtime pack. Do not report this structural audit as complete aiur-build or per-ticket CE execution. Final planning requires exact interface examples, pinned source/version evidence, repeated adversarial review, approved planning commit and coordinated dashboard rendering.
