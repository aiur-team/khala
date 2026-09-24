---
title: "KHA-166 interactive OpenCode listening-mode proof"
date: 2026-09-24
type: feat
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: legacy-requirements
execution: knowledge-work
origin: docs/product/internal-mode/requirements.md
---

# KHA-166 interactive OpenCode listening-mode proof

## Goal Capsule

- **Objective:** Produce reproducible, timestamped evidence for `steer`, `sync`, and `async` in a user-started OpenCode 1.17.10 TUI running DeepSeek, then translate the results into implementation ticket contracts.
- **Authority:** The operator clarification on issue #166 narrows `docs/product/internal-mode/requirements.md`: Khala never launches or hosts OpenCode, and a wrapper is not an approved default.
- **Execution profile:** Research and empirical proof only. Product changes are out of scope; retained scripts and plugins are throwaway proof fixtures.
- **Stop conditions:** Every matrix cell is either Proven or Blocked with a concrete reason and best alternative; no hosted or headless agent process is counted as the user's interactive session.
- **Tail ownership:** This ticket owns raw evidence, the internal-mode proof document, coordination notes for PR #154, review, and CI-ready packaging.

---

## Product Contract

### Summary

The proof must establish what OpenCode 1.17.10 can actually deliver into a person's already-running interactive TUI. Endpoint discovery, server-only execution, or a Khala-launched agent is insufficient. The proof must distinguish delivery timing from ingestion and preserve Khala's shared batch-token acknowledgement contract.

### Requirements

- R1. Record the host, both installed OpenCode versions, their resolved executable paths and hashes, version-local help, relevant sanitized configuration shape, and the exact target executable/provider/model.
- R2. Inventory native plugins and hooks, built-in TUI/server and session APIs, SDK, event stream, MCP client behavior including server notifications, attach/IPC surfaces, config reload, stdin, and queue mechanisms before considering fallbacks.
- R3. Prove `steer` with a deterministic turn containing at least two sequential tool boundaries: admit the marker during tool 1 and require a marker-derived model action before tool 2 begins, without aborting by default.
- R4. Prove `sync` against the same two-boundary turn: retain the marker through both tools and deliver it into the same live TUI only after the original turn reaches idle, or mark the native route Blocked and document the best non-default wrapper option if no user-started-session route exists.
- R5. Prove `async` by showing no automatic injection and an explicit agent-decided channel read through the shared pull shape.
- R6. Use a long synthetic tool and timestamp admission, tool boundaries, idle, injection, and model consumption closely enough to distinguish the three semantics.
- R7. Demonstrate safety boundaries: batch-token acknowledgement rather than host dedupe, no message bytes or credentials in process argv, no corruption of the session or unsent draft, wrong-session protection, peer content treated as untrusted data under existing tool permissions, and hard abort disabled unless explicitly selected.
- R8. Retain allowlisted, minimally sanitized commands, logs, fixtures, and results under `experiments/interactive-cli/opencode/`; link every matrix claim to evidence and ship a sanitization manifest plus secret/private-content scan results.
- R9. Write `docs/product/internal-mode/interactive-opencode.md` with the mode matrix, recommended route per mode, risks, and complete slug-based ticket contracts including wrong-implementation tests.

### Scope Boundaries

- Product bridge, setup, connector, or UI implementation is out of scope.
- A separately launched `opencode serve` process may help inspect APIs but cannot satisfy a mode proof.
- `tui.appendPrompt` plus `submitPrompt` is evidence only unless the proof shows it preserves the user's draft and targets the admitted session.
- A `khala run <cli>` PTY wrapper may be described only as Blocked-without-wrapper plus an operator option; it is not an approved recommendation.
- Provider credentials, full private transcripts, and unrelated local configuration are never retained.

### Acceptance Examples

