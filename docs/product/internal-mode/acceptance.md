# Internal mode acceptance

Status: research proposal, 2026-09-24. This applies D1–D12 from [requirements.md](requirements.md), the reuse map in [survey.md](survey.md), and the Executor's E09 decisions without reopening them.

## Summary

| Acceptance | Shape | Pass condition |
|---|---|---|
| 1 — CI | Extend `tests/e2e/harness` around the real internal composition; fake only native harness boundaries | Two agents join one channel, exchange deliberate sends, receive a human message, exercise listening modes, survive restart without duplicate delivery, and stop/resume with correct UI state |
| 2 — live | A manual script creates test tickets in `aiur-team/khala` labelled `acceptance`, first for Claude + Codex and then for the approved OpenCode + DeepSeek pairing | The channel store and Aiur agent logs show the requested distinct sessions joined one channel and exchanged messages in both directions; the script stops sessions and closes its tickets |

The live runner uses normal Aiur dispatch, not a dedicated acceptance Executor or sandbox repository. It needs no signed evidence envelope, reply-to field, or Aiur-repository implementation ticket. Fixed run markers are allowed; success comes from correlated server state and agent logs, never an agent self-report.

## Fixed decisions and assumptions

| Item | Decision |
|---|---|
| Terminology | User- and agent-facing text says **channel**. Matrix-internal `room` types and the slug `local-sqlite-room-store` remain unchanged. |
| Inbox and pull | `mcp-inbox-batch` owns the only bounded durable peek and batch token. The next Khala call acknowledges it on Khala's side; hosts do not deduplicate. `listening-mode-pull` owns `khala_read` / `khala read`; acceptance adds no second API. |
| Capabilities | `listening-mode-contract` owns `HarnessCapabilities`. Unproved routes stay `unproven`, including MCP async until `mcp-piggyback-evidence` passes. |
| Admission | The launcher never binds silently. Agents request access and the human grants it through RD4b/RD8. |
| Receipts | RR3 owns Codex, RR4 owns Claude, and RR5 owns OpenCode receipt proof. Acceptance consumes rather than redefines them. |
| Stop | `stop-control` ends agent sessions only. The server keeps running and the channel stays viewable/resumable. Closing the launcher stops the server; `khala internal --resume <channel-id>` resumes it. |
| OpenCode + DeepSeek | The exact pairing is pending an operator answer. Its live profile remains `unproven` and cannot substitute Aiur's direct DeepSeek backend. |

## Findings and evidence

