---
title: "KHA-145 Native agent surface - Requirements"
type: feat
date: 2026-09-18
topic: native-agent-surface
artifact_contract: ce-unified-plan/v1
artifact_readiness: requirements-only
product_contract_source: ce-brainstorm
execution: code
origin: docs/product/decisions.md#p15
covers: KHA-145, KHA-146, KHA-147, KHA-148, KHA-149, KHA-150, KHA-151, KHA-152, KHA-153
---

# KHA-145 Native agent surface - Requirements

## Goal Capsule

Replace the parked existing-session attachment approach with an agent surface the owner directed on 2026-09-18 (P15): an agent installs a Khala CLI, each harness uses its own native mechanism first, a generic skill plus CLI covers harnesses without one, and a human sends and receives in the same room from the web UI. This artifact is the product contract for the nine tickets KHA-145 to KHA-153. It is requirements-only: G-HARNESSES and G-SUBSTRATE are still open, and nothing here claims a route works. The implementation plan is `docs/plans/2026-09-18-kha-145-native-agent-surface-plan.md`.

Product authority: `docs/product/decisions.md` P01, P04, P06, P10, P11, and the four decisions recorded 2026-09-18 (P12 admission policy, P13 closure and retention, P14 recovery and escrow, P15 native agent surface).

Open blockers carried in: G-HARNESSES (no route is approved until a proof passes), G-SUBSTRATE (no messaging substrate is selected, so no live transport exists), G-AUTOMATION (automatic peer delivery stays out of scope).

## Product Contract

### Summary

An agent joins a Khala room by installing and running a Khala CLI, not by having a human configure infrastructure. Where the agent's harness has a native way to receive a message into the session that is already working, Khala uses it. Where it does not, the agent installs a Khala skill that runs a listener. A human in the same room sends and receives from the web UI and can see, per agent, which route that agent is on.

### Problem Frame

KHA-103 asked whether an already-running Claude Code session could be attached to from outside, and answered no under the no-setup contract: the nearest route needed a human permission approval, expired after thirty minutes, had no reconnect, no backlog and no dedup (`docs/evidence/claude.md`). That answer parked KHA-117 as a fail-closed adapter (`packages/harnesses/src/claude/README.md`) and left KHA-133 with one live harness. The question was the wrong one. Both Claude Code and Codex ship a command line that an agent can install and run itself, and an agent running a Khala process is not the same problem as a third party reaching into a session it does not own. The frame changes from *attach to a session* to *the agent runs a Khala client, and Khala uses the harness's own delivery mechanism to put released bytes in front of the model*.

The second half of the frame is the human. `apps/web/src/features/timeline/` and `apps/web/src/features/review/` already implement a composer, a live timeline and a recipient review UI against injected ports, but nothing composes them into a room page, and no agent-presence surface exists anywhere. A human cannot currently see whether their agent is connected, on which route, or what to paste to the agent to connect it.

### Requirements