- AE1. While the TUI runs tool 1 of a deterministic two-tool turn, a `steer` marker arrives and causes a marker-derived tool 2 argument or assistant response before the original turn can become idle, without an abort request.
- AE2. While the TUI runs tool 1 of the same two-tool turn, a `sync` marker remains absent through tool 2 and is consumed only after the original turn reaches idle, without requiring the human to retype it.
- AE3. In `async`, a marker remains absent from the OpenCode session until the agent invokes the explicit read tool; that Khala call acknowledges the preceding batch token and returns the next bounded batch.
- AE4. Restart before acknowledgement exposes the same Khala batch token once, with no OpenCode-side dedupe database or blind replay.
- AE5. A second OpenCode session and a prefilled TUI draft remain unchanged throughout session-addressed delivery.
- AE6. For every claimed delivery, the resulting assistant message records `deepseek/deepseek-flash` and returns a nonce derived from the injected marker; storage, HTTP success, or an unrelated completion cannot satisfy the oracle.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **Pin the real target executable.** Use `~/.local/share/mise/installs/opencode/1.17.10/opencode`; the current shell resolves it directly, while `mise exec` unexpectedly resolves the Node-installed 1.15.6 binary. Evidence records both instead of repeating the ticket's stale ordering.
- KTD2. **Fail closed on model drift.** Use `deepseek/deepseek-flash`, which the isolated 1.17.10 catalog resolves. Before timing probes, require a live nonce response whose stored assistant metadata names that provider/model. The configured `deepseek/deepseek-v4-flash`, catalog presence without inference, and silent model substitution are invalid proof inputs.
- KTD3. **The TUI owns an authenticated loopback server.** Start the user-facing TUI on explicit `127.0.0.1` with a fresh non-default credential supplied outside argv, then drive only that embedded server. Audit listeners, require fail-closed startup when auth is absent, test missing/wrong/correct auth across session, event, TUI, and abort API families, and record Host/Origin behavior. A separate `serve` or SDK-hosted session cannot satisfy acceptance.
- KTD4. **Bind the focused interactive session before using session-addressed calls.** Start or select one uniquely marked disposable session in the TUI, capture its ID from an authoritative event/message correlation, and revalidate focus/project scope before delivery. Session APIs preserve target identity and the user's draft only after that binding; reject ambiguous focus. Global append/submit remains a contained fallback probe in the disposable workspace whose safety limitations are measured explicitly.
- KTD5. **Treat events as timing evidence, not a queue.** Correlate server events and plugin hooks with authoritative session status/message reads; do not infer delivery from an HTTP success code.
- KTD6. **Keep shared semantics outside OpenCode.** The proof fixture models a stable Khala batch token and next-call acknowledgement but introduces no OpenCode cursor, lease, or deduplication state.
- KTD7. **Route proofs use a contract-faithful channel source.** A local fixture supplies bounded ordered batches, stable tokens, next-call acknowledgement, and restart-before-ack replay to the proof plugin/companion. Correlated channel admission, pull, OpenCode injection or explicit read, model consumption, and acknowledgement evidence is required; direct endpoint calls prove routes only.

### Sequence

1. Freeze inventory and exact-version source references.
2. Build isolated, authenticated proof fixtures and an event recorder.
3. Run idle, busy, queued-after-idle, explicit-read, abort-negative, wrong-session, and restart probes in a real TUI.
4. Classify each route against the mode definitions, preserving negative results.
5. Write the proof document and ticket contracts, then review all claims against raw evidence and PR #154.

### Risks

- The global config's `@opencode-ai/plugin` dependency is 1.15.6 while the selected binary is 1.17.10; proof fixtures must pin their own compatible package or avoid importing it.
- `promptAsync` may persist a user message without scheduling the intended follow-up, so message storage alone is not consumption evidence.
- TUI controls are directory-scoped and may submit the human's draft or target the focused session rather than the admitted session.
- Exact timing can vary with the provider; fixed markers and event timestamps must distinguish transport behavior from model latency.
- A proof credential or provider token in logs, argv, or committed evidence invalidates the run.
- A single long tool cannot distinguish a safe boundary from turn idle; all timing claims require the deterministic two-boundary fixture and a marker-derived consumption oracle.
- Peer-authored channel bytes are untrusted data, never system/operator instructions, and may not weaken the session's existing tool permission gates.

---

## Implementation Units

### U1. Freeze the version and native-surface inventory

- **Goal:** Establish the exact runtime and enumerate all candidate routes from local behavior, official docs, and version-tagged source.
- **Files:** `experiments/interactive-cli/opencode/inventory.md`, `experiments/interactive-cli/opencode/source-notes.md`.
- **Approach:** Record commands and sanitized output for both binaries, target model resolution, help, auth shape, plugin/event hooks, session/TUI APIs, MCP notification handlers, attach/ACP, and absent queue/stdin mechanisms.
- **Test scenarios:** Resolve each binary independently; demonstrate the `mise exec` discrepancy; require the selected provider/model to appear in the target catalog.
- **Verification:** Every surface claim links to local output or the exact `v1.17.10` source tag.

