---
title: "KHA-104 Prove Codex existing-session attachment - Plan"
type: feat
date: 2026-09-16
topic: codex-existing-session-proof
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-brainstorm
execution: code
origin: docs/product/tickets/KHA-104.md
---

# KHA-104 Prove Codex existing-session attachment - Plan

## Goal Capsule

Determine which current Codex interface can notify and submit released content to an already-running session. Dependencies: None. Follow the approved scope card and the units below. A plan is not evidence that the proposed integration works. All implementation surfaces listed here are proposed unless a source explicitly identifies existing code.

## Product Contract

### Summary

Determine which current Codex interface can notify and submit released content to an already-running session.

### Problem Frame

A transport receipt cannot establish model consumption, and successful replay cannot establish exactly-once agent execution. The observable outcome in this ticket must preserve the owner-controlled review boundary and existing session identity across retries and failures.

### Requirements

- R1. Use the target session identity and preserve workdir, permission state, model and conversation.
- R2. Verify idle and busy behavior with version-pinned evidence rather than inferring attachment from resume APIs.
- R3. Keep delivery uncertainty explicit across client disconnect and request retry.

### Actors and flow

A1: owning human. A2: trusted owner connector. A3: existing model session and its harness adapter. A4: ciphertext transport/control service. Human identity, connector device, agent participant and working session are distinct.

F1. An agent inspects its harness, arranges the supported local notification path, and receives a released nonce in its existing thread.

### Acceptance Examples

- AE1. The idle session consumes the nonce under its original thread ID; a busy case records actual queue/consumption times. Covers R1 and R2.
- AE2. A new app-server thread or resumed duplicate process fails same-session acceptance even if it has copied history. Covers R2 and R3.

### Key Decisions

