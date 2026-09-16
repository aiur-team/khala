# Independent transport plan review — 2026-09-16

Reviewer: security/identity planning agent, independent of the transport plan author. Scope: KHA-103,104,106,114,115,116,117,118,121,130,133,137,139. Lenses: feasibility, security, coherence; additional adversarial checks on session continuity, duplicate effects and receipt interpretation. This is a document/source review, not executed product testing or independent cryptographic certification.

Read each scoped plan and relevant dependency cards, the105/119/120 contract counterparts, and the transport evidence manifest. Requirements-only documents retain their product gates; their prospective technical sections were checked for contradictions affecting future implementation. Dependency proofs are dispatch conditions, not evidence that a research artifact is incomplete. No new provider/API capability is asserted here.

## Findings

| ID | Severity / confidence | Evidence and consequence | Requested resolution |
|---|---|---|---|
| T01 | High /100 |133 U3 requires the real pending→human review→release path and worked example invokes134;134's card depends on133.133 U4 says base runtime can complete first. An executor could wait on its own descendant or replace real approval with an undisclosed fake. |133 base acceptance must use explicitly labeled injected authenticated release/control fixtures;134–136 and140 own complete feature integration after base merge. Correct F1 to storage-before-bootstrap as detailed startup already requires. |
| T02 | Medium /100 |103/104 declare no dependencies but their verification commands use root `pnpm exec tsx`; their source-grounding paragraph says commands are after101 bootstrap. No root manifest exists at planning baseline. | Own isolated experiment manifests/locks/scripts and reproducible runner, without inventing a101 dependency or importing unimplemented105/106 runtime code. |
| T03 | Medium /75 |115 publishes pending/cursor methods but says future release/claim/budget ports should match119/121;121 only names an injected transactional ledger. Independent workers lack a common exact effect/result surface. | Name local transaction operations/results for commit release, eligibility+claim+budget, receipts and retention reference fencing; one owner115 implements,121 consumes. No generic SQL escape hatch or atomicity with external harness. |
| T04 | Medium /75 |115 PendingKey has recipientBindingId but no generation, while recovery/rebinding can change generation and approval commands enforce expectedBindingGeneration. A worker could silently adopt old pending records under a replacement binding generation. | Specify stored generation or immutable binding-generation lookup, preserve source data separately from release authority, and require explicit fresh authority when reviewing under another generation. Test that old releases never retarget. |
| T05 | Medium /100 |137 specifies common test:e2e security entry;138 previously proposed a separate test:e2e:security root command without a matching owned entry. | Reviewer corrected138 to owned security.test.ts plus common runner and mandatory live-case count. |

T01–T04 were sent to the transport author, corrected, and independently rechecked as recorded below. T05 is fixed in the security-owned plan. No production files were edited.

## What the plans already handle correctly

- 103/104 compare native session identity, original context marker, workdir, model and permission state. Restarted/replayed replacement sessions explicitly fail ordinary-flow proof. A negative feasibility result is valid and blocks the matching production support claim.
- 106 separates verified OwnerAuthority from untrusted JSON, binds expected generation, distinguishes individual content and full payload digests, and prevents duplicate prompts from notify plus submit. Its expanded ApprovalPort preserves ambiguous commit outcome and expired content. Policy acknowledgments echo request/binding generation; unknown is not effective.
- 114 treats shared links as discovery, validates origin/redirects, and requires the approved ownership proof. It does not infer ownership from email/display names or delegate technical setup to humans.
- 115/116 explicitly reject atomic SDK-crypto/application-ledger assumptions. Ciphertext spooling is not presumed to recover plaintext after irreversible ratchet progress. Replay gaps, missing keys and uncertain cursor movement remain visible and block readiness.
- 117/118 expose only evidenced native receipt levels. Native queue/thread APIs are candidate routes rather than interchangeable attachment semantics. Unsupported reconciliation returns null, never implicit resend permission.
- 121 records dispatch intent and allowance before external submission. It explicitly recognizes that fencing/lease expiry cannot prevent a resumed old process from sending; it forbids automatic reclaim/resend of uncertain external effects. Unknown acceptance does not automatically refund budget.
- 130 coordinates deletion and approval through the same local transaction, retains necessary dedup evidence, and distinguishes local cleanup from remote erasure or key-backup destruction.
- 133 specifies one device-state lock and no second crypto client; reconnect preserves binding and unresolved dispatch evidence.
- 137 uses independent A/B/C identities, explicit fake/live evidence modes, and positive broken-fixture controls; live acceptance fails if all tests skip.
- 139 requires the chosen useful task rather than nonce-only success, independent third-owner policy and honest offline/consumption timing. Unanswered product choices remain gates.

## Readiness and evidence limits

103/104/137 are bounded proofs or test infrastructure and can be decision-complete before production integrations exist. Pure technical predecessors do not require a fresh user choice. Admission/ownership, automation/budget, retention/history/recovery, browsers-closed expectations and the actual task remain product decisions where referenced. The final executor must distinguish an implementation-ready plan with unmet predecessors from an unconditional launch authorization.

No CLI notification, live SDK, SQLite fault injection, session attachment, OAuth, infrastructure provision, deployment or model message occurred during this review. Document checks cannot establish dedup behavior in a real harness. Evidence must be produced by the named implementation/proof tickets.

## Recheck of author corrections

T01 fixed:133 now describes base acceptance with an explicitly test-only authenticated release fixture over real storage/SDK/harness ports;134–136/140 retain the real browser authorization flow. F1 now agrees with the storage-first startup order.

T04 fixed:115 now stores `recipientGeneration` in PendingKey and explicitly refuses silent transfer of pending approval/release authority on recovery to another generation.

T02 fixed:103/104 now own isolated npm manifests/lockfiles and `npm --prefix ... ci/probe/test` commands. The source-grounding paragraph now explicitly denies a101 dependency or imports from unbuilt contract packages.

T03 fixed:115 now defines synchronous local `ConnectorLedger.transaction` and `LedgerTx` operations for release commit, dispatch claim/budget, receipt and retention. `readApprovalSnapshot` supplies consistent pending records/binding/policy/revision; putRelease checks that revision. Pure119/120 explicitly perform no ledger I/O;121/130/134/135 own effects.

T05 fixed:138 uses `tests/e2e/security/security.test.ts` and137's common test:e2e target, with actual live execution required for acceptance.

Checked required sections and balanced code fences for all13 scoped documents. `git diff --check` passed. These are document checks only.

Final disposition: all five review findings corrected and rechecked in the documents. No new ungated security/coherence blocker identified by this review; existing explicit product and live-capability gates remain.
