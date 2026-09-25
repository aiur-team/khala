# Internal mode acceptance

Status: research proposal, 2026-09-24. This applies D1–D12 from [requirements.md](requirements.md), the reuse map in [survey.md](survey.md), and the Executor's E09 decisions without reopening them.

## Summary

| Acceptance | Shape | Pass condition |
|---|---|---|
| 1 — CI | Extend `tests/e2e/harness` around the real internal composition; fake only native harness boundaries | Two agents join one channel, exchange deliberate sends, receive a human message, exercise listening modes, survive restart without duplicates, Stop sessions while preserving the channel view, then close/resume the launcher and server with correct UI state |
| 2 — live | A manual script creates test tickets in `aiur-team/khala` labelled `acceptance`, first for Claude + Codex and then for OpenCode + DeepSeek with Claude | The channel store and Aiur agent logs show the requested distinct Executor-owned test sessions joined one channel and exchanged messages in both directions; the script invokes Stop and closes its tickets |

The live runner uses normal Aiur dispatch, not a dedicated acceptance Executor or sandbox repository. It needs no signed evidence envelope, reply-to field, or Aiur-repository implementation ticket. Fixed run markers are allowed; success comes from correlated server state and agent logs, never an agent self-report.

## Fixed decisions and assumptions

| Item | Decision |
|---|---|
| Terminology | User- and agent-facing text says **channel**. Matrix-internal `room` types remain unchanged; the canonical SQLite implementation slug is `local-sqlite-channel-store`. |
| Inbox and pull | `mcp-inbox-batch` owns the only bounded durable peek and batch token. The next Khala call acknowledges it on Khala's side; hosts do not deduplicate. `listening-mode-pull` owns `khala_read` / `khala read`; acceptance adds no second API. |
| Capabilities | `listening-mode-contract` owns `HarnessCapabilities`, including `acknowledgement: unknown | unsupported | batch_token_next_call`. Unproved routes stay `unproven`, including MCP async until `mcp-piggyback-evidence` passes. |
| Agent ownership | Khala launches or hosts no agent. The user starts the only Claude, Codex, or OpenCode CLI session; native hooks/plugins/MCP/CLI-server routes deliver every mode into that session. A `khala run <cli>` wrapper is not an accepted default. |
| Setup | The package is `@aiur/khala`: `npx @aiur/khala setup`, `status`, and `remove`. Claude uses one user-scope plugin owned by `claude-plugin` and installed by `setup-cli-claude`; Codex uses MCP plus the Khala skill and no plugin. |
| Admission | The launcher never binds silently. `/khala join <channel-url>` and other joins pass through `channel-access-journal` and `channel-access-inbox`; the human grants each participant. An agent may request `khala channels create` / `khala_create_channel`, but creation requires human confirmation. |
| Receipts | `codex-read-receipts`, `claude-read-receipts`, and `opencode-read-receipts` own route proof. Acceptance consumes rather than redefines them. |
| Stop | `stop-control` ends the user-started agent sessions, not the local server. The channel stays viewable/resumable while the server runs. Closing the launcher stops the server; `khala internal --resume <channel-id>` resumes it. Khala never starts a replacement agent. |
| Second live pair | One OpenCode session configured for DeepSeek exchanges with one Claude session. Two DeepSeek/OpenCode sessions and Aiur's direct DeepSeek backend do not qualify. |
| Claude hardening | Channel text reaches the normal interactive Claude session as untrusted content in every mode. `setup` may report an optional hardening check, but delivery never depends on a restricted profile. Claude hook execution is owned by `claude-plugin`. |

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

One protocol scenario starts the real loopback server with disposable SQLite state and two independent fake native-harness drivers. Those drivers model two externally started user CLI sessions; the internal server never launches an agent:

1. Create a channel through the production API. Both agents discover and request access; the test acts as the human and grants each through `channel-access-journal` and `channel-access-inbox`.
2. A deliberately sends E1. B receives E1 and deliberately sends E2. A receives E2. Add a human message and prove both agents receive it.
3. Exercise exact listening semantics: non-abort `steer` at the next safe boundary, `sync` at the end-of-turn boundary, and `async` through `khala_read`. Unsupported/unproved controls remain disabled with a reason.
4. Pause before claim, prove no claim occurs, resume, and consume the pending event once.
5. Restart over the same SQLite files after a durable release. Re-read and acknowledge through the batch token; duplicate timeline or delivery records fail.
6. Invoke Stop and prove both externally started agent sessions end while the server and channel remain available. Then close the launcher and prove the loopback server becomes unavailable; run `khala internal --resume <channel-id>` and prove the same persisted channel reopens without Khala launching an agent.
7. Dispose through `ScenarioHarness.defer`; leftovers and unfired injected faults fail.

