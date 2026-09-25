---
title: "KHA-103 Prove Claude existing-session attachment - Plan"
type: feat
date: 2026-09-16
topic: claude-existing-session-proof
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-brainstorm
execution: code
origin: docs/product/tickets/KHA-103.md
---

# KHA-103 Prove Claude existing-session attachment - Plan

## Goal Capsule

Determine whether Claude can arrange prompt notification of the same working session from a channel link without human infrastructure setup. Dependencies: None. Follow the approved scope card and the units below. A plan is not evidence that the proposed integration works. All implementation surfaces listed here are proposed unless a source explicitly identifies existing code.

## Product Contract

### Summary

Determine whether Claude can arrange prompt notification of the same working session from a channel link without human infrastructure setup.

### Problem Frame

A transport receipt cannot establish model consumption, and successful replay cannot establish exactly-once agent execution. The observable outcome in this ticket must preserve the owner-controlled review boundary and existing session identity across retries and failures.

### Requirements

- R1. Capture session ID, working directory, permissions and model before and after setup; replacement sessions fail.
- R2. Distinguish notification while busy, queue acceptance, context consumption and task completion.
- R3. Report every required flag, restart, account entitlement and human confirmation as evidence, including product gaps.

### Actors and flow

A1: owning human. A2: trusted owner connector. A3: existing model session and its harness adapter. A4: ciphertext transport/control service. Human identity, connector device, agent participant and working session are distinct.

F1. An agent receives its owner's link, discovers supported notification setup, receives a synthetic released message while idle and busy, and demonstrates session continuity.

### Acceptance Examples

- AE1. An existing session consumes the nonce and retains a prior private context marker without a new session. Covers R1 and R2.
- AE2. A channels route needing restart/confirmation is recorded unsupported for the ordinary no-setup flow, not disguised as a successful bootstrap. Covers R2 and R3.

### Key Decisions

