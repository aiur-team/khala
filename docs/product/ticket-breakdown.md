# Khala ticket proposal — revision 4

2026-09-16. **44 proposed tickets, replacing 13; scope approved for detailed planning.** No issues created or implementation started. Detailed `ce-brainstorm` / `ce-plan` artifacts are written and cross-reviewed following user authorization. Old KHA-01–13 IDs are retired; new stable IDs are KHA-101–144. [Previous proposal](archive/ticket-breakdown-v3.md).

## Product contract carried into this proposal

Khala is an Aiur-branded shared conversation for humans and their existing working agents, across owners and model vendors. The creator or their agent can prepare messages before inviting another human. The recipient previews them and controls what enters their own agent's context. The trusted owner connector may decrypt pending content. Humans can enable automatic peer delivery and re-arm review. Agents set up harness-appropriate pub/sub to be notified promptly in their existing sessions. The transport is E2EE.

Our code is TypeScript. Prefer existing OSS and Netlify for the web app and small functions. A Railway-hosted OSS backend is acceptable if its development savings justify the operation. **Recommended evaluation target: Matrix/Synapse on Railway, Khala web app on Netlify, owner-side TypeScript connectors.** Matrix is not yet selected. [The comparison](../research/11-hosting-tradeoffs.md) records the tradeoff.

The proposal preserves a product usable beyond one named model. Initial real harness proofs should cover Claude Code and Codex as representative integrations; the common adapter contract and documented capability reporting allow others to join. This is not a promise that every current harness exposes a compatible notification API.

Production web origin: **https://khala.aiur.team** (user-selected). Hosting/DNS provisioning is not yet performed.

## Ordinary user journey

1. Sign in with OAuth, following Archon’s identity-only email sign-in experience.
2. Create a chat, optionally give it a name, and optionally prepare introductory content.
3. Copy the chat link to the existing working agent and coworker.
4. The agent performs its own supported connection/subscription setup; the coworker joins through the web experience and shares the link with their agent.

Connector, adapter, pairing and key-storage terminology below describes implementation, not additional user setup. No manual install/configuration, shell command, separate Matrix registration or normal-path cryptographic ceremony is part of this flow. Review/release controls remain intentional human interactions.

## Build-order design

One undispatched root owns the product outcome; lane headings are organizational, not extra worker tickets. Every member has one outcome and an exclusive primary write surface. Shared interfaces land before consumers; adapters/UI use injected ports and fixtures until named composition tickets connect them. Complexity estimates are provisional 2–3, distinct from security risk.

[Repository layout and conflict rules](repo-layout.md) define ownership, package boundaries and integration seams. [Proposal graph](ticket-graph.proposal.json) is the source for the tables below, not an Aiur runtime/discovery pack. Its dependency levels are computed; gates and capacity still govern readiness.

## Epics and metadata

One undispatched root, **KHA-ROOT**, contains eight undispatched epics. Only their 44 leaf members are potential worker tickets. Epic membership organizes outcomes; it does not add dependency barriers.

| Epic | Outcome | Members |
|---|---|---|
| KHA-E01 — Validate feasibility and ownership | Evidence resolves substrate, no-setup ownership and existing-session feasibility gates. | KHA-102, KHA-103, KHA-104, KHA-141, KHA-142, KHA-143, KHA-144 |
| KHA-E02 — Establish workspace and contracts | Independent consumers build against owned, versioned ports and fixtures. | KHA-101, KHA-105, KHA-106 |
| KHA-E03 — Operate reusable hosting | Selected services and Netlify deployment have restart, restore and upgrade evidence. | KHA-108, KHA-109, KHA-131 |
| KHA-E04 — Deliver human encrypted chat | Two humans complete OAuth/create/share/chat with attribution and queued introductions. | KHA-107, KHA-110, KHA-111, KHA-112, KHA-113, KHA-122, KHA-123, KHA-124, KHA-132 |
| KHA-E05 — Attach existing working agents | Owner runtime attaches and notifies existing sessions without human technical setup. | KHA-114, KHA-115, KHA-116, KHA-117, KHA-118, KHA-121, KHA-133 |
| KHA-E06 — Control peer delivery | Human authorization governs exact release, trusted delivery, re-arm and pause. | KHA-119, KHA-120, KHA-125, KHA-126, KHA-134, KHA-135 |
| KHA-E07 — Recover and revoke safely | Loss, replacement and closure follow approved history/retention policy. | KHA-127, KHA-128, KHA-129, KHA-130, KHA-136 |
| KHA-E08 — Prove and accept the product | Independent security and collaboration evidence passes on merged base; root owner accepts. | KHA-137, KHA-138, KHA-139, KHA-140 |