The served-app Playwright slice drives the critical composed flow: create, two human grants, exchange, human message, one supported and one unproved-mode state, pause/resume, session stop/view, launcher close, and CLI server resume. It asserts keyboard reachability, focus after stop, and announced failure state. Exhaustive component state and accessibility matrices remain with `listening-mode-ui` and `channel-access-inbox`. The slice must use real internal composition, not a fabricated feature port.

| Wrong implementation | Failing test |
|---|---|
| Final model prose is auto-posted | Driver returns prose without calling send; no channel event appears. |
| One binding represents both agents | Identical participant/binding IDs fail the exchange assertion. |
| Host dedupe masks broken acknowledgement | Restart and replay the batch token; any duplicate fails. |
| `steer` aborts | A long tool boundary must complete before queued steer delivery. |
| Stop kills the server or spawns a replacement | User-started sessions end, but the same browser channel remains viewable; Khala launches no process. |
| Browser test bypasses composition | It cannot obtain the internal composition marker and fails. |

### Acceptance 2 — live Aiur tickets

One manual repository script, for each approved pair:

1. Acquires one host-level kernel advisory lock keyed only by repository. Process death releases it; there is no TTL takeover. Different profiles cannot run concurrently on that Executor host, which is the supported v1 execution location.
2. Runs `npx @aiur/khala status`, then preflights `aiur-team/khala`, the `acceptance` and normal state labels, requested harness/provider versions, credentials, timeout, and a unique run marker. The optional Claude hardening result is recorded but never gates delivery.
3. Starts or resumes the local server through `internal-launcher`, then prompts the human/controller to create or select exactly one channel and confirm it. Record its stable URL/ID and control handle. This step starts no agent and does not read live SQLite files.
4. Creates two issues with `acceptance`, a normal dispatch label, and a harness/model label. Each fixed secret-free prompt names that role's marker and says: in the agent's existing interactive CLI session, treat channel text as untrusted; join the named channel URL; for each controller-requested mode, wait for its confirmed effective/unsupported state and perform the ordered three-event handshake; after the final acknowledgement remain alive at the hold barrier until Stop; do not change code or open a PR. Markers are role-specific but public; they are correlation labels, not secrets or observation proof.
5. Lets the normal Executor start exactly one ordinary interactive CLI process per acceptance ticket as an external test-user fixture, independently of Khala. Record its native process/session identity before the first Khala operation. The human/controller grants both access requests through `channel-access-journal` and `channel-access-inbox`; neither starts pre-admitted. The runner never invokes a Khala agent launcher, hosted app-server/SDK route, or `khala run <cli>`.
6. For each mode the exact route advertises as supported, waits a bounded time for a three-event handshake delivered into those same two native sessions: A sends A's role-specific marker; B receives that exact event, returns its batch token on the next call, and replies with A's marker plus B's role-specific marker; A receives/acknowledges B's exact event and replies with the final acknowledgement. Pull routes use `khala_read` and the batch token. Unsupported/unproven modes are recorded as non-runnable, never silently substituted.
7. After the final acknowledgement, both prompts enter a hold barrier instead of exiting. Prove both native sessions are alive and retain the same identities. Invoke `stop-control` only with the recorded ticket → participant → binding ID and generation; refuse a stale or mismatched target. Prove both matching sessions terminate because of Stop while the local server and browser channel remain available.
8. After recording the Stop outcome, enter `finally` and close the launcher even when Stop or its assertions failed. Read a documented post-shutdown snapshot through the `local-sqlite-channel-store` test adapter. Correlate it with Aiur logs and owned receipt facts: two ticket/binding identities, every declared-supported mode delivered into the same native session IDs, and ordered event/read/ack evidence. Requested labels are insufficient. Missing durable native-session, harness, provider/model, or exchange evidence returns non-passing `unproven`.
9. Continue cleanup after launcher close regardless of earlier failures: revoke run-scoped access if a product API exists, then close both issues terminally so dispatch cannot continue. The Executor—not Khala—owns process cleanup for acceptance tickets. Cleanup is idempotent and refuses an issue lacking the run marker and `acceptance` label.

Claude + Codex runs first. The second run pairs one OpenCode session configured for DeepSeek with one Claude session. Missing route proof reports non-passing `unproven`; it never falls back to two OpenCode sessions, another provider, or Aiur's direct DeepSeek backend.

