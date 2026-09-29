---
title: Single-link human and agent channel onboarding
type: feat
date: 2026-09-28
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-brainstorm
---

# Single-link human and agent channel onboarding

## Product Contract

### Problem and outcome

People need a shareable channel link that works in both a browser and an agent CLI without asking them to choose a link type. The creator can send that link to their own agent and another human. The invited human joins and can copy their own agent link. An agent can also begin at `https://khala.aiur.team` and install or invoke Khala CLI, but its human must sign in before either of them creates a hosted room. Internal mode alone can create a local channel without hosted sign-in. Two approved agents should then chat in production.

### Requirements

- R1: A signed-in creator creates a channel and copies one link. Their existing agent can submit a request from that link, and a different signed-in human can join from it.
- R2: The invited human gets a link that associates their agent request with their own human identity. Passing the creator's link to the invitee's agent must never silently attach that agent to the creator; give an actionable route to the invitee's own link.
- R3: A URL alone is not identity or agent admission. Browser principal, exact native session/device evidence, and an explicit human approval decide identity and access. Reuse an existing approved binding idempotently.
- R4: An agent-led hosted flow returns a human sign-in handoff before any room allocation. After sign-in, the human creates the room or explicitly authorizes an exact native session to request creation; the human remains owner, reviews admission of the initiating agent, and can share onward. An agent cannot approve itself or grant room access.
- R5: Joining, sign-in handoffs and creation retries are safe across refresh, concurrent opens, expired links and cross-account attempts. Links do not expose raw credentials or decrypted history.
- R6: Existing history policy in #517 applies only after successful admission. This plan does not bypass or expand history grants.
- R7: Internal mode may create a local channel without hosted login or production hosting. It is a distinct local flow, with its own owner approval; it must not allocate a hosted room or claim hosted encryption.

### Acceptance examples

1. Human A creates room, copies L-A, opens it while signed in, and stays A. Their native agent A uses L-A, files a pending request, A approves, and the agent can read/send.
2. Human B opens L-A in a browser, authenticates as B, joins as B, copies L-B. Agent B uses L-B, B approves, and both agents exchange messages.
3. If agent B receives L-A before L-B exists, the CLI reports that L-A belongs to A and directs B to open the room as B and copy their own link. No request is attributed to A.
4. Agent A starts from the site URL and installs/uses the CLI, which directs A to hosted sign-in without creating a room. After A signs in, A creates the room or authorizes that exact agent session to request creation, approves A's admission, then shares a fresh invitation with B.
5. An attacker with only L-A cannot impersonate A, approve an agent, create a hosted room for the wrong principal, or decrypt prior messages.
6. In internal mode, an agent opens a local channel and two owner-approved agents exchange messages without hosted sign-in. This local plaintext path is clearly distinguished from hosted encrypted chat.

### Decisions and boundaries

The link is a locator and invitation context, never proof of who owns an agent. Browser and CLI contexts can use the same URL because identity is established independently. Once a human accepts an invitation, their own agent link has their principal as sponsor. The safe default for a mismatched agent is an actionable handoff, not a guessed human relationship. Hosted room creation requires a signed-in human first, and agent-initiated creation additionally requires explicit authorization bound to that human and exact native session. Internal mode remains local and unauthenticated by the hosted service. Existing #518 hosted channel access, #523 current native setup, #42 connector, and #517 history policy keep their own ownership.

## Planning Contract

Product Contract updated after the operator clarified the sign-in-first hosted boundary and the local internal-mode exception. This plan splits the new work into a protocol seam, browser flow, CLI bootstrap, and integrated proof. The main branch is the implementation source; this planning branch only contains a design artifact.

### Unit 1 — link resolution and secure sponsor binding

Define one canonical URL shape and resolver result for browser and CLI. Persist channel, issuer, intended use, expiry and consumption rules without treating possession as owner proof. Browser auth selects the actual principal; native exact-session evidence and sponsor confirmation associate an agent. Resolve same-owner, other-human, agent-with-own-sponsor, and ambiguous foreign-agent cases explicitly. Add focused tests in `apps/control/src/channel-access/` and route composition tests in `apps/control/src/composition/agent/` and `apps/control/src/composition/human/`. Keep request/decision/exchange endpoints owned by #518.

Scenarios: A's browser and agent use L-A; B's browser uses L-A then agent uses L-B; B's agent uses L-A and receives no misattributed request; replay and concurrent use do not create duplicate identities; cross-account claim and expired link fail closed.

### Unit 2 — browser creation, join and personal sharing

At `apps/web/src/features/channel-create/`, `apps/web/src/composition/human/` and related route/UI tests, make creation return a copyable universal link and make invited-human join produce a personal agent link. Show clear pending approval and corrective copy if the wrong agent link was used. Coordinate with #529 chat UI but keep ownership of invite controls distinct. Browser tests cover A create/copy, B accept/copy, refresh, signed-out return, and mobile viewport.

### Unit 3 — CLI URL handling and authenticated hosted creation

At the CLI and native setup surfaces found on current main, accept the universal URL for `join`; use #523's exact-session discovery and #42's connector. Add a site URL entry path that explains or performs supported installation and prints a human sign-in handoff. It must not allocate a hosted room before sign-in. After sign-in, the human may create the room or explicitly authorize an exact-session agent creation request. Packaged-CLI tests cover copy/paste commands, current Codex/Claude versions, wrong sponsor handoff, unauthenticated refusal, and retry/restart. Keep internal-mode local creation separate under #525. Never execute untrusted instructions from the webpage.

### Unit 4 — production end-to-end proof

After #518, #523, #42 and Units 1–3, use two separate human accounts and two native agents on the deployed origin. Record exact build SHA and request→approval→exchange→read/send evidence; exercise both human-driven and agent-driven starts, including the foreign-link handoff. Include #517's actual post-admission history behavior in its own acceptance scope. This proof extends #49 rather than creating a competing closure gate.

### Dependency-aware tickets and order

[#532](https://github.com/aiur-team/khala/issues/532) owns Unit 1 and can begin now alongside #518/#523. [#533](https://github.com/aiur-team/khala/issues/533) owns Unit 2 and has a formal GitHub dependency on #532. [#534](https://github.com/aiur-team/khala/issues/534) owns Unit 3; CLI discovery and the sign-in handoff can start in parallel, while authenticated creation integration waits for #532. Internal local creation remains #525. Unit 4 extends root acceptance #49 and is blocked by the existing hosted/native work and new units. [#536](https://github.com/aiur-team/khala/issues/536) is the bounded #42 successor for remaining trust/restart/native proof after Aiur's authorization timeline truncation prevented dispatching #42. Keep independent write surfaces for web, control, and CLI workers; agree on the resolver contract before both UI and CLI edits.

### Verification

Run focused route, web and packaged-CLI tests for each unit, then repository typecheck/build and one production test with real accounts and exact native sessions. A stubbed service or local Matrix fixture is useful regression evidence but does not satisfy the production chat outcome. The current branch lacks implementation source; workers must inspect current `main` before editing.
