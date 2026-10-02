---
title: External M1 Thin Path - Plan
type: refactor
date: 2026-10-01
topic: external-m1-thin-path
artifact_contract: ce-unified-plan/v1
artifact_readiness: requirements-only
product_contract_source: ce-brainstorm
execution: code
---

# External M1 Thin Path - Plan

## Goal Capsule

- **Objective:** Two humans and their existing Claude Code and Codex sessions chat in one end-to-end-encrypted external channel. Run it first on the local stack, then in production. Get there by deleting most of the current agent and server machinery rather than repairing it.
- **Product authority:** the operator. The source of truth is `docs/product/khala-spec.md` (operator spec, 2026-10-01) together with this plan's decisions. Earlier plans, `docs/product/decisions.md` and the evidence docs are history, not requirements.
- **Governing rule:** simplify as much as possible. When two designs both meet a requirement, pick the one with less code, fewer hops and fewer concepts.
- **Open blockers:** one feasibility question: can each harness wake an idle existing session? It is proved first (R9) and does not block planning.

---

## Product Contract

### Summary

M1 is the thin external happy path. A human signs in and creates a channel. A coworker joins from the link. Each human pastes the link into their existing Claude Code or Codex session, and all four participants exchange encrypted messages. Idle agents wake and reply on their own. The agent side becomes a thin Matrix-native client, and the server shrinks to sign-in plus Matrix account provisioning.

### Problem Frame

Khala's purpose is to stop humans acting as "meat proxies" who copy messages between isolated agent conversations. Planning finished on 2026-09-18. In the two weeks after that, about 960 commits added roughly 245k lines. External mode has never passed a single human↔agent message.

The added machinery was not requested:
- Three owner approvals before an agent joins.
- Human review of every message.
- A headless Chromium per agent session.
- Device attestation, send fences and a polled owner mailbox.
- About 25 identity and state concepts on the agent path, and about 12 network hops per human→agent message.

The local test runner discards raw failure output and tears its stack down after every attempt, so each failure cost a full rebuild and a guess. The operator's spec (`docs/product/khala-spec.md` §13) directs simplifying toward "share a link and collaborate with our existing agents."

### Actors

- A1. Owner: the human who creates the channel and is its admin. Signs in with a Gmail-linked identity in the browser.
- A2. Coworker: a second signed-in human who joins from the link.
- A3. Claude Code session: an existing interactive session owned by A1 or A2.
- A4. Codex CLI session: an existing interactive session owned by A1 or A2.
- A5. Khala service: sign-in, Matrix account provisioning and the Matrix homeserver. It never sees message plaintext.

### Key Flows

- F1. Create and share
  - **Trigger:** A1 opens the Khala site.
  - **Steps:** A1 signs in, creates a channel and copies its link.
  - **Outcome:** A1 is the channel admin and holds a shareable link.
  - **Covered by:** R1, R2
- F2. Human joins
  - **Trigger:** A2 opens the link.
  - **Steps:** A2 signs in and is admitted with no admin approval.
  - **Outcome:** A2 sees the full channel history and can send.
  - **Covered by:** R3, R4
- F3. Agent joins
  - **Trigger:** A human pastes the channel link into their existing agent session.
  - **Steps:** the agent asks Khala to join. Khala returns one confirmation link. The owner opens it while signed in. The agent becomes a member attributed to that owner.
  - **Outcome:** the agent can read the full history and send. No other approval happens, now or per message.
  - **Covered by:** R5, R6, R7
- F4. Conversation
  - **Trigger:** any participant sends a message.
  - **Steps:** every other member receives it with sender attribution. An idle agent wakes and decides whether to reply.
  - **Outcome:** humans and agents converse without humans relaying messages. Both humans see the whole thread after a reload.
  - **Covered by:** R8, R9, R10, R11

### Requirements

**Humans and channels**
- R1. A human signs in with a Gmail-linked identity and creates a channel, becoming its admin.
- R2. The admin can copy a channel link. In M1 only the admin creates links.
- R3. Any signed-in human who opens the link is admitted automatically. M1 has one invite type: open, automatic join.
- R4. Every admitted member, human or agent, can read the channel's full history.

**Agents**
- R5. An agent joins from the channel link inside its existing Claude Code or Codex session. Khala never launches a new agent or replaces the session.
- R6. Joining requires exactly one owner confirmation: a link the agent returns, which the signed-in owner opens. It never opens a desktop browser on its own.
- R7. An admitted human's agents need no admin approval, and no message from or to any agent needs approval.

**Messaging**
- R8. Messages are end-to-end encrypted between participant endpoints. The Khala service cannot read plaintext or obtain decryption keys.
- R9. A message reaching an idle agent wakes the existing session promptly and enters its context, attributed to its sender. The agent then decides whether to reply.
- R10. A message reaching a busy agent waits for the next input boundary the harness supports (sync behavior), then arrives with attribution and order intact.
- R11. An agent's own messages never come back to it as new incoming events, and redelivery never causes a repeated reaction.
- R12. Send failures and disconnected agents are visible to the affected human.

**Simplification**
- R13. Code that M1 does not use is deleted, not hidden: the old agent connector, the per-message review and release path, the policy package, multi-approval join, proof-key and device-attestation machinery, the owner mailbox, send fences, pairing, and the control routes that only those features served.
- R14. Local external mode runs as one long-lived stack (OIDC provider, homeserver, web app and functions) that stays up across attempts and surfaces raw logs on failure.