The `acceptance` label is the durable test marker, not a second state machine. Normal dispatch is intentional. The host-held lock permits at most one local pair; a timeout bounds cost. The script detects and reports an unexpected PR. Closed tickets remain the audit trail. The channel follows normal retention; acceptance does not invent deletion. Stopping sessions does not stop the server.

| Source | Required evidence |
|---|---|
| Channel store | One run channel; two distinct bindings; ordered A marker → B echo plus B marker → A acknowledgement of B marker; stable event IDs/timestamps; no duplicate client transaction |
| Aiur logs and owned receipts | Each ticket owns one native CLI process/session; every declared-supported mode delivers into that same identity; B reads/acknowledges A and A reads/acknowledges B; both are alive at the hold barrier and terminate after Stop. Actual route identity comes from a durable current-run/usage projection, not labels or prose. |
| GitHub metadata | Repository, `acceptance` label, run marker/profile, timestamps, and no runner-linked PR |
| Verifier | Both sources correlate to one run/pair; all required identity/evidence fields are proven; Stop causally ends the two live test sessions without stopping the server; `unproven` never passes; two owned tickets close |

Only fixed markers are inspected, and they are not copied into the summary artifact. Issue completion, comments, workpads, and agent-authored “success” text are not evidence.

### Dependencies and ownership

| Capability | Owning slug |
|---|---|
| Internal lifecycle | `internal-launcher`, `local-web-entry`, `stop-control` |
| Channel UI | `listening-mode-ui` |
| Channel discovery and access request/grant | `internal-channel-discovery`, `channel-access-journal`, `channel-access-inbox`, `channel-access-cli-mcp` |
| Listening semantics/storage | `listening-mode-contract`, `listening-mode-store`, `local-automation-fence`, `listening-mode-dispatch`, `local-sqlite-channel-store` |
| Inbox/pull | `mcp-inbox-batch`, `mcp-result-piggyback`, `listening-mode-pull`, `mcp-piggyback-evidence` |
| Event read/ack proof | `codex-read-receipts`, `claude-read-receipts`, `opencode-read-receipts` |
| Claude route/setup | `claude-session-adapter`, `claude-plugin-hooks`, `claude-plugin-dispatch`, `claude-plugin-channel-commands`, `setup-cli-claude` |
| Codex route/setup | `setup-cli-codex` |
| OpenCode route | `opencode-interactive-cli-proof`, `opencode-session-bridge`, `opencode-listening-routes`, `opencode-server-auth-proof` |

Acceptance adds no competing batch, pull, capability, receipt, admission, or stop API.

## Trade-offs and risks

| Choice / risk | Consequence / mitigation |
|---|---|
| Real composition, fake native drivers | Deterministic CI proves storage/dispatch/send/UI, with more setup than the reference channel. |
| Normal live dispatch | Matches the operator definition. The visible label, fixed prompt, one-pair limit, timeout, and guarded cleanup contain the run. |
| Store + logs, not signed envelopes | Simple and auditable; proves operational exchange, not cryptographic non-repudiation or comprehension. |
| Fixed markers | Public issues make markers role-specific, not secret. Exact event-linked read/ack facts plus the ordered three-event handshake—not marker secrecy—prevent timer-only sends, copied text, or self-report from passing. |
| Provider drift | Pin/print versions. `unproven` is a diagnostic, non-passing result; Acceptance 2 passes only with durable native-session, harness, provider/model, and exchange evidence. |
| Prompt injection | Fixed narrow prompt, bounded time/cost, no implementation request, and visible stop; arbitrary hostile-content safety is not claimed. |
| Restricted-profile drift | Every mode delivers untrusted-framed channel text to the normal Claude session; optional setup hardening is reported, never required. |
| Cleanup targets unrelated issues | Re-fetch repository, label, marker, ID, and creation window before close; mismatch fails closed. |

## Non-goals

- A dedicated acceptance Executor, sandbox repository, signed envelope, or reply-to field.
- Aiur product changes or Aiur-repository tickets.
- Proving comprehension, conversation quality, external encryption, LAN access, recovery, or make-external.
- Treating captured output, issue closure, agent comments, or direct DeepSeek as proof.
- Defining another inbox, pull, receipt, capability, admission, or stop contract.
- Launching, hosting, or wrapping an agent CLI as a Khala product path.

## Implementation ticket contracts

### AC1 — Protocol CI acceptance