KD1. Existing-session delivery (session-settled: user-directed — chosen over replacement agents: preserve the human's working context). Any model is supported by protocol extensibility; actual harness support requires evidence.

KD2. Connector-gated review (session-settled: user-directed — chosen over separate review encryption groups: pending plaintext may stay in the trusted owner connector but not model context).

KD3. TypeScript and OSS reuse (session-settled: user-directed — chosen over custom infrastructure by default: reduce development). Netlify is preferred; Railway is acceptable when reuse saves work. Matrix remains a candidate, not a selected dependency.

### Scope Boundaries

- `experiments/claude/`
- `docs/evidence/claude.md`

No sibling implementation edits, root package/lockfile changes, provider deployment or production credentials. Root dependency changes go through KHA-101. This ticket does not add human installation/configuration, broaden history disclosure, weaken harness permissions or claim isolation from an unrestricted same-host agent. Integration is explicit, not accomplished by importing unfinished sibling implementations.

### Open Questions

No product choice is needed to run a bounded proof; a failed proof blocks KHA-106/117 rather than relaxing onboarding.

### Sources

- `docs/product/tickets/KHA-103.md`, `docs/product/decisions.md`, `docs/product/repo-layout.md`.
- `docs/research/01-agent-protocols.md`, `docs/research/02-substrates.md`, `docs/research/07-state-and-transport.md`.

## Planning Contract

Source manifest: `docs/evidence/transport-planning-sources.json` pins local repositories, read-only CLI observations and official documentation checks. No runtime proof is implied.

### Approach and alternatives

Run a bounded TypeScript experiment against a disposable, explicitly designated existing working session, with a prior context marker and permitted synthetic message. Preserve its identity and settings. This proof may validly conclude unsupported; the acceptance outcome is reproducible evidence, not a forced pass. KHA-117 depends on the conclusion rather than copying speculative experiment code into production.

Inspect the [official channels reference](https://code.claude.com/docs/en/channels-reference) and [cross-session messaging docs](https://code.claude.com/docs/en/cross-session-messaging). Documentation checked 2026-09-16. Channels use a local MCP route, but startup registration and preview confirmation may violate no-setup attachment. A returned notification write does not establish consumption. Cross-session messaging concerns sessions messaging each other; it is not evidence of a supported arbitrary external sender API. Investigate only documented/local supported surfaces; do not reverse engineer a private inbox socket into a launch dependency or run a helper model conversation to masquerade as the existing agent.

Local read-only evidence: `claude --version` returned `2.1.271 (Claude Code)`. This establishes installed version only. No live notification was sent during planning. Read account/org restrictions, actual available tool set and current session identity before choosing the experiment route. A startup-only configuration in a freshly launched experimental session can characterize the mechanism but cannot satisfy attachment to an already-running unprepared session.

Proposed files: `experiments/claude/probe.ts`, `scenario.ts`, `evidence.ts`, `README.md`, `package.json`, `package-lock.json`, and `docs/evidence/claude.md`. Export only experiment-local `runAttachmentProbe(input: ProbeInput): Promise<ProbeReport>`. No production harness package edits. This ticket has no graph dependency on KHA-101. Own an isolated npm package and lockfile under `experiments/claude/`, pin TypeScript/tsx/test runner versions there, and set scripts `probe` and `test`. It does not alter root workspace manifests or require a root install.

```ts
type ProbeInput = { sessionId: string; expectedWorkdir: string;
  nonce: string; mode: "idle" | "busy"; deadlineMs: number };
type ProbeReport = { harness: "claude"; version: string;
  originalSessionId: string; observedSessionId: string | null;
  setupActions: readonly {actor:"agent"|"human"; action:string}[];
  observations: readonly {kind:string; monotonicMs:number;
    evidencePath:string}[];
  outcome: "supported"|"unsupported"|"inconclusive";
  limitations: readonly string[] };
```

### Worked scenario and evidence interpretation

Before setup, the existing session knows `prior-marker-claude-alpha`; the synthetic approved message asks it to report `release-nonce-7` alongside that prior marker without embedding the marker itself. Record the original native session/thread ID independently of generated text. Capture workdir and permission/model settings before/after. Passing the nonce alone proves neither context preservation nor same-session identity. Use only disposable non-secret content; redact tokens and personal paths in published evidence.

Timeline contains source event publication, connector receipt, durable acceptance, notification write, native queue acceptance if observable, first context-consumption evidence and result. Use local monotonic durations per process; cross-host wall-clock subtraction is not a reliable latency measure without recorded synchronization/error. Repeat once idle, once during a controllable long tool call, and once across notification-client disconnect. A deadline is an experiment bound, not a product latency SLO.

## Implementation Units

### U1. Inventory and bind the experiment

Capture CLI version, binary origin/package version, platform, provider/account constraints, current session ID, route schema/help and exact setup actions. Require explicit experiment target rather than scanning and notifying unrelated live sessions. Produce a route table: documented capability, installed capability, unproven assumptions. Covers R1.

### U2. Execute same-session idle and busy cases

Depends U1. Implement experiment-local probe with bounded deadline and cleanup. Agent performs setup; human technical intervention is recorded as a no-setup gap. Capture before/after context and settings plus receipt levels. Covers R1/R2, F1 and AE1. Never bypass organization or harness permissions to get a pass.

### U3. Inject disconnect, duplicate and exit

Depends U2. Disconnect after write and before response; replay identical operation only if the native protocol's dedup/reconcile semantics are established. Record ambiguous outcomes. Exit the target session and prove no new replacement process is silently created. Busy delivery must not interrupt running tools or increase permission scope. Covers R2/R3 and AE2.

### U4. Publish route decision and adapter handoff

Depends U3. Evidence contains exact commands with redacted inputs, version pins, JSON reports, observed timestamps, setup inventory, raw output hashes and unsupported rows. Recommend one route only if it satisfies the user contract; otherwise report the smallest concrete product gap to the parent. KHA-106 consumes capability/receipt facts; KHA-117 consumes route/schema/error behavior. Version support is a tested pair, not an open-ended minimum-version claim.

## Verification Contract

Run the experiment's documented TypeScript runner after dependencies are pinned: `npm --prefix experiments/claude ci`, `npm --prefix experiments/claude run probe -- --help`, `npm --prefix experiments/claude test`, then the documented explicit target-session arguments in its README. A help run is only smoke verification. The final evidence must include actual idle/busy/disconnect/exit cases and native session identity checks. An unsupported conclusion must still contain sufficient observations to reproduce the gap; no live send is required merely to review this plan. Tests for report redaction and deadline cleanup run through the experiment's documented runner. No live proof was executed during planning.

## Definition of Done

AE1 either passes with preserved identity and no extra human setup, or is explicitly unsupported/inconclusive with a reproducible cause. AE2 is exercised and documented. Exact installed versions/schema/evidence paths are pinned; credentials and private conversation content are absent. KHA-106 and KHA-117 receive an honest support report. A negative proof completes this research ticket but blocks the corresponding production support claim.

### Source grounding and verification discipline

Repository planning base: `6d4694173eff9b0832f4c3a2cdb90b4281fcccd9`; source cards and decisions are authoritative for scope. Read the proposed KHA-105/106 types as design reference only; the experiment has no imports of unbuilt workspace packages and no dependency on KHA-101. Its owned isolated npm package/lock/scripts provide the reproducible runner. Do not change root manifests or require a root install. The experiment report is consumed by the contract/adapter owners after this proof; KHA-133 owns later production integration.
