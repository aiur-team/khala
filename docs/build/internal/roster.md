# Internal mode build — ticket roster (plan_version 1)

- Build order: `aiur-team/khala:internal-mode`. Logical prefix `KI-`; IDs are opaque and do not encode phase.
- Plan: [`docs/plans/2026-10-02-001-feat-internal-mode-plan.md`](../../plans/2026-10-02-001-feat-internal-mode-plan.md). Shapes: [`contracts.md`](contracts.md) as amended by [`reconciliation.md`](reconciliation.md) (every ticket quotes it verbatim). Deferred: [`deferred-findings.md`](deferred-findings.md). Questions: [`questions-or-commands.md`](questions-or-commands.md). Research: [`research/`](research/).
- Researched at `origin/main` `5ad41c8b` (2026-10-02). Implementation pointers in each ticket are refreshable at pickup; contract names are pinned.
- Validate with `python3 docs/build/internal/build_pack.py <out_dir>` (writes `build-order.json`, prints waves, critical path and lane starts; exits non-zero on any error).

## Lanes

| Lane | Icon | Scope |
|---|---|---|
| platform | `server-stack` | deletion, spec, docs, landing |
| agent | `cpu-chip` | `@khala/agent` client seam, LocalSession, identity |
| helper | `bolt` | `khala local serve`: store, HTTP core, routes, lifecycle, CLI |
| web | `window` | `apps/web` local adapter, entry, owner chrome |
| acceptance | `shield-check` | no-egress guard, scripted e2e, live capstone |

Model routing (label at promotion): `model:codex` (Codex Sol 6.1) for logic; `model:claude-opus` for any UI/visual ticket (KI-144, KI-145, KI-171). KI-161 is Executor-owned and promoted as `human:todo`.

Contract-layer ticket KI-110 is the spine: every helper route, the agent seam and the web adapter code against its pinned names, so they fan out in one wave against fakes. KI-137 (helper composition) and KI-143 (web composition) reconnect the pieces; KI-160 proves them end to end (integration ledger in the plan).

## Tickets

`dep` = hard `depends_on` (each passes the CI-green or contract-authority test, or is the operator-ordered D7 gate). `ser` = `serializes_with` (symmetric). Model: `codex` or `opus` (= claude-opus).

| ID | Title | Lane | Model | C | dep | ser | Scope in one line |
|---|---|---|---|---|---|---|---|
| KI-101 | Delete apps/internal | platform | codex | 1 | — | — | D7: delete `apps/internal/`, its workspace exclusion, ESLint ignore and the frozen-app branch of the boundary checker; keep `experiments/` |
| KI-102 | Amend spec §3.1, §14, §15 for local channels | platform | codex | 1 | 101 | — | D2/D3 wording in `docs/product/khala-spec.md`; record D1–D8 |
| KI-110 | Local contract layer | agent | codex | 2 | 101 | — | `packages/contracts/src/m1/local.ts` (L3–L7), optional `autoConfirmed`/`transport` in `agent-join.ts` (L4), `packages/agent/src/local/types.ts` (L8) |
| KI-120 | ChannelSession seam and auto-confirmed join | agent | codex | 2 | 110 | 122 | `src/transport.ts` (L9), lazy session selection, `join.ts` keeps `transport`/`autoConfirmed`, `client-impl` waits ≤15 s for an auto-confirmed join, `tools.ts` render |
| KI-121 | LocalSession over the helper API | agent | codex | 3 | 110, 120, 136 | — | `src/local/session.ts` `createLocalSession`: L5 calls, long-poll loop, backoff, helper respawn |
| KI-122 | Local owner name and hosted-username cache | agent | codex | 1 | 110 | 120 | `src/local/identity.ts` (L10) and one call in `client-impl` after a hosted connect |
| KI-130 | Channel store (append-only log) | helper | codex | 3 | 110 | — | `src/local/store.ts` `openLocalStore` implementing `LocalStore` (L2, L3, L8): replay, single-writer append, dedup, links, tokens, owner profile |
| KI-131 | Helper HTTP core | helper | codex | 2 | 110 | — | `src/local/http.ts` `createHelperServer`: loopback bind, Host/Origin/cookie/bearer guards, router, static SPA with CSP, idle exit (L11) |
| KI-132 | Agent-join routes | helper | codex | 2 | 110 | — | `src/local/routes/agent-join.ts`: C2 request/poll/ready with link consumption, naming and auto-confirm (L4) |
| KI-133 | Participant room routes | helper | codex | 3 | 110 | — | `src/local/routes/rooms.ts`: me, join (+ "joined" event), events long-poll, messages, send, members, mode echo (L5) |
| KI-134 | Owner channel routes | helper | codex | 3 | 110 | — | `src/local/routes/owner.ts`: channels list/long-poll/get/create/delete, links, open, mode command, agent rename, remove, shutdown (L6) |
| KI-135 | Owner profile routes | helper | codex | 1 | 110 | — | `src/local/routes/profile.ts`: profile get, username (+ default-name cascade), colour, initials (L6, L7) |
| KI-136 | Helper lifecycle | helper | codex | 2 | 110 | — | `src/local/lifecycle.ts` `ensureHelper`, `readHelperFile`, helper paths; detached spawn and health wait (L11) |
| KI-137 | `khala local` CLI and helper composition | helper | codex | 2 | 122, 130, 131, 132, 133, 134, 135, 136 | — | `src/local/{cli,serve}.ts` + `bin/khala.mjs` `local` dispatch: serve composes store + server + routes, writes `helper.json`; create/link/open/list/delete/status/stop (L12) |
| KI-140 | Web: local helper client, session and profile ports | web | codex | 2 | 110 | — | `apps/web/src/composition/local/{http,types,session,profile,agent-names}.ts` (L13) |
| KI-141 | Web: LocalSubstrate and shared message projection | web | codex | 3 | 110, 140 | — | `composition/local/{substrate,channel-service}.ts`; extract `composition/human/message-wire.ts` from `matrix-browser.ts` (L13) |
| KI-142 | Web: channel list, members, modes and links ports | web | codex | 2 | 110, 140 | — | `composition/local/{conversations,members,links}.ts` (L13) |
| KI-143 | Web: local entry and build | web | codex | 2 | 140, 141, 142, 144 | — | `local-main.tsx`, `local.html`, `vite.local.config.mjs`, `build:local`, `composition/local/ports.ts`, bundle guard (L13) |
| KI-144 | Web: local owner account mode | web | opus | 2 | 101 | — | `mount.tsx` `account: 'local_owner'` hides Log out and sign-in redirect, helper-down panel; neutral "Encrypted" copy via the mode (L13) |
| KI-145 | Web: local full-app browser spec and visual check | web | opus | 2 | 143 | — | Playwright harness on the built local app with a faked `/api/local/**`; flows and screenshots at 1280/390, dark/light |
| KI-150 | Agent skill and install docs for local channels | platform | codex | 1 | 137, 143 | — | `claude-plugin/khala/skills/khala/SKILL.md`, `packages/agent/README.md`, `docs/install-*.md` (build:local step) |
| KI-151 | No-egress guard and test (D3) | acceptance | codex | 2 | 121, 137 | — | `packages/agent/test/no-egress/*`: `--import` preload that fails on non-loopback sockets; a test running the helper and two local sessions under it; `matrix-js-sdk` not loaded |
| KI-160 | Scripted local acceptance AE1–AE12 | acceptance | codex | 3 | 120, 121, 137, 143, 151 | — | One command: helper + two `khala mcp` processes with fake hook drivers + headless Chromium on `dist-local`, under the egress guard |
| KI-161 | Live acceptance on one machine (Executor-owned, `human:todo`) | acceptance | — | 3 | 145, 150, 160 | — | Real Claude Code + Codex panes + the operator's Firefox via `AGENT-MESSAGES.md`; evidence `docs/evidence/internal-mode-acceptance.md` |
| KI-170 | Docs: local channels available | platform | codex | 1 | 161 | — | `docs/settings.md` Channel types, `docs/user-guide.md` Local channels, `README.md`, `llms.txt`/`AGENTS.md`; aiur.team Quick start drops "Coming soon" (cross-repo PR) |
| KI-171 | Landing card 04: D3 copy, no "Coming soon" | platform | opus | 1 | 161 | — | `apps/web/src/landing/index.html:97-98` + landing tests + affected visual snapshots |