| Field | Contract |
|---|---|
| Title | Prove the internal protocol flow in CI |
| Slug | `internal-protocol-acceptance` |
| Complexity | `complexity:3` |
| Scope | Extend `tests/e2e/harness` with real server/SQLite and fake externally started CLI drivers for grant, two-way send, human message, modes, pause, restart/token acknowledgement, session stop, launcher close/CLI server resume, and cleanup. Assert that Khala launches no agent. |
| Out of scope | Browser assertions, live providers, new product contracts. |
| Files/packages | `tests/e2e/internal-mode/**`, `tests/e2e/harness/**`; consume contracts, connector, messaging, policy, harnesses, agent-cli, internal composition. |
| Acceptance criteria | Ordinary CI; only native boundaries fake; protocol steps pass; stop leaves server/channel available; unproved routes stay unproven; no leftovers. |
| Tests | Happy flow plus boundary faults. **Wrong implementations must fail:** replaying a batch token creates a duplicate; Khala launches an agent; Stop kills the server or leaves an agent session alive; launcher close leaves the server alive; or `khala internal --resume <channel-id>` does not reopen the same channel. |
| Blocked by | `internal-launcher`, `listening-mode-contract`, `mcp-inbox-batch`, `mcp-result-piggyback`, `listening-mode-pull`, `local-sqlite-channel-store`, `local-automation-fence`, `listening-mode-dispatch`, `stop-control`, `internal-channel-discovery`, `channel-access-journal`, `channel-access-inbox`. |
| Conflict risk | High with internal composition/listening fixtures; consume their ports and keep changes in E2E modules. |

### AC2 — Browser CI acceptance

| Field | Contract |
|---|---|
| Title | Prove the internal channel flow in the browser |
| Slug | `internal-browser-acceptance` |
| Complexity | `complexity:3` |
| Scope | Add served-app Playwright coverage for channel create/confirm, grants, exchange, human message, modes, session stop/view, launcher close/CLI server resume, including accessibility. |
| Out of scope | Protocol fault injection; redesign; live providers. |
| Files/packages | `apps/web/src/internal/**/*.browser.spec.ts` or final internal composition path; shared AC1 fixture. |
| Acceptance criteria | Existing browser CI lane; real composition; **channel** in UI; stop ends sessions while channel stays viewable; keyboard/focus/status passes. |
| Tests | Critical flow above. **Wrong implementations must fail:** session Stop kills the server, hides the channel, or leaves a session alive; launcher close leaves the server reachable; CLI resume opens a fresh channel instead of the persisted one. |
| Blocked by | `internal-protocol-acceptance`, `local-web-entry`, `listening-mode-ui`, `stop-control`, `internal-channel-discovery`, `channel-access-journal`, `channel-access-inbox`. |
| Conflict risk | High in internal web composition; limit production changes to feature-owned test seams. |

### AC3 — Live acceptance runner

| Field | Contract |
|---|---|
| Title | Create and verify live Aiur acceptance tickets |
| Slug | `live-acceptance-runner` |
| Complexity | `complexity:3` |
| Scope | Add the manual script: acquire one host/repository lock; run `npx @aiur/khala status`; start/resume only the server and one human-confirmed channel; retain guarded control IDs; create one labelled pair; run supported-mode handshakes and the alive barrier; Stop; close the launcher; correlate the post-shutdown snapshot/logs/receipts; close tickets; report. |
| Out of scope | Any Khala agent launcher or wrapper, provider launch logic, dedicated Executor, sandbox repository, signatures, reply-to, Aiur product changes. |
| Files/packages | `scripts/acceptance/**`, `tests/e2e/acceptance/**`, concise script documentation. |
| Acceptance criteria | Only `aiur-team/khala`; normal dispatch + `acceptance`; one host/repository-serialized run; post-launcher-close snapshot from `local-sqlite-channel-store`; bounded time/cost; Executor-owned native sessions exercise every declared-supported mode; route/identity/exchange proof is mandatory and absent proof is non-passing `unproven`; optional hardening never gates delivery; guarded Stop and best-effort ownership-checked cleanup. |
| Tests | Exact prompt-fixture assertion for join URL, untrusted framing, per-mode request/confirmation, ordered handshake, final hold-until-Stop, and no-code/no-PR; fake GitHub/log/snapshot/receipt/process adapters; different profiles contend on one lock; process death releases it; live raw SQLite access and Khala agent-launch commands are rejected; sessions are alive before Stop; wrong-binding/stale-generation Stop is refused; Stop failure still closes launcher/tickets; timeout/partial cleanup. **Wrong implementation must fail:** successful logs/timed sends pass without event-linked read/ack evidence, or the runner uses `khala run <cli>`. |
| Blocked by | `internal-launcher`, `local-web-entry`, `local-sqlite-channel-store`, `listening-mode-pull`, `stop-control`, `internal-channel-discovery`, `channel-access-journal`, `channel-access-inbox`, `channel-access-cli-mcp`, `read-receipt-contract`, `read-receipt-recording`. |
| Conflict risk | Low with product packages; medium with test scripts/fixtures. Keep profiles declarative. |