Each member has a [draft scope card](tickets/KHA-101.md); all 44 cards are linked from the graph’s `doc` fields. The graph records kind/provenance, epic/lane, computed phase, complexity and rationale, separate risk/capabilities, requirements, hard dependencies, symmetric conflict fields, advisory order, external gates, read/write/contract/safety surfaces, and acceptance gates. `ticket: null` explicitly means no tracker issue exists. Exact interface sketches and implementation-time verification commands are in the [44 canonical plans](../plans/README.md).

`serializes_with` is currently empty because primary write directories are disjoint and shared-file changes have one owner. This is a proposed ownership result, not proof that future implementations cannot conflict; any ownership amendment must update both sides of a conflict edge.

## Foundation

| Ticket | Bounded outcome | Prerequisites | Primary write surface |
|---|---|---|---|
| KHA-101 | Scaffold TypeScript workspace and CI | None | `package.json`; `pnpm-lock.yaml`; `pnpm-workspace.yaml`; `tsconfig.base.json`; `.github/workflows/`; `scripts/check-boundaries.mjs` |
| KHA-105 | Define identity, room and messaging ports | KHA-101, KHA-102, KHA-141, KHA-142, KHA-144 | `packages/contracts/src/messaging/`; `packages/contracts/fixtures/messaging/` |
| KHA-106 | Define approval and harness ports | KHA-101, KHA-103, KHA-104 | `packages/contracts/src/delivery/`; `packages/contracts/fixtures/delivery/` |

**KHA-101 acceptance:** All package shells build; feature imports are checked; root commands discover package tests without per-feature CI edits.

**KHA-105 acceptance:** Versioned identities, room admission, immutable event references, SDK mapping and recovery ports have valid/invalid fixtures; provider subject is distinct from email, device and agent session.

**KHA-106 acceptance:** Pin exact release references, owner commands, capability reports, receipt states and outcome_unknown; contract tests cover forgery and duplicate semantics without importing messaging implementations.

## Research

| Ticket | Bounded outcome | Prerequisites | Primary write surface |
|---|---|---|---|
| KHA-102 | Prove OSS backend hosting fit | None | `experiments/backend/`; `docs/evidence/backend.md` |
| KHA-103 | Prove Claude existing-session attachment | None | `experiments/claude/`; `docs/evidence/claude.md` |
| KHA-104 | Prove Codex existing-session attachment | None | `experiments/codex/`; `docs/evidence/codex.md` |
| KHA-141 | Prove browser SDK crypto and UI seams | None | `experiments/browser-crypto/`; `docs/evidence/browser-crypto.md` |
| KHA-142 | Prove TypeScript headless crypto persistence | None | `experiments/headless-crypto/`; `docs/evidence/headless-crypto.md` |
| KHA-143 | Choose client reuse boundary | KHA-141 | `docs/evidence/client-reuse.md`; `experiments/client-reuse/` |
| KHA-144 | Prove OAuth-to-agent ownership bootstrap | KHA-102, KHA-141, KHA-142 | `experiments/ownership/`; `docs/evidence/ownership.md` |

**KHA-102 acceptance:** Pinned Synapse/Postgres starts with durable volumes; record license, service requirements and Netlify comparison. No custom chat backend.

**KHA-103 acceptance:** An existing working session receives an event after agent-performed setup; record required opt-ins, busy behavior, identity and timestamps. Any human setup requirement is a product gap.

**KHA-104 acceptance:** Prove same-session enqueue and distinguish it from consumption, including busy and ambiguous acceptance cases; no replacement session.

**KHA-141 acceptance:** Supported SDK demonstrates device persistence, encrypted history and key loss on browser restart; record exact versions and candidate UI constraints.

