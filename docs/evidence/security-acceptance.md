# Security boundary acceptance (KHA-138)

Scoped, reproducible evidence for the encryption and approval boundaries of the merged KHA-134/135/136/137 system. This is not a blanket security certification. Each row below says what was observed, on what composition, and what is still missing. A row is **pass** only for the paths and encodings the named tests exercise.

Recorded 2026-09-25 on Linux 7.1.4-arch1-1 x86_64, Node 24.18.0, pnpm 10.34.5, Vitest 5.0.1, from branch commit `c6bc1a5` over base `6bc22b5`. CI runs the same suite on Node 22.23.2. Codex adapter `khala-hosted-queue-1` against the package's fake app-server at Codex 0.154.0.

## Commands

| Command | Result |
| --- | --- |
| `pnpm test:e2e -- tests/e2e/security/` | 41 passed, 1 expected fail (known defect #380), 3 live cases skipped |
| `pnpm test:e2e -- tests/e2e/security/security.test.ts` | 3 live cases skipped: live mode off |
| `KHALA_E2E_LIVE=1 KHALA_E2E_DISPOSABLE_ENV=<id> pnpm test:e2e -- tests/e2e/security/security.test.ts` | **fails**: every live case is blocked, and an all-skipped live run is not acceptance |

## What "local composition" means here

No production entry point composes the hosted connector yet: nothing outside tests calls `createConnectorRuntime` (see the KHA-136 README). No encrypted relay adapter is wired either, since `packages/messaging` has no relay SDK. So the suite drives two real compositions in-process:

- **Internal mode.** This is the real SQLite channel store, loopback channel server and release feed (`apps/internal`). The agent CLI, MCP server, inbox and delivery (`@aiur/khala`) are composed as `cli/main.ts` composes them. Only the clock and IDs are fixed.
- **Hosted review gate.** This is the KHA-115 ledger, KHA-119 release policy, KHA-134 review handler and registration, KHA-121 dispatcher and KHA-118 Codex adapter. The model session is the Codex package's fake app-server, and every call the adapter makes to it is recorded. The protected human transport is a stand-in that hands the handler an authenticated `OwnerAuthority`. The session port overlays a proven `sync` listening mode on the adapter's capabilities, because the fake cannot prove a user-owned Codex mode.

Neither composition is live evidence. The existing crypto experiments in `headless-crypto.md` and `headless-verification.md`, run against real Synapse, are feasibility evidence for a future relay. They are not proof about this merged system.

## Canaries

Each case seeds fresh random canaries: `pending` (unreleased) and `approved` (released). The scanner looks for the canary's random core as UTF-8, UTF-16LE, hex (both cases), and base64 and base64url at every byte alignment. It scans surface output, logs, and every file under the relevant state directories, SQLite databases and WAL included. Failure reports name the canary label, encoding and surface, never the content. `inventory.test.ts` checks that the scanner detects a deliberate leak in every encoding. `airlock.test.ts` checks that a canary posted where the agent may read it is reported on the same probes. Absence supports only these paths and encodings; it does not rule out other encodings, compression, or compromised endpoint code.

## Matrix

| Boundary | Positive control | Negative / race evidence | Result |
| --- | --- | --- | --- |
| Relay confidentiality | none: no relay is wired | Internal mode: server logs and error responses never carry a body (`relay.test.ts`). Hosted: pending plaintext exists only in the owner-local ledger, which is a trusted endpoint (KTD3). | **not observed** for relay ciphertext, relay logs and key material; tripwire in `relay.test.ts` fails when a relay SDK appears |
| Review gate | The owner approves one event; it reaches the existing Codex session once (`forgery.test.ts` control, `airlock.test.ts` dispatcher-gate) | The pending neighbour is absent from every app-server call and notify hint. Unreleased channel content is absent from every inventoried agent surface (below). | **pass** (local composition); live existing-session receipt **not observed** |
| Human authority | Owner approval accepted | Peer owner approval `forbidden`; peer preview `forbidden`; authority fields in the body (`ownerId`, `authority`, `approved`) refused; cross-room reference and cross-room command `forbidden`; tampered digest `stale_content`; unknown event `expired_content`; replayed command with a wider selection `idempotency_conflict`; no model tool approves, releases, reviews or changes trust or pause (`forgery.test.ts`) | **pass** (local composition) |
| Recipient binding | Current generation releases | Rebind after approval and before dispatch: nothing reaches the old or the replacement session, and a later approval answers `unavailable` (`restart.test.ts`). Internal mode: revoked and superseded generations get 401 on every agent route and read nothing new (`revocation.test.ts`). | **pass** (local composition) |
| Policy | Approved release delivered once after resume, with no new approval | A pause committed after approval holds the release (`queued`, never claimed) across a restart (`restart.test.ts`). Hosted `auto` refusal is covered by KHA-135's own tests, not repeated here. | **pass** for pause and resume across restart (local composition); unacknowledged re-arm reconnect **not observed** |
| Recovery / revocation | Restored ledger keeps the release held with no resubmission | Damaged release bytes block dispatch (`payload_damaged`) and nothing else is sent. A revoked hosted binding cannot be approved (`forbidden`), previewed (`revoked`) or dispatched to, even for an earlier approval, and recovery reports `binding_revoked` (`recovery.test.ts`, `revocation.test.ts`). | **pass** (local composition); messaging key loss and approved key restore **not observed** (no relay) |
| Delivery ambiguity | A lost reply after the write is reconciled from the session's native queue to `accepted`, observed once (`restart.test.ts`) | Once the session has consumed the entry, the release stays `outcome_unknown` and is never resubmitted (`restart.test.ts`). **But** the KHA-136 recovery view reports that release as undispatched with no unknown outcome (#380). | **fail**: owner-facing recovery status is wrong (#380); no resubmission observed |

A failed row blocks acceptance. Rows marked not observed are gaps, not passes.

## Model-facing surface inventory

`inventory.ts` discovers surfaces from the built code: the default and Claude MCP registries, the OpenCode plugin tools, `CLI_COMMANDS`, `CLAUDE_COMMAND_OPS`, the Claude plugin, Codex and Codex-app hook events, the internal server route table, the internal discovery routes, the hosted control route manifest, and the harness adapters in the `@khala/harnesses` export map. `inventory.test.ts` fails when a registered surface is missing from the checked inventory, or when a listed surface is no longer registered.

| Surfaces | Coverage |
| --- | --- |
| 8 default MCP tools and `khala mcp-serve` | Probed in one session. Every tool result carried the approved batch (positive control) and none carried the pending canary. |
| 14 agent CLI commands, 7 `khala claude` ops, 4 Codex hook events | Probed as installed. Only `listen` and `read` return content. `claude` ops refuse (`invalid_arguments`) because the shipped CLI composes no Claude session. Codex hooks returned no output in this composition, so their silence is weak evidence. |
| 12 internal server routes | Probed with the agent's binding and without credentials. The pending channel returns 403; path-traversal and encoded variants return 403/404; the hint stream is content-free. Session exchange with a binding bearer returns 401; channel creation returns 403. |
| 2 OpenCode tools | Probed as shipped. The transport is unavailable, so they deliver nothing. |
| 6 harness adapters | Covered by the dispatcher gate. `@khala/harnesses` depends only on `@khala/contracts` (checked), so an adapter sees only what the dispatcher passes it. |
| 3 Claude MCP tools, 4 Claude plugin hooks, 2 Codex-app hooks | **Not observed**: no Claude or Codex app session could be started here. |
| 17 internal discovery routes, 31 hosted control routes | Human routes are human-only. Agent routes **not observed**: discovery was not mounted, and control carries no message bodies in any wired flow. |

The frozen Claude plugin contract (`FROZEN_MCP_TOOLS`) names `khala_create_channel`, which no registry serves, and omits the registered `khala_pair`. That is contract drift, not a leak; the inventory records it so that registering the tool forces a coverage decision.

## Documented non-guarantees

- Internal mode is a single-machine mode with no relay, no end-to-end encryption and no review step. It keeps message plaintext in the host's channel store (`relay.test.ts` asserts this, so the note stays true). Any process running as the same OS user can read it.
- The same applies to the owner connector's ledger: an unrestricted agent on the same host as the same user is outside the connector-gate guarantee.
- In internal mode, pause holds delivery only. A bound agent can still read its own channel's timeline route.
- An inference provider receives approved content once it is released; transport encryption does not hide it from the model service.
- Revocation cleanup is local. It does not recall content already released to a model.

## Findings returned to owners

- #380 (KHA-136): `recoverConnectorStorage` reads dispatch evidence only from `receipts`, while the dispatcher keeps its receipts in `dispatch_records`. The composed recovery view therefore misreports a release written to the session. Reproduced by the `it.fails` case in `recovery.test.ts`.
