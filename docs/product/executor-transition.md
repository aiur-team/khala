# Transition from planning to Khala execution

User authorization, 2026-09-16: deeply research all tickets with ce-brainstorm/ce-plan, write and push docs to research, report completion, then primary becomes aiur-run Executor using local aiurdev.

## Before first dispatch

1. Confirm 44 canonical plans, eight epic memberships, requirement coverage and independent review dispositions. Preserve unresolved product decisions as explicit gates; do not dispatch a requirements-only plan.
2. Push reviewed planning artifacts to `research` and record the exact commit. Use `research` as the proposed initial integration base so worker clones contain the plans; PRs preserve a review boundary and do not modify `main` implicitly.
3. Materialize the reviewed Build Order in the actual Aiur discovery paths. Current runtime members use `id`, `title`, `lane`, `phase`, `complexity`, `depends_on`, `ticket`, `doc`; enriched planning metadata stays in the proposal graph and ticket bodies.
4. Resolve tracker publication under the recorded Executor authority. Roots and epics remain undispatched; executable issues carry `agent:todo` at creation, with `agent:paused` on unresolved readiness/product gates. Native relationships must match the approved dependency graph before admission.
5. Create only Khala's repo-local config and isolated workspace root. Preserve GitHub triage/author checks; never impersonate an operator to bypass admission. Initial ready work is the workspace and isolated feasibility proofs, not production rollout.
6. Recheck host resources, peer capacity, release stamp and port. Use the actual Khala instance identity. Source checkout and project root are different concepts; keep them separate. Any release rebuild/restart is coordinated with the peer Executor.
7. Launch with `--executor`, verify the listener and roster, arm durable event consumption plus bounded quiet audits, then dispatch ready independent work. Verify Build Order dashboard rendering before claiming runtime planning-pack completion.

## Authority and constraints

- Planning commits and push to `research`: explicit.
- Operating local aiurdev as Khala Executor after planning: explicit.
- Aiur defect creation with `agent:todo` and peer notification: separately explicit; follow `docs/operations/aiur-coordination.md`.
- Khala scope: the approved 44 tickets. Scope changes and paid provisioning still need a concrete decision; research proof is not purchase authority.
- Workers may prepare changes and reviewable PRs within their assigned scope. Do not claim merge authority from a generic green check; record applicable user authority and branch policy before any merge.
- Never mutate the peer's repo-local config, stop by process name, disable admission gates or silently repoint shared operator surfaces.
- No debug capture of real participant plaintext/keys. Runtime diagnostics remain sanitized.

## Finite completion condition

KHA-140 owns root acceptance. Complete means the selected collaboration scenario, E2EE/review boundaries, existing-session delivery, expansion to a third owner, dashboard-native UI, recovery and support docs have evidence on the merged candidate under recorded merge authority. Closed issues or mock-only tests do not establish completion.

Contained defects return to their ticket; independent acceptance blockers get a reviewed graph amendment; nonblocking optimizations remain deferred. Keep maximum useful concurrency within measured host/provider/fleet capacity and shared write conflicts.