**KHA-142 acceptance:** Pinned supported engine/bindings decrypt after process restart with persisted identity; native packaging and verification requirements are explicit.

**KHA-143 acceptance:** Compare reusable client adaptation with thin SDK UI using actual review-control seams; select maintainable boundary before prescribing a framework/component structure.

**KHA-144 acceptance:** Demonstrate automatic messaging account/device and scoped existing-agent authorization from link; copied public link alone cannot claim owner. No required human technical setup.

## Web

| Ticket | Bounded outcome | Prerequisites | Primary write surface |
|---|---|---|---|
| KHA-107 | Build Aiur-branded shell | KHA-101, KHA-143 | `apps/web/src/shell/`; `apps/web/src/brand/` |
| KHA-122 | Build create-chat and intro composer | KHA-101, KHA-105, KHA-107 | `apps/web/src/features/create-chat/` |
| KHA-123 | Build attributed live timeline | KHA-101, KHA-105, KHA-107 | `apps/web/src/features/timeline/` |
| KHA-124 | Build OAuth entry and invitation journey | KHA-101, KHA-105, KHA-107 | `apps/web/src/features/join/` |
| KHA-125 | Build recipient review UI | KHA-101, KHA-105, KHA-106, KHA-107 | `apps/web/src/features/review/` |
| KHA-126 | Build trust and agent-status controls | KHA-101, KHA-105, KHA-106, KHA-107 | `apps/web/src/features/agent-controls/` |
| KHA-127 | Build recovery and closure UI | KHA-101, KHA-105, KHA-107 | `apps/web/src/features/recovery/` |

**KHA-107 acceptance:** Reuse sourced Aiur/Archon assets and tokens; responsive accessible shell exposes slots and theme. No feature routing or policy logic.

**KHA-122 acceptance:** Fixture-driven named/unnamed creation, multi-message intro preparation and share link states are accessible; no connector terminology/setup steps.

**KHA-123 acceptance:** Typed projection shows human/agent ownership, pagination, send reconciliation and offline state; unsafe markup cannot execute or auto-fetch external content.

**KHA-124 acceptance:** Fixture-driven sign-in/admission/error paths deliver OAuth/create/share flow and correct identity; no homeserver/password/config screens.

**KHA-125 acceptance:** Human sees full content and selects exact pending items for release; arrivals do not alter selection; revoked/stale command feedback is explicit.

**KHA-126 acceptance:** Shows subscription, queued versus consumed, pending/effective trust, pause and unknown outcomes accurately; incoming text cannot operate controls.

**KHA-127 acceptance:** Missing keys, replacement, revocation and retention consequences are presented from typed fixtures without promising deletion of participant-held copies.

## Platform

| Ticket | Bounded outcome | Prerequisites | Primary write surface |
|---|---|---|---|
| KHA-108 | Package messaging service deployment | KHA-101, KHA-102 | `infra/messaging/` |
| KHA-109 | Prove backend restore and upgrades | KHA-108 | `infra/operations/`; `docs/operations/backend.md` |
| KHA-131 | Package Netlify web and functions | KHA-101, KHA-105 | `netlify.toml`; `infra/netlify/`; `apps/control/src/runtime/` |

**KHA-108 acceptance:** Reproducible service/config/volume/HTTPS and registration boundary; restart preserves server identity and encrypted data. Selected-substrate gate applies.

**KHA-109 acceptance:** Restore a disposable backup and exercise upgrade/rollback against declared versions; sanitized health evidence and resource baseline are recorded.

**KHA-131 acceptance:** Static app and small authenticated control handlers deploy through Netlify adapter; environment validation keeps secrets private; no persistent Hono service or duplicate chat event log.

## Identity

| Ticket | Bounded outcome | Prerequisites | Primary write surface |
|---|---|---|---|
| KHA-110 | Implement OAuth identity mapping | KHA-101, KHA-105 | `apps/control/src/auth/` |
| KHA-111 | Implement browser encrypted device lifecycle | KHA-101, KHA-105 | `packages/messaging/src/browser-device/` |
| KHA-113 | Implement invitation admission | KHA-101, KHA-105 | `apps/control/src/invitations/` |
| KHA-128 | Implement device and agent revocation | KHA-101, KHA-105 | `packages/messaging/src/revocation/` |
| KHA-129 | Implement encrypted recovery | KHA-101, KHA-105 | `packages/messaging/src/recovery/` |

