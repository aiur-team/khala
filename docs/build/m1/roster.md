# M1 build — ticket roster (plan_version 3)

- Build order: `aiur-team/khala:m1-external-chat`.
- Logical prefix: `KM-`. IDs are opaque; they do not encode phase.
- Sources: `docs/plans/2026-10-01-002-refactor-external-m1-thin-path-plan.md` (units U1–U17), `docs/plans/2026-10-01-003-feat-channel-events-plan.md` (events E-U1–E-U6), and the Claude Design import (design lane).
- Shapes: every ticket quotes [`contracts.md`](contracts.md) verbatim.
- plan_version 2 applies the Executor decisions in [`reconciliation.md`](reconciliation.md): contract amendments A1–A10, graph changes, late additions and acceptance ownership.
- plan_version 3 applies its **Round 2 rulings** R1–R12: KM-103 owns `bin/khala.mjs` outright (C12) and no later ticket edits it; KM-150 gains `depends_on` KM-147 and owns the Codex waker wiring; KM-104's `./m1/*` wildcard serves KM-170/171 (no edge with KM-125); C11 gains `displayName`; C6 envelopes depend only on the hook event.
- Agent package: `@khala/agent` (bin `khala`) for all of M1; never renamed. Filter with `pnpm --filter @khala/agent` or `--filter ./packages/agent`.

## Lanes

| Lane | Icon | Columns |
|---|---|---|
| platform | `server-stack` | local stack, build cuts, deletions, CI fixes, docs |
| app | `window` | web and control (human path, agent-join server, confirm page) |
| agent | `cpu-chip` | `@khala/agent` agent client, MCP tools, hooks, wakers |
| events | `bolt` | channel events (Aiur-compatible) |
| design | `sparkles` | Claude Design recreation; model is Claude Opus 5.5 |
| acceptance | `shield-check` | integration and four-party acceptance, local and production |

Model routing:
- Lane `design` → label `model:claude` (Claude Opus 5.5).
- All others → `model:codex` (Codex Sol 6.1).
- Exception, **Executor-owned**: KM-151 and KM-152 are promoted with label `human:todo`, not `agent:todo`, so Aiur never dispatches them. The Executor (Claude) runs them as runbooks, acting as both humans via headless browsers and coordinating the operator's listening Claude Code and Codex terminals through `/home/everdred/github/everdred/khala/AGENT-MESSAGES.md`.
- KM-111 and KM-112 stay Aiur-dispatchable (`agent:todo`) for their code; their manual pane legs are requested from the Executor by a message in `AGENT-MESSAGES.md`.

## Tickets

`dep` lists hard `depends_on` edges, each passing the CI-green or contract-authority test. `ser` lists `serializes_with` edges (symmetric). `after` marks `suggested_after`.

Serialization groups: root scripts KM-101 ~ KM-102; lockfile KM-102 ~ KM-103; shared panes KM-111 ~ KM-112 ~ KM-151; browser `matrix-browser.ts` KM-130 ~ KM-134 ~ KM-135 ~ KM-172; control `matrix.ts`/`handlers.ts` KM-130 ~ KM-122 and KM-130 ~ KM-123; shared thread styles KM-172 ~ KM-182.

Deletion PRs: `deletion-guard` needs admin approval on the head SHA for any PR that deletes files — KM-102, KM-120, KM-123, KM-124, KM-125, KM-153. Each says so in its PR checklist; the reviewer handles it.