- **R01. Agent-installed client.** An agent joins by installing and running a Khala CLI from the room link it was given. No human runs a pairing command, edits a config file, chooses a homeserver, or configures a harness on the agent's behalf. The install and connect instruction is one copyable command the human hands over, per P06.
- **R02. Native route first, per harness.** Each supported harness declares exactly one route, chosen from that harness's own mechanisms, with CLI preferred over MCP. A route is claimed only with evidence recorded from the installed CLI on a named version. Documentation is not evidence.
- **R03. Evidence before support.** No route reaches `support: "tested"` without a recorded proof run under `docs/evidence/`, matching the existing KHA-103/KHA-104 shape and the `evidenceRef` requirement the KHA-106 capability decoder already enforces.
- **R04. Generic fallback.** A harness with no proven native route is still usable: the agent installs a Khala skill that starts a listener for released messages and exposes a send command. The fallback is honest about its cost, including any permission approval the harness requires to start a long-running process.
- **R05. The airlock is unchanged.** Every route delivers only human-released bytes (P04). A listener, a native queue entry and an MCP tool are all delivery mechanisms and none of them may read pending content. Payload bytes must match `job.payloadDigest` before anything is sent, and must never appear in process arguments, receipts, endpoints, errors or logs.
- **R06. One send per release.** Every route must be able to say what it observed: that nothing was written, that a write returned, that the harness accepted it, or that the outcome is unknown. An unknown outcome never licenses a resend. Deduplication after consumption stays with the connector (KHA-121).
- **R07. Human send and receive in the room.** A human opens the room and can send a message, see messages from humans and agents attributed correctly, review and release pending items, and see each agent's connection state and route.
- **R08. Agent onboarding is visible to the human.** The room page shows, per agent participant, the install command, whether that agent has connected, and which route it is on, including when the route is the fallback skill.
- **R09. Existing contracts are reused.** New adapters implement `HarnessPort` from `@khala/contracts/delivery/index` and pass the neutral conformance suite in `tests/conformance/suites.ts`. No parallel port, receipt vocabulary or capability record is invented.
- **R10. Scope is the local CLI.** Cloud sessions and official desktop apps for Claude and Codex are out of scope for these tickets and are recorded as a follow-up, per P15.

### Actors and flow

A1 the owning human, in the browser. A2 the trusted owner connector, running on the agent's host. A3 the agent's existing working session and its harness. A4 the ciphertext transport. A5 the Khala agent CLI, a new process the agent installs and runs, which is A2's local entry point.

F1. The human creates a room and copies a link (KHA-122). F2. The human hands the link to their agent in ordinary conversation. F3. The agent runs the Khala CLI's connect command with that link; the CLI completes the KHA-114 bootstrap, persists keys and inbox in the KHA-115 ledger, and starts the KHA-116 subscription. F4. The CLI reports which route it can use for this harness and records the capability. F5. A peer's message arrives encrypted, is decrypted into the connector's pending store and shown to the owning human for review (KHA-125). F6. The human releases it (KHA-119). F7. The connector dispatches it (KHA-121) through the harness adapter's route, which puts the released bytes in front of the model in the session that is already working. F8. The agent replies by calling the Khala CLI's send command, or the equivalent MCP tool, and the reply appears in the room for every participant.

### Acceptance Examples

- **AE1.** An agent is given a room link in chat, runs one command, and is connected: the room page shows that agent as connected with a named route, and the agent never asked its human to configure anything. Covers R01, R08.
- **AE2.** A human releases one pending message. The agent's session, which was already mid-task, receives exactly the released bytes and nothing else, and the room shows a consumption receipt. The agent's session id, working directory and context are unchanged. Covers R05, R06.
- **AE3.** A harness with no proven route reports `support: "unsupported"` for the native route and offers the fallback skill instead. The capability record says which, and the room page says which. Covers R02, R04, R08.
- **AE4.** A release is written and the connection then drops before any acknowledgement. The receipt is `outcome_unknown`, not `failed`, and the connector does not resend on its own. Covers R06.
- **AE5.** A human opens a room on a phone-width screen, sends a message, and sees an agent's reply arrive without reloading. Covers R07.
- **AE6.** A proof run records, for one exact CLI version, what the route did when the session was idle, when it was busy, and when the listener was interrupted; the capability record is narrowed to exactly what was observed. Covers R03.

### Key Decisions

**KD1. Agent-installed CLI, not third-party attachment** (session-settled: user-directed, 2026-09-18 — chosen over reaching into a running session from outside). The agent is a first-class actor that can install software. This dissolves KHA-103's blocking finding rather than working around it: the permission approval that made the `Monitor` route unacceptable was the cost of a stranger's process, not of the agent's own.

**KD2. Native mechanism per harness, CLI before MCP** (session-settled: user-directed). MCP is a pull surface bound at session start; it is a good way for an agent to *send*, and a poor way for Khala to *deliver*. A harness command line that queues into an existing session is the preferred delivery route where one exists.

**KD3. Skill plus CLI as the generic fallback** (session-settled: user-directed — chosen over declaring unsupported harnesses out of scope). Support for any model (P01) needs a path that does not depend on a vendor shipping a queue command.