**KHA-110 acceptance:** Verified provider subject maps internally to messaging identity; session expiry/logout and unauthorized requests fail correctly; no separate messaging account setup.

**KHA-111 acceptance:** SDK keys initialize automatically, persist across restart and handle missing/revoked device state; no ordinary-path key ceremony or server plaintext escrow.

**KHA-113 acceptance:** Recipient admission and history disclosure follow approved policy; revoked/expired/wrong-owner link fails without content disclosure; retries do not duplicate membership.

**KHA-128 acceptance:** SDK-backed revocation enforces documented future-access semantics; replacement binding does not inherit agent trust implicitly.

**KHA-129 acceptance:** Approved SDK recovery restores expected decryptability and makes unrecoverable history explicit; backend never receives plaintext recovery keys.

## Messaging

| Ticket | Bounded outcome | Prerequisites | Primary write surface |
|---|---|---|---|
| KHA-112 | Implement room and intro commands | KHA-101, KHA-105 | `packages/messaging/src/rooms/` |

**KHA-112 acceptance:** Room creation and named/unnamed chat work; human and delegated-agent multi-message intro batches retain attribution and retry identity. Agent room creation is not assumed.

## Connector

| Ticket | Bounded outcome | Prerequisites | Primary write surface |
|---|---|---|---|
| KHA-114 | Implement agent-operated link bootstrap | KHA-101, KHA-105, KHA-106 | `packages/connector/src/bootstrap/`; `apps/control/src/agent-bootstrap/` |
| KHA-115 | Persist connector keys and inbox | KHA-101, KHA-105, KHA-106 | `packages/connector/src/storage/` |
| KHA-116 | Implement live encrypted subscription | KHA-101, KHA-105, KHA-106 | `packages/connector/src/subscription/` |
| KHA-121 | Implement bounded model dispatch | KHA-101, KHA-105, KHA-106 | `packages/connector/src/dispatch/` |
| KHA-130 | Implement retention and local cleanup | KHA-101, KHA-105, KHA-106 | `packages/connector/src/retention/` |

**KHA-114 acceptance:** Machine-readable link instructions yield scoped owner/session authorization without exposing human OAuth credentials to the model; agent performs supported setup, not the human.

**KHA-115 acceptance:** Supported crypto storage and local inbox survive crash/restart; explicit reconciliation spans separate stores; no assumption of an atomic crypto-plus-inbox transaction.

**KHA-116 acceptance:** Subscribe/catch-up repairs missed events; replay deduplicates inbox input; disconnect and sleep are visible; notification hints contain no pending plaintext.

**KHA-121 acceptance:** Only authorized released jobs reach harness port; durable dedup, budgets, pause and ambiguous receipt recovery are proven using injected ports; cancellation never claims rollback.

**KHA-130 acceptance:** Approved expiry/closure cleans eligible local state while preserving required dedup and unresolved outcomes; no promise of universal remote erasure.

## Adapters

| Ticket | Bounded outcome | Prerequisites | Primary write surface |
|---|---|---|---|
| KHA-117 | Implement Claude harness adapter | KHA-101, KHA-106 | `packages/harnesses/src/claude/` |
| KHA-118 | Implement Codex harness adapter | KHA-101, KHA-106 | `packages/harnesses/src/codex/` |

**KHA-117 acceptance:** Implements approved capability contract against tested native mechanism; preserves session/workspace and exposes opt-in/unavailable/queued distinctions.

**KHA-118 acceptance:** Implements approved enqueue/correlation contract; uncertain submission is not silently resent and no new session is substituted.

## Policy

| Ticket | Bounded outcome | Prerequisites | Primary write surface |
|---|---|---|---|
| KHA-119 | Implement exact approval release | KHA-101, KHA-105, KHA-106 | `packages/policy/src/release/` |
| KHA-120 | Implement trust and re-arm transitions | KHA-101, KHA-105, KHA-106 | `packages/policy/src/trust/` |

