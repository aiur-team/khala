# Khala ticket proposal — revision 3

2026-09-16. **Awaiting user sign-off.** These are proposed local tickets, not published issues or implementation-ready plans. This revision carries forward the OSS-first breakdown and adds the user’s explicit no-setup onboarding requirement: OAuth, create chat, share link.

## Product contract carried into this proposal

Khala is an Aiur-branded shared conversation for humans and their existing working agents, across owners and model vendors. The creator or their agent can prepare messages before inviting another human. The recipient previews them and controls what enters their own agent's context. The trusted owner connector may decrypt pending content. Humans can enable automatic peer delivery and re-arm review. Agents set up harness-appropriate pub/sub to be notified promptly in their existing sessions. The transport is E2EE.

Our code is TypeScript. Prefer existing OSS and Netlify for the web app and small functions. A Railway-hosted OSS backend is acceptable if its development savings justify the operation. **Recommended evaluation target: Matrix/Synapse on Railway, Khala web app on Netlify, owner-side TypeScript connectors.** Matrix is not yet selected. [The comparison](../../research/11-hosting-tradeoffs.md) records the tradeoff.

The proposal preserves a product usable beyond one named model. Initial real harness proofs should cover Claude Code and Codex as representative integrations; the common adapter contract and documented capability reporting allow others to join. This is not a promise that every current harness exposes a compatible notification API.

## Ordinary user journey

1. Sign in with OAuth, following Archon’s identity-only email sign-in experience.
2. Create a chat, optionally give it a name, and optionally prepare introductory content.
3. Copy the chat link to the existing working agent and coworker.
4. The agent performs its own supported connection/subscription setup; the coworker joins through the web experience and shares the link with their agent.

Connector, adapter, pairing and key-storage terminology below describes implementation, not additional user setup. No manual install/configuration, shell command, separate Matrix registration or normal-path cryptographic ceremony is part of this flow. Review/release controls remain intentional human interactions.

## Proposed tickets

### KHA-01 — Verify reusable encrypted messaging and deployment fit

**Outcome:** choose supported components using a reproducible four-participant encrypted messaging experiment.

**Scope:** Synapse container/Postgres deployment configuration; browser SDK/client candidate; TypeScript headless connector crypto persistence, key verification and restart. Compare the Netlify-native alternative only against concrete gaps found. Railway provisioning is a later execution action, not part of approving this document.

**Acceptance:** two independent human identities and two agent identities exchange encrypted messages; restart preserves keys and history access; forbidden device/key access fails; a source-pinned dependency/license inventory and deploy/restore procedure exist. Record exactly which Matrix work is reused, which Khala components remain, and any failing required scenario. No new crypto protocol or fallback selection hidden inside the ticket.

**Depends on:** product approval of evaluation scope. **Unblocks:** 03, 04, 05, 06.

### KHA-02 — Verify attachment and immediate notification in existing sessions

**Outcome:** the agent receiving a link performs its own setup, subscribes and gets a new chat notification in the session already working in its repository, without human technical setup.

**Scope:** versioned, model-independent adapter capability contract; real Claude Code and Codex proof; documented custom-adapter route. Determine setup/restart requirements, idle and busy behaviour, and available acknowledgement strength for each harness.

**Acceptance:** preserve the existing session identity and workspace; the agent installs/starts its supported subscription without creating a replacement session; event receipt triggers native notification rather than periodic model polling; duplicate/replayed events do not create duplicate durable inbox entries or approved-job scheduling; ambiguous harness acceptance remains `outcome_unknown` until correlated or explicitly retried; unsupported capability is explicit. Measure notification latency under stated conditions and distinguish notification receipt from model consumption. If a harness cannot attach dynamically, return that concrete product gap for resolution.

**Depends on:** product approval of evaluation scope; can run independently of 01 with synthetic approved events. **Unblocks:** 03, 08.

### KHA-03 — Establish TypeScript packages, shared contracts and fixtures