**KD4. Evidence gates the support claim, not the ticket** (carried from KHA-106). A route may be implemented behind a capability record that reports `unsupported` until its proof lands. This is how `packages/harnesses/src/codex/` is already built, and it is why proof tickets precede adapter tickets here.

**KD5. Existing-session support is a closed enum that must grow** (repo-grounded). `EXISTING_SESSION_SUPPORT` in `packages/contracts/src/delivery/harness.ts` currently admits only `unknown`, `unsupported`, `khala_hosted_resume`. A native CLI queue route into a session Khala did not start is none of those. The contract must gain the new variants before either adapter can describe itself honestly. This is a contract amendment, not an adapter workaround.

**KD6. The human UI gap is narrow** (repo-grounded). `apps/web/src/features/timeline/` and `review/` already carry composer, timeline, attribution, selection and approval behaviour against ports. KHA-132 owns the entry point, router and live ports; KHA-134 owns the review wiring. The genuinely unowned gap is a room page that composes them together with agent presence and onboarding. Do not re-scope KHA-132 or KHA-134 into this work.

**KD7. Cloud and official apps are a follow-up** (session-settled: user-directed). Recorded, not planned.

### Scope Boundaries

In scope: two harness route proofs, one contract amendment, a Khala agent CLI package, native routes in the Claude and Codex adapters, a fallback skill package, one web room page with agent presence, and the composition that binds them.

Out of scope, and each already owned elsewhere: the messaging substrate choice (G-SUBSTRATE), the browser entry point, bundle, router and live `RoomPort` (KHA-132), the review approval route and `ReviewUiPort` implementation (KHA-134), trust and automatic delivery (KHA-135, G-AUTOMATION), recovery and closure UI (KHA-127, KHA-136), cloud sessions and desktop apps (KD7), and any change to the airlock boundary.

Also out of scope: changing `packages/`, `apps/` or `infra/` source as part of *this planning artifact*. These tickets authorise those edits when they are dispatched; the planning pass does not make them.

### Outstanding Questions

- **G-HARNESSES** stays open until KHA-145 and KHA-146 report. The route table in this artifact is a set of candidates with evidence about the CLI surface, not a set of proven routes.
- **G-SUBSTRATE** stays open. Without it there is no live transport, so KHA-152's room page is fixture-driven at merge and KHA-153 cannot prove the loop end to end.
- Whether the Claude route ends up being the child-process messaging socket or a Khala-hosted streaming session is a KHA-145 outcome, not a decision made here. Both are planned as candidates and the adapter is built so either can be pinned.
- Whether `codex queue` works against a thread a TUI already holds the writer lock on is exactly what KHA-146 must answer; the shipped app-server route from KHA-104 is the fallback inside the Codex adapter if it does not.
- Attachments and file content remain unasked (P07 residual).

### Sources

- `docs/product/decisions.md` (P01, P04, P06, P10, P11, P12-P15), `docs/product/ticket-breakdown.md`, `docs/product/repo-layout.md`, `docs/product/build-order.json`.
- `docs/evidence/claude.md`, `docs/evidence/codex.md`.
- `docs/plans/2026-09-16-kha-103-claude-existing-session-proof.md`, `-kha-104-codex-existing-session-proof.md`, `-kha-106-delivery-harness-contracts.md`, `-kha-117-claude-harness-adapter.md`, `-kha-118-codex-harness-adapter.md`, `-kha-133-connector-runtime-composition.md`.
- `packages/contracts/src/delivery/`, `packages/harnesses/src/claude/README.md`, `packages/harnesses/src/codex/README.md`, `tests/conformance/suites.ts`, `scripts/check-boundaries.mjs`.
- GitHub `aiur-team/khala` issues #26 (KHA-117, parked on G-HARNESSES, with the owner's 2026-09-18 direction) and #42 (KHA-133 executor notes).
- Local CLI observations recorded 2026-09-18 in `docs/product/native-agent-surface.md`.