**KHA-119 acceptance:** Pure policy binds approval to exact recipient and immutable bytes/version; stale, forged and duplicate commands have defined outcomes; new arrivals are excluded from prior selection.

**KHA-120 acceptance:** Pure transitions cover peer-scoped auto delivery, backlog choice and acknowledged re-arm; offline requests remain pending, not falsely effective.

## Integration

| Ticket | Bounded outcome | Prerequisites | Primary write surface |
|---|---|---|---|
| KHA-132 | Wire real human create/share/chat flow | KHA-108, KHA-110, KHA-111, KHA-112, KHA-113, KHA-122, KHA-123, KHA-124, KHA-131 | `apps/web/src/composition/human/`; `apps/control/src/composition/human/`; `tests/integration/human/` |
| KHA-133 | Wire existing-session agent connection | KHA-114, KHA-115, KHA-116, KHA-117, KHA-118, KHA-121 | `apps/connector/src/runtime/`; `apps/control/src/composition/agent/`; `tests/integration/connector/` |
| KHA-134 | Wire human approval to model delivery | KHA-119, KHA-125, KHA-132, KHA-133 | `apps/web/src/composition/review/`; `apps/connector/src/composition/review/`; `tests/integration/review/` |
| KHA-135 | Wire trust, pause and status acknowledgments | KHA-120, KHA-126, KHA-134 | `apps/web/src/composition/controls/`; `apps/connector/src/composition/controls/`; `tests/integration/controls/` |
| KHA-136 | Wire recovery, revocation and cleanup | KHA-127, KHA-128, KHA-129, KHA-130, KHA-132, KHA-133 | `apps/web/src/composition/recovery/`; `apps/connector/src/composition/recovery/`; `tests/integration/recovery/` |

**KHA-132 acceptance:** Two OAuth humans create/join and exchange encrypted attributed messages through real ports, including queued intro history; fixtures are unreachable in production wiring.

**KHA-133 acceptance:** Agent bootstrap, persistent crypto/inbox, subscription and harness dispatch work in one owner runtime; model APIs expose only approved projection; supported agent setup is reproducible.

**KHA-134 acceptance:** Exact human-authorized command reaches connector release/dispatch and a real existing session; human approval cannot be invoked by model tools; restart/replay cannot leak unreleased content.

**KHA-135 acceptance:** Auto-delivery and review re-arm propagate with actual connector acknowledgments; busy/offline/backlog behavior and loop bounds match approved policy.

**KHA-136 acceptance:** Device loss/replacement, membership removal and closure exercise real storage/SDKs; unknown external outcomes survive recovery without silent retry.

## Verification

| Ticket | Bounded outcome | Prerequisites | Primary write surface |
|---|---|---|---|
| KHA-137 | Build reusable multi-owner acceptance harness | KHA-101, KHA-105, KHA-106 | `tests/e2e/harness/`; `tests/conformance/` |
| KHA-138 | Prove encryption and approval boundaries | KHA-134, KHA-135, KHA-136, KHA-137 | `tests/e2e/security/`; `docs/evidence/security-acceptance.md` |
| KHA-139 | Prove collaborative task across owners | KHA-109, KHA-134, KHA-135, KHA-136, KHA-137 | `tests/e2e/collaboration/`; `docs/evidence/collaboration-acceptance.md` |

**KHA-137 acceptance:** Isolated owners, clients, adapter double and fault injection are usable through fixed ports; third adapter conformance can be run without a vendor-specific model assumption.

**KHA-138 acceptance:** Inspect encrypted server state/logs and every model-facing read/history/search/notification/error surface; demonstrate forbidden access, forged commands and restart races fail closed.

**KHA-139 acceptance:** Two humans/two existing agents complete selected task, then third owner/agent joins with independent review; capture measured receipt/enqueue/consumption and supported browser-closed behavior.

## Acceptance

| Ticket | Bounded outcome | Prerequisites | Primary write surface |
|---|---|---|---|
| KHA-140 | Close root with merged-product evidence | KHA-138, KHA-139 | `docs/product/release-acceptance.md`; `docs/user-guide.md`; `docs/adapter-guide.md` |