### U2. Prove timing and safety in the user-started TUI

- **Goal:** Produce repeatable evidence for the three listening modes without changing product code.
- **Files:** `experiments/interactive-cli/opencode/README.md`, `experiments/interactive-cli/opencode/probe/`, `experiments/interactive-cli/opencode/evidence/`, `experiments/interactive-cli/opencode/evidence/sanitization.md`.
- **Approach:** Use a disposable proof workspace and synthetic TUI session, an authenticated loopback server embedded in that TUI, request bodies read from 0600 workspace-private scratch files, a contract-faithful channel source, and a proof-only plugin/event recorder pinned to `@opencode-ai/plugin` 1.17.10. Wrap peer bytes in an explicit untrusted-data envelope, preserve all existing tool permissions, and capture monotonic plus wall-clock timestamps around both tool boundaries, session state, injection, idle, and reply completion. Snapshot the focused session and draft before global-control probes and fail closed on ambiguity.
- **Test scenarios:** AE1-AE6; correct/missing/wrong auth on every used API family; explicit listener and Host/Origin audits; no-abort assertion; hostile peer text remains data and denied tools remain denied; global TUI draft and wrong-session preservation; same-token restart replay; message/credential argv inspection; plugin runtime version attestation; provider/model response metadata.
- **Verification:** Each result includes the channel admission and token, command, exit/HTTP status, timestamps, relevant events, focused session ID, and marker-derived DeepSeek response. A 2xx, stored prompt, catalog entry, or unrelated assistant completion is insufficient. The run uses restrictive permissions, terminates listeners/recorders, removes scratch credentials and bodies, deletes disposable sessions, and records cleanup verification.

### U3. Publish the mode decision and implementation contracts

- **Goal:** Convert the evidence into a candid mode matrix and actionable follow-on contracts.
- **Files:** `docs/product/internal-mode/interactive-opencode.md`.
- **Approach:** State native versus fallback routes, Proven versus Blocked, recommendations, limitations, safety risks, and exact evidence links. Reconcile any superseded assumptions in PR #154 and comment there with the final proof outcome.
- **Test scenarios:** Link check all evidence; search for prohibited `room`/`chat` terminology in agent-facing text; verify every contract declares slug, title, complexity, scope, files, acceptance, wrong-implementation test, and slug-only dependencies.
- **Verification:** A reviewer can trace every matrix cell to retained evidence and cannot mistake a hosted/background process for the interactive TUI.

---

## Verification Contract

| Check | Applies to | Done signal |
|---|---|---|
| Exact binary, hash, model, host, and config-shape inventory | U1 | Commands are reproducible and both version paths are explicit. |
| Version-tagged source audit | U1 | All native surfaces and stated absences are backed by `v1.17.10` code or official docs. |
| Authenticated live-TUI probe matrix | U2 | Each required scenario has raw timestamps and an unambiguous observed result. |
| `ps`/`/proc` argv audit | U2 | No fixed message marker, channel payload, proof credential, or provider credential appears in any launched process argv. |
| Evidence sanitization and cleanup audit | U2 | Allowlisted captures, sanitization manifest, secret scan, 0600 scratch inputs, terminated processes, and removed temporary secrets/bodies are recorded. |
| Evidence/document link audit | U3 | Every relative link resolves and every matrix result has evidence. |
| Markdown and repository scoped checks | U3 | Formatting and applicable repository checks pass without altering product code. |

---

## Definition of Done

- [ ] R1-R9 and AE1-AE5 are traceable to retained evidence or an explicit Blocked finding.
- [ ] The selected target is exactly OpenCode 1.17.10 with a currently resolvable DeepSeek model.
- [ ] The proof uses the person's live, user-started TUI and does not count Khala-hosted or server-only execution.
- [ ] The matrix is candid about native limitations and does not recommend an unapproved wrapper as the default.
- [ ] Safety findings cover acknowledgement, argv, draft/session integrity, authentication, and abort behavior.
- [ ] A two-boundary timing fixture, focused-session binding, channel-source correlation, and marker-derived DeepSeek oracle prevent false `steer`/`sync`/consumption claims.
- [ ] Committed evidence passes the allowlist sanitization and secret/private-content gate; temporary proof secrets, bodies, sessions, and processes are cleaned up.
- [ ] The final document includes complete slug-based ticket contracts and coordinates the result back to PR #154.
- [ ] Review findings are resolved, the draft PR targets `main`, and CI receives the exact reviewed head.