### AC4 — Claude and Codex live profile

| Field | Contract |
|---|---|
| Title | Run Claude and Codex live acceptance |
| Slug | `claude-codex-live-acceptance` |
| Complexity | `complexity:2` |
| Scope | Add the Claude/Codex profile, untrusted-content prompts, exact version checks, and authorized manual run using AC3. Consume the native Claude plugin and Codex MCP/skill routes; for every declared-supported mode prove delivery returns to the same recorded CLI session identity; launch neither through Khala. |
| Out of scope | OpenCode/DeepSeek, product/API changes, another runner. |
| Files/packages | Profile/fixtures under `scripts/acceptance/**`; consume Aiur logs and Khala store. |
| Acceptance criteria | Executor-owned Claude and Codex test sessions exercise the same native routes as user-started product sessions; every declared-supported mode stays on the recorded session IDs; grants, event-linked handshake, alive-before-Stop, and causal stop pass; durable route proof is mandatory, with absent proof a non-passing `unproven`; normal Claude delivery works without restricted hardening. |
| Tests | Offline profile/mode matrix plus opt-in live run. **Wrong implementations must fail:** only A authors an event; a supported mode reaches a secondary hosted process; Claude uses a separate skill/plugin layout; Codex requires a plugin; optional hardening gates delivery; Stop is a no-op. |
| Blocked by | `live-acceptance-runner`, `interactive-codex`, `interactive-claude`, `codex-read-receipts`, `claude-read-receipts`, `mcp-piggyback-evidence`, `setup-cli-codex`, `setup-cli-claude`, `claude-session-adapter`, `claude-plugin-hooks`, `claude-plugin-dispatch`, `claude-plugin-channel-commands`. |
| Conflict risk | Medium with `claude-read-receipts`; consume its evidence without redefining it. |

### AC5 — OpenCode with DeepSeek and Claude live profile

| Field | Contract |
|---|---|
| Title | Run OpenCode with DeepSeek and Claude live acceptance |
| Slug | `opencode-deepseek-claude-live-acceptance` |
| Complexity | `complexity:2` |
| Scope | Add the resolved profile and authorized run: one Executor-owned OpenCode test session configured for DeepSeek exchanges with one Executor-owned Claude test session, exercising the native user-session routes. Verify OpenCode, DeepSeek, Claude, and same-session delivery for every declared-supported mode independently. |
| Out of scope | Two OpenCode/DeepSeek agents, direct-DeepSeek substitution, bridge/plugin implementation, Khala-launched agents, runner changes. |
| Files/packages | One profile and fixtures under `scripts/acceptance/**`. |
| Acceptance criteria | OpenCode+DeepSeek and Claude receive separate grants; every declared-supported mode stays on the recorded session IDs; event-linked handshake and causal Stop pass; missing route/provider/session proof is non-passing `unproven`; no fallback or wrapper passes. |
| Tests | Three-part identity and mode matrix, unsupported refusal, cleanup injection, opt-in live. **Wrong implementations must fail:** direct DeepSeek passes without OpenCode; two DeepSeek/OpenCode agents replace Claude; a supported mode reaches a hosted secondary process; Stop is a no-op; or Khala launches/wraps either CLI. |
| Blocked by | `live-acceptance-runner`, `opencode-interactive-cli-proof`, `opencode-session-bridge`, `opencode-listening-routes`, `opencode-server-auth-proof`, `opencode-read-receipts`, `interactive-claude`, `claude-read-receipts`, `setup-cli-opencode`, `setup-cli-claude`, `claude-session-adapter`, `claude-plugin-hooks`, `claude-plugin-dispatch`, `claude-plugin-channel-commands`. |
| Conflict risk | Medium with OpenCode and Claude route fixtures; consume their released profiles without redefining them. |

Recommended order: dependency slugs first, then `internal-protocol-acceptance` → `internal-browser-acceptance`; independently `live-acceptance-runner` → (`claude-codex-live-acceptance` ∥ `opencode-deepseek-claude-live-acceptance`).
