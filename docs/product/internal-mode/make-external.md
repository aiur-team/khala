# Make external and pairing codes

Status: research and implementation contracts, 2026-09-24.

Source baseline: the fixed D1–D12/I1–I10 brief and reuse survey were read from PR #136 head `6edc181d847354d21eb28bffd4e1b48fd30aec5d`, now merged on `main` as `99bbcb5`. Code evidence was checked at `dba0de0`; the merge added only those source documents, and the later requirements edit did not touch D12 or I9.

## Summary

Make external is a resumable conversion, not an in-place transport switch. It creates a new external room, lets the human choose a read-only imported transcript or an empty timeline, re-invites the exact snapshotted agent sessions, then marks the internal room read-only and links it to the external room only after reconciliation.

A pairing code is a short-lived locator for one pending connector claim. It never admits an agent by possession alone: the human must approve the claimed session, after which the service issues the existing kind of high-entropy, sender-constrained bootstrap grant and normal admission creates the binding.

## Fixed inputs and assumptions

| Item | Contract |
|---|---|
| D12 | The human chooses **carry history** or **start fresh**. This fast follow does not block internal mode. |
| I9 | Pairing codes are short, single-use, time-limited, and serve cross-machine connection or Make external. |
| D11 | Agents never self-admit. A human approval must name every agent granted access. |
| D6/D8 | External rooms keep E2EE; pairing never exposes the loopback-only internal server to LAN or remote traffic. |
| A1 | “Carry history” means a read-only imported transcript with original author labels and timestamps, not forged external events authored by old devices. |
| A2 | One conversion confirmation may approve the displayed snapshot of agents as a batch; any changed, stale, revoked, or unsupported session remains unapproved and visible. |
| A3 | The human signs in to the hosted service when Make external begins. Reusing the current hosted OAuth/session flow from an internal launch is **unproven**. |
| A4 | A conversion may remain incomplete with per-agent retry/skip choices, but it cannot silently replace a failed agent or commit while an agent is unresolved. |

## Findings and evidence

| Finding | Evidence | Confidence |
|---|---|---|
| Admission already distinguishes `history:'none'` and `history:'full'`, binds principal/device/operation, and waits for provider history readiness. | `packages/contracts/src/messaging/admission.ts:10-49`; `apps/control/src/invitations/admit.ts:18-51,105-176,201-207` | proven in module tests |
| Normal invites are not single-use. Their records retain status, expiry, policy, and the latest authorized operation without rejecting a new operation. | `apps/control/src/invitations/policy.ts:17-27`; `apps/control/src/invitations/admit.ts:56-103` | proven by code inspection |
| Link bootstrap treats the link as a locator, verifies the native session before admission, reserves one device, and journals retries. | `packages/connector/src/bootstrap/orchestrator.ts:60-131`; `packages/connector/src/bootstrap/ports.ts:97-151` | proven in module tests |
| The only ownership method is same-machine `loopback-browser-v1`; descriptor endpoints are fixed and same-origin. | `packages/connector/src/bootstrap/descriptor.ts:6-30,41-75`; `packages/connector/src/bootstrap/README.md:19-48` | proven in module tests |
| Bootstrap's existing one-time code and grant live for 60 seconds, are stored hashed, and are atomically consumed. The code is a 43-character, 256-bit token, not a human pairing code. | `apps/control/src/agent-bootstrap/handler.ts:217-286`; `apps/control/src/agent-bootstrap/handler.test.ts:217-226,325-358` | proven in module tests |
| Redeem is sender-constrained and yields only `publish_own`, `receive_released`, and `ack_delivery`; it cannot approve, release, or change policy. | `apps/control/src/agent-bootstrap/handler.ts:289-375`; `packages/connector/src/bootstrap/ports.ts:68-95` | proven in module tests |
| Current room/timeline contracts carry only native text events. They have no import manifest, original-source provenance, or migration checkpoint. | `packages/contracts/src/messaging/events.ts:11-86`; `packages/contracts/src/messaging/rooms.ts:53-64` | proven absent from cited contracts |
| Current bootstrap stores one binding per owner and room and rejects a different session/device. Plural same-agent rebinding during conversion is not established. | `apps/control/src/agent-bootstrap/handler.ts:378-418`; `packages/connector/src/bootstrap/README.md:88-95` | **unproven** end to end |
| Internal SQLite → encrypted external-room transfer, imported-timeline rendering, and hosted conversion sign-in have no local proof. | No implementation is identified by the survey or current source. | **unproven** |

