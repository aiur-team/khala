# Research 1: internal mode, spec and history (2026-10-02)

Track 1 of the internal-mode research. This is research only; the repo was not modified.

Sources were read at `origin/main` `cc561ded` (exported read-only to `scratchpad/r1main/`). Citations use repo paths and line numbers at that commit. GitHub issues and PRs are in `aiur-team/khala`.

## 0. Summary

- The **spec** (`docs/product/khala-spec.md`, 2026-10-01) is short and strict about internal mode. It is local-only, for one human and their several local agents. It needs no servers, external services, or extra dependencies. It says outright: "a mandatory local web server or database service must not be introduced by default" (§3.1, line 48).
- The **previous Codex executor** built the opposite. Its design had these parts:
  - a loopback HTTP server on :4870, with token bootstrap, cookies, CSP and Host/Origin checks;
  - a SQLite store with about 30 tables;
  - a copy of the hosted React UI, loaded through an HTTP `RoomSubstrate` and SSE;
  - the full connector, policy and dispatcher pipeline, with release ledgers, batch tokens, receipts and causal-depth automation limits;
  - per-agent discovery, access requests and human grants;
  - descriptor files, launcher locks, resume, export, delete and make-external;
  - and finally an owner-confirmed asymmetric "process key" for Claude.

  That came to roughly 28.5k lines in `apps/internal`, 6.9k in `apps/web/src/internal`, and around 15 internal-specific files in `packages/agent-cli`. It sat on top of packages that held another ~85k lines. There were 114 commits and about 60 internal-titled issues and PRs over 8 days (2026-09-24 to 10-02).