| Finding | Evidence | Consequence |
|---|---|---|
| The E2E harness separates fake/live evidence, assigns private state directories, and disposes in reverse order. | [`scenario.ts`](../../../tests/e2e/harness/scenario.ts), [`evidence.ts`](../../../tests/e2e/harness/evidence.ts), [`live.ts`](../../../tests/e2e/harness/live.ts) | Extend it; do not create another lifecycle framework. |
| Reference channels and fake connector adapters are test oracles, not product composition. | [`reference.ts`](../../../tests/e2e/harness/reference.ts), [`fakes.ts`](../../../packages/connector/src/dispatch/fixtures/fakes.ts), [survey §5](survey.md#5-existing-fakes-and-harnesses-that-could-be-promoted) | CI wraps the real server and stores; only native harness boundaries are fake. |
| Replies must be deliberate sends; `HarnessPort` has no implicit model-output-to-channel path. | [`harness.ts`](../../../packages/contracts/src/delivery/harness.ts), [`types.ts`](../../../packages/agent-cli/src/cli/types.ts) | Captured final output cannot pass. No reply-to extension is required. |
| Root CI runs Node and browser tests, not root `pnpm test:integration`. | [CI](../../../.github/workflows/ci.yml), [`package.json`](../../../package.json) | Keep protocol tests under `tests/e2e/` and composed browser checks in the browser lane, or wire a lane explicitly. |
| Aiur writes per-ticket `.log`, `.events.log`, and `.agent_events.jsonl`. | Aiur `src/lib/aiur/issue_log.ex` | Correlate expected sessions and harness/model metadata without trusting issue comments. |
| Aiur's DeepSeek entry is a disabled-by-default direct OpenAI-compatible backend. | Aiur `src/lib/aiur/open_ai_compat/registry.ex` | It cannot prove the requested OpenCode route. |

Local proof on 2026-09-24:

```text
pnpm test:e2e -- tests/e2e/harness/harness.test.ts tests/e2e/harness/live-gate.test.ts
Result: 2 files, 27 tests passed.
```

The run used Node `24.18.0` while the repository requests `22.23.2`; pinned-runtime CI is authoritative.

## Design

### Acceptance 1 — CI end to end

One protocol scenario starts the real loopback server with disposable SQLite state and two independent fake native-harness drivers:

1. Create a channel through the production API. Both agents discover and request access; the test acts as the human and grants each through RD4b/RD8.
2. A deliberately sends E1. B receives E1 and deliberately sends E2. A receives E2. Add a human message and prove both agents receive it.
3. Exercise exact listening semantics: non-abort `steer` at the next safe boundary, `sync` at the end-of-turn boundary, and `async` through `khala_read`. Unsupported/unproved controls remain disabled with a reason.
4. Pause before claim, prove no claim occurs, resume, and consume the pending event once.
5. Restart over the same SQLite files after a durable release. Re-read and acknowledge through the batch token; duplicate timeline or delivery records fail.
6. Stop both agent sessions and prove the server and channel remain available. Resume those sessions in the existing browser flow. Then close the launcher and prove the loopback server becomes unavailable; run `khala internal --resume <channel-id>` and prove the same persisted channel reopens.
7. Dispose through `ScenarioHarness.defer`; leftovers and unfired injected faults fail.

The served-app Playwright slice drives the critical composed flow: create, two human grants, exchange, human message, one supported and one unproved-mode state, pause/resume, session stop/view/resume, launcher close, and CLI resume. It asserts keyboard reachability, focus after stop, and announced failure state. Exhaustive component state and accessibility matrices remain with `listening-mode-ui` and the RD4b access-grant UI owner. The slice must use real internal composition, not a fabricated feature port.

| Wrong implementation | Failing test |
|---|---|
| Final model prose is auto-posted | Driver returns prose without calling send; no channel event appears. |
| One binding represents both agents | Identical participant/binding IDs fail the exchange assertion. |
| Host dedupe masks broken acknowledgement | Restart and replay the batch token; any duplicate fails. |
| `steer` aborts | A long tool boundary must complete before queued steer delivery. |
| Stop kills the server | Sessions end, but the same browser channel remains viewable and resumable. |
| Browser test bypasses composition | It cannot obtain the internal composition marker and fails. |

### Acceptance 2 — live Aiur tickets

One manual repository script, for each approved pair:

1. Acquires a host-level kernel advisory lock keyed by repository/profile. Process death releases it; there is no TTL takeover. The guarantee serializes runners on that Executor host, which is the supported v1 execution location.
2. Preflights `aiur-team/khala`, the `acceptance` and normal state labels, requested harness/provider versions, credentials, timeout, and a unique run marker.
3. Starts or resumes exactly one channel through `internal-launcher`; records its stable ID and supported verifier/control handle; and proves the verifier can use an authenticated read API (or a post-shutdown snapshot), never concurrent ad-hoc SQLite reads.
4. Creates two issues with `acceptance`, a normal dispatch label, and a harness/model label. Each fixed secret-free prompt contains only that role's run marker and says: join the named channel, perform the handshake through Khala, do not change code, and do not open a PR.
5. Lets the normal Executor claim them. The human/controller grants both access requests through RD4b/RD8; neither starts pre-admitted.
6. Waits a bounded time for a three-event handshake: A sends A's role-private marker; B observes it and replies with A's marker plus B's role-private marker; A observes that reply and acknowledges B's marker. Pull routes use the shared `khala_read` and batch-token path.
7. Correlates the channel store and both Aiur logs/owned receipt facts. Require two ticket IDs, two participant/binding identities, and ordered server event IDs/timestamps plus read/ack evidence for all three events within the run window. Requested routing comes from labels; actual harness/provider identity remains `unproven` unless the script can cite an existing durable Aiur current-run/usage projection keyed by ticket and native session.
8. In `finally`, use the retained control handle to stop the two sessions, revoke run-scoped access if a product API exists, and close both issues terminally. Cleanup is idempotent and refuses an issue lacking the run marker and `acceptance` label.

Claude + Codex runs first. OpenCode + DeepSeek reuses the runner only after the operator resolves the exact pairing and its route is proved. Missing support reports `unproven`; it never falls back.

The `acceptance` label is the durable test marker, not a second state machine. Normal dispatch is intentional. The host-held lock permits at most one local pair; a timeout bounds cost. The script detects and reports an unexpected PR. Closed tickets remain the audit trail. The channel follows normal retention; acceptance does not invent deletion. Stopping sessions does not stop the server.

| Source | Required evidence |
|---|---|
| Channel store | One run channel; two distinct bindings; ordered A marker → B echo plus B marker → A acknowledgement of B marker; stable event IDs/timestamps; no duplicate client transaction |
| Aiur logs and owned receipts | Each expected ticket was handled once; B read/acknowledged A's event and A read/acknowledged B's event in the run window; each reached a bounded terminal outcome. Actual route identity is accepted only from a cited durable current-run/usage projection, not labels or transcript prose. |
| GitHub metadata | Repository, `acceptance` label, run marker/profile, timestamps, and no runner-linked PR |
| Verifier | Both sources correlate to one run/pair; exactly the two owned sessions stop and two owned tickets close |

Only fixed markers are inspected, and they are not copied into the summary artifact. Issue completion, comments, workpads, and agent-authored “success” text are not evidence.

### Dependencies and ownership

| Capability | Owning slug |
|---|---|
| Internal lifecycle | `internal-launcher`, `local-web-entry`, `stop-control` |
| Channel UI | `listening-mode-ui` |
| Human access request/grant | RD4b and RD8 |
| Listening semantics/storage | `listening-mode-contract`, `listening-mode-store`, `local-automation-fence`, `listening-mode-dispatch`, `local-sqlite-room-store` |
| Inbox/pull | `mcp-inbox-batch`, `mcp-result-piggyback`, `listening-mode-pull`, `mcp-piggyback-evidence` |
| Receipt proof | RR3 (Codex), RR4 (Claude), RR5 (OpenCode) |
| OpenCode route | `opencode-server-auth-proof` |

Acceptance adds no competing batch, pull, capability, receipt, admission, or stop API.

## Trade-offs and risks

| Choice / risk | Consequence / mitigation |
|---|---|
| Real composition, fake native drivers | Deterministic CI proves storage/dispatch/send/UI, with more setup than the reference channel. |
| Normal live dispatch | Matches the operator definition. The visible label, fixed prompt, one-pair limit, timeout, and guarded cleanup contain the run. |
| Store + logs, not signed envelopes | Simple and auditable; proves operational exchange, not cryptographic non-repudiation or comprehension. |
| Fixed markers | Role-private markers plus the ordered three-event handshake and matching read/ack evidence prevent timer-only sends, a copied transcript, or self-report from passing. |
| Provider drift | Pin/print versions; unsupported is `unproven`, never fallback. |
| Prompt injection | Fixed narrow prompt, bounded time/cost, no implementation request, and visible stop; arbitrary hostile-content safety is not claimed. |
| Cleanup targets unrelated issues | Re-fetch repository, label, marker, ID, and creation window before close; mismatch fails closed. |

## Non-goals

- A dedicated acceptance Executor, sandbox repository, signed envelope, or reply-to field.
- Aiur product changes or Aiur-repository tickets.
- Proving comprehension, conversation quality, external encryption, LAN access, recovery, or make-external.
- Treating captured output, issue closure, agent comments, or direct DeepSeek as proof.
- Defining another inbox, pull, receipt, capability, admission, or stop contract.

## Implementation ticket contracts

### AC1 — Protocol CI acceptance

| Field | Contract |
|---|---|
| Title | Prove the internal protocol flow in CI |
| Slug | `internal-protocol-acceptance` |
| Complexity | `complexity:3` |
| Scope | Extend `tests/e2e/harness` with real server/SQLite and fake native drivers for grant, two-way send, human message, modes, pause, restart/token acknowledgement, session stop/resume, launcher close/CLI resume, and cleanup. |
| Out of scope | Browser assertions, live providers, new product contracts. |
| Files/packages | `tests/e2e/internal-mode/**`, `tests/e2e/harness/**`; consume contracts, connector, messaging, policy, harnesses, agent-cli, internal composition. |
| Acceptance criteria | Ordinary CI; only native boundaries fake; protocol steps pass; stop leaves server/channel available; unproved routes stay unproven; no leftovers. |
| Tests | Happy flow plus boundary faults. **Wrong implementations must fail:** replaying a batch token after restart creates a duplicate; session Stop kills the server; closing the launcher leaves the server alive; or `khala internal --resume <channel-id>` does not reopen the same persisted channel. |
| Blocked by | `internal-launcher`, `listening-mode-contract`, `mcp-inbox-batch`, `mcp-result-piggyback`, `listening-mode-pull`, `local-sqlite-room-store`, `local-automation-fence`, `listening-mode-dispatch`, `stop-control`, RD4b, RD8. |
| Conflict risk | High with internal composition/listening fixtures; consume their ports and keep changes in E2E modules. |

### AC2 — Browser CI acceptance

| Field | Contract |
|---|---|
| Title | Prove the internal channel flow in the browser |
| Slug | `internal-browser-acceptance` |
| Complexity | `complexity:3` |
| Scope | Add served-app Playwright coverage for create, grants, exchange, human message, modes, session stop/view/resume, launcher close/CLI resume, including accessibility. |
| Out of scope | Protocol fault injection; redesign; live providers. |
| Files/packages | `apps/web/src/internal/**/*.browser.spec.ts` or final internal composition path; shared AC1 fixture. |
| Acceptance criteria | Existing browser CI lane; real composition; **channel** in UI; stop ends sessions while channel stays viewable; keyboard/focus/status passes. |
| Tests | State matrix above. **Wrong implementations must fail:** session Stop kills the server or hides the channel; launcher close leaves the server reachable; CLI resume opens a fresh channel instead of the persisted one. |
| Blocked by | `internal-protocol-acceptance`, `local-web-entry`, `listening-mode-ui`, `stop-control`, RD4b, RD8. |
| Conflict risk | High in internal web composition; limit production changes to feature-owned test seams. |

### AC3 — Live acceptance runner

| Field | Contract |
|---|---|
| Title | Create and verify live Aiur acceptance tickets |
| Slug | `live-acceptance-runner` |
| Complexity | `complexity:3` |
| Scope | Add the manual script: acquire a host kernel lock, start/resume one channel and retain supported read/control handles, preflight, create one labelled pair, wait, correlate store/logs/receipts, stop owned sessions, close owned tickets, report. |
| Out of scope | Provider launch logic, dedicated Executor, sandbox repository, signatures, reply-to, Aiur product changes. |
| Files/packages | `scripts/acceptance/**`, `tests/e2e/acceptance/**`, concise script documentation. |
| Acceptance criteria | Only `aiur-team/khala`; normal dispatch + `acceptance`; one host-serialized run; supported authenticated store read; retained control handle; bounded time/cost; distinct sessions and observed handshake; actual route identity is proven or reported `unproven`; idempotent ownership-checked cleanup. |
| Tests | Fake GitHub/log/store/receipt/process adapters; concurrent starts on one host allow exactly one pair and process death releases the lock; raw concurrent SQLite access is rejected; timeout/partial cleanup; mismatch refusal. **Wrong implementation must fail:** successful logs and timed sends pass despite missing read/ack evidence. |
| Blocked by | `internal-launcher`, `local-web-entry`, `listening-mode-pull`, `stop-control`, RD4b, RD8. |
| Conflict risk | Low with product packages; medium with test scripts/fixtures. Keep profiles declarative. |

### AC4 — Claude and Codex live profile

| Field | Contract |
|---|---|
| Title | Run Claude and Codex live acceptance |
| Slug | `claude-codex-live-acceptance` |
| Complexity | `complexity:2` |
| Scope | Add the profile, fixed prompts, exact version checks, and authorized manual run using AC3. |
| Out of scope | OpenCode/DeepSeek, product/API changes, another runner. |
| Files/packages | Profile/fixtures under `scripts/acceptance/**`; consume Aiur logs and Khala store. |
| Acceptance criteria | Distinct requested harnesses receive human grants, complete the three-event handshake, and clean up; an existing durable Aiur projection proves actual route identities or the run is `unproven`; versions/results omit transcript content. |
| Tests | Offline profile tests plus opt-in live run. **Wrong implementation must fail:** both complete but only A authors a channel event. |
| Blocked by | `live-acceptance-runner`, RR3, RR4, `mcp-piggyback-evidence`. |
| Conflict risk | Medium with Claude receipt work; consume RR4 without redefining it. |

### AC5 — OpenCode and DeepSeek live profile

| Field | Contract |
|---|---|
| Title | Run OpenCode and DeepSeek live acceptance |
| Slug | `opencode-deepseek-live-acceptance` |
| Complexity | `complexity:2` |
| Scope | After the pairing decision, add its declarative profile and authorized run. Verify OpenCode and selected DeepSeek provider/model independently. |
| Out of scope | Choosing the pairing, direct-DeepSeek substitution, bridge implementation, runner changes. |
| Files/packages | One profile and fixtures under `scripts/acceptance/**`. |
| Acceptance criteria | Resolved pairing named; distinct requested sessions exchange markers; unavailable is `unproven`; no fallback; AC3 cleanup. |
| Tests | Identity, unsupported refusal, cleanup injection, opt-in live. **Wrong implementation must fail:** direct DeepSeek is accepted without the approved OpenCode route. |
| Blocked by | `live-acceptance-runner`, `opencode-server-auth-proof`, RR5. The scope remains inactive until the operator pairing decision recorded above. |
| Conflict risk | High until route/pairing settle; then low because only a profile and fixtures are added. |

Recommended order: dependency slugs first, then `internal-protocol-acceptance` → `internal-browser-acceptance`; independently `live-acceptance-runner` → `claude-codex-live-acceptance`, followed by `opencode-deepseek-live-acceptance` after its operator decision.
