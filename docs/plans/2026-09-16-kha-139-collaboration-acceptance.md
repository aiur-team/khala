---
title: "KHA-139 Prove collaboration across independent owners - Plan"
type: feat
date: 2026-09-16
topic: collaboration-acceptance
artifact_contract: ce-unified-plan/v1
artifact_readiness: requirements-only
product_contract_source: ce-brainstorm
execution: code
origin: docs/product/tickets/KHA-139.md
---

# KHA-139 Prove collaboration across independent owners - Plan

## Goal Capsule

Demonstrate the chosen real collaboration task with two humans and their existing agents, then an independent third owner. Dependencies: KHA-109, KHA-134, KHA-135, KHA-136, KHA-137. Follow the approved scope card and the units below. A plan is not evidence that the proposed integration works. All implementation surfaces listed here are proposed unless a source explicitly identifies existing code.

## Product Contract

### Summary

Demonstrate the chosen real collaboration task with two humans and their existing agents, then an independent third owner.

### Problem Frame

A transport receipt cannot establish model consumption, and successful replay cannot establish exactly-once agent execution. The observable outcome in this ticket must preserve the owner-controlled review boundary and existing session identity across retries and failures.

### Requirements

- R1. Use the approved task and ordinary OAuth/chat-link flow without hidden human infrastructure setup.
- R2. Show exact-message approval, optional trusted delivery, re-arm and independent third-owner policy.
- R3. Measure notification and consumption separately and disclose browser-closed and unsupported-harness limitations.

### Actors and flow

A1: owning human. A2: trusted owner connector. A3: existing model session and its harness adapter. A4: ciphertext transport/control service. Human identity, connector device, agent participant and working session are distinct.

F1. Two owners complete the selected task through their actual sessions; a third owner joins, reviews independently and participates without inherited trust.

### Acceptance Examples

- AE1. A reviewed message reaches only the intended session, produces a correlated useful task result and retains the original session identity. Covers R1 and R2.
- AE2. A busy/offline participant remains visible and cannot be counted as having consumed a message merely because the relay accepted it. Covers R2 and R3.

### Key Decisions