KD1. Existing-session delivery (session-settled: user-directed — chosen over replacement agents: preserve the human's working context). Any model is supported by protocol extensibility; actual harness support requires evidence.

KD2. Connector-gated review (session-settled: user-directed — chosen over separate review encryption groups: pending plaintext may stay in the trusted owner connector but not model context).

KD3. TypeScript and OSS reuse (session-settled: user-directed — chosen over custom infrastructure by default: reduce development). Netlify is preferred; Railway is acceptable when reuse saves work. Matrix remains a candidate, not a selected dependency.

### Scope Boundaries

- `experiments/codex/`
- `docs/evidence/codex.md`

No sibling implementation edits, root package/lockfile changes, provider deployment or production credentials. Root dependency changes go through KHA-101. This ticket does not add human installation/configuration, broaden history disclosure, weaken harness permissions or claim isolation from an unrestricted same-host agent. Integration is explicit, not accomplished by importing unfinished sibling implementations.

### Open Questions

No product choice blocks a bounded proof; remote control privileges and supported version range remain proof outputs.

### Sources

- `docs/product/tickets/KHA-104.md`, `docs/product/decisions.md`, `docs/product/repo-layout.md`.
- `docs/research/01-agent-protocols.md`, `docs/research/02-substrates.md`, `docs/research/07-state-and-transport.md`.

## Planning Contract

Source manifest: `docs/evidence/transport-planning-sources.json` pins local repositories, read-only CLI observations and official documentation checks. No runtime proof is implied.

### Approach and alternatives

Run a bounded TypeScript experiment against a disposable, explicitly designated existing working session, with a prior context marker and permitted synthetic message. Preserve its identity and settings. This proof may validly conclude unsupported; the acceptance outcome is reproducible evidence, not a forced pass. KHA-118 depends on the conclusion rather than copying speculative experiment code into production.

Inspect the [official Codex app-server documentation](https://developers.openai.com/codex/app-server) (current redirect to `learn.chatgpt.com/docs/app-server`) and local `codex queue --help`, `codex app-server --help`. Read-only evidence on 2026-09-16: `codex --version` returned `codex-cli 0.154.0`; queue help exposes thread/message targeting and remote transport options; app-server exposes proxy/daemon/schema-generation surfaces. Presence of an option does not establish which running sessions it controls or whether its result means consumption.

Compare native queue/proxy attachment to app-server thread/turn APIs using the exact generated schema for this installed release. A new app-server process resuming a thread is not automatically attached to the already-running TUI. Reject duplicate executors, permission changes and replacement sessions as qualifying routes. Avoid secret/plaintext command arguments; prefer a supported structured stream API once its semantics are verified. Do not assume that `turn/steer` for a busy app-server turn works on an arbitrary local CLI session.

Proposed files: `experiments/codex/probe.ts`, `scenario.ts`, `evidence.ts`, `README.md`, `package.json`, `package-lock.json`, and `docs/evidence/codex.md`. Export only experiment-local `runAttachmentProbe(input: ProbeInput): Promise<ProbeReport>`. No production harness package edits. This ticket has no graph dependency on KHA-101. Own an isolated npm package and lockfile under `experiments/codex/`, pin TypeScript/tsx/test runner versions there, and set scripts `probe` and `test`. It does not alter root workspace manifests or require a root install.

```ts
type ProbeInput = { sessionId: string; expectedWorkdir: string;
  nonce: string; mode: "idle" | "busy"; deadlineMs: number };
type ProbeReport = { harness: "codex"; version: string;
  originalSessionId: string; observedSessionId: string | null;
  setupActions: readonly {actor:"agent"|"human"; action:string}[];
  observations: readonly {kind:string; monotonicMs:number;
    evidencePath:string}[];
  outcome: "supported"|"unsupported"|"inconclusive";
  limitations: readonly string[] };
```

### Worked scenario and evidence interpretation

Before setup, the existing session knows `prior-marker-codex-alpha`; the synthetic approved message asks it to report `release-nonce-7` alongside that prior marker without embedding the marker itself. Record the original native session/thread ID independently of generated text. Capture workdir and permission/model settings before/after. Passing the nonce alone proves neither context preservation nor same-session identity. Use only disposable non-secret content; redact tokens and personal paths in published evidence.

Timeline contains source event publication, connector receipt, durable acceptance, notification write, native queue acceptance if observable, first context-consumption evidence and result. Use local monotonic durations per process; cross-host wall-clock subtraction is not a reliable latency measure without recorded synchronization/error. Repeat once idle, once during a controllable long tool call, and once across notification-client disconnect. A deadline is an experiment bound, not a product latency SLO.

## Implementation Units

### U1. Inventory and bind the experiment

Capture CLI version, binary origin/package version, platform, provider/account constraints, current session ID, route schema/help and exact setup actions. Require explicit experiment target rather than scanning and notifying unrelated live sessions. Produce a route table: documented capability, installed capability, unproven assumptions. Covers R1.

### U2. Execute same-session idle and busy cases

Depends U1. Implement experiment-local probe with bounded deadline and cleanup. Agent performs setup; human technical intervention is recorded as a no-setup gap. Capture before/after context and settings plus receipt levels. Covers R1/R2, F1 and AE1. Never bypass organization or harness permissions to get a pass.

### U3. Inject disconnect, duplicate and exit

Depends U2. Disconnect after write and before response; replay identical operation only if the native protocol's dedup/reconcile semantics are established. Record ambiguous outcomes. Exit the target session and prove no new replacement process is silently created. Busy delivery must not interrupt running tools or increase permission scope. Covers R2/R3 and AE2.

### U4. Publish route decision and adapter handoff

Depends U3. Evidence contains exact commands with redacted inputs, version pins, JSON reports, observed timestamps, setup inventory, raw output hashes and unsupported rows. Recommend one route only if it satisfies the user contract; otherwise report the smallest concrete product gap to the parent. KHA-106 consumes capability/receipt facts; KHA-118 consumes route/schema/error behavior. Version support is a tested pair, not an open-ended minimum-version claim.

## Verification Contract

Run the experiment's documented TypeScript runner after dependencies are pinned: `npm --prefix experiments/codex ci`, `npm --prefix experiments/codex run probe -- --help`, `npm --prefix experiments/codex test`, then the documented explicit target-session arguments in its README. A help run is only smoke verification. The final evidence must include actual idle/busy/disconnect/exit cases and native session identity checks. An unsupported conclusion must still contain sufficient observations to reproduce the gap; no live send is required merely to review this plan. Tests for report redaction and deadline cleanup run through the experiment's documented runner. No live proof was executed during planning.

## Definition of Done

AE1 either passes with preserved identity and no extra human setup, or is explicitly unsupported/inconclusive with a reproducible cause. AE2 is exercised and documented. Exact installed versions/schema/evidence paths are pinned; credentials and private conversation content are absent. KHA-106 and KHA-118 receive an honest support report. A negative proof completes this research ticket but blocks the corresponding production support claim.

### Source grounding and verification discipline

Repository planning base: `6d4694173eff9b0832f4c3a2cdb90b4281fcccd9`; source cards and decisions are authoritative for scope. Read the proposed KHA-105/106 types as design reference only; the experiment has no imports of unbuilt workspace packages and no dependency on KHA-101. Its owned isolated npm package/lock/scripts provide the reproducible runner. Do not change root manifests or require a root install. The experiment report is consumed by the contract/adapter owners after this proof; KHA-133 owns later production integration.