**Outcome:** workers can implement separate features against one agreed interface.

**Scope:** package/module ownership, supported runtime versions, build/lint/test commands, actor/owner/instance identity, immutable message references, approval policies, connector receipts, adapter capabilities and upgrade rules. Use native substrate identities and SDK tokens instead of inventing parallel room ordering.

**Acceptance:** shared fixtures prove compatible web/connector parsing; schemas reject version/identity mismatches; duplicate command and uncertain outcome meanings are explicit; each later ticket references the same contracts. No production secret or endpoint key in public config.

**Depends on:** 01 and 02 decisions. **Unblocks:** all integration tickets.

### KHA-04 — Package and operate the selected backend

**Outcome:** the backend has a reproducible, observable deployment with durable state.

**Scope:** if Matrix is selected, configure unmodified Synapse/Postgres, persistent media/configuration, HTTPS, registration access and backups. Keep Netlify web/control deployment separate. Reuse supported infrastructure; avoid a new Hono daemon unless a proven Khala-only need exists.

**Acceptance:** restart and restore retain expected encrypted room data and server identity; health checks and sanitized diagnostics identify failures; upgrade/rollback procedure is tested; actual baseline resource usage is recorded. Federation exposure matches the approved product scope. Do not duplicate Matrix history into Blobs.

**Depends on:** 01, 03 and substrate selection. A Netlify-native selection requires rewriting this ticket's implementation scope before planning.

### KHA-05 — Integrate Archon-like OAuth sign-in and automatic client identity

**Outcome:** a human signs in with OAuth for identity/email and reaches Khala without separate messaging-account or connector setup.

**Scope:** reuse Archon’s identity-only OAuth/OIDC approach and supported messaging SDKs; map authenticated identity internally to messaging identity; initialise device keys automatically; support persistent sessions/logout and recovery entry points. Keep identity mapping and device machinery internal to the ordinary sign-in flow.

**Acceptance:** a new user can sign in and create a chat without a separate Matrix login/password, homeserver choice, manual keys or connector installation; returning users retain expected access; account ownership uses the verified provider identity rather than an untrusted email string. New/revoked device and expired-login/recovery cases are handled explicitly. Any upstream flow that forces extra ordinary onboarding is a feasibility gap to resolve, not an unapproved new user step.

**Depends on:** 03, 04; OAuth providers and exceptional recovery policy need refinement; the ordinary OAuth/create/share flow is settled.

### KHA-06 — Apply Aiur branding and the reusable client shell

**Outcome:** Khala looks and behaves like an Aiur product on desktop and mobile web.

**Scope:** evaluate a thin existing-client adaptation versus supported SDK-based UI; import the inspected Aiur/Archon symbol, typography, palette and application tokens with provenance. Build navigation, theme, accessible states and a reusable conversation/review layout.

**Acceptance:** the ordinary encrypted conversation and device flows remain functional; custom review controls fit without a deep unmaintainable fork; keyboard navigation, readable contrast, responsive layout and persisted theme are checked. The chosen UI reuse boundary is documented; do not plan against the archived standalone matrix-react-sdk.

**Depends on:** 01, 03. Can proceed alongside backend/identity integration using fixtures.

### KHA-07 — Create a room, queue introductory content and invite a human

**Outcome:** the creator shares one clear invitation and the recipient can read the intended introductory batch.

**Scope:** human room creation, manual or delegated agent-authored introductory messages, room membership, link lifecycle, intended-recipient admission and initial history disclosure. Agent message preparation must retain creator/agent attribution and the owner's authority; agent permission to create rooms is a separate product choice.

**Acceptance:** creator queues multiple messages before admission; recipient accepts and reads the intended set; expired/revoked/misused links do not disclose content; admission does not silently pair an agent or release content to it. Retry does not admit duplicate identities. Avoid requiring creator approval twice unless the approved identity model needs it.

**Depends on:** 03–06; chosen initial history and onboarding behaviour.

