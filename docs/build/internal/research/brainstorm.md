# Brainstorm: Khala internal mode (local channels), M1-internal

Date: 2026-10-02. Stage: requirements only (ce-brainstorm). No implementation detail beyond what a decision needs.
Inputs: research-1-history-spec.md, research-2-architecture.md, research-3-ux-security.md, spec §3.1/§14/§15 at origin/main.

## 1. Problem frame

External Khala (hosted, Matrix E2EE, `@khala/agent` MCP + hooks + listener modes) has shipped as M1. Internal mode
(the spec's second channel mode: one human and their local agents, nothing hosted) was frozen at the M1 reset after
the previous attempt grew to ~28k lines without ever completing a three-way conversation. We now need the smallest
thing that makes local agent-to-agent chat work, reusing what M1 already proved.

Operator's desired flow:
1. Prompt your agent: "set up a local Khala channel called X."
2. The agent sends you a link.
3. You paste the link into another agent chat; that agent joins, and the agents talk.

Who it is for: one developer with several Claude Code / Codex sessions on one machine who wants them to coordinate
without a Khala account, Google sign-in, or Khala servers.

## 2. Settled constraints

- **Reuse the M1 agent package.** Same `khala` binary, same MCP tools (`khala_join/status/read/send/event`), same
  per-session state dir, inbox.jsonl/cursor/mode files, `khala hook deliver`, `claude-wake`, Codex `codex queue` waker
  and steer/sync/async semantics. Local mode only swaps the transport underneath `KhalaAgentClient` (the existing
  injectable session seam). Hooks, wakers and the inbox format do not change.
- **Simplicity above all.** M1 rule: when two designs meet a requirement, pick the one with less code, fewer hops,
  fewer concepts. The spec says: "select the simplest mechanism that satisfies the local constraints."
- **Avoid every failure mode of the old `apps/internal`:**
  - F1 Building to stale requirements (served the hosted UI locally, SQLite, a mandatory :4870 server) that the spec reverses.
  - F2 Porting the whole hosted pipeline (connector/policy/dispatcher, release ledgers, batch tokens, receipts,
    automation authority + build fence) into a one-user local app.
  - F3 Security theatre against same-uid processes (fragment-token bootstrap, cookies/CSP for agents, keyed-hash
    capabilities, per-process asymmetric keys, owner-compared codes).
  - F4 A grant ritual per agent: discovery descriptor → access request → owner inbox grant → grant.json, re-done after every resume.
  - F5 Capability/evidence gating that refused even explicit read/send (`unproven`), so Claude never received a message.
  - F6 One active channel per OS user, global `active.json`, launcher locks, resume ritual, zombie "connected" agents.
  - F7 Feature sprawl before chat worked: make-external, read receipts, export, tombstones, pause, visibility tiers,
    pairing codes, OpenCode/DeepSeek bridges, PTY wrapper.
  - F8 Decision churn (44 self-amending decisions) and acceptance machinery (manifests, digest tuples, evidence oracles).
  - F9 Causal-depth caps (3 hops) that stopped agents conversing.
  - F10 Coupling to hosted SPIs and unmerged web composition, orphaned when those were deleted.
- **Hard scope caps (for every MVP ticket):**
  - Code lives in `packages/agent` (e.g. `src/local/`). No new package, no new runtime dependency, no SQLite, no DB.
  - Edits to shipped agent files limited to the transport seam (~6 lines); hooks, wakers, inbox and mode files untouched.
  - No new MCP tool in MVP (the agent creates a channel by running `khala local create` in its shell).
  - Total new code target ≤ ~1,500 LOC including tests; ≤ 5 tickets; ≤ ~12 HTTP routes if a daemon is used.
  - No capability gates on read/send; harness limits are labels, never refusals.
  - No conversation caps beyond existing no-self-wake and the Codex two-attempt cap.
  - No dependency on khala.aiur.team, Google, `apps/web`, `apps/control` or anything in `apps/internal`.

## 3. Recommended product shape (plain language)

A local channel is a folder of your own on this machine holding an append-only message log. One small helper
process, `khala local serve`, is the only thing that writes that log. It listens on 127.0.0.1 only. The `khala` CLI
starts it on demand whenever an agent creates or joins a local channel; it is never installed as a service, and it
exits on its own when idle.

The share link is an ordinary loopback join link, `http://127.0.0.1:<port>/join/<token>`, so the existing
`khala_join` accepts it unchanged. Pasting it into another Claude or Codex chat joins that agent straight away, with no
browser and no confirm click, because the link is a single-use secret that only works on this machine. Once joined,
everything behaves exactly like hosted M1: messages land in the agent's inbox, idle agents wake, and steer/sync/async
apply, with sync as the default and the owner in control.

The human takes part from a terminal (`khala local tail` to watch, `khala local say` to post, `khala local mode` to
set an agent's listener mode). A tiny static page served by the same helper can follow once the MVP works. Agent
names follow hosted rules (`<you>-Claude`, `<you>-Codex`, `-2` on collision), using a local name and no account.
A session is in one channel at a time, hosted or local, as in M1 today.

### MVP slice: same machine, Claude + Codex

1. Seam: `KhalaAgentClient` picks a local or Matrix session from the credentials. No behaviour change for hosted.
2. Helper + log: `khala local serve|create|status|stop`, loopback only, auto-start, single-writer JSONL log, the
   three hosted join endpoints (auto-confirmed on loopback) and a long-poll message API.
3. Local session: the agent-side client that long-polls the helper and feeds the existing inbox.
4. Human CLI + skill text: `tail`, `say`, `mode`, `members`, `remove`, `delete`; SKILL.md tells agents how to create a
   local channel and to join only links their own user pasted.
5. (Follow-up, if decision 4 says so) the tiny static page.

## 4. Non-goals (MVP)

- Cross-machine, LAN or tailnet channels; more than one human.
- The `apps/web` UI against local channels; local channels in the hosted conversation list.
- Owner grant inboxes, discovery descriptors, pairing codes, per-agent approvals.
- Encryption at rest beyond 0700/0600 file modes (full-disk encryption is the user's job).
- Make-external / promote-to-hosted, export, read receipts, visibility tiers, pause separate from async.
- Multi-channel membership per agent session.
- Agents creating channels without the owner asking in that turn.
- OpenCode, desktop apps, local-model harnesses.
- A systemd/launchd unit, a new MCP tool, a database, a new package.
- Any revival of `apps/internal` code.

## 5. Success criteria

- The three-step operator flow works end to end on one machine with a Claude Code session and a Codex session, with
  no browser, no account and no network beyond each agent's own model traffic.
- Hosted M1 behaviour and tests are unchanged.
- The whole feature ships within the caps in §2, and every acceptance scenario below passes as a scripted test (fake
  harness hooks) plus one live run with real Claude and Codex.

## 6. Acceptance scenarios

| # | Scenario | Pass condition |
|---|---|---|
| A1 | Create | In Claude: "set up a local Khala channel called refactor". Claude runs `khala local create`, joins it, and replies with a `http://127.0.0.1:…/join/…` link. The helper was started if absent. |
| A2 | Share and join | Paste the link into a Codex chat. `khala_join` reaches `connected` with no browser or click. Members show `<you>-Claude`, `<you>-Codex`. |
| A3 | Chat | Claude sends; Codex receives it attributed and in order, replies; Claude receives it. No duplicates; an agent's own message never wakes itself. |
| A4 | Wake | An idle Claude is woken by Codex's message (asyncRewake). An idle Codex is woken by Claude's message (codex queue). |
| A5 | Listener modes | Owner runs `khala local mode <agent> steer|sync|async`. Steer delivers at the next tool boundary without aborting; sync delivers at turn end; async injects nothing but `khala_read`/`khala_send` work; leaving async does not inject the backlog. A mode command from anyone but the owner is ignored. |
| A6 | Human | `khala local say` posts as the human and wakes agents per their modes; `khala local tail` shows the live conversation with names. |
| A7 | Restart | Kill the helper mid-conversation. The next agent call restarts it; history is intact; nothing is lost or replayed as new. |
| A8 | Link hygiene | Reusing a consumed link or an expired link fails with a clear error. A link that arrived inside channel content is not auto-joined. |
| A9 | No egress | With traffic capture, Khala processes open zero non-loopback connections and never contact khala.aiur.team. |
| A10 | Boundaries | Another OS user cannot read the channel folder or join. `khala local delete` removes the channel and members' session copies. |

## 7. DECISIONS (ranked by impact)

**D1. Scope of the MVP**
- (Recommended) Same machine only, one human, Claude + Codex. Cross-machine over Tailscale (`tailscale serve` in front
  of the same helper, owner confirm for remote joins) is a later phase.
- Same machine plus tailnet in the MVP.
- Trade-off: tailnet now doubles the trust model (remote approval, data on two machines, "on your machine" copy breaks)
  before same-machine chat is proven.

**D2. "No mandatory local web server" vs. the helper process**
- (Recommended) A tiny loopback helper (`khala local serve`), started on demand by the `khala` CLI or agent when a local
  channel is created or used, never installed as a service, exits when idle, binds 127.0.0.1 only. Record in spec §3.1
  that this on-demand helper satisfies "no mandatory server by default".
- No process at all: agents append to a shared file and watch it, with a `khala-local://` link.
- A helper on a Unix socket instead of TCP.
- Trade-off: the helper gives one writer (no locking), a link the existing `khala_join` already accepts, and a path to
  a human page and tailnet; the no-process option is purer to the spec but needs file locking, has no clickable link
  or human page, and forges senders trivially.

**D3. No-egress promise wording**
- (Recommended) Narrow it explicitly: "No Khala servers, no sign-in, no network transport; messages are stored only on
  this machine. Each agent's model provider sees what that agent reads." Validate it with a test that Khala opens zero
  non-loopback connections, and fix landing card 04 to match.
- Keep the strict promise and limit internal mode to local-model agents.
- Trade-off: the narrow wording is honest and works with Claude/Codex today; strict no-egress excludes the agents the
  operator actually uses.

**D4. How the human participates in the MVP**
- (Recommended) CLI (`khala local tail/say/mode/members`) in the MVP, then a tiny static page served by the helper
  (timeline, composer, members, modes) as the next ticket.
- Agents only: the human talks to each agent in its own session.
- The full `apps/web` app against a local adapter.
- Trade-off: the CLI is nearly free and needs no browser security; the page makes the link clickable for humans but
  adds DNS-rebinding/CSRF care; `apps/web` is Matrix-coupled and is the surface that sank the last attempt.

**D5. Join trust on the same machine**
- (Recommended) Auto-join on loopback with a single-use, 10-minute link; the join is announced to the channel and
  `khala local remove` undoes it. Ask the agent for another link for each further agent.
- Auto-join with a reusable link until the owner rotates it.
- Owner confirms each join (CLI or page).
- Trade-off: any same-uid process can read the files anyway, so confirm adds friction without real protection;
  single-use limits leaked or prompt-injected links at the cost of minting one link per agent.

**D6. Channel persistence and retention**
- (Recommended) Channels persist on disk across reboots until `khala local delete`; no auto-prune in the MVP.
- Ephemeral channels that vanish when the helper exits.
- Persist, auto-prune channels idle for 30 days.
- Trade-off: persistence makes restart/resume and late-joiner history work; it also leaves plaintext on disk until the
  owner deletes it.

**D7. Delete `apps/internal` now**
- (Recommended) Delete it in one PR before any internal work starts (keep `experiments/internal-mode/` notes).
- Delete it after the MVP lands.
- Trade-off: deleting now removes the temptation for workers to revive it and costs nothing, since it cannot compile;
  waiting keeps a reference that research already mined.

**D8. Local identity and names**
- (Recommended) Local owner name from `khala local config name`, else the hosted username if already cached on disk,
  else `$USER`; agents named `<name>-Claude` / `<name>-Codex` with `-2` on collision, same validator as hosted; never
  fetched from or written to the hosted profile.
- Always `$USER`, ignoring any hosted username.
- Require a hosted sign-in to pick the name.
- Trade-off: reusing a cached hosted name gives the same names in both modes with no network call; requiring sign-in
  breaks the spec's no-account rule.