KD1. Existing-session delivery (session-settled: user-directed — chosen over replacement agents: preserve the human's working context). Any model is supported by protocol extensibility; actual harness support requires evidence.

KD2. Connector-gated review (session-settled: user-directed — chosen over separate review encryption groups: pending plaintext may stay in the trusted owner connector but not model context).

KD3. TypeScript and OSS reuse (session-settled: user-directed — chosen over custom infrastructure by default: reduce development). Netlify is preferred; Railway is acceptable when reuse saves work. Matrix remains a candidate, not a selected dependency.

### Scope Boundaries

- `tests/e2e/collaboration/`
- `docs/evidence/collaboration-acceptance.md`

No sibling implementation edits, root package/lockfile changes, provider deployment or production credentials. Root dependency changes go through KHA-101. This ticket does not add human installation/configuration, broaden history disclosure, weaken harness permissions or claim isolation from an unrestricted same-host agent. Integration is explicit, not accomplished by importing unfinished sibling implementations.

### Open Questions

G-TASK plus G-AUTOMATION, G-HARNESSES, G-RETENTION and P02 applicable to the chosen demonstration must clear; no invented task or timing SLO.

### Sources

- `docs/product/tickets/KHA-139.md`, `docs/product/decisions.md`, `docs/product/repo-layout.md`.
- `docs/research/01-agent-protocols.md`, `docs/research/02-substrates.md`, `docs/research/07-state-and-transport.md`.

## Planning Contract

Source manifest: `docs/evidence/transport-planning-sources.json` pins local repositories, read-only CLI observations and official documentation checks. No runtime proof is implied.

### Approach and scenario gate

KHA-109's approved collaboration scenario is the source of task content and observable completion. Do not choose cross-repo code work, technical Q&A or autonomous tool use here before G-TASK is resolved. Own `tests/e2e/collaboration/scenario.ts`, `assertions.ts`, `evidence.ts` and `docs/evidence/collaboration-acceptance.md`. Reuse KHA-137 drivers and actual KHA-134/135/136 feature composition; no parallel fake product implementation in E2E code.

### Scenario contract and worked skeleton

```ts
type CollaborationCase = {caseId:string; taskDecisionRef:string;
  owners:readonly [OwnerFixture,OwnerFixture,OwnerFixture];
  harnessVersions:Readonly<Record<string,string>>;
  browserClosedMode:"not_required"|"required"|"unsupported";
  expectedTaskAssertions:readonly string[]};
type AcceptanceResult = {caseId:string;
  outcome:"pass"|"fail"|"blocked";
  assertions:readonly {id:string;passed:boolean;evidenceRef:string}[];
  limitations:readonly string[]};
```

A/B each OAuth-sign in, use the actual create/join link flow and give the link to their existing agent session. Record technical setup actions by actor; any human connector configuration fails the ordinary-flow assertion. A sends task message E1. B previews the exact content/provenance and releases it only to B's bound session. Capture original session identity plus receipt/write/queue/consumption/result separately. B later opts into the approved trusted mode, then re-arms review and proves a subsequent message waits again. C joins with its own identity/device/session; C's approval/trust state starts according to the agreed product policy and never inherits B's permission merely from room membership.

The task assertions must show useful collaboration results, not just nonce echoes. Nonces are additional correlation evidence. Tool actions remain constrained by each existing session's permissions and approved scenario; a chat message cannot grant shell/repository authority. No credentials, proprietary data or destructive actions are needed for the synthetic launch case.

### Busy, offline and recovery coverage

Run one recipient busy in a controllable tool call and record when the message is notified/queued and consumed. A source publication timestamp minus another host's wall clock is not a valid latency claim without synchronization bounds. Record local monotonic durations, clock sources and cross-host uncertainty. No arbitrary latency SLO is invented; G-TASK/harness evidence sets the launch expectation. A disconnected connector reports offline and catches up durably. Unknown native acceptance cannot count as successful consumption or be hidden by resend.

P02 decides which browsers-closed mode is required. If background operation is unapproved, mark that case unresolved rather than skipping it under a passing overall launch result. Recovery must follow KHA-136's proven limits, not restore an unreviewed backup shortcut. G-RETENTION controls what C can read after admission and whether expired history is intentionally unavailable.

## Implementation Units

### U1. Bind approved scenario and environment manifest

Read KHA-109 decision and inherited gates, then encode concrete task assertions and permitted effects. Capture app/backend/SDK/harness versions, chosen runtime, source SHA, owner setup, test credentials via secure fixture provision, and browser-closed requirement. Covers R1. A missing decision returns blocked before executing actions.

### U2. Two-owner reviewed collaboration

Depends U1 and completed real feature compositions. Exercise OAuth/chat-link/current-session bootstrap, full human chat, exact review and useful correlated task response. Covers R1/R2 and AE1. Assert no pending message entered model context before approval; do not infer from UI alone.

### U3. Trust, re-arm and independent third owner

Depends U2. Exercise approved auto mode/budgets, effective-vs-requested controls, re-arm and C joining with independent review. Covers R2. Reject cross-owner authority and stale binding generation. KHA-138 owns hostile security proof; this scenario verifies ordinary multi-owner behavior.

### U4. Busy/offline/recovery and evidence report

Depends U3. Run busy and disconnect cases, then the approved browser-closed/recovery expectation. Covers R3/AE2. Produce report with per-assertion artifacts, measured timing, pass/fail/blocked outcome and explicit support limitations. Use redacted transcripts or synthetic content only; evidence mode must be live for launch claims.

## Verification Contract

Run `pnpm test:conformance` and `pnpm test:e2e -- tests/e2e/collaboration/collaboration.test.ts` for the KHA-137 runner entry; put scenario assertions behind that entry and document environment inputs in `tests/e2e/collaboration/README.md`. Actual acceptance uses `KHALA_E2E_LIVE=1 pnpm test:e2e -- tests/e2e/collaboration/collaboration.test.ts` and must fail if no live scenario executed. Real run requires designated owner accounts/devices and existing sessions, selected deployment and approved scenario. Failure/blocked rows remain in the report; reruns retain distinct run IDs instead of overwriting adverse evidence. Planning performed no live collaboration.

## Definition of Done

The selected task completes under ordinary no-human-setup onboarding with two humans/two existing agents and independent third owner; review/trust/re-arm and busy/offline assertions pass with actual session evidence. Browser-closed, recovery/history and automation expectations are explicit and met. All listed product/feasibility gates must clear before implementation-ready status; mocks or a transport-only round trip do not count as completion.