### KHA-08 — Let an existing agent join and subscribe from the chat link

**Outcome:** the human pastes the chat link into their existing agent; that agent establishes its own scoped connection and notification subscription without human setup.

**Scope:** TypeScript connector packaging, pairing bootstrap, owner-to-agent identity binding, local key/pending state, subscription lifetime, adapter setup and status. Keep endpoint secrets on approved owner devices.

**Acceptance:** no user-run install, pairing command or configuration is required; the link lets the agent discover machine-readable connection instructions; internal authorisation binds the intended human and existing session without passing human OAuth credentials to the model; subscription reaches the existing session; reconnection preserves identity and state; replacement is explicit; a disconnected/sleeping host is visible; model-facing tools cannot read pending data or invoke human approval. Native crypto bindings are allowed as OSS dependencies with supported packaging and version checks.

**Depends on:** 02–05 and 07; can implement against 07's agreed invitation fixture before its UI finishes.

### KHA-09 — Project live chat and send attributed messages

**Outcome:** both humans can follow the same conversation and add messages as themselves while agents post under their own identities.

**Scope:** SDK sync, timeline pagination, own-send reconciliation, reconnect/offline state, inert Markdown/code display and attribution. Reuse the substrate's event store and transport.

**Acceptance:** human/agent owner identity is clear; accepted messages survive reconnect; repeated sync does not duplicate entries; forged display text does not become a control event; untrusted rendering cannot execute code or auto-fetch external content. Notifications remain timely and catch-up repairs missed live updates.

**Depends on:** 03, 05, 06, 07 and SDK/deployment work from 04. Agent posting integrates with 08.

### KHA-10 — Enforce recipient review and exact message release

**Outcome:** human approval determines exactly which peer content enters their agent's context.

**Scope:** recipient-specific pending queue, preview, selected-item release, human-authorised control channel, immutable version binding, restart-safe approvals and model projection.

**Acceptance:** a connector can hold pending plaintext but no unreleased item appears in any model read/history/search/notification path; newly arriving messages are not accidentally included in a reviewed selection; stale/forged approvals fail; duplicate release is idempotent. A sender's edit does not substitute unseen bytes for approved content. Humans retain the full readable room independently of their agent's released view.

**Depends on:** 08, 09 and 03 approval contract. Redaction and sender-visible rejection semantics remain product choices, not assumed scope.

### KHA-11 — Enable trusted delivery, bound automation and pause safely

**Outcome:** trusted peers can collaborate without repeated approvals while each owner retains control.

**Scope:** peer-scoped automatic delivery, visible policy, re-arm review, pause/resume, bounded replies and scheduling deduplication. Use the harness's own permissions for repo/tool actions.

**Acceptance:** policy races have one defined outcome; incoming text cannot change trust or budgets; re-arming blocks future unapproved context; already-disclosed/running work is visible; loops stop at configured bounds; retry/reconnect does not duplicate durable release scheduling; if an external submission may already have been accepted, reconcile using harness correlation or surface `outcome_unknown` without silent resubmission. Distinguish requested cancellation from confirmed cancellation and avoid claiming rollback of external effects.

**Depends on:** 08, 10. Busy-session behaviour, unattended mode and backlog policy need product choices.

### KHA-12 — Revoke, recover and retain data under the chosen policy

**Outcome:** device loss, connector replacement and conversation closure have predictable consequences.

**Scope:** SDK recovery integration, membership/instance revocation, local connector state cleanup, agreed transcript/attachment retention and user-facing history limits. Reuse upstream recovery; do not invent server-side plaintext escrow.

**Acceptance:** revoked endpoints cannot receive newly protected content under the substrate's documented semantics; restored clients deduplicate local released jobs and retain unresolved external outcomes rather than silently resubmitting; expired history/key state is explicit; deletion descriptions distinguish server, backup and participant-held copies. An agent replacement does not inherit automatic trust accidentally.

**Depends on:** 05, 08, 10, 11 and chosen retention/history behaviour.

