# Security boundary acceptance (KHA-138)

Scoped, reproducible evidence for the encryption and approval boundaries of the merged KHA-134/135/136/137 system. This is not a blanket security certification. Each row below says what was observed, on what composition, and what is still missing. A row is **pass** only for the paths and encodings the named tests exercise.

Recorded 2026-09-26 on Linux 7.1.4-arch1-1 x86_64, Node 24.18.0, pnpm 10.34.5, Vitest 5.0.1, from this branch merged with base `89dad01`. CI runs the same suite on Node 22.23.2. Codex adapter `khala-hosted-queue-1` against the package's fake app-server at Codex 0.154.0.

## Commands

| Command | Result |
| --- | --- |
| `pnpm test:e2e -- tests/e2e/security/` | 45 passed, 1 expected fail (known defect #380), 3 live cases skipped |
| `pnpm test:e2e -- tests/e2e/security/security.test.ts` | 3 live entries, one per row, skipped: live mode off |
| `KHALA_E2E_LIVE=1 KHALA_E2E_DISPOSABLE_ENV=<id> pnpm test:e2e -- tests/e2e/security/security.test.ts` | **fails**: every live entry is blocked, and an all-skipped live entry is not acceptance |

## What "local composition" means here

No production entry point composes the hosted connector yet: nothing outside tests calls `createConnectorRuntime` (see the KHA-136 README). The encrypted relay (Synapse, via `matrix-js-sdk`) is reached only from the human browser flow (KHA-132: `apps/web/src/composition/human/matrix-browser.ts` and its control session issuer). No connector or agent path reaches it. So the suite drives two real compositions in-process, and the shipped `khala internal` runtime as its own process:

- **Internal mode.** This is the real SQLite channel store, loopback channel server and release feed (`apps/internal`). The agent CLI, MCP server, inbox and delivery (`@aiur/khala`) are composed as `cli/main.ts` composes them. Only the clock and IDs are fixed.
- **Claude sessions (internal mode).** `claude-session.test.ts` starts `khala internal` in a child process with the launcher's fixture web bundle, as `apps/internal`'s own process test does. Claude sessions reach it through the client `cli/main.ts` composes: `khala mcp-serve` with `KHALA_MCP_HARNESS=claude`, and `khala claude <op>`. A session binds only through its own access request and the owner's approval in the owner's UI.
- **Hosted review gate.** This is the KHA-115 ledger, KHA-119 release policy, KHA-134 review handler and registration, KHA-121 dispatcher and KHA-118 Codex adapter. The model session is the Codex package's fake app-server, and every call the adapter makes to it is recorded. The protected human transport is a stand-in that hands the handler an authenticated `OwnerAuthority`. The session port overlays a proven `sync` listening mode on the adapter's capabilities, because the fake cannot prove a user-owned Codex mode.

Neither composition is live evidence. The KHA-132 live Playwright suite (`tests/integration/human`) checks that raw room events fetched through the client API are `m.room.encrypted` and hold no message canary; no recorded run of it was found in `docs/`, and it inspects no server database or log. The crypto experiments in `headless-crypto.md` and `headless-verification.md` ran against real Synapse, but they are feasibility evidence, not proof about this merged system.

## Canaries

Each case seeds fresh random canaries: `pending` (unreleased) and `approved` (released). The scanner looks for the canary's random core as UTF-8, UTF-16LE, hex (both cases), and base64 and base64url at every byte alignment. It scans surface output, logs (including the `khala internal` process's stdout and stderr), and every file under the relevant state directories, SQLite databases and WAL included. Failure reports name the canary label, encoding and surface, never the content. `inventory.test.ts` checks that the scanner detects a deliberate leak in every encoding. `airlock.test.ts` checks that a canary posted where the agent may read it is reported on the same probes. Absence supports only these paths and encodings; it does not rule out other encodings, compression, or compromised endpoint code.

## Matrix

| Boundary | Positive control | Negative / race evidence | Result |
| --- | --- | --- | --- |
| Relay confidentiality | none in this suite | Configuration only: browser rooms are created with Megolm and Rust crypto. Internal mode: server logs and error responses never carry a body (`relay.test.ts`). Hosted connector: pending plaintext exists only in the owner-local ledger, which is a trusted endpoint (KTD3). | **not observed** for relay records, relay logs and key material: this needs a disposable Synapse with database and log access. `relay.test.ts` fails if a new relay path appears. |
| Review gate | The owner approves one event; it reaches the existing Codex session once (`forgery.test.ts` control, `airlock.test.ts` dispatcher-gate) | The pending neighbour is absent from every app-server call and notify hint. Unreleased channel content is absent from every inventoried agent surface (below). | **pass** (local composition); live existing-session receipt **not observed** |
| Human authority | Owner approval accepted | Peer owner approval `forbidden`; peer preview `forbidden`; authority fields in the body (`ownerId`, `authority`, `approved`) refused; cross-room reference and cross-room command `forbidden`; tampered digest `stale_content`; unknown event `expired_content`; replayed command with a wider selection `idempotency_conflict`; no discovered MCP tool, OpenCode tool, CLI command or `claude` op is named to approve, release, review or change trust or pause (`forgery.test.ts`) | **pass** (local composition) |
| Recipient binding | Current generation releases | Rebind after approval and before dispatch: nothing reaches the replacement session, nor the original session still running with the old binding, and a later approval answers `unavailable` (`restart.test.ts`). Internal mode: revoked and superseded generations get 401 on the timeline, releases, channel and binding routes, and `read` and MCP `khala_read` return nothing new (`revocation.test.ts`). | **pass** (local composition) |
| Policy | Approved release delivered once after resume, with no new approval | A pause committed after approval holds the release (`queued`, never claimed) across a restart (`restart.test.ts`). Hosted `auto` refusal is covered by KHA-135's own tests, not repeated here. | **pass** for pause and resume across restart (local composition); unacknowledged re-arm reconnect **not observed** |
| Recovery / revocation | A ledger copied after a lost reply and restored keeps the release `outcome_unknown` with no resubmission | Damaged release bytes block dispatch (`payload_damaged`) and nothing else is sent. A revoked hosted binding cannot be approved (`forbidden`), previewed (`revoked`) or dispatched to, even for an earlier approval, and recovery reports `binding_revoked` (`recovery.test.ts`, `revocation.test.ts`). A backup taken before dispatch and restored after delivery holds no evidence of the send, so the approved release is offered to the session a second time (`recovery.test.ts`, recorded as observed). | **pass** for confidentiality (local composition); messaging key loss and approved key restore **not observed** (browser relay only) |
| Delivery ambiguity | A lost reply after the write is reconciled from the session's native queue to `accepted`, observed once (`restart.test.ts`) | Once the session has consumed the entry, the release stays `outcome_unknown` and is never resubmitted (`restart.test.ts`). **But** the KHA-136 recovery view reports that release as undispatched with no unknown outcome (#380). | **fail**: owner-facing recovery status is wrong (#380); no resubmission observed |

