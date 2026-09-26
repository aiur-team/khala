# Release acceptance (KHA-140)

This record decides whether the root build order can close. It is based on the
merged product and requires evidence for each requirement. Closing every leaf
ticket does not change the verdict (AE1). A result is **pass** only when the
evidence below shows it. `unknown` and `not observed` are never shown as pass.

## Verdict

**Root not accepted.** Blocking evidence is missing, and one security row fails.

| Field | Value |
| --- | --- |
| Release candidate | `a120b9eaa33f50e538e2f6376faca4805370e98d` (`origin/main`, 2026-09-26) |
| Recorded | 2026-09-26 by the KHA-140 agent. Linux 7.1.4-arch1-1 x86_64, Node 24.18.0 (CI pins 22.23.2), pnpm 10.34.5 |
| Reviewer | None. A human reviewer signs this record only for a pass. For this verdict, review happens on the PR that lands this record |
| Next decision point | Rerun this record once every blocker in [Findings](#findings) has evidence on one candidate |

```json
{
  "release_commit": "a120b9eaa33f50e538e2f6376faca4805370e98d",
  "requirements": [
    { "id": "R01", "result": "unknown", "evidence": "docs/evidence/collaboration-acceptance.md (3 runs, all blocked)" },
    { "id": "R02", "result": "unknown", "evidence": "docs/evidence/collaboration-acceptance.md" },
    { "id": "R03", "result": "unknown", "evidence": "docs/evidence/collaboration-acceptance.md" },
    { "id": "R04", "result": "unknown", "evidence": "docs/evidence/security-acceptance.md (local composition only)" },
    { "id": "R05", "result": "unknown", "evidence": "docs/evidence/security-acceptance.md (re-arm reconnect not observed)" },
    { "id": "R06", "result": "unknown", "evidence": "docs/evidence/security-acceptance.md (relay confidentiality not observed)" },
    { "id": "R07", "result": "unknown", "evidence": "docs/adapter-guide.md support table" },
    { "id": "R08", "result": "unknown", "evidence": "docs/adapter-guide.md support table" },
    { "id": "R09", "result": "unknown", "evidence": "tests/conformance; no live harness report" },
    { "id": "R10", "result": "pass", "evidence": "package manifests; docs/evidence/client-reuse.md; docs/evidence/backend.md" },
    { "id": "R11", "result": "pass", "evidence": "decisions P16, P11; docs/operations/backend.md" },
    { "id": "R12", "result": "unknown", "evidence": "no recorded desktop/mobile/keyboard run (#238 open)" },
    { "id": "R13", "result": "pass", "evidence": "docs/research/README.md; docs/product/decisions.md" },
    { "id": "R14", "result": "pass", "evidence": "docs/plans/README.md; docs/plans/reviews/README.md" },
    { "id": "R15", "result": "unknown", "evidence": "no hosted journey observed" }
  ],
  "security": "docs/evidence/security-acceptance.md: fail (#380)",
  "collaboration": "docs/evidence/collaboration-acceptance.md: blocked, no live run",
  "root_acceptance": "not-accepted"
}
```

## Checks run on the candidate

AE2 requires the proofs to run on the actual candidate, not on the build each
predecessor recorded. Every check below ran on `a120b9e` with a clean tree. It
first ran on `a4a6adc`, with the same results, before #396 landed on `main`.

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | pass |
| `pnpm typecheck` | pass |
| `pnpm lint` (includes the boundary and terminology checks) | pass |
| `pnpm build` | pass |
| `pnpm test` | pass (includes conformance and E2E in fake/default mode) |
| `node --test tests/integration/agent-setup/setup-acceptance.test.mjs` | pass: 14 pass, 3 todo, 0 fail |
| `pnpm test:e2e -- tests/e2e/security/` | 47 passed, 1 expected fail (#380), 3 live cases skipped. Same as the KHA-138 record on `ba843ba` |
| `pnpm test:e2e -- tests/e2e/collaboration/` | 33 passed, 1 skipped (live entry). This proves only that the evaluator judges evidence correctly |
| `KHALA_E2E_LIVE=1 pnpm test:e2e -- --scenario first-collaboration` (from the plan) | **Not runnable**: the runner has no `--scenario` option. The live entry is `tests/e2e/collaboration/collaboration.test.ts` |
| `KHALA_E2E_LIVE=1 pnpm test:e2e -- tests/e2e/collaboration/collaboration.test.ts` | **fail**: `KHALA_E2E_LIVE=1 requires KHALA_E2E_DISPOSABLE_ENV`. No disposable environment exists, and no harness version is pinned for the case |

The default suites pass. That shows the candidate builds and its component
contracts hold. It does not show that the collaboration product works.

## Ticket requirements

| ID | Requirement | Result | Evidence |
| --- | --- | --- | --- |
| R1 | Validate the chosen collaboration journey on the merged base with real existing sessions | **fail** | No live run. The three KHA-139 runs are all `blocked` before any action. The latest one is blocked only because no harness version is pinned |
| R2 | Separate security, operational and user-experience evidence tied to exact builds | **fail** | Security: rerun on the candidate, with one failing row (#380). Operational: backup/restore rehearsal passed on 2026-09-18 against the packaged Synapse (`docs/operations/backend.md`); no hosted deployment exists. User experience: not observed (#238 open) |
| R3 | Finish user and adapter docs and record limitations without expanding scope | **pass** | [User guide](../user-guide.md), [adapter guide](../adapter-guide.md), and the [findings](#findings) below |
| AE1 | Leaf tickets closed but no evidence of third-owner admission, so the root stays unaccepted | **holds** | `third_owner_independent` and `third_owner_history` are `blocked` in every run |
| AE2 | A proof on a stale build is rerun on the candidate | **holds** | The security and collaboration suites were rerun on `a120b9e` (above) |

## Product requirements

These are the IDs from [requirements coverage](requirements-coverage.md).

| ID | Requirement | Result | Evidence and gap |
| --- | --- | --- | --- |
| R01 | Two humans and two agents, expandable | unknown | Collaboration case `two-owners-then-third` exists but never ran live |
| R02 | Humans read and post as themselves | unknown | The KHA-132 live Playwright suite has no recorded run. Internal mode is one human only |
| R03 | Queue messages for recipient preview | unknown | Covered by the review gate in local composition only |
| R04 | Recipient controls what enters their agent | unknown | Review gate **pass** in local composition (`forgery.test.ts`, `airlock.test.ts`). A live existing-session receipt is not observed |
| R05 | Disable review for a trusted peer and re-arm it | unknown | Pause/resume across a restart passes locally. A reconnect with an unacknowledged re-arm is not observed. Hosted `auto` is closed (G-AUTOMATION) |
| R06 | End-to-end encryption | unknown | Relay confidentiality is **not observed**: no disposable Synapse with database and log access. The crypto experiments are feasibility evidence only |
| R07 | Attach to the existing session | unknown | OpenCode plugin 1.17.10 tested. Claude Code hooks: no proven version. Codex routes blocked on #230 and #266 |
| R08 | Agent sets up pub/sub itself | unknown | `khala setup` passes the packaged gate. Installed entries cannot find the runtime descriptor (#386) |
| R09 | Any model, cross-owner | unknown | Conformance passes in `fake-contract` mode. No `live-harness` report has been accepted |
| R10 | TypeScript and OSS reuse | pass | Product source is TypeScript. The exceptions are the Claude plugin's hook entry points and runtime, which ship as `.mjs` with a `.d.mts` declaration so that Claude Code can run them unbuilt, plus build configuration and one landing-page script. Synapse and `matrix-js-sdk` are reused (`client-reuse.md`, `backend.md`) |
| R11 | Netlify preferred, Railway acceptable | pass | Topology decided in P16 (Synapse on Railway, web on Netlify at P11's origin). Neither is provisioned, so this is a design pass, not a deployment pass |
| R12 | Aiur branding, dashboard-native | unknown | Shell built (KHA-107). No recorded desktop, mobile, keyboard or contrast run; #238 is open |
| R13 | Parallel research and product questions | pass | Research index and decision register |
| R14 | Ticket proposal, then detailed plans | pass | 44 plans with review dispositions |
| R15 | No-setup onboarding | unknown | No hosted OAuth → link → coworker journey has been observed |

## Ordinary user journey (U2)

**Not observed.** No production entry point starts the owner connector (the
KHA-136 README; nothing outside tests calls `createConnectorRuntime`). The KHA-134
and KHA-135 compositions still have no protected human control transport. As a
result, none of these steps could run: OAuth, create/name/share link, the agent's
automatic setup, the coworker joining, reviewed introductions, exact release, and
third-owner admission. Nothing was simulated in their place.

What exists on the candidate is internal mode. It is a single-owner local flow
with no encryption and no review. CI proves its protocol flow (#237). Its
limitations are listed in the [user guide](../user-guide.md#known-gaps-in-internal-mode).
It does not satisfy R01, R02 or R15, because those need two owners.

## Production excludes experiments and fixtures

- `experiments/` is outside `pnpm-workspace.yaml` (`apps/*`, `packages/*`), so no
  production build includes it.
- The published CLI tarball is limited to an allowlisted file set
  (`scripts/agent-cli-package-gate.mjs`), and the setup gate above passed with
  it. `@aiur/khala` maps `./fixtures/*` to `null`, and `@khala/harnesses` maps
  `./codex/fakes` to `null`.
- `@aiur/khala` is not published to npm yet (`npm view` returns 404).

## Findings

Findings are classified under U4. Component defects go back to their owners. This
ticket does not fix them.

### Acceptance blockers

| Finding | Owner | Needed for |
| --- | --- | --- |
| #380: the recovery view misses dispatcher evidence, which makes the KHA-138 "delivery ambiguity" row fail | KHA-136 (in CI) | Security report |
| No live collaboration run. The case needs a pinned harness version, a registered live driver and a disposable environment | #239, #240, #241. Under decision 43 the Executor owes the Claude and OpenCode live runs (#240, #241) | R1, R01–R03, R15, AE1 |
| No disposable preview environment exists for the live human proof | #134 (Executor-owned) | R1, R01–R03, R06, R15 |
| No production composition of the hosted connector, and no protected human control transport | KHA-133/134/135/136 integration owners | R04, R05, R07, R15 |
| Relay confidentiality not observed: needs a disposable Synapse with database and log access | KHA-138 live rows | R06 |
| No hosted deployment is provisioned (P16 credentials are operator-supplied) | Executor / operator | R11 in practice, R15 |
| No Claude Code version is proven for the approved hook route | #231 | R07, R08 |
| Codex is required (P15, decisions 23 and 37) but unproven. It is parked on a broken Codex API key (operational), not deferred by decision | #230, #266 | R07, R08 |
| OpenCode and cross-harness read receipts are not proven. Acknowledgement is core to decision 3 | #232, #233 | R02, R03, R07 |
| Internal mode has no pause or listening-mode control. Decisions 23 and 42 require mode control | #392 | R05, R07 |
| Installed harness entries cannot find the runtime descriptor, and only one agent session per user can bind. Both gate the internal-mode flow | #386, #391 | R08, R1 |
| Browser acceptance (desktop, mobile, keyboard) is not recorded | #238 | R12 |

### Contained rework (owned elsewhere, not blocking this record's scope)

#385 (setup crash recovery) and #388 (absent harnesses not reported).

### Fixed after this candidate

- #384 (flaky listing-ref tamper test): fixed on `main` by #397 (`a8bee18`),
  which changes one test only. The next rerun of this record covers it.

### Deferred, nonblocking by decision

- The desktop and cloud apps (#244, #245): parked. Codex is not deferred; see
  [Acceptance blockers](#acceptance-blockers).
- Automatic release: closed by the G-AUTOMATION ruling.
- Attachments (P07) and automatic conversation control (P08): never asked, and
  not added here.

## Documented non-guarantees

These come from the KHA-138 and KHA-139 records and still apply:

- No isolation from an unrestricted agent on the owner's host running as the same user.
- A model provider sees released content.
- Revocation and closure clean up only local copies. They never recall released
  content.
- Restoring a backup older than a delivery can deliver that message again.
- Latency is reported only as durations on one owner's clock. No cross-host SLO
  is claimed.