## Waves (computed; each is an antichain)

| Wave | Tickets | Notes |
|---|---|---|
| 1 | KI-101 | D7 gate |
| 2 | KI-102, KI-110, KI-144 | contract spine; KI-144 needs only `mount.tsx` |
| 3 | KI-120, KI-122, KI-130, KI-131, KI-132, KI-133, KI-134, KI-135, KI-136, KI-140 | widest wave (10); KI-120 ~ KI-122 serialize on `client-impl.ts` |
| 4 | KI-121, KI-137, KI-141, KI-142 | |
| 5 | KI-143, KI-151 | |
| 6 | KI-145, KI-150, KI-160 | KI-150 needs `build:local` (G1) |
| 7 | KI-161 | Executor capstone |
| 8 | KI-170, KI-171 | ship docs once live acceptance passes |

**Critical path (8 waves):** KI-101 → KI-110 → KI-140 → KI-141 → KI-143 → KI-160 (or KI-145 / KI-150) → KI-161 → KI-170. Parallel equal-length spine through the helper: KI-110 → KI-130/KI-133 → KI-137 → KI-151 → KI-160.

**Spine for first-slot staffing:** KI-110 (fans out to 17 tickets), then KI-140 and KI-130/KI-133 (largest complexity on the path), then KI-137 and KI-143 (composition points).

**Same-wave serialization losses:** one pair, KI-120 ~ KI-122 (`packages/agent/src/client-impl.ts`), both small.

**Lane earliest start:** platform 1, agent 2, web 2, helper 3 (needs KI-110 only), acceptance 5 (needs the composed helper KI-137: CI-green, it runs the real binary).

**Delta from the operator's estimate ("~15–30 small tickets"):** 26 tickets. Boundaries are one module each so the helper (8) and web (6) lanes fan out in one wave; composition is concentrated in KI-137 and KI-143.

## External gates

- **G-PANES** (KI-161): the operator's Claude Code and Codex panes listen on `AGENT-MESSAGES.md`, with the current Khala plugin installed (the old E09 plugin tools must be removed first; research-1 side note).
- **G-AIUR-DOCS** (KI-170): a PR in `aiur-team/aiur` (`website/docs-app/khala/quick-start.md`, section "Local agents only") — opened by the KI-170 worker if it has push access, else by the Executor.
- **In-flight PRs** that touch surfaces the web adapter implements: #976 (agent rename via `AgentNamesPort`), #978 (per-human colours), #986 (custom initials), #979 (docs/settings.md). Tickets name them in their stop conditions and refresh pointers at pickup; none is a hard edge.

## Promotion notes for the Executor

- Create every member unlabelled, then add labels ~6 s later (memory: create-then-label until aiur#2818): `agent:todo` (or `human:todo` for KI-161), `complexity:<C>`, `build-lane:<lane>`, `model:codex` or `model:claude-opus`.
- Replace `KI-` references in bodies with issue numbers in the `Depends on:` / `Serializes with:` header lines at promotion; after promotion edits go to the issue, never the doc.
- Deletion PR: KI-101 deletes files → it needs an approving review on the head SHA before merge (`deletion-guard`).