| ID | Title | Lane | C | dep | ser | Plan source | Scope in one line |
|---|---|---|---|---|---|---|---|
| KM-101 | Long-lived local external stack | platform | 3 | — | 102 | U1 | `infra/local/stack.mjs` up/down/logs/status reusing `infra/preview` pieces; state in `.khala-local/` |
| KM-102 | Take internal mode out of the build | platform | 2 | — | 101, 103 | U4 | Exclude `apps/internal` from the workspace; drop the internal vite build, CI steps, scripts and boundary rules |
| KM-103 | Scaffold `@khala/agent` and harvest reusable agent code | agent | 2 | 104 | 102 | U2/U13/U14 prep | New `packages/agent` skeleton (package.json, tsconfig, vitest, the final `bin/khala.mjs` C12 dispatcher, `src/client.ts` interface from C7); copy the MCP stdio scaffolding and Codex idle-wake process code from soon-deleted packages |
| KM-104 | M1 contracts module | app | 1 | — | — | C2/C3/C5 | Create `packages/contracts/src/m1/{agent-join,participants,inbox}.ts` with the C2/C3/C5 types plus runtime validators and tests; add the export subpath |
| KM-110 | Agent Matrix session (Node rust crypto) + evidence | agent | 3 | 101, 103, 104 | — | U2 | `packages/agent/src/matrix/session.ts` (C11, including `displayName`) and a live test against the stack: browser invite with history, then agent decrypts, sends and self-filters; `docs/evidence/m1-node-matrix-agent.md` |
| KM-111 | Spike: Claude Code idle wake via hooks | agent | 3 | 103 | 112, 151 | U3 (Claude) | Prototype `asyncRewake` Stop watcher + `UserPromptSubmit` delivery on a stub inbox; check `/reload-plugins`; evidence `docs/evidence/m1-idle-wake-claude.md`. Uses the operator's Claude pane via `AGENT-MESSAGES.md` |
| KM-112 | Spike: Codex idle wake via codex queue | agent | 3 | 103 | 111, 151 | U3 (Codex) | Prototype `codex queue` + trusted hook delivery on a stub inbox; evidence `docs/evidence/m1-idle-wake-codex.md`. Uses the operator's Codex pane |
| KM-120 | Web cut: plain send, remove dead client features | app | 3 | 102 | — | U5 | Remove send fence, review, owner controls, channel-access inbox, owner-device trust/proof, revocation and closure from `apps/web`; send is `client.sendEvent` |
| KM-122 | Control prep: participants without agent stores | app | 2 | 104 | 130 | U6 part | Participants route reads human map + C3 owner map, returns `unknown` instead of failing; move `createMatrixBrowserSenderVerifier` out of `room-send-routes.ts` |
| KM-123 | Control cut: shrink to the M1 route surface | app | 3 | 120, 122 | 130 | U6 | `hosted-production.ts` registers only kept human routes; delete agent-bootstrap, channel-access, channel-discovery, pairing, closure, owner-mailbox, revocation, room-send and device-admission code |
| KM-124 | Delete old agent stacks, suites, scripts and preview runner | platform | 2 | 101, 102, 103, 123 | — | U7 | Delete `apps/connector`, `packages/{connector,policy,agent-skill,agent-cli,harnesses,claude-plugin}`, `tests/{conformance,e2e}`, agent-only integration suites, old scripts, `infra/preview`, the release workflow; fix CI and boundaries |
| KM-125 | Prune dead contracts and messaging modules | platform | 2 | 124 | — | U8 | Remove unimported modules in `packages/contracts` and `packages/messaging`; keep the list in the U8 approach |
| KM-130 | Shared history visibility + browser cross-signing | app | 2 | 120 | 122, 123, 134, 135, 172 | U9 | `history_visibility: shared` at both creation sites; silent `bootstrapCrossSigning`; drop the `history:'full'` refusals; update the human browser spec (AE7) |
| KM-131 | Control: agent-join store and agent routes | app | 2 | 104 | — | U10 part | `apps/control/src/agent-join/{store,agent-routes}.ts`: request, poll, ready (C2), Blobs compare-and-set, 10-minute TTL, hashed poll secret. Unregistered handlers plus tests |
| KM-132 | Control: agent provisioning and human confirm routes | app | 3 | 104, 131 | — | U10 part | `apps/control/src/agent-join/{provision,human-routes}.ts`: view, confirm, status (C2); register the agent account (C4), mint token, seal credentials, write owner map (C3). Unregistered handlers plus tests |
| KM-133 | Control: register agent-join routes | app | 2 | 123, 131, 132 | — | U10 wiring | Add KM-131/132 handlers to `hosted-production.ts`; route smoke tests |
| KM-134 | Web: agent confirmation page | app | 2 | 104, 120 | 130, 135, 172 | U11 | `apps/web/src/features/agent-confirm/`: signed-out redirect, confirm, poll status, `client.invite(roomId, agentUserId)`; states connecting, done, error |
| KM-135 | Web: agent attribution in the timeline | app | 2 | 104, 120, 122 | 130, 134, 172 | U15 | Render C3 participants: agent label, owner and harness badge; `unknown` fallback |
| KM-141 | Agent state dir, inbox and cursor library | agent | 2 | 103, 104 | — | U12 part | `packages/agent/src/{state,inbox}.ts`: C5 layout and permissions, append with eventId dedup, atomic cursor, unread count |
| KM-142 | Agent join client | agent | 2 | 103, 104 | — | U12 part | `packages/agent/src/join.ts`: request, poll every 2 s for up to 10 min, ready; typed errors (C2); persists `join.json` |
| KM-143 | Agent client orchestration | agent | 3 | 110, 141, 142 | — | U12 | `packages/agent/src/client-impl.ts` implementing `KhalaAgentClient` (C7): join → session → wait for invite → `joinRoom`; intake to inbox with own-sender filter; read/send; `status.json` |
| KM-144 | MCP server and four tools | agent | 2 | 103, 104 | — | U13 | `packages/agent/src/mcp/{server,tools}.ts`: C7 tools against a fake `KhalaAgentClient`; session id resolution (C5); `src/mcp/main.ts` default export for `khala mcp` (C12; no bin edit) |
| KM-145 | Sync delivery hook | agent | 2 | 141 | — | U14 part | `packages/agent/hooks/deliver.ts` (C12 hook module; no bin edit): print the C6 frame in its event envelope for unread entries, advance the cursor atomically, no-op when empty |
| KM-146 | Claude wake watcher and plugin packaging | agent | 2 | 111, 145 | — | U14 part | `packages/agent/hooks/claude-wake.ts` (C12 hook module; no bin edit) + `hooks.claude.json`; `packages/agent/claude-plugin/` (plugin.json, .mcp.json, SKILL.md); install doc |
| KM-147 | Codex waker and Codex packaging | agent | 2 | 141, 145 | — | U14 part | `packages/agent/src/wake/codex.ts` (debounced `codex queue`, no shell, scrubbed env) + `hooks.codex.json` + `codex/config.toml.example`; install doc |
| KM-150 | Integration: agent joins and chats on the local stack | acceptance | 3 | 130, 133, 134, 135, 143, 144, 147 | — | U12/U13 wiring | Wire `src/mcp/main.ts` to the real client and the Codex waker (`src/mcp/wiring.ts`; no bin edit); live test: headless owner confirms, agent reads history, agent sends, browser sees it with attribution |
| KM-151 | Local four-party acceptance (Executor-owned, `human:todo`) | acceptance | 3 | 135, 146, 147, 150 | 111, 112 | U16 | Runbook, headless human driver, and the run with the operator's Claude and Codex panes; verifies KM-150's Codex waker wiring (no `packages/agent` edits); evidence doc |
| KM-152 | Production reset, deploy and acceptance (Executor-owned, `human:todo`) | acceptance | 3 | 151 | — | U17 | Back up and wipe prod Synapse + Blobs, deploy the KM-151 SHA, prove the deploy SHA three ways (deploy id, deploy title, served `index.html` hash), repeat AE6 on `khala.aiur.team` |
| KM-153 | Docs: M1 user guide and README | platform | 1 | — (after 151) | — | DoD | Rewrite `README.md` and `docs/user-guide.md` for the M1 flow only; delete stale operations docs |
| KM-160 | CI repair pass 1 (after deletions) | platform | 2 | 124 | — | KTD11 | Make `main` CI green after the cut; this ticket waits for CI |
| KM-161 | CI repair pass 2 (before acceptance) | platform | 2 | 150 | — | KTD11 | Make `main` CI green after integration; waits for CI |
| KM-170 | Channel event contract and formatter | events | 2 | 104 | — | E-U1 | `packages/contracts/src/m1/channel-event.ts` |
| KM-171 | Aiur → Khala event mapper | events | 2 | 170 | — | E-U2 | `packages/contracts/src/m1/from-aiur.ts`, pure function with fixtures |
| KM-172 | Browser channel-event pill | events | 3 | 170, 120 | 130, 134, 135, 182 | E-U3 | Decode `com.khala.event.v1` in `matrix-browser.ts`; `ChannelEventPill` component |
| KM-173 | Agent `khala_event` tool | events | 2 | 143, 144, 170, 171 | — | E-U4 | `khala_event` MCP tool + `sendChannelEvent` (C7, C11); emit with a key-derived txn id. No CLI |
| KM-174 | Agent reads events as framed data | events | 2 | 143, 145, 170 | — | E-U5 | Events in the inbox as `kind:'event'`; never wake |
| KM-175 | Aiur adapter integration doc | events | 1 | 170, 171, 173 | — | E-U6 | `docs/integrations/aiur-channel-events.md` |
| KM-180 | Design: edge-to-edge Khala shell and tokens | design | 3 | — (gate G-DESIGN) | — | design | Recreate the design's tokens and the three-pane layout full-bleed; owns `apps/web/src/ui/conversation/tokens.css` and `ConversationLayout` |
| KM-181 | Design: conversation list pane | design | 2 | 180 | — | design | `ConversationList` per design |
| KM-182 | Design: thread, bubbles, day separators, event pill style | design | 3 | 180 | 172 | design | `ChatThread`, `ChatMessage`, event-row styles |
| KM-183 | Design: header and roster disclosure | design | 3 | 180 | — | design | Avatar stack, title, member summary, human → agents roster tree |
| KM-184 | Design: composer and recipient chips | design | 2 | 180 | — | design | `ChatComposer` with chips row |
| KM-185 | Design: agent confirmation page visual | design | 1 | 134, 180 | — | design | Restyle KM-134's page to the design system |
| KM-186 | Design parity audit | design | 2 | 181, 182, 183, 184, 185 | — | design | Side-by-side comparison against the imported design at 5 widths in both themes; fix drift |

## External gates

- **G-DESIGN:** the Claude Design project is imported to `docs/design/khala-chat/` with a diff/recreation spec. Owner: Executor. It gates KM-180..186.
- **G-PANES:** the operator's live Claude Code and Codex test panes are listening on `AGENT-MESSAGES.md`. It gates the manual legs of KM-111, KM-112 and KM-151 (all coordinated by the Executor).
- **G-PROD:** gates KM-152. It covers operator approval of the production wipe, naming two real Google accounts, and the operator doing a one-time headed login (`humans.mjs login`). Precondition D8: the production identity provider (Google OIDC configuration) is confirmed before KM-152.