### Acceptance Examples

- AE1. **Covers R3, R4.** Given A1 and A2 have exchanged three messages, when A2's Claude session joins, then it can read all three.
- AE2. **Covers R9.** Given A1's Codex session is idle at its prompt, when A2 sends a message, then the Codex session receives it without A1 typing anything, and may reply.
- AE3. **Covers R10.** Given A2's Claude session is mid-task, when A1 sends a message, then it arrives at Claude's next supported input boundary, and Claude's current task is not interrupted.
- AE4. **Covers R11.** Given Codex sends a reply, when its own message syncs back, then Codex is not woken by it.
- AE5. **Covers R9 fallback.** Given a harness that cannot wake an idle session, when a message arrives, then it is delivered at that session's next turn, and the gap is recorded per harness and version.
- AE6. **Covers M1 done.** Given the local stack, A1 and A2 in headless browsers, a real Claude Code session and a real Codex session: each agent reads the humans' messages and replies, the agents exchange at least one message each way, and both humans see all of it after a reload. The same run then passes against production.

### Key Decisions

- **Thin Matrix-native agent client plus a minimal server.** Each agent session runs a small local client that is its own Matrix device, with encryption running in-process. That replaces the old connector and its per-session headless Chromium. The server keeps sign-in and Matrix account provisioning; membership and history use Matrix room membership and visibility. (session-settled: user-directed — chosen over stripping the existing connector in place, and over a thin client with the current control plane kept: the old agent stack is where the thrash lived, and minimal server work deletes the most code.)
- **One owner confirmation per agent join.** Ownership must be proven, but the three-step approval was invented. (session-settled: user-directed — chosen over keeping the proof-key, discovery-consent and access-decision steps: an admitted owner's agents need no discretionary approval.)
- **M1 is the thin happy path.** (session-settled: user-approved — chosen over adding listener modes, admin basics, or the full external spec to M1: one working path first.)
- **Idle agents must wake in M1.** (session-settled: user-approved — chosen over next-turn-only delivery: agents must converse without a human nudging each CLI.) Where a harness cannot wake an idle session, M1 ships with next-turn delivery for that harness and reports the gap rather than blocking.
- **Full history for every member in M1.** (session-settled: user-approved — chosen over from-join-onward history: late-joining agents need context.) The operator's intended model comes in M2: the link sharer picks a history setting per link, the admin can override it per channel, and the admin can allow or block members from creating links.
- **Ship external first, then redesign internal.** Internal mode is frozen during M1. It may stop compiling as shared packages are deleted, and it is deleted and redesigned with the operator after M1. (session-settled: user-directed — chosen over deleting it now or slimming it: external ships first, and the internal design is a separate conversation.)
- **Reset production; no migration.** Existing production channels and agent bindings are discarded. That waives spec §13's migration requirement for this reset.

### Scope Boundaries

**Deferred to M2+**
- Steer and Async listener modes, per-channel mode settings, defensive downgrade and owner override.
- Single-use invites, approval-required invites, per-link history choice, admin history override, the member link-sharing permission.
- Remove an agent, remove a human with their agents, delete a channel.
- Agent-first channel creation.
- The redesign of internal mode.
- More harnesses beyond Claude Code and Codex.

**Outside this product's identity (spec §16)**
- Per-message approvals, per-agent admin approvals, participant or agent quotas, ownership transfer.
- Replacement agent runtimes or hosted agent compute, project orchestration, attachments, bridges, roles, billing, read receipts.

### Dependencies / Assumptions

- Matrix stays the encrypted transport (spec §3.2, §11.1). The Synapse homeserver on Railway and the web app on Netlify stay in place.
- Assumption: Matrix encryption runs in a plain Node process without a browser. Planning must prove it before building on it.
- Assumption: Claude Code can push an MCP server event into a running interactive session. Codex can add input to an existing interactive session through its app-server or queue surfaces. Both are proved first (R9).
- Production has no channel data worth keeping.

### Outstanding Questions

**Deferred to Planning**
- Which in-process Matrix crypto runtime to use, and how device keys are stored per agent session.
- The exact wake mechanism per harness and tested version, and what the human sees in the terminal (spec §10 keeps presentation open).
- How the owner confirmation link binds an agent's Matrix identity to its owner without proof-key machinery.
- Which existing modules survive (web UI, sign-in, Matrix provisioning) and the deletion order, so the browser path keeps working throughout.
- What raw-log and keep-alive behavior the long-lived local stack needs, and which parts of `infra/preview` to reuse.

### Sources

- `docs/product/khala-spec.md`: operator spec, 2026-10-01, the authoritative scope.
- `docs/research/recovered/SCOPE.md`: the operator's original 2026-09-16 framing ("meat proxies"; "send the other human a link, they hand it to their agent, everyone is in the room").
- `infra/preview/external-local.mjs`, `infra/preview/compose.yaml`, `infra/messaging/compose.yaml`: the existing disposable local external stack (Dex, Synapse, Postgres, `netlify dev`).
- `tests/integration/human/create-share-chat.spec.ts`: the passing human↔human encrypted browser path to preserve.
- `apps/connector/src/substrate/matrix.ts`: the per-session headless-Chromium Matrix substrate being replaced.
- `apps/control/src/composition/hosted-production.ts`: the hosted route surface being trimmed.
