# Internal mode build — validation report (plan_version 1)

Command: `python3 docs/build/internal/build_pack.py` (exit 0). Reviewed against `origin/main` `5ad41c8b`.

## Mechanical checks

| Check | Result |
|---|---|
| Unique ids, every `dep`/`ser` reference resolves, `ser` symmetric | pass (26 tickets) |
| Ticket header (complexity, model, depends on, serializes with) equals the roster | pass (26/26) |
| Hard-dependency graph acyclic; every computed phase is an antichain | pass (8 phases) |
| `path:line` pointers exist and are within the file at `5ad41c8b` (contracts, reconciliation, plan, 26 tickets) | pass (≈1,240 pointers, 0 errors) |
| Bare paths that do not exist at `5ad41c8b` | warnings only: `apps/web/dist-local/` (build output created by KI-143) and `docs/evidence/internal-mode-acceptance.md` (created by KI-161) |
| `node scripts/check-terminology.mjs` | pass |

## Graph

| Phase | Tickets |
|---|---|
| 1 | KI-101 |
| 2 | KI-102, KI-110, KI-144 |
| 3 | KI-120, KI-122, KI-130, KI-131, KI-132, KI-133, KI-134, KI-135, KI-136, KI-140 (one same-wave serialization: KI-120 ~ KI-122) |
| 4 | KI-121, KI-137, KI-141, KI-142 |
| 5 | KI-143, KI-151 |
| 6 | KI-145, KI-150, KI-160 |
| 7 | KI-161 |
| 8 | KI-170, KI-171 |

Critical path: 8 waves (KI-101 → KI-110 → KI-140 → KI-141 → KI-143 → KI-145/KI-150/KI-160 → KI-161 → KI-170). Spine: KI-110 (13 direct dependents). Lane earliest starts: platform 1, agent 2, web 2, helper 3, acceptance 5 (needs the composed helper, CI-green). Phase budget 5–10: met.

## Semantic review

- Every ticket has one owner, one outcome and exclusive write surfaces; shared files are serialized (KI-120 ~ KI-122) or owned by one ticket (bin by KI-137, `mount.tsx` by KI-144, `matrix-browser.ts` extraction by KI-141).
- Every cross-ticket shape has one defining owner (contracts L1 + reconciliation R12/R16 pins).
- Every data-flow coupling dropped from the hard graph is reconnected by KI-137, KI-143, KI-145 or KI-160 (plan § Integration ledger).
- Integration and feature acceptance: KI-160 (scripted, agent-runnable) and KI-161 (live, Executor-owned).
- Ticket-writer findings were reconciled in [`reconciliation.md`](reconciliation.md) (R1–R18 contract rulings, G1–G4 graph/scope rulings); one P3 gap moved to the deferred ledger (ID13).
- In-flight PRs (#976, #978, #986, #979, #972, #982) are stop conditions in the affected tickets, not edges; #976 is a soft gate for the rename legs of KI-145/KI-161 (G3).