### Local proof run

All commands used Node `22.23.2` and Vitest `5.0.1`.

| Command scope | Result | What it proves |
|---|---:|---|
| `@khala/control`: agent bootstrap + invite admit/share | 3 files, 68 tests passed | Existing one-use token/grant and admission orchestration behave as cited with injected dependencies. |
| `@khala/connector`: bootstrap orchestrator + loopback + discovery | 3 files, 40 tests passed | Same-machine link bootstrap, retries, origin checks, and device reservation work at module level. |
| `@khala/contracts`: messaging ports + fixtures | 2 files, 137 tests passed | Current strict admission and messaging decoders accept only their documented shapes. |

These runs do not prove a provider, browser, Matrix, cross-machine, or history-migration capability.

## Design

### Pairing protocol

| Property | Decision |
|---|---|
| Display form | Ten Crockford Base32 characters, grouped `XXXXX-XXXXX` (50 bits); omit ambiguous characters. |
| Lifetime | Five minutes from trusted server time; no extension. Regeneration creates a new operation. |
| Authority | Locator only. Claiming reserves the pending request to one connector key/session/device; human approval is still mandatory. |
| Storage | Store only a purpose-separated digest. Never place the code in a URL, durable operation record, analytics, or logs. |
| Claim | Atomically move `issued → claimed`. A retry with the same operation/key reconciles; another claimant receives the same non-enumerating refusal as an invalid/expired code. |
| Abuse limit | Before lookup, allow at most five failed claims per network bucket and five per pairing operation in five minutes; then refuse until expiry. Return finite non-enumerating errors. The backing provider is **unproven** and must fail closed. |
| Approval | The signed-in owner sees harness, verified session identity/generation, and target room before approving or denying. |
| Grant | Approval mints a 256-bit, 60-second, DPoP-bound bootstrap grant. Existing redeem/admission rules remain authoritative. |
| Terminal state | Pairing requests end as `approved`, `denied`, or `expired`. The separately minted bootstrap grant becomes `spent` after redeem. Denied or expired attempts require a new code. |

Pairing is a new ownership method, `pairing-code-v1`, beside `loopback-browser-v1`. Code-only pairing takes the canonical hosted origin from trusted connector configuration, fetches a versioned descriptor from that origin's fixed path, and includes the origin and descriptor identity in the operation fingerprint; neither the code nor a response can select or redirect the origin. It does not weaken session inspection, device reservation, operation replay, admission, or adapter-capability scope. For an internal room, the pairing endpoint is hosted and reached outbound during explicit externalization; the local server remains loopback-only.

### Conversion lifecycle

| State | Durable fact | Retry behavior |
|---|---|---|
| `preparing` | Internal room, immutable choice, roster snapshot, source revision, operation ID | Same input resumes; changed choice/room is an operation conflict. |
| `external_created` | One external room ID and owner session | Read back after an ambiguous create; never create a second room. |
| `history_copying` | Manifest digest, chunk count, last acknowledged chunk | Resume at the first unreconciled chunk; start-fresh skips this state. |
| `history_catching_up` | Last copied source revision and bounded delta | Copy deltas while internal writes continue until one bounded final delta remains. |
| `drain_required` | Three catch-up rounds did not reduce the backlog to one maximum-sized chunk | Ask the human to begin finalization; pause internal agents and writes, then drain within the transfer ceiling or return a finite blocked result and resume the internal room. |
| `agents_pending` | Per-agent verified session/generation and `pending/joined/skipped/blocked` outcome | Re-run bootstrap for the same identity; joined destination bindings remain paused and cannot publish or receive. |
| `committing` | Source revision is frozen and final destination state is reconciled | A failure before the authoritative link transaction unfreezes the internal room. |
| `activating` | The internal room is read-only, the authoritative link is committed, and per-binding activation progress is journaled | Resume activation forward; never reopen the internal room after authority has moved. |
| `externalized` | Internal room is read-only and points to the external room | Stable terminal result; internal data remains until explicit deletion. |

The human can cancel before `committing`; the created external room is then reported as an orphan requiring explicit cleanup rather than hidden deletion. Messages may continue internally during preparation. Carry-history attempts at most three catch-up rounds. If one maximum-sized delta remains, finalization takes a short write freeze; otherwise the UI enters `drain_required` and asks the human to pause internal agents and writes for a bounded drain. Failure before link commit resumes the internal room. Link commit atomically marks it read-only and records activation intent; any later failure resumes forward through `activating`. No agent can publish or receive in the destination before that barrier.