- **Result:** there was never a complete three-way conversation. The Codex leg passed once (#813). The Claude leg was blocked by the code's own capability gating (#418, #819) and then by a same-user threat model it invented for itself (#822).
- **M1 reset:** internal mode was frozen and taken out of the build (#876, `f7afdcfb`). It is to be deleted after M1 (deferred finding D5). The internal design is "a separate conversation" (M1 plan line 137).

---

## 1. Spec requirements touching internal mode

The repo spec and `~/Downloads/Kala_Product_Specification.md` are identical apart from the Kala→Khala rename and §7.4. The repo copy, edited in `bbad27b3` (#959), replaced "default mode not finalized" with "default is Sync, owner-only control, Matrix `com.khala.listening_mode` transport". That edit was written for external mode (see I-15).

### 1a. Confirmed internal-mode requirements

| # | Requirement | Cite |
|---|---|---|
| I-1 | Internal mode is a **minimal, local protocol** for **one human and their multiple local agents**. | spec.md:44 |
| I-2 | It needs **no third-party hosting, external services, servers, or additional dependencies**. | :46 |
| I-3 | **Channel communication and storage stay on the computer.** | :46 |
| I-4 | No dependency on the Khala website, Gmail sign-in, or external channel infrastructure. | :46, :380 |
| I-5 | "Lightweight local coordination mechanism, **not a locally hosted copy of a complex cloud product**." | :48 |
| I-6 | Transport, storage format and minimum runtime are implementation decisions. **A mandatory local web server or database service must not be introduced by default.** | :48 |
| I-7 | Human-directed channel creation is in scope. | :50 |
| I-8 | Agent-created internal channels are an **open candidate feature**: opt-in and human-controlled if adopted. Do not build unrestricted agent creation. | :50, :397 |
| I-9 | **No-egress boundary.** "No chat leaving the computer" is stronger than "local transport". The design must show how agents satisfy it, or surface the conflict for a scope decision. It must not silently weaken the promise to "no Khala server". | :52, :396 |
| I-10 | The local human interface and local encryption/key handling are **open**. Neither uncertainty authorises cloud dependencies. | :54 |
| I-11 | Journey 4.4: a human creates a local channel and attaches several existing local agents. The agents exchange messages according to their listener settings, without external infrastructure. | :96-98 |
| I-12 | How the human reads and writes local messages is open. **A full duplicate of the external website is not required.** | :100 |
| I-13 | The internal mechanism covers local creation, membership, message storage/transport and listener coordination. **"Select the simplest mechanism that satisfies the local constraints."** | :339 |
| I-14 | Acceptance: one human and several agents coordinate **without external Khala services, Google login, or servers**, and **the no-egress claim is explicitly validated**. | :380 |

### 1b. Shared semantics that apply to internal mode

| # | Requirement | Cite |
|---|---|---|
| I-15 | Both modes share channel terminology, human-agent ownership, message attribution and per-agent/per-channel listener semantics "where applicable". Sharing **must not force local channels through cloud auth, public invitations or the external backend**. Note §7.4's transport line (`com.khala.listening_mode.v1` / `m.room.member`, :213) is Matrix-specific, so internal mode needs its own carrier for the same semantics. | :64-66, :213 |
| I-16 | Khala connects **existing** agents. It never launches replacement agents or becomes their runtime. | :19, :337 |
| I-17 | Three listener modes: Steering, Synchronous and Asynchronous. Async means no automatic intake, and an always-on reader that feeds the model does not qualify. Own messages never re-trigger. Duplicates cause no repeat reactions. Messages from a sibling agent with the same owner still count as incoming. | :169-207 |
| I-18 | The default mode is **Sync**. The owner controls the mode. Steer delivers at the next tool boundary and never aborts. Leaving Async does not inject the backlog. | :209-211 |
| I-19 | Mode settings are per agent-channel membership, not global. | :36, :374 |
| I-20 | Human authority: the owner can always set any mode. Defensive downgrade to async comes with a **private** owner alert in the CLI. The control interface "may differ between local and external channels, but ownership enforcement must be consistent". | :217-235 |
| I-21 | Messages carry a stable ID, channel, sender, owner association, body, ordering and timestamp. Senders can't forge metadata. "system:" in a body is still a participant message. | :245-253 |
| I-22 | Agents get attributed, ordered history with bounded retrieval and **no silent summary substitution**. | :255-261 |
| I-23 | Joining never auto-publishes a private transcript, files or tool output. No automatic cross-posting between channels. | :263-267 |
| I-24 | Delivery keeps per-channel order and lets agents identify seen messages. Reconnect never silently loses messages or replays the history as new steering events. "Reached the integration" is distinct from "supplied to the harness". Failures are visible to the human. **No user-facing read receipts unless asked for.** | :269-275 |
| I-25 | Local plaintext and keys need "appropriate protection as part of the chosen endpoint design". | :329 |
| I-26 | Out of scope: replacement CLI, hosted compute, orchestration, attachments, bridges, roles, moderation platform. Rejected: per-message and per-agent approvals. | :407-409 |
| I-27 | Implementation order: audit, validate existing-session CLI paths, simplify external, **implement the local mechanism without cloud dependencies**, then run acceptance. Neither mode is dropped from scope. | :411 |

### 1c. How internal differs from external (from the spec)

| Aspect | Internal | External |
|---|---|---|
| Humans | One human (:44) | Many, Gmail-linked (:27, :60) |
| Placement | One computer (:46) | Different computers (:58) |
| Hosting | None; no server or DB service by default (:46-48) | Khala website, homeserver |
| Identity | Not Gmail (:46) | Gmail-linked identity (:60) |
| Invites and admission | Not required; must not go through public invitations (:66) | Open and single-use invites, approval, admin (:102-141) |
| Encryption | Open decision (:54) | E2EE is mandatory (:301-319) |
| Privacy promise | **No chat leaves the computer**, including model egress (:52) | Participant-side processing disclosed (:327) |
| Human UI | Open; a website duplicate is not required (:100) | Khala website |
| Listener modes | Same semantics; control surface may differ (:223) | Matrix state transport (:213) |

### 1d. The operator's newer local flow (internal-mode README) compared with the spec

"Prompt your agent to set up a local channel → the agent sends you a link → paste the link into another agent chat."

- This fits I-7 and I-11 (human-directed, via the agent).
- It is also a form of I-8 (agent-initiated creation). The human prompts it, so it counts as "under the human's control". This should be confirmed (see Q3).
- The "link" is new. The spec has no local link concept. The link needs a meaning (see Q4).
- The README says "agents and humans on local machines". The spec says one human and one computer. This needs confirming (see Q1).

---

## 2. What the previous Codex executor built

### 2a. Timeline and volume

| Date | Event | Evidence |
|---|---|---|
| 2026-09-24 | Epic KHA-E09 "Internal mode and agent integrations" opens. Requirements D1-D12 and borrowed ideas I1-I10 are approved. 14 research docs land on the same day. | #137, #136 (`99bbcb55`), `docs/product/internal-mode/*.md` (5,359 lines of design docs) |
| 2026-09-24/25 | Executor decisions 1-44 (`executor-decisions.md`, 122 lines) amend each other repeatedly: 17 amended by 31; 5 by 31; 12 by 36; 8/18/40 by 44. | `docs/product/internal-mode/executor-decisions.md` |
| 2026-09-25/26 | Bulk build: 71 commits in 2 days. SQLite store #274, loopback server #283, automation fence #288, launcher #305, lifecycle #281, discovery #339, UI #349/#374, Claude/OpenCode delivery #428/#432, CI proof #393, browser proof #394. | `git log -- apps/internal` |
| 2026-09-26 | Gate checks find that **nothing actually delivers**: Claude #418, OpenCode #430, no modes or pause #392, no acks #442, second agent can't bind #391, resume leaves zombie "connected" #390, experimental route not grantable #425. | issues listed |
| 2026-09-28/29 | "Make local internal chat runnable" #525/#527: the docs had "discovery descriptors and owner grants across many steps", and users could not find how to start it. | #525 body |
| 2026-10-01 | A two-mode parity plan adds candidate manifests, digest tuples and an evidence oracle. Native three-party canary #803/#813. Grant restore after resume #757/#759, stable identities #758/#762. | `docs/plans/2026-10-01-001-two-mode-e2e-parity-plan.md`, PRs |
| 2026-10-01/02 | **Codex leg passes; Claude refused as `unproven`** (#813, #819). The fix requires per-process asymmetric keys with owner-compared codes (#822). | #813, #819, #822 |
| 2026-10-02 | Run stopped. Internal mode removed from builds (#876 `f7afdcfb`, −7,158 lines including `apps/web/src/internal` 6,917). `apps/internal` frozen and excluded from the workspace. Dependencies deleted in #909 `102c26f3` (−113,922 lines) and #919 `bd3e93e3` (−15,958). | M1 plan U4; `docs/build/m1/deferred-findings.md:15` |

Totals: 114 commits touched internal-specific paths. `apps/internal` has 121 files and 28,473 TS lines. About 60 issues and PRs have "internal" in the title. There are 107 "E09" issues.

### 2b. Architecture chosen ("Option A: local substrate, real pipeline")

The survey offered Option A, "reuse the whole pipeline", and Option B, a "thin relay". It recommended A (`survey.md:194-266`). A was chosen because a thin relay "does not reuse the pub/sub pipeline, which is the operator's explicit ask" (`survey.md:249`).

| Layer | Choice | Evidence |
|---|---|---|
| Process | One `khala internal` owner process per OS user, holding one active channel. A root lock, `active.json`, and `--resume <id>`. | `internal-core.md:11-30, 209-211`; `apps/internal/src/launcher/{launcher,lock}.ts` |
| Transport | HTTP plus SSE on `127.0.0.1:4870+`. A fragment-token bootstrap swaps the token for an HttpOnly cookie. Exact Host/Origin checks, strict CSP, rate and connection caps. Agents get a "transport capability" from a 0600 descriptor. | `requirements.md:22` (D8); `internal-core.md:119-135`; `apps/internal/src/server/*` (`channel-server.ts` 1,008 lines; `credentials.ts`; `discovery.ts` 619) |
| Storage | `node:sqlite` at `~/.local/share/khala/internal/<channel>/room.sqlite`, 0700/0600, WAL, `synchronous=FULL`, `O_NOFOLLOW`. **About 30 tables**, including `meta`, `participants`, `devices`, `channels`, `memberships`, `bindings`, `events`, `mode_controls`, `mode_operations`, `receipt_facts`, `receipt_projection_checkpoints`, `control_*`, `discovery_*` (6), `admission_operations`, `issued_agent_releases/batches/batch_members`, `agent_acknowledgements`, `automation_arrivals/releases/turn_ends/terminal_challenges`. | `requirements.md:21` (D7); `apps/internal/src/store/schema.ts:9-359` |
| Delivery | The hosted connector pipeline, run locally: `SubscriptionSource` → pending store → policy `evaluateAutomaticRelease` behind a **local automation authority** (G-AUTOMATION opened only here, enforced by a boundary checker) → dispatcher → harness routes. A Khala-side "batch token" ack. Loop limits `{maxCausalDepth:3, maxJobsPerCausalRoot:3, maxConcurrentJobs:1}`. | `survey.md:194-235`; `executor-decisions.md:7-12`; `listening-modes.md:286-342, 508`; `apps/internal/src/composition/local-automation/provider.ts:1-30` |
| Identity | Synthetic local human, plus per-agent participant and device IDs. "Binding capabilities" are stored as keyed hashes. Attribution comes from capability, not the request body. | `internal-core.md:110, 128` |
| Agent admission | Each agent runs `discovery` to get a per-session descriptor, then `/khala join <url>` creates an **access request**. The human grants it in the UI inbox. The server issues a binding capability, which is written to `discovery/<principal>/grant.json`. "An agent can never admit itself" (D11). | `requirements.md:25`; `executor-decisions.md:38-39`; `internal-core.md:128, 182-191` |
| Listener modes | `HarnessCapabilities` evidence matrix. Anything without exact-version proof is `unproven` and refused. Experimental routes need an owner "experimental_route grant". Requested and effective mode are tracked separately. Last-writer-wins with `expectedVersion`. | `executor-decisions.md:22, 42` (decision 42 contradicts spec I-18 "owner controls"); #418, #425 |
| Harness hooks | Claude plugin: `PostToolUse`→steer, `Stop`→sync, `asyncRewake` for idle. Codex: native hooks plus `codex queue` idle wake. OpenCode plugin with `promptAsync`. | `executor-decisions.md:26, 31-32, 34` |
| Human UI | The hosted React app re-composed with a local entry (`vite.internal.config.mjs`). Synthetic always-signed-in identity, HTTP `RoomSubstrate`, durable browser journal, reconnect state machine, owner grant inbox, listening-mode controls, Stop, pause. | `internal-core.md:137-168`; `requirements.md:19` (D4); removed in #876 |
| Lifecycle extras | Markdown and JSONL export with atomic 0600 writes; tombstone delete; **make-external** conversion with history transfer and a journal; receipt projection; read receipts. | `apps/internal/src/{lifecycle,externalization,web/make-external}`; `make-external.md`, `read-receipts.md` |
| Same-user security | The final blocker. A same-uid process could read the shared descriptor and claim another session's ID. The proposed fix: a fresh asymmetric key per Claude MCP process, bound by an owner-compared code shown in the native session. | #822 |

### 2c. What actually worked or was proven

- The local SQLite store passed its own contract and crash-reopen tests, and a `node:sqlite` proof with 0700/0600 modes succeeded (`internal-core.md:57-66`). Node 22's built-in `node:sqlite` means no new dependency.
- The loopback bind with port increment worked (`internal-core.md:62`).
- A packaged smoke test ran with scripted sessions and blocked external requests: `tests/integration/internal-chat/packaged-smoke.test.mjs`, described in the parity plan at line 156.
- **Codex 0.160 native session:** after owner approval it read a human challenge, acknowledged it, replied, and the reply stayed visible after a browser reload (#813 body).
- Claude Code hook mechanics were proven in an isolated plugin probe on 2.1.282:
  - `PostToolUse` context;
  - `Stop` continuation;
  - `UserPromptSubmit` `asyncRewake`;
  - an atomic rename-claim of a per-session pending JSON file;
  - the `/khala <sub>` plugin skill dispatcher.

  Source: `experiments/internal-mode/claude-plugin/README.md`, which is still on main.
- **Never proven:**
  - a Claude read or send in internal mode (#819);
  - the full human↔Codex↔Claude loop (`AGENT-MESSAGES.md`: "the Codex leg of a private internal test passed, but Claude and the complete three-way loop have not");
  - OpenCode delivery (#430);
  - steer, sync or async as *effective* modes for Claude (#819: "steer/sync/async support all `unproven`").

### 2d. Why it was frozen

- The M1 reset decided "Ship external first, then redesign internal". This was user-directed, chosen over deleting internal now or slimming it. Internal was frozen and could stop compiling; it was removed from the build in U4 (`docs/plans/2026-10-01-002-refactor-external-m1-thin-path-plan.md:137, 147, 330-342`).
- The deferred ledger has **D5 "Internal mode redesign and deletion of `apps/internal`", P2, operator, after M1** (`docs/build/m1/deferred-findings.md:15`).
- The governing rule: "When two designs both meet a requirement, pick the one with less code, fewer hops and fewer concepts" (M1 plan:18). Earlier plans, `decisions.md` and `evidence/` "are history, not requirements" (:17).
- The problem frame (M1 plan:44-50) names the general pathology: 960 commits and 245k lines, about 25 identity and state concepts, and about 12 hops per message. Operator memory (`khala-reset-2026-10`): "codex was WAY off from my initial requirements … a very basic chat app."

---

## 3. Failure analysis: specific over-complexity and bad decisions

### F1. The requirements contradicted the later spec, and the build optimised the wrong target

`requirements.md` D4 (serve the hosted UI locally), D7 (SQLite), D8 (local server on :4870) and D11 (a human grant per agent) were "operator-approved" on 09-24. The 10-01 spec reverses three of them:

- §3.1 forbids a mandatory local web server or DB service by default.
- It says a website duplicate is not required.
- It says local channels must not be forced through admission rituals.

Lesson: the spec is now the authority, and any revived design must not restore D4, D7 or D8 as defaults.

### F2. "Reuse the real pipeline" imported every hosted-mode concept into a single-user local app

Option A reused the connector, policy, dispatcher and release-envelope pipeline (`survey.md:194-235`). That pipeline existed for cross-machine trust: per-message approval, at-most-once release, digest-bound release, the G-AUTOMATION gate. On one machine with one human, none of it is needed. It brought in:

- release ledgers;
- batch tokens;
- receipt projections;
- an "automation authority" that needed a build-graph fence to keep it out of hosted bundles (#288, `internal-core.md:217-236`);
- causal-depth loop limits.

The survey listed this risk itself: "The most moving parts" (`survey.md:228`).

### F3. Security theatre for a same-user threat model

Several defences guard against a browser or another process on the same uid:

- token bootstrap through a URL fragment, plus a separate argv-secrecy spike (executor decision 13, `internal-core.md:130`);
- an HttpOnly cookie, exact Host matching, CSP, connection caps, and constant-time compares;
- per-agent capabilities stored as keyed hashes;
- and finally per-process asymmetric keys with owner-compared codes (#822).

The design's own risk table admits that a same-uid process can read everything anyway (`internal-core.md:258-262`). The spec puts the security bar at "appropriate protection" of local plaintext (I-25). The real local boundary is the OS user and file mode 0600, and the threat is mis-attribution between cooperating agents, not adversarial processes.

### F4. A human grant ritual for every agent, on top of discovery descriptors

A local agent had to:

1. run `discovery` to get a descriptor;
2. run `join <url>` to create an access request;
3. wait for the owner to grant it in the browser inbox;
4. receive a binding capability written to `grant.json`.

A resumed launcher then invalidated every capability, so each agent had to re-join (#390, #757). In internal mode there is one human, and every agent belongs to them. Spec §5.4 rejects "multiple successive approvals for an ordinary agent join". #525 records users who could not even find how to start.

### F5. A capability and evidence matrix that refuses to work

`HarnessCapabilities` treated any harness version without exact-session process evidence as `unproven` and refused reads, *including the explicit async `khala_read`* (#418, #819).

- Claude in internal mode never received a single message, because no production call site supplied the required process evidence.
- Experimental routes needed an owner grant that the internal UI had no way to issue (#425).

Honesty about mode support is right (spec :299). Making basic read and send depend on it is wrong.

### F6. A single-active-channel launcher with path-coupled descriptors

- Only one internal channel at a time per OS user (`internal-core.md:245`).
- There was one `active.json`, so a second agent session could not bind (#391).
- Resume wrote a transport-only descriptor, which left zombie "connected" agents (#390).
- Spec I-1 and I-11 want several agents and imply several channels (per-channel modes, I-19).

### F7. Feature sprawl beyond the spec

Built or designed before basic chat worked:

- make-external conversion with history transfer and journals;
- read receipts (the spec says avoid them, I-24);
- Markdown and JSONL export;
- tombstone delete;
- pause separate from Stop separate from async;
- channel visibility (public/private/secret);
- OpenCode and DeepSeek bridges;
- pairing codes;
- a desktop and web app survey;
- hard-cancel spikes;
- a `khala run` PTY wrapper.

In total there were 14 design docs and 5.3k lines on the first day.

### F8. Decisions churned instead of the product shipping

Decisions 1-44 amend one another, sometimes within hours: decision 17 was amended by 31, 5 by 31/32, 12 by 36, 8/18/40 by 44. Ownership by ticket slug and merge-order rules for a hotspot package (decisions 18 and 44) show coordination overhead outweighing product work. Acceptance grew from "a test script creates tickets and agents exchange messages" (decision 11) to candidate manifests, digest tuples, evidence oracles and stage journals (parity plan KTD5, :113).

### F9. The loop limit capped conversation depth

A provisional `maxCausalDepth:3` / `maxJobsPerCausalRoot:3` with `busy:"wait"` (`listening-modes.md:508`) means agents could only ping-pong three hops automatically. That conflicts with the core goal of agents conversing without a human nudging them. The spec asks only to "avoid automatic message-response loops" (:357). The no-auto-reply rule (I-17, :205) already covers this.

### F10. Coupling to a moving hosted composition

The local web entry depended on unmerged PR #120 composition exports (`internal-core.md:51, 139`). The store implemented hosted `RoomSubstrate` and `SubscriptionSource` SPIs. When the hosted stack was deleted in the M1 reset, internal mode was left orphaned. It now depends on `@khala/connector`, `@khala/harnesses`, `@khala/policy` and `@aiur/khala`, which no longer exist (`apps/internal/package.json:12-18`).

### Side note: stale installed plugin

The operator's machine still has the **old** Khala Claude plugin installed. This session exposes `mcp__plugin_khala_khala__khala_create_channel`, `khala_request_channel_access`, `khala_channel_access_status` and `khala_mode_get/set`, which are the E09-era tools. M1's `@khala/agent` exposes `khala_join/status/read/send`. Any internal-mode test must uninstall or replace the old plugin first.

---

## 4. Salvage list

### Worth salvaging: ideas or small code

| Item | Why | Where |
|---|---|---|
| **M1 `KhalaAgentClient` interface** (`join/status/read/send/sendChannelEvent/close`) as the seam for a `LocalAgentClient` | Same MCP tools and hooks; only the transport changes. | `packages/agent/src/client.ts` (main) |
| **M1 per-session inbox, cursor and hook delivery** (`inbox.jsonl`, `advanceCursor` with conflict, `deliver.ts`, `claude-wake.ts`, Codex `idle-wake`) | Transport-agnostic delivery that is already proven in M1. Internal mode only needs to feed the inbox from a local source instead of Matrix. | `packages/agent/src/inbox.ts`, `hooks/`, `src/wake/` |
| **A file-based per-session pending queue with atomic rename-claim** | Proven exclusive claim between competing hook processes, with no server. | `experiments/internal-mode/claude-plugin/README.md`, `hooks/probe.mjs` |
| **`node:sqlite` is in Node 22** (if a DB is wanted at all) | No added dependency. But see I-6: not a "database service", and probably not needed. An append-only JSONL file per channel may be enough. | `internal-core.md:50, 61` |
| **Owner-only file modes (0700/0600), `O_NOFOLLOW`, no payloads in argv, env or logs** | Cheap, correct local hygiene, matching I-25. | `survey.md:181-186`; `apps/internal/src/store/path.ts` (pattern only) |
| **Idempotent send key** `(author, clientTxnId)`, **own-message filtering**, and **monotonic per-channel sequence plus cursor** | Satisfy I-17 and I-24 (no duplicates, no self-wake, ordered catch-up). | `internal-core.md:112-115`; `apps/internal/src/store/cursors.ts` (concept) |
| **Untrusted-content framing of injected messages** | Spec §8.3/§9.1. Already in M1 hooks. | `executor-decisions.md:25`; M1 `deliver.ts` |
| **Listener-mode semantics: sync default, steer at the tool boundary with no abort, async means explicit read only, leaving async does not inject the backlog** | Matches spec I-17/I-18 and M1 behaviour (#960/#963/#964). | spec :169-211 |
| **Honest per-harness disclosure** ("idle agents receive messages only at their next turn" until wake is proven) | Spec :299. Keep it as a *label*, never as a gate on read or send. | `executor-decisions.md:34, 37` |
| **Markdown or JSONL export** | Optional and later. Trivial if storage is already JSONL. | `apps/internal/src/lifecycle/export.ts` (concept) |

### Must not come back

- A mandatory local HTTP server, a browser-UI duplicate of the hosted app, or a DB service *by default*. This violates I-5, I-6 and I-12.
- The connector, policy, dispatcher, release-envelope, batch-token, receipt and automation-authority pipeline, plus its build-graph fence (F2).
- Per-agent access requests, owner grant inboxes, discovery descriptors, binding capabilities and `grant.json` (F4).
- Fragment-token bootstrap, cookies, CSP and Host-check machinery, per-process asymmetric keys, and owner-compared codes. Any defence against a same-uid adversary (F3).
- Capability or evidence gating that refuses read or send (F5).
- A single active channel per user, a global `active.json`, launcher locks and a resume ritual (F6).
- Make-external, history transfer, read receipts, channel visibility tiers, pause separate from modes, pairing codes, the OpenCode/DeepSeek bridge, and a `khala run` wrapper. None are needed for v1 internal mode (F7).
- Causal-depth or turn caps on agent conversation (F9).
- Any dependency on hosted SPIs (`RoomSubstrate`, `SubscriptionSource`) or web composition internals (F10).
- `apps/internal/` as a codebase. It cannot compile, since its dependencies were deleted, and its schema encodes the rejected concepts. Delete it per D5 and keep only ideas from it.

---

## 5. Open product questions for the operator

1. **Scope: one human or several?** The spec says "one human and their multiple local agents" on one computer (:44). Your flow says "send the link to another agent chat". Is every participant your own agent on this machine? Are other humans, or the same human on a second machine over the LAN, out of scope for internal v1?
2. **No-egress (spec I-9).** Claude Code and Codex send their context to Anthropic and OpenAI. That means internal channel text *will* leave the machine through model calls. Do you accept narrowing the promise to "no Khala service or network transport, and storage stays local; agents' own model providers still see what they read"? Or does internal mode have to be restricted to local-model agents? The spec forbids weakening this silently, so it needs your explicit call.
3. **Agent-created channels (I-8).** Your flow has the agent set up the channel when you prompt it. Is "the human asked the agent in the CLI" enough human control, with no further confirmation? Or is there an opt-in setting?
4. **What is the "link"?** It could be a `khala://local/<channel-id>` token, a file path, or an `http://127.0.0.1` URL. Does pasting it into a second agent chat join that agent immediately, with no grant step? The spec rules out repeated approvals, and every agent is yours.
5. **How does the human read and write?** Options:
   - (a) only through their agents' CLIs (ask the agent to send or read);
   - (b) a `khala` CLI tail or TUI;
   - (c) an optional on-demand local web view;
   - (d) the hosted website reading local files (impossible without a server, so effectively c).

   The spec says this is open and no website duplicate is needed. Is the human a participant who posts at all, or mostly an observer?
6. **Persistence and lifecycle.** Should local channels persist across reboots and sessions, with history kept on disk? Do they need delete or export in v1, or is "delete the folder" acceptable?
7. **Listener-mode control surface.** In internal mode, how does the owner change an agent's mode: by telling the agent, through a CLI command, or a file? Should agents be allowed to change their own mode beyond the defensive downgrade? The spec says the owner controls the mode. Old decision 42 allowed last-writer-wins.
8. **Several channels at once.** Should one agent session be able to join several local channels (spec :36), or is one channel per session enough for v1?
9. **Encryption at rest.** Is plaintext in a 0600 file under `~/.local/share/khala/` acceptable (old D6), or do you want local encryption (open per spec :54)?
10. **Make external.** Is converting a local channel to a hosted one wanted at all, or dropped?
11. **Harness scope.** Is it Claude Code and Codex only for internal v1, with OpenCode, desktop apps and others out?
12. **Deleting `apps/internal`.** Confirm deleting it now (D5) before new internal work starts, so no worker is tempted to revive it.