A failed row blocks acceptance. Rows marked not observed are gaps, not passes.

## Model-facing surface inventory

`inventory.ts` discovers surfaces from the built code: the default and Claude MCP registries, the OpenCode plugin tools, `CLI_COMMANDS`, `CLAUDE_COMMAND_OPS`, the Claude plugin, Codex and Codex-app hook events, the internal server route table, the internal discovery routes, the hosted control route manifest, and the harness adapters in the `@khala/harnesses` export map. `inventory.test.ts` fails when a registered surface is missing from the checked inventory, or when a listed surface is no longer registered.

| Surfaces | Coverage |
| --- | --- |
| 10 default MCP tools and `khala mcp-serve` | Probed in one session. Every inbox-surface tool result carried the approved batch (positive control, asserted per tool); `khala_pair` is not an inbox surface and carries none. None carried the pending canary. |
| 14 agent CLI commands, 4 Codex hook events | Probed as installed. Only `listen` and `read` return content. Codex hooks returned no output in this composition, so their silence is weak evidence. |
| 17 internal server routes | Probed with the agent's binding and without credentials. The pending channel returns 403; traversal and encoded variants, sent unnormalized, return 400/403/404; the hint stream opens (`event: ready`) and stays content-free while new messages arrive. Session exchange with a binding bearer returns 401; channel creation, the owner-only receipts route and the human-only binding Stop route return 403. Stop is mounted as the launcher composes it, and a refused Stop leaves the agent's own read working. Discovery fails on any server route registration it cannot account for. The four app-shell document routes (channel, settings, channel requests) mount only with a built asset manifest. The tested composition has none, so they answer 404. The static shell they would serve is **not observed**. |
| Codex harness adapter | Driven through the review gate over its fake app-server. |
| 5 other harness adapters, 2 OpenCode tools | **Not observed**. The dispatcher hands every adapter the same approved job, and `@khala/harnesses` depends only on `@khala/contracts` (checked), but these adapters' own behaviour was not driven. The shipped OpenCode entry composes no transport. |
| 8 Claude MCP tools, 7 `khala claude` ops, the Claude session route | Driven against the `khala internal` process for a granted session and an unbound bystander in the same installation. Neither canary appears on any output or in the launcher's own output. The session route refuses the owner's browser session (403) and a forged bearer (401). The bystander is refused `session_not_bound` everywhere, and its sends reach no channel. The granted session is real: its sends reach its own channel and not the other one. Every `pull` and `read` refuses `unproven`, and `hook`, `mode` and `status` refuse `unavailable`. #382 composes no Claude acknowledgement route and no internal listening-mode store, so no message body reaches a Claude session in this build. The suite asserts these refusals exactly. The approved-content positive control and the Claude release path are therefore **not observed**, and the test fails once reads are enabled. |
| 4 Claude plugin hooks, 2 Codex-app hooks | **Not observed**: no Claude or Codex app session could be started here. The Claude hooks render `khala claude` output, which is covered above. |
| `khala setup`, `khala remove` | **Not observed**. They install or remove harness configuration from the packaged payload and read no channel state. The test composition has no payload, so neither command was driven. |
| 17 internal discovery routes, 31 hosted control routes | Human routes are human-only. Agent routes **not observed**: discovery was not mounted, and control carries no message bodies in any wired flow. |

The frozen Claude plugin contract (`FROZEN_MCP_TOOLS`) omits the registered `khala_pair`. That is contract drift, not a leak. `inventory.test.ts` also fails if the contract names a tool that no registry serves.

## Documented non-guarantees

- Internal mode is a single-machine mode with no relay, no end-to-end encryption and no review step. It keeps message plaintext in the host's channel store (`relay.test.ts` asserts this, so the note stays true). Any process running as the same OS user can read it.
- The same applies to the owner connector's ledger: an unrestricted agent on the same host as the same user is outside the connector-gate guarantee.
- In internal mode, pause holds delivery only. A bound agent can still read its own channel's timeline route.
- An inference provider receives approved content once it is released; transport encryption does not hide it from the model service.
- Revocation cleanup is local. It does not recall content already released to a model.
- Restoring a ledger backup older than a delivery can deliver that approved release again. Codex reconciliation finds it only while it is still queued.

## Findings returned to owners

- #380 (KHA-136): `recoverConnectorStorage` reads dispatch evidence only from `receipts`, while the dispatcher keeps its receipts in `dispatch_records`. The composed recovery view therefore misreports a release written to the session. Reproduced by the `it.fails` case in `recovery.test.ts`.