### History choices

| Choice | External timeline | Agent delivery |
|---|---|---|
| Start fresh | Empty before the first new external message. The title and exact approved agent roster may carry over. | Each snapshotted session is re-verified and admitted; zero old messages enter pending delivery. |
| Carry history | An encrypted, chunked import whose manifest binds ordered source records, author labels, original timestamps, bodies, and per-record digests. The web timeline renders it as a read-only pre-cutover segment. | Imported records never masquerade as new native events and never enter subscription/delivery or read-receipt pipelines. Re-invited agents can explicitly page through bounded read-only imported context before responding. |

History uses a versioned manifest plus bounded chunks so a lost response can reconcile by manifest/chunk digest. The destination records who performed the import and the source chat's opaque migration ID; it does not claim the old local device cryptographically authored an external event.

### Human journey

| Step | Human-visible state and exit |
|---|---|
| Entry | Make external explains that a new hosted room will be created and the internal room becomes read-only only after success. Cancel changes nothing. |
| Hosted sign-in | A new hosted sign-in opens and returns to the same journaled conversion. Authentication failure leaves the internal room active with retry/cancel. |
| Confirm | Choose history mode, review the exact agent roster, and approve the immutable conversion summary before room creation. |
| Prepare | Show room creation, up to three history catch-up rounds, and each agent's paused destination status. If the backlog stays large, offer a bounded final drain that pauses internal agents and writes. Reload resumes from the journal. |
| Resolve agents | Retry a blocked agent or explicitly skip it; unresolved agents disable final commit. Denying a pairing claim is terminal, mints no grant, and tells the claimant to request a new code. |
| Commit | Announce the write pause; copy the final delta, atomically link and mark the internal room read-only, then activate agents. A pre-link failure unfreezes; a post-link failure shows “finishing activation” and resumes forward without reopening the internal room. |
| Cancel after create | Keep the internal room active and show the orphaned external room identifier with explicit cleanup guidance. |
| Success | Show the external room as authoritative and the retained internal room as read-only, with explicit deletion available separately. |

### Trade-offs

| Decision | Benefit | Cost |
|---|---|---|
| New external room instead of mutating the local room | Preserves hosted E2EE, admission, trust, and provider invariants. | Requires a durable cross-room conversion journal and visible partial states. |
| Imported transcript instead of replaying native messages | Preserves attribution honestly and avoids triggering agents/read receipts on old content. | Timeline contracts and UI need an imported-history shape. |
| Code as locator, not bearer admission | Keeps D11 and existing bootstrap authority intact despite a short secret. | Requires an owner approval rendezvous and hosted state. |
| Batch owner approval for the exact roster snapshot | Makes “same agents” practical without self-admission. | Changed generations or unavailable sessions need explicit per-agent resolution. |
| Keep the internal copy after success | Gives recovery and auditability without a secure-erase claim. | The product must clearly show which room is authoritative. |

## Risks

| Risk | Mitigation / contract |
|---|---|
| Online guessing or code enumeration | 50-bit code, five-minute TTL, five-failure network and operation caps, non-enumerating errors, digest-only storage. Provider remains **unproven** until an integration test exercises it. |
| Pairing code becomes admission authority | Require authenticated approval, verified native session, connector key proof, and normal redeem/admission after the code is claimed. |
| Duplicate room/import after response loss | Journal one operation, reconcile external create, and checkpoint manifest/chunk digests. |
| Forged author history | Render an explicitly imported transcript; never mint native events under old agent/device identities. |
| Counterfeit cross-room import | Authorize every manifest/chunk mutation against the signed-in conversion owner, journaled operation, and exact destination room. |
| Plaintext staging or log disclosure | Keep bodies out of logs/analytics; stage only inside the internal-mode 0700/0600 boundary; delete staging after completion/cancel without claiming secure erase. |
| Active content in imported messages | Reuse the existing inert text/code renderer; do not interpret HTML, load external resources, activate links, or derive controls from bodies. |
| Old history wakes agents or creates receipts | Exclude imported records from `SubscriptionSource`, pending delivery, and read-receipt projection. |
| Sustained writes starve catch-up | Stop after three non-convergent rounds; require an explicit bounded drain, with a finite blocked result that resumes the internal room if the ceiling is exceeded. |
| Split brain during cutover | Atomically persist the read-only source state, authoritative external link, and activation intent; after that point recover forward and never unfreeze the source. |
| Agent identity drift | Snapshot session ID/generation, re-run evidence-backed inspection, and surface stale/revoked/unsupported outcomes. |
| Source requirements drift after this baseline | Re-check this document against the current requirements and survey before implementation tickets are promoted. |

