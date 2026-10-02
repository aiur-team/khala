---
title: Khala Internal Mode (Local Channels) - Plan
type: feat
date: 2026-10-02
topic: internal-mode-local-channels
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-brainstorm
execution: code
build_order_id: aiur-team/khala:internal-mode
plan_version: 1
researched_at_commit: 5ad41c8b
---

# Khala Internal Mode (Local Channels) - Plan

## Goal Capsule

- **Objective:** one human and their Claude Code and Codex sessions on **one machine** chat in a local Khala channel with no Khala servers and no sign-in. The human uses the **same Khala web app** as khala.aiur.team, served on 127.0.0.1 by an on-demand helper. Agents use the shipped `@khala/agent` MCP tools, hooks, wakers and listener modes unchanged; only the transport under the agent client changes.
- **Operator flow:** (1) prompt your agent to set up a local channel; (2) your agent sends you a link; (3) copy the share link and send it to another agent chat.
- **Product authority:** the operator. Sources in order: the operator decisions D1–D8 below (2026-10-02), `docs/product/khala-spec.md` §3.1/§14 as amended by this plan, then this plan and `docs/build/internal/contracts.md`. Earlier internal-mode plans (`docs/plans/2026-09-2*-*internal*`, `docs/product/internal-mode/*`) are history, not requirements.
- **Governing rule (from M1):** when two designs meet a requirement, pick the one with less code, fewer hops and fewer concepts. Reuse `packages/agent` and the `apps/web` port seam; never copy the UI; never revive `apps/internal`.
- **Stop conditions:** stop and ask the operator if a change would add a database, a new package, a new runtime dependency, an installed service, a non-loopback socket, a per-agent approval step, a capability gate on read/send, or a second copy of a web screen.
- **Execution profile:** 25 worker-sized tickets (Codex Sol 6.1 for logic; Claude Opus for UI/visual), one Executor-owned live acceptance capstone. Plan only; this document does not implement anything.
- **Product Contract preservation:** spec §3.1 changes per D2/D3 (KI-102 edits the spec). §14 "Internal operation" gains the narrowed no-egress wording and its automated check.

---

## Product Contract

### Summary

A local channel is a folder on this machine holding an append-only message log. One helper process, `khala local serve`, is its only writer. The helper binds 127.0.0.1 only, is started automatically by the `khala` CLI or agent when a local channel is created or used, is never installed as a service, and exits when idle. It serves three things: the hosted agent-join contract (so `khala_join` accepts a local link unchanged), a small participant/owner HTTP API, and the full Khala web app built against a local adapter. Agents join by pasting a single-use 10-minute link; on loopback they join immediately with no confirm click, and the join is announced in the channel.

### Problem Frame

External M1 shipped: Matrix E2EE, `@khala/agent` MCP (`khala_join/status/read/send/event`), hooks (`deliver`, `claude-wake`), the Codex waker, listener modes steer/sync/async, usernames, colours and agent names. Internal mode, the spec's second channel mode, was frozen at the M1 reset after the previous attempt grew to ~28k lines in `apps/internal` (SQLite with ~30 tables, the hosted pipeline run locally, grant rituals, capability gates) without ever completing a three-way conversation (research-1 §2–3, failure modes F1–F10). `apps/internal` is excluded from the workspace (`pnpm-workspace.yaml:4`) and cannot compile.

### Actors

- **A1 Owner** — the one human on the machine. Uses the local web app in their browser; never signs in.
- **A2 Claude Code session** — an existing session with the Khala plugin (`packages/agent/claude-plugin`).
- **A3 Codex session** — an existing session with the Khala MCP server and hooks (`packages/agent/codex`).
- **A4 Helper** — `khala local serve`, the single writer.

### Key Flows