### KHA-13 — Prove the complete product and publish operational documentation

**Outcome:** a reproducible end-to-end demonstration meets the agreed collaboration scenario and can be supported.

**Scope:** two humans and their existing sessions on separate machines; invitation/batch preview, manual release, direct agent exchange, trust/review controls, restart and failure recovery; installation and adapter-author guidance; backend/client/connector troubleshooting.

**Acceptance:** the agreed task is completed without human copy/paste mediation; extend the scenario to a third human and their agent to prove there is no hardcoded two-owner limit, with independent per-recipient review; encrypted server storage contains no message keys/plaintext; all human-only controls have negative authorization tests; branded UI works with keyboard and mobile viewport; latency, failure and recovery evidence names exact versions and environment. Demonstrate a third adapter contract implementation or a reproducible conformance harness to substantiate model independence without claiming untested universal harness support.

**Depends on:** 04–12 and any selected conditional scope. This ticket integrates evidence; it does not defer other tickets' tests until the end.

## Conditional scope for sign-off

| Candidate | Proposed handling | Product decision needed |
|---|---|---|
| KHA-C1: encrypted attachments and previews | Reuse SDK media; add approval-aware model fetch and inert human preview | Are files/screenshots needed for the first complete task? |
| KHA-C2: third-party self-hosted distribution | Deployment is reproducible in 04; polished supported customer installation is additional scope | Is customer-operated hosting required at launch? |
| KHA-C3: federation support | Reuse Matrix capability if selected; test cross-server policy and history explicitly | Must participants bring independent homeservers, or can all use Khala's service? |
| KHA-C4: outbound review/redaction | Add owner controls and derived-message provenance if selected | Should owners review their agent's outgoing messages, and edit inbound content before release? |

No conditional feature is silently decided here. Browser closure and local connector lifetime belong in 08/11 rather than a mandatory separate gateway service. Native mobile apps, voice/video, enterprise compliance and model hosting have not been requested and are not in this proposal.

## Dependencies and safe parallel work

01 and 02 are independent validation tracks. Their decisions feed 03. After 03, deployment (04), client shell/branding (06), and adapter implementation preparation can proceed independently against fixtures. Identity (05) enables room admission (07). Connector pairing (08) and chat projection (09) meet at review (10), then automatic delivery (11) and recovery (12). Integration evidence and documentation (13) follow the actual completed interfaces.

Plans should define ownership for shared contracts and generated fixtures. Independent workers should not each invent their own message identity or approval semantics. A ticket may contain several small ordered implementation units; those units belong in `ce-plan`, after sign-off.

## Requirements coverage

[The requirements map](../requirements-coverage.md) traces every explicit product constraint to tickets and the evidence expected from implementation. It also separates completed research from unperformed runtime verification.

## Decisions still needed

- Choose the evaluation/deployment direction after the hosting comparison; recommendation is Matrix/Synapse on Railway plus Netlify frontend.
- Define the first collaboration outcome, whether agents act while browsers are closed, and how they respond while busy.
- Refine admission authority, OAuth provider selection, history/retention, attachment and release/backlog behaviour. Basic sign-in/create/share onboarding is settled.

A scope-level sign-off can approve the ticket structure while explicitly leaving named product decisions for each ticket's brainstorm. Such a sign-off does not permit a plan to invent those decisions or mark unresolved behaviour implementation-ready.

## After sign-off

Run `ce-brainstorm` for each approved ticket's product contract, then enrich that same canonical artifact through `ce-plan`. Each final plan must have stable requirements, settled decisions, explicit non-goals, exact interfaces and module ownership, state transitions/failures, small ordered implementation units, fixtures, runnable verification and completion criteria. Run the workflows' required grounding/deepening/document review and record unresolved decisions rather than hiding them.

This document does not authorise a deployment, create issues, or launch implementation. Aiur defect reporting is separately authorised in [executor coordination](../../operations/aiur-coordination.md).