**KHA-140 acceptance:** On merged base, confirm complete user journey, support docs and named evidence; no placeholder production wiring or unresolved blocking gate; child completion alone cannot close root.

## Computed dependency levels

These are earliest graph levels under unlimited capacity, not elapsed-time estimates or a command to wait for every ticket in a level. Dispatch each ready member when its own dependencies/gates clear.

| Level | Width | Tickets |
|---|---:|---|
| 1 | 6 | KHA-101, KHA-102, KHA-103, KHA-104, KHA-141, KHA-142 |
| 2 | 4 | KHA-106, KHA-108, KHA-143, KHA-144 |
| 3 | 5 | KHA-105, KHA-107, KHA-109, KHA-117, KHA-118 |
| 4 | 21 | KHA-110, KHA-111, KHA-112, KHA-113, KHA-114, KHA-115, KHA-116, KHA-119, KHA-120, KHA-121, KHA-122, KHA-123, KHA-124, KHA-125, KHA-126, KHA-127, KHA-128, KHA-129, KHA-130, KHA-131, KHA-137 |
| 5 | 2 | KHA-132, KHA-133 |
| 6 | 2 | KHA-134, KHA-136 |
| 7 | 1 | KHA-135 |
| 8 | 2 | KHA-138, KHA-139 |
| 9 | 1 | KHA-140 |

One longest dependency chain: KHA-102 → KHA-144 → KHA-105 → KHA-110 → KHA-132 → KHA-134 → KHA-135 → KHA-138 → KHA-140. This identifies dependency depth, not a duration forecast. Prioritize the feasibility/ownership gates and contract owners; adding workers cannot bypass them.

## Decision gates and conditional scope

- **Scope approval:** ticket scope approved; dispatch still depends on ready plans and resolved gates.
- **Substrate/client choice:** 102/141/142/143/144 produce evidence. Matrix/Synapse remains a candidate; accept its topology and UI reuse boundary before production tickets relying on it. Rewrite affected surfaces if rejected.
- **Harness feasibility:** 103/104 must prove agent-operated setup without extra ordinary human steps; failing proof returns a product decision, not permission to create replacement sessions.
- **Admission/OAuth/history:** settle providers, admission authority and history disclosure before 105/110/113. The ordinary OAuth/create/share flow is already settled.
- **Automation:** settle busy-session policy, browser-closed operation, trust backlog and reply budgets before 106/120/121/135.
- **Recovery/retention:** settle exceptional recovery and deletion/expiry policy before 127–130.
- **Acceptance:** choose concrete collaboration task before 139; accessibility/keyboard/mobile viewport evidence belongs in each UI ticket and the composed flow.

Encrypted attachments, polished customer self-hosting, federation and outbound review/redaction remain conditional, uncounted scope. No new bespoke crypto, model host or mandatory persistent application backend is proposed.

## Revision-3 coverage preserved

| Retired ticket | New owners |
|---|---|
| KHA-01 feasibility | 102, 141–144 |
| KHA-02 harness validation | 103, 104, 106 |
| KHA-03 foundations | 101, 105, 106 |
| KHA-04 hosting | 108, 109, 131 |
| KHA-05 OAuth/device identity | 110, 111, 144 |
| KHA-06 brand/client | 107, 143 |
| KHA-07 rooms/intros/invites | 112, 113, 122, 124, 132 |
| KHA-08 existing agent | 114–118, 133 |
| KHA-09 live conversation | 116, 123, 132 |
| KHA-10 review | 119, 125, 134 |
| KHA-11 trust/automation | 120, 121, 126, 135 |
| KHA-12 recovery/retention | 127–130, 136 |
| KHA-13 proof/docs | 137–140 |

## Approval boundary

The user approved this scope for deep planning and subsequent Aiur execution. Run the requested per-ticket brainstorm/plan workflows, including exact interface sketches, fixtures, implementation pointers, decision gates and adversarial review. Future Aiur materialization uses its canonical runtime member shape and discovery paths; this local proposal is intentionally inert. The final planning pack still requires validation and dashboard rendering at the separately coordinated runtime stage.