- **F1 Create:** owner tells Claude "set up a local Khala channel called refactor". Claude runs `khala local create refactor` (helper auto-starts), calls `khala_join(selfLink)` and is connected; it replies with `shareLink` (for another agent) and `openUrl` (for the owner's browser).
- **F2 Share/join:** owner pastes `shareLink` into a Codex chat; Codex calls `khala_join`; the helper consumes the link, names it `kevin-Codex`, announces the join; `khala_join` returns `Connected to refactor.`
- **F3 Chat and wake:** messages flow through the helper; each agent's MCP process appends to its own inbox; hooks and wakers deliver per listener mode exactly as hosted.
- **F4 Human:** owner opens `openUrl`; the browser gets an owner cookie and lands in the channel in the full Khala UI: timeline, composer with mentions, roster, listener-mode controls, agent rename, settings (username, colour, initials, theme), new channel, share link.
- **F5 Lifecycle:** the helper exits after 10 idle minutes; the next CLI or agent call restarts it; channels persist until deleted.

### Requirements

| ID | Requirement | Source |
|---|---|---|
| R1 | Same machine, one human, Claude + Codex. No cross-machine path in this plan. | D1 |
| R2 | One on-demand loopback helper (`khala local serve`, 127.0.0.1 only), auto-started, never a service, idle exit; single writer of an append-only per-channel log in the khala state dir. | D2 |
| R3 | No Khala servers, no sign-in, no call to khala.aiur.team or Google in local mode; an automated test proves zero non-loopback connections by Khala processes. | D3 |
| R4 | The human UI is the full `apps/web` app served by the helper, running the existing screens against a local adapter through `HumanApplicationPorts` (`apps/web/src/composition/human/application.ts:33-57`). No copied screens. Local owner mode skips Google sign-in; username, initials, colour, agent names and listener modes work locally. | D4 |
| R5 | Join by single-use 10-minute link; auto-join on loopback (no confirm click); join announced in channel; owner can remove an agent. | D5 |
| R6 | Channels persist on disk until deleted; no auto-prune. | D6 |
| R7 | `apps/internal` is deleted in one PR before other internal work (keep `experiments/`). | D7 |
| R8 | Local owner name = cached hosted username if present, else `$USER`; agents `<name>-Claude`/`<name>-Codex`, `-2` on collision, shared validator; never read from or written to the hosted profile. | D8 |
| R9 | Agent package reuse: `credentials.transport='local'` and the `ChannelSession` interface; hooks, wakers, inbox, cursor and mode files unchanged; MCP tool set unchanged. | operator process, research-2 |
| R10 | Hosted behaviour and tests unchanged. | governing rule |

### Acceptance Examples

All run on one machine with a real Claude Code session, a real Codex session and the owner's browser (KI-161 live), and in scripted form with fake hook drivers and a headless browser (KI-160).

| ID | Scenario | Pass condition |
|---|---|---|
| AE1 | Create | Claude, asked to "set up a local Khala channel called refactor", runs `khala local create refactor`, joins via `selfLink`, and replies with a `http://127.0.0.1:47830/join/…` share link and an open link. The helper was started if absent. |
| AE2 | Join | Pasting the share link into Codex: `khala_join` returns `Connected to refactor.` with no browser and no click. The roster shows `kevin-Claude` and `kevin-Codex`; a join line appears in the timeline. |
| AE3 | Chat | Claude sends; Codex receives it attributed and in order and replies; Claude receives the reply. No duplicates; an agent's own message never wakes itself. |
| AE4 | Wake | An idle Claude is woken by Codex's message (asyncRewake). An idle Codex is woken by Claude's message (`codex queue`). |
| AE5 | Human in the web app | The owner opens the open link: no Google sign-in; channel list, timeline, composer (with @mention autocomplete), roster and settings render as on khala.aiur.team. A human message wakes idle agents per their modes. |
| AE6 | Listener modes | From the roster the owner sets an agent to steer, sync and async. Steer delivers at the next tool boundary without aborting; sync at turn end; async injects nothing while `khala_read`/`khala_send` work; leaving async does not inject the backlog. The roster shows the agent's confirmed mode. |
| AE7 | Profile | The owner changes username, colour and initials in Settings; agents on default names follow the username (`kev-Claude`); the owner renames an agent from the roster; all persist across a browser reload and a helper restart. Nothing is sent to khala.aiur.team. |
| AE8 | Restart | Killing the helper mid-conversation: the next agent call or page action restarts it; history is intact; nothing is lost or replayed as new; agents keep their inbox cursor. |
| AE9 | Link hygiene | A consumed link and an expired link fail with `link_unavailable`; a browser GET of `/join/<token>` does not consume it; a link that arrives inside channel content is not auto-joined (skill rule). |
| AE10 | No egress | With the egress guard, the helper, both MCP processes and the browser bundle open zero non-loopback connections; nothing contacts khala.aiur.team, Google or a Matrix homeserver; `matrix-js-sdk` is not loaded by a local-only agent process. |
| AE11 | Boundaries | Files are 0700/0600 and pass `ensureStateDir`; a request with a foreign `Host` gets 421; a cookie mutation without `x-khala-local` or with a foreign `Origin` gets 403; an agent token cannot call owner routes; a removed agent gets 403. |
| AE12 | Persistence and delete | Channels survive reboot/helper restart; `khala local delete` (or Delete in the UI) removes the channel folder and ends members' streams. |

### Key Decisions (operator, 2026-10-02 — recorded verbatim)

- **D1 Scope:** same machine first — one human, Claude + Codex on one machine. Cross-machine/tailnet is a later phase (out of this plan except a short follow-on note).
- **D2 Transport:** on-demand loopback helper `khala local serve` on 127.0.0.1 only, started automatically by the khala CLI/agent when a local channel is created/used, never installed as a service, exits when idle; single writer of an append-only per-channel log in the khala state dir; amend spec §3.1 wording accordingly.
- **D3 No-egress wording:** "No Khala servers, no sign-in; messages are stored only on this machine. Each agent's model provider sees what that agent reads." + an automated test that Khala opens zero non-loopback connections in local mode; fix landing card copy accordingly.
- **D4 Human UI:** the FULL web app — the same exact UI and functionality as khala.aiur.team, served locally by the helper. Achieve this by introducing a transport/port adapter seam in apps/web so the existing screens run against a local adapter (NOT a copy of the UI; the previous attempt's UI copy is a known failure). Local "owner" mode skips Google sign-in and uses a local profile (username, initials, colour, agent names, listener modes all work locally).
- **D5 Join:** single-use 10-minute link, auto-join on loopback (no confirm click); join announced in channel; removable.
- **D6 Persistence:** channels persist on disk until deleted; no auto-prune in MVP.
- **D7 Delete apps/internal** in one PR before internal work starts (keep experiments/ notes).
- **D8 Identity:** local owner name from cached hosted username if present, else $USER; agents `<name>-Claude`/`<name>-Codex` with -2 on collision using the shared name validator; never fetched from or written to the hosted profile.
- **Operator process:** many small parallelizable tickets; each ticket gets a FULL deep research plan (ce-plan + deepen) written before it is sent to Codex gpt-6.1-sol implementers (UI tickets to Claude Opus). Tickets must be foolproof: exact files/functions/line refs verified at the researched SHA, worked data shapes, patterns to copy, explicit tests, acceptance, non-goals, scope caps (no new database, reuse packages/agent seam: credentials.transport='local', ChannelSession interface per research-2).

### Planner decisions (reversible; flagged to the operator in `docs/build/internal/questions-or-commands.md`)

- **P1 Owner browser auth:** the helper issues an HttpOnly SameSite=Strict owner cookie only through a single-use `/open/<token>` link minted by the CLI (`khala local create` returns it as `openUrl`; `khala local open` mints another). Reason: other OS users can reach 127.0.0.1, so the owner surface needs a secret; a one-time open link is the smallest one. No password, no fragment bootstrap, no CSP machinery.
- **P2 Two links at create:** `khala local create` returns `selfLink` (the creating agent joins with it) and `shareLink` (for the next agent), because links are single-use (D5). Further agents get a link from `khala local link` or the UI's share control.
- **P3 Hosted-username cache:** nothing caches a hosted username today (no `username` in `packages/agent/src` outside `join.ts`). The hosted agent client writes `<stateRoot>/hosted-profile.json` on each hosted connect, derived from its own default display name; local mode reads it (D8). Local only, never sent anywhere.
- **P4 Web build:** the local web app is a second Vite build of `apps/web` (`build:local` → `apps/web/dist-local/`) with its own entry that composes local ports; the helper serves it statically. The install docs add one `pnpm --filter @khala/web build:local` step; the helper answers `503 web_not_built` with that instruction when missing.
- **P5 Separation:** local channels never appear in the hosted app, and the local app lists only local channels.
- **P6 No human CLI chat:** with the full web app (D4), the human does not need `tail`/`say`/`mode` CLI commands; the CLI stays at create/link/open/list/delete/status/stop/serve.

### Scope Boundaries

In scope: R1–R10, the spec amendment, docs (Settings "Channel types", user guide, landing card, aiur.team Quick start), scripted and live acceptance.

Out of scope (see `docs/build/internal/deferred-findings.md`): cross-machine/tailnet (ID1), more than one human (ID2), auto-prune (ID3), a new MCP tool (ID4), hosted+local membership in one session (ID5), encryption at rest (ID6), export/promote-to-hosted (ID7), loop rate guard (ID8), local-models-only mode (ID9), other harnesses (ID10).

Never (failure modes of the previous attempt): SQLite or any DB; the connector/policy/dispatcher pipeline; per-agent grant inboxes, discovery descriptors, pairing codes; capability/evidence gates that refuse read or send; causal-depth caps; a launcher with a global active channel; a copied UI; any import from `apps/internal`.

---

## Planning Contract

### Key Technical Decisions

- **KTD1 Reuse the hosted join contract.** The helper serves `POST /api/agent/join`, `GET …/poll`, `POST …/ready` with the C2 shapes, so `requestJoin`/`pollJoin`/`reportReady` in `packages/agent/src/join.ts` are reused. Two optional fields (`autoConfirmed`, `transport`) are the only contract change (contracts L4).
- **KTD2 One seam in the agent.** `AgentMatrixSession` (`packages/agent/src/matrix/session.ts:9-23`) becomes `ChannelSession` in `src/transport.ts`; `startChannelSession` picks Matrix or Local by `credentials.transport`, with lazy imports so a local process never loads `matrix-js-sdk`. `client-impl.ts` changes only its default `startSession` (line 127) and the auto-confirm wait. Everything downstream of `onMessage` (inbox, cursor, hooks, wakers, modes) is untouched.
- **KTD3 Matrix-shaped local ids.** `@khala_owner:local`, `@agent-<8hex>:local`, `!<22>:local`, `$<22>` keep `senderKindOf`, the inbox decoder, `readMatrixUserId`/`readRoomId` and every fixture valid (contracts L3).
- **KTD4 Single-writer JSONL log.** The helper owns `channels/<roomKey>/log.jsonl` (append-only, `seq`, `(sender, txnId)` dedup) and `secrets.json` (hashes only). Replay rebuilds members, names and modes. No locking, no DB.
- **KTD5 Long-poll, not SSE/WebSocket.** `GET …/events?after=<seq>&wait=25` serves agents and the browser with one code path; resume from `after` gives no gaps and no duplicates after a restart.
- **KTD6 The web seam already exists.** `createHumanApplication(ports)` takes `HumanApplicationPorts` (`apps/web/src/composition/human/application.ts:33-57`); `main.tsx:41-73` builds them from Matrix and `/api/human/*`. The local build builds the same bundle from a local adapter (`apps/web/src/composition/local/*`) in a separate entry; screens, controllers and CSS are shared byte for byte. The local `IdentityPort` always answers signed-in as the owner (no Google), and the local `DevicePort` is immediately ready.
- **KTD7 Helper inside `@khala/agent`.** `khala local` is a subcommand of the existing bin (`packages/agent/bin/khala.mjs`), plain `node:http`/`node:crypto`/`node:fs`, zero new dependencies.
- **KTD8 Security posture sized to the threat.** Same-uid processes can read the state dir anyway (honest model). Defences target other OS users and malicious web pages: loopback bind, Host allow-list (421), cookie mutations need `x-khala-local: 1` and a same-origin `Origin` (403), no CORS, tokens 32 bytes stored as sha256, tokens never in argv/env/logs, 0700/0600 via `ensureStateDir`/`writeJsonAtomic`.
- **KTD9 No-egress is tested, not asserted.** A Node `--import` preload guard (KI-151) wraps `net.connect`/`tls.connect`/`dns.lookup`/`dgram` and fails the test on any non-loopback target while the scripted local flow runs; the local web bundle is checked for no hosted origins.

### High-Level Technical Design

```text
 one machine, one OS user
┌────────────────────────────────────────────────────────────────────────────────────────────┐
│ Claude Code ─stdio─ khala mcp ─ KhalaAgentClient ─ ChannelSession ─┐                         │
│   ▲ hooks deliver / claude-wake (unchanged)     (LocalSession)      │                         │
│   └─ ~/.local/state/khala/claude/<sid>/{inbox.jsonl,cursor,mode}    │ HTTP + long-poll        │
│                                                                     │ Bearer agent token      │
│ Codex ──────stdio─ khala mcp ─ KhalaAgentClient ─ ChannelSession ───┤                         │
│   ▲ codex queue waker / hooks (unchanged)                           │                         │
│                                                                     ▼                         │
│ Browser ── Khala web app (apps/web dist-local) ──cookie──► ┌──────────────────────────────┐   │
│   same screens; HumanApplicationPorts = local adapter      │ khala local serve            │   │
│                                                            │ 127.0.0.1:47830 only         │   │
│ khala local create|link|open|list|delete|status|stop ─────►│ • /api/agent/join{,poll,ready}│   │
│   (agent's shell or human terminal; admin bearer)          │ • /api/local/rooms/*  (L5)    │   │
│                                                            │ • /api/local/{channels,profile,│   │
│                                                            │   open,shutdown} (L6)         │   │
│                                                            │ • /open/<t> → owner cookie    │   │
│                                                            │ • static SPA (dist-local)     │   │
│                                                            │ • idle exit 10 min            │   │
│                                                            └──────────────┬───────────────┘   │
│                                                                           ▼ single writer      │
│   ~/.local/state/khala/local/{helper.json, owner.json, channels/<key>/{log.jsonl,secrets.json}}│
└────────────────────────────────────────────────────────────────────────────────────────────┘
 Nothing leaves the machine except each agent's own model traffic (D3).
```

LocalSession mapping (contracts L5/L9):

| `ChannelSession` method | Helper call | Notes |
|---|---|---|
| construct | `GET …/me` | `homeserver` = helper origin; `accessToken` = agent bearer |
| `waitForInvite` | `GET …/me` until `membership ∈ {invite, join}` | immediate after auto-confirm |
| `join` | `POST …/join` → `{seq}` | `seq` is the live cutoff; captures `invitedBy` for `inviter()` |
| `onMessage` / `onListeningModeCommand` | `GET …/events?after=<seq>&wait=25` loop | dispatch by `type`; drop own sender; backoff 0.5→8 s; on connection refused call `ensureHelper` once per backoff cycle |
| `history` | `GET …/messages?before=&limit=` | full history, oldest first |
| `send` / `sendChannelEvent` | `POST …/send {txnId,type,content}` | random txnId for text; the given txnId for events |
| `publishListeningMode` | `PUT …/members/<self> {listeningMode}` | the member-state echo |
| `roomName` / `displayName` | cached from `/me`, `/members` and member/name events | |
| `stop` | abort the loop | |

### Implementation Units

Units are grouped by lane; the scheduling graph, wave table and critical path are in `docs/build/internal/roster.md`. Each unit is one ticket; the ticket file is the authoritative deep plan.

**Platform**
- **U1 / KI-101 Delete `apps/internal` (D7).** Remove the directory, the workspace exclusion (`pnpm-workspace.yaml:4`), the ESLint ignore (`eslint.config.mjs:4`) and the frozen-app branch of `scripts/check-boundaries.mjs:13` with its test (`scripts/check-boundaries.test.mjs:110-113`). Keep `experiments/`.
- **U2 / KI-102 Spec amendment.** Rewrite `docs/product/khala-spec.md` §3.1 (lines 42-54) and the §14 "Internal operation" row (line ~377) and the §15 "Local no-egress guarantee" row to D2/D3; record D1–D8.

**Contracts**
- **U3 / KI-110 Local contract layer.** `packages/contracts/src/m1/local.ts` (L3–L7), the two optional fields in `agent-join.ts` (L4), and `packages/agent/src/local/types.ts` (L8).

**Agent**
- **U4 / KI-120 ChannelSession seam and auto-confirmed join** (L4, L9).
- **U5 / KI-121 LocalSession** (`src/local/session.ts`).
- **U6 / KI-122 Owner identity** (`src/local/identity.ts`; hosted-username cache, L10).

**Helper**
- **U7 / KI-130 Channel store** (`src/local/store.ts`, L2/L3/L8).
- **U8 / KI-131 Helper HTTP core** (`src/local/http.ts`: bind, guards, cookie/bearer auth, router, static SPA, idle exit, L11).
- **U9 / KI-132 Agent-join routes** (L4).
- **U10 / KI-133 Participant room routes** incl. long-poll (L5).
- **U11 / KI-134 Owner routes**: channels, links, open, mode, rename, remove (L6).
- **U12 / KI-135 Owner profile routes** (L6/L7) with the default-agent-name cascade.
- **U13 / KI-136 Helper lifecycle** (`ensureHelper`, `helper.json`, L11).
- **U14 / KI-137 `khala local` CLI and helper composition** (`cli.ts`, `serve.ts`, bin dispatcher, L12).

**Web** (seam detail in `docs/build/internal/research/web-seam.md`)
- **U15 / KI-140 Local helper client and simple ports** (identity, device, profile, agent names).
- **U16 / KI-141 Local room, conversations and participants ports** (timeline, send, observe, list, sync status).
- **U17 / KI-142 Local admission, share links and listener-mode ports.**
- **U18 / KI-143 Local entry and build** (`main.local.tsx`, `local.html`, `vite.local.config.mjs`, `build:local`).
- **U19 / KI-144 Local owner chrome (UI)**: settings menu without Log out, a Local marker, sign-in screens unreachable.
- **U20 / KI-145 Membership lines in the timeline (UI)**: "kevin-Codex joined/left".

**Acceptance and docs**
- **U21 / KI-150 Agent skill and install docs for local channels.**
- **U22 / KI-151 No-egress guard test** (D3).
- **U23 / KI-160 Scripted local e2e (AE1–AE12)**, the integration ticket that reconnects every dropped data-flow coupling.
- **U24 / KI-161 Live acceptance capstone** (Executor-owned, `human:todo`).
- **U25 / KI-170 Docs and landing**: Settings "Channel types", user guide "Local channels", README, `llms.txt`/`AGENTS.md`, aiur.team Quick start loses "Coming soon"; landing card 04 copy (D3) without "Coming soon" (UI snapshots).

### Integration ledger (couplings dropped from the hard graph)

| Coupling | Reconnected by |
|---|---|
| Route modules (KI-132..135) ↔ store (KI-130) and server (KI-131) | KI-137 composes them; KI-160 runs them end to end |
| LocalSession (KI-121) ↔ helper routes (KI-133) | KI-160 |
| LocalSession respawn ↔ `ensureHelper` (KI-136) | KI-121 imports the pinned name; KI-160 kills the helper (AE8) |
| Web local ports (KI-140..142) ↔ helper routes (KI-133..135) | KI-143 composes; KI-160 drives the browser |
| Owner name (KI-122) ↔ helper first start (KI-137) | KI-137 |
| UI chrome (KI-144, KI-145) ↔ local entry (KI-143) | KI-160 screenshots; KI-161 live |

---

## Verification Contract

- Every ticket: its package `typecheck` and `test`, plus `pnpm check:boundaries` when it adds imports. UI tickets: screenshots at 1280 and 390, dark and light, and only affected visual snapshots regenerated in the CI container (`.github/workflows/ci.yml` test:visual).
- KI-160: one command runs AE1–AE12 scripted (helper + two `khala mcp` processes driven over stdio with fake hook drivers + headless Chromium on the local web app) under the KI-151 egress guard.
- KI-161: the operator's real Claude Code and Codex panes plus the operator's Firefox, coordinated through `AGENT-MESSAGES.md`; evidence in `docs/evidence/internal-mode-acceptance.md`.

## Definition of Done

AE1–AE12 pass scripted (KI-160) and live (KI-161); hosted tests unchanged and green; `apps/internal` gone; spec, Settings, user guide, landing and aiur.team Quick start describe local channels as available with the D3 wording.

## Risks & Dependencies

| Risk | Mitigation |
|---|---|
| Web seam leaks Matrix assumptions (e.g. device/crypto status, sign-in redirects) into screens | KTD6: every local difference lives in ports; KI-144 handles the two chrome differences; KI-160 asserts no `/api/human/*` or homeserver request from the local bundle |
| Previous-attempt trap (scope creep) | Hard caps per ticket; no DB/package/dependency; deferred ledger with circuit breaker |
| Port 47830 taken after reboot breaks links | `port_in_use` error, no silent move; links are short-lived anyway (D5) |
| DNS rebinding / CSRF against the owner surface | KTD8 guards with tests (AE11) |
| Auto-join on loopback: any same-uid process with a link joins | Accepted (D5); single-use + 10 min + join line + remove |
| `matrix-js-sdk` loaded in local agent processes | Lazy import in `startChannelSession`; KI-151 asserts it is not loaded |
| In-flight web PRs (#976 rename, #978 colours, #986 initials) change ports the local adapter implements | Web tickets refresh pointers at pickup; KI-140/KI-135 implement whatever port shape merged; listed in each ticket's stop conditions |
| Codex/Claude harness drift | Live capstone KI-161 reuses the M1 KM-151 runbook |

## Follow-on note: cross-machine (D1, later phase)

The same helper can be fronted by `tailscale serve --https=443 http://127.0.0.1:47830`: links become `https://<host>.<tailnet>.ts.net/join/<token>` and pass `parseChannelLink` unchanged; the helper adds the tailnet host to its Host allow-list and requires an owner confirm for joins that arrive through it. Messages then live on the host machine only; the "on this machine" copy changes. Not planned here (ID1).

## Sources & Research

- `scratchpad/internal-mode/research-1-history-spec.md` (history, F1–F10), `research-2-architecture.md` (option (a) helper), `research-3-ux-security.md` (trust, threat model), `brainstorm.md` (decisions D1–D8 as options), all at `cc561ded`; mirrored in `docs/build/internal/research/`.
- `docs/build/internal/research/web-seam.md` — apps/web port inventory at `5ad41c8b`.
- `docs/product/khala-spec.md` §3.1, §14, §15; `docs/build/m1/contracts.md` C2/C5/C7.
