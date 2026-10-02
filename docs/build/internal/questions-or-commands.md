# Internal mode build — questions and commands

## Boundary and permissions (operator, 2026-10-02)

- Planning only. Commit and push the planning branch `plan/internal-mode`; open a **draft** PR; do not merge it.
- Do **not** create GitHub issues and do **not** dispatch Aiur. Promotion is a later, separate Executor action.
- Settled decisions D1–D8 are recorded verbatim in the plan's Key Decisions.

## Open — planner decisions the operator may overturn (none blocks the start)

- **Q1 (P1) Owner browser auth.** The helper gives the browser an owner cookie only via a single-use `/open/<token>` link (`khala local create` returns `openUrl`; `khala local open` mints another). A helper restart signs the browser out until a new open link is used. Alternative: persist owner sessions on disk (ID11). Default: as planned.
- **Q2 (P2) Two links at create.** `khala local create` returns `selfLink` (the creating agent joins with it) and `shareLink` (for the next agent). Default: as planned.
- **Q3 (P3) Hosted-username cache.** Nothing caches a hosted username today, so D8's "cached hosted username" needs a writer: the hosted agent client writes `<stateRoot>/hosted-profile.json` on each hosted connect from its own default display name. Local only, never sent anywhere. Default: as planned (KI-122).
- **Q4 (P4) Web build step.** The local web app is a second Vite build (`pnpm --filter @khala/web build:local`). Install docs add that one step; the helper answers `503 web_not_built` with the instruction when it is missing. Alternative: the helper builds on first use (slow first start, needs devDependencies). Default: as planned.
- **Q5 Viewer display name.** Hosted shows the viewer as the email first name (`matrix-browser.ts:434`); local has no email, so the local viewer shows the username. Default: username.
- **Q6 "Join announced in channel" rendering.** Joins and leaves are posted by the helper as channel events (`com.khala.event.v1`, kind `member`), which the web shows with the existing event pill and agents receive as non-waking events. No new UI. Default: as planned.
- **Q7 Unread counts.** The local channel list computes unread counts in the browser from a last-seen marker in localStorage (no helper read receipts). Default: as planned.

## Answered

- D1–D8 (operator, 2026-10-02): see the plan.
- Model routing: Codex Sol 6.1 for logic tickets, Claude Opus for UI tickets (KI-144, KI-145, KI-171); KI-161 is Executor-owned (`human:todo`).
