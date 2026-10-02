# Ticket writer brief (M1 build)

You expand rows of [`roster.md`](roster.md) into worker-ready ticket documents. You are a planner, not an implementer. Never edit product code, never commit or push, never touch GitHub. Write only `docs/build/m1/tickets/<ID>.md` for the IDs you were assigned.

## Repository facts and hazards

- **Repo:** `/tmp/claude-1000/-home-everdred-github-everdred-khala/18d3495f-d7d6-4668-b3b9-400fcabf4882/scratchpad/main`, branch `reset/m1-external-plan`.
- **Researched base:** `main` at `5db209cc`. Product code is unchanged on this branch, so read code here.
- **Shell hazards:**
  - Never `cd` into the repo; it hangs. Use absolute paths and `git -C <repo>`.
  - Use `/bin/ls`, not `ls`.
  - Do not use heredocs.

## Read first

1. `docs/plans/2026-10-01-002-refactor-external-m1-thin-path-plan.md`: the M1 plan, with KTD1–11 and units U1–U17.
2. `docs/plans/2026-10-01-003-feat-channel-events-plan.md` (events lane only).
3. `docs/build/m1/contracts.md`: the authoritative shapes. Quote the relevant C-sections verbatim in your ticket; never invent a variant.
4. `docs/build/m1/roster.md`: your rows, their dependencies, and sibling boundaries.
5. `docs/product/khala-spec.md`: the operator spec, for intent.
6. `/home/everdred/.claude/plugins/cache/compound-engineering-plugin/compound-engineering/3.19.0/skills/ce-plan/references/plan-sections.md` and `.../deepening-workflow.md`. Apply ce-plan's implementation-ready contract and its confidence/deepening pass to each ticket, non-interactively; there is no user to ask.

## Who reads your ticket

A capable but literal model (Codex Sol 6.1; design lane: Claude Opus 5.5). It will do exactly what the ticket says. It must be able to start within minutes and finish without guessing. **Foolproof** means:

- Every file to create or modify has its full repo-relative path. Every existing function, type or module you tell it to reuse or edit is **verified to exist at `5db209cc`** with `path:line`. A phantom reuse target is a blocking defect.
- One worked example of each data shape it produces or consumes. Quote it from contracts.md where one exists.
- Numbered steps in order, including what to delete.
- Explicit non-goals that name the sibling ticket owning adjacent work.
- Exact test file paths and enumerated test scenarios (input → action → expected).
- The exact local commands it should run. Run only the tests relevant to the touched package, for example `pnpm --filter @khala/control test`, plus `pnpm typecheck`. Do not ask it to wait for CI.
- What "done" looks like, observable.

## Ticket document format

Write `docs/build/m1/tickets/<ID>.md` in this shape:

```markdown
# <ID> — <Title>

**Lane:** <lane> · **Complexity:** <1-5> · **Model:** codex | claude-opus · **Depends on:** <IDs or none> · **Serializes with:** <IDs or none>
**Plan context (pinned):** [M1 plan](https://github.com/aiur-team/khala/blob/reset/m1-external-plan/docs/plans/2026-10-01-002-refactor-external-m1-thin-path-plan.md) · [contracts](https://github.com/aiur-team/khala/blob/reset/m1-external-plan/docs/build/m1/contracts.md) · [roster and graph](https://github.com/aiur-team/khala/blob/reset/m1-external-plan/docs/build/m1/roster.md)
**Exclusive write surfaces:** <paths this ticket owns>

## Outcome
## Context and evidence           (why; cite plan U-ID/KTD/R/AE and research with path:line)
## Scope
## Non-goals                      (name the owning sibling ticket for each)
## Existing owner and reuse target   (verified path:line at 5db209cc)
## Contract and invariants        (quote contracts.md sections verbatim)
## Implementation pointers (refreshable @ 5db209cc)
   ### Files                      (create / modify / delete lists)
   ### Worked example             (data in → data out)
   ### Steps                      (numbered)
## Test scenarios                 (file path + enumerated cases; mark `Covers AEn` where relevant)
## Verification                   (exact commands; observable done-state)
## Risks and stop conditions      (when to stop and ask the Executor instead of improvising)
## Complexity rationale
```

Keep each ticket tight; length should come from precision, not prose. Typical length is 120–250 lines.

## When done

Return one line per ticket, `<ID> — written — <n> lines — <any blocking concern>`. Also list any roster or contract problem you found: a wrong dependency, a phantom file, or a shape that cannot work. Do not fix the roster yourself.