## Non-goals

- Remote or LAN access to an internal server.
- Making an internal room encrypted in place.
- Treating a code, copied link, display name, or saved roster as owner authority.
- Deleting the internal chat automatically or claiming secure erase.
- Replaying imported history through agent delivery, read receipts, or automation.
- Rebinding a changed/revoked session silently, creating a replacement model session, or changing its harness/model.
- General account/device pairing, room discovery, or recovery beyond the conversion/agent-connect use case.

## Ticket contracts

Every contract is a fast follow and is blocked by `internal-core` (#138). Paths under `packages/internal-mode/` are provisional: adopt the package and storage boundaries delivered by `internal-core` instead of creating a parallel core.

### 1. Pairing-code control protocol

| Field | Contract |
|---|---|
| Title | Add the pairing-code control state machine |
| Complexity | `complexity:4` |
| Scope | Versioned pairing request/claim/approval results; ten-character code generation; digest-only storage; trusted expiry; atomic claim; attempt/rate-limit port; authenticated approve/deny; 60-second DPoP-bound grant issuance; finite safe errors. |
| Out of scope | Connector CLI, internal UI, room creation, direct admission, or a new long-lived capability. |
| Files/packages | `packages/contracts/src/messaging/pairing.ts`; `packages/contracts/src/messaging/index.ts`; `apps/control/src/pairing/{handler,store,policy}.ts` and tests; control runtime route registration. |
| Acceptance | Code possession cannot admit or mint a capability; exactly one connector key/session can claim; owner approval binds the displayed claim; raw codes never persist or log; requests end as approved/denied/expired and grants become spent only after redeem; unavailable rate-limit storage fails closed. |
| Tests | Race two claims and require exactly one winner; retry the winning operation and reconcile it; present a valid code without owner approval and require no grant; inspect store/log fixtures for raw code; make the limiter unavailable and require a finite refusal. **Wrong implementation caught:** a naive lookup-then-write lets both racing claimants succeed. |
| Blocked by | `internal-core`; existing link bootstrap #83 and admission are reuse prerequisites, not blockers. |
| E09 conflict risk | High with `internal-core` control/storage composition; medium with `room-and-agent-listing` (#144) if pairing request views enter shared contracts. Keep pairing types in a dedicated module. |

### 2. Pairing-code connector ownership method

| Field | Contract |
|---|---|
| Title | Connect a verified agent from another machine |
| Complexity | `complexity:4` |
| Scope | Add `pairing-code-v1` to strict bootstrap discovery/ownership negotiation; resolve the canonical hosted origin from trusted connector configuration; accept a human-entered code; submit connector key, reserved device, and verified native session; poll/await approval; redeem the resulting grant through existing bootstrap; expose finite CLI results and stable retries. |
| Out of scope | Hosted approval UI, bypassing session inspection, automatic room selection, or connecting directly to a loopback internal server. |
| Files/packages | `packages/connector/src/bootstrap/{descriptor,ports,orchestrator,pairing}.ts` and tests; `packages/agent-cli/src/cli/connect.ts` and composition/tests; bootstrap READMEs. |
| Acceptance | Link bootstrap still prefers/uses loopback where available; code-only pairing fetches a fixed-path descriptor from the configured hosted origin and fingerprints both; cross-machine pairing reserves one device before claim; secrets never enter the operation ledger; changed session/generation is a conflict; approval grant remains sender-constrained; invalid/expired/used codes reveal no room details. |
| Tests | Exercise strict descriptor negotiation with both methods; resume after lost approval response without a second device; substitute another session/generation/key and require refusal; ensure a code or response cannot select or redirect the configured origin. **Wrong implementation caught:** trusting the session fields submitted with the code instead of `SessionInspectionPort` makes a forged-session test pass when it must fail. |
| Blocked by | `internal-core`; contract 1 (`pairing-code-control-protocol`). |
| E09 conflict risk | High with `one-command-setup` (#143) in agent CLI composition; medium with harness integrations (#139/#140/#142). Keep the ownership method behind bootstrap ports. |

### 3. Multi-agent hosted room bindings

| Field | Contract |
|---|---|
| Title | Support multiple agent bindings in one hosted room |
| Complexity | `complexity:4` |
| Scope | Replace owner+room singleton binding storage with participant-scoped bindings; migrate existing records; preserve per-binding generation, revocation, capability supersession, lookup, and authorization; admit two or more distinct verified sessions for one owner and room. |
| Out of scope | Conversion orchestration, new harness routes, shared capabilities, or silently rebinding a changed session. |
| Files/packages | `apps/control/src/agent-bootstrap/{handler,store}.ts` and tests; binding index/capability authorization; revocation composition/tests; any required messaging binding contract version. |
| Acceptance | Existing singleton records migrate without losing revocation state; two participant-scoped bindings coexist; refreshing/revoking one does not supersede another; duplicate participant/session bootstrap remains idempotent; conflicting device or generation is refused. |
| Tests | Migrate an existing owner-room record; admit two distinct verified sessions into one room; rotate and revoke one capability while the other remains authorized; race duplicate admission for one participant. **Wrong implementation caught:** retaining the owner+room key causes the second agent to return `binding_conflict`. |
| Blocked by | `internal-core`; existing link bootstrap #83 and revocation composition. |
| E09 conflict risk | High with room/agent listing (#144), setup (#143), and harness integrations (#139/#140/#142), which all consume binding identity. Land the cardinality change before those consumers finalize roster assumptions. |

### 4. Externalization journal and start-fresh conversion

| Field | Contract |
|---|---|
| Title | Convert an internal room to a fresh external room |
| Complexity | `complexity:4` |
| Scope | Durable conversion states including pre-link and post-link recovery; immutable mode/room/roster snapshot; authenticated hosted room creation; create-result reconciliation; per-agent verification and batch human approval; paused destination bindings; re-invite status/retry/skip; final write pause; atomic link/read-only transaction; resumable activation barrier; cancel/orphan reporting. |
| Out of scope | History payload import, imported-history rendering, automatic internal deletion, or silently replacing failed agents. |
| Files/packages | `packages/contracts/src/messaging/externalization.ts`; internal-core-owned `packages/internal-mode/src/externalization/{journal,service}.ts` and tests; hosted room/bootstrap composition adapters. |
| Acceptance | Start-fresh transfers zero messages; repeated operation creates one external room; exact session/generation identities are re-verified; joined destination bindings stay paused before commit; blocked agents keep conversion incomplete; commit requires every agent joined or explicitly skipped; link commit makes the internal room read-only and records activation intent before any joined binding activates; post-link recovery only resumes forward. |
| Tests | Lose the create response and reconcile the same destination; mutate the conversion choice and require conflict; use stale/revoked/unsupported sessions and require blocked statuses; prove a joined destination agent cannot publish/receive before commit; fail immediately before link commit and require the source to unfreeze; fail after link commit but before activation and require the source to stay read-only while activation resumes; assert start-fresh sends no source message. **Wrong implementation caught:** retrying after an ambiguous create produces two external rooms. |
| Blocked by | `internal-core`; #41 / PR #120 (`external-room-composition`); contracts 1–3. |
| E09 conflict risk | Highest with `internal-core` storage/launcher/UI ownership; high with room/agent listing (#144) and setup (#143). Implement only against the landed internal-core package. |

### 5. Imported-history contract and codecs

| Field | Contract |
|---|---|
| Title | Define a truthful encrypted history archive |
| Complexity | `complexity:3` |
| Scope | Versioned manifest/chunk/record contracts; source revision and ordering; original author label/timestamp/body; per-record and chunk digests; import actor/provenance; strict bounds/decoders; read-only human projection and bounded agent context pages; explicit exclusion from native event references. |
| Out of scope | SQLite export, provider upload, UI styling, agent context injection, or native-event impersonation. |
| Files/packages | `packages/contracts/src/messaging/imported-history.ts`; messaging exports/fixtures/tests; `packages/messaging/src/rooms/imported-history.ts` projection tests. |
| Acceptance | Deterministic encoding and digest verification; bounded chunks and agent-readable pages; strict version/field rejection; imported entries cannot satisfy `EventRef` or enter approval/release APIs; original attribution is display provenance, not external authorship. |
| Tests | Round-trip Unicode/newlines and boundary sizes; reorder/drop/alter a chunk and require digest failure; feed an imported record into native event/release decoders and require rejection. **Wrong implementation caught:** accepting a body whose digest belongs to another source record. |
| Blocked by | `internal-core`; contract 4 for conversion identity and source revision. |
| E09 conflict risk | High with read receipts (#145) and piggyback delivery (#141) because both consume timeline/event surfaces. Use a distinct imported projection rather than widening `MessageContent` silently. |

### 6. Checkpointed encrypted history transfer

| Field | Contract |
|---|---|
| Title | Transfer internal history without duplication |
| Complexity | `complexity:4` |
| Scope | Snapshot the internal SQLite log; encode bounded archive chunks; authorize every manifest/chunk write against the signed-in conversion owner, journaled operation, and destination room; attempt at most three catch-up rounds; enter a human-confirmed paused drain when the backlog still exceeds one maximum-sized chunk; enforce a finite transfer ceiling; send through the external encrypted-room composition; persist acknowledgements; reconcile and resume; expose bounded read-only context pages to re-invited agents. |
| Out of scope | New encryption, new external provider, live dual-write, UI rendering, or delivering imported rows to agents. |
| Files/packages | Internal-core-owned export/storage adapter; `packages/messaging/src/rooms/history-import.ts` and tests; provider/composition adapter beside the landed external room substrate; conversion journal integration. |
| Acceptance | E2EE transport handles every chunk; plaintext stays out of logs/analytics and staging remains inside the 0700/0600 boundary; retry never duplicates records; catch-up either reaches one maximum-sized final delta within three rounds or returns `drain_required`; the paused drain completes within the transfer ceiling or returns a finite blocked result and resumes the internal room; completion reconciles manifest/count/order/digests; imported records stay out of `SubscriptionSource`; agents can explicitly page bounded context. Provider support is **unproven** until integration passes. |
| Tests | Interrupt/resume each chunk; append source messages during copy and reconcile them through catch-up; drive a producer faster than transfer and require `drain_required` after three rounds; complete a paused drain, then exceed its ceiling and require a finite blocked result with the source resumed; lose the final acknowledgement and reconcile; reject another principal/room; inspect storage/log fixtures for bodies; query delivery/read-receipt projections for zero imported events; page agent context without enqueue. **Wrong implementation caught:** checking the initial revision only causes an active room to abort forever. |
| Blocked by | `internal-core`; #41 / PR #120 (`external-room-composition`); contracts 4 and 5. |
| E09 conflict risk | High with `internal-core` SQLite schema and external substrate composition; medium with read receipts (#145), listening modes (#139), and live acceptance (#147). Keep import traffic outside normal subscription cursors. |

### 7. Make-external and pairing UX with acceptance coverage

| Field | Contract |
|---|---|
| Title | Ship the human conversion and approval journey |
| Complexity | `complexity:4` |
| Scope | Internal-room Make external action; hosted sign-in/return; history and exact-roster confirmation; pairing display, approval, and denial; progress, reload-resume, retry/skip, commit, orphan, and success states; inert imported transcript rendering; authoritative-room link; fake-provider E2E and browser coverage. |
| Out of scope | Room discovery redesign, general account pairing, mobile-native UI, or hiding partial failures. |
| Files/packages | Internal-core-owned web composition/routes; `apps/web/src/features/make-external/**`; pairing approval UI under the hosted human composition; `tests/e2e/` fake internal/external harness scenarios. |
| Acceptance | Human can complete both choices; blocked agents keep conversion incomplete until joined/skipped; non-convergent history offers a clear paused-drain choice; denial is terminal and mints no grant; post-create cancel shows orphan cleanup; reload resumes; a post-link failure shows forward activation recovery and never offers source resume; all actions are keyboard-operable with managed focus and named controls; expiry/progress/errors/completion are announced; imported bodies render as inert text/code only. |
| Tests | Playwright both choices, sign-in failure/return, pre/post-create cancel, denial, expiry, retry, partial-agent failure, non-convergent catch-up and drain confirmation, post-link activation recovery, reload, keyboard/focus/live announcements; use script/image/link/fake-approval markup and assert no execution, external loads, active links, or body-derived controls; fake provider loses responses and still yields one room/import. **Wrong implementation caught:** imported history emitted as live events wakes fake agents or receipts. |
| Blocked by | `internal-core`; #41 / PR #120 (`external-room-composition`); contracts 1–6. |
| E09 conflict risk | High with `internal-core` and room/agent listing (#144); medium with setup (#143), read receipts (#145), and live acceptance (#147). Land after their shared UI contracts stabilize. |

## Promotion order

`internal-core` and #41 / PR #120 (`external-room-composition`) → contracts 1 and 3 → contract 2 → contract 4 → contract 5 → contract 6 → contract 7. Contracts 1 and 3 may run in parallel after their blockers land; all PRs must adopt the final internal-core and external-room composition boundaries.
