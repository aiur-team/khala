# Security planning review — 2026-09-16

Scope: KHA-105,110,111,112,113,119,120,128,129,138,141,142,144. Requirements-first artifacts were enriched in place; original R1–R4 intent was retained and acceptance examples clarified. Reviewed with ce-doc-review coherence, feasibility, security and adversarial lenses, serially by the author. This is not an independent multi-model review. Existing transport agent independently peer-reviewed105/119/120 contract fit; brand agent reviewed105 consumer fit. No additional agents or external model review were launched under the parent’s capacity/scope constraint.

Requirements-only artifacts were reviewed as product contracts; their prospective technical sections received an additional design consistency check. Implementation-ready artifacts received unit/path/scenario review. “Ready” is conditional on predecessor dispatch gates, not a claim that runtime proof passed.

## Findings and dispositions

| Finding | Lens / confidence | Concrete evidence and consequence | Disposition |
|---|---|---|---|
| S01 Identifier limits disagreed | Coherence /100 |105 said512 while106 proposed1024; same input could pass only one domain | Fixed both to512 UTF-8 bytes; consumer parity tests retained |
| S02 UI had no link issuance or snapshot semantics | Coherence /100 |105 AdmissionPort lacked share; observe returned no defined projection | Added service-owned canonical share URL and replacement snapshot/generation;113 issuance tests |
| S03 Stale approval could retarget binding | Security /100 |Command binding ID alone did not bind expected generation |106 adds expectedBindingGeneration;119/120 explicitly reject stale values |
| S04 Wrong ledger owner reference | Coherence /100 |119/129 referred to117 as ledger;117 is Claude adapter | Corrected to115 storage,121 dispatch and134 composition |
| S05 Ambiguous commit not expressible | Feasibility /100 |Approval result must distinguish lost commit response from rejection |106 peer updated outcome_unknown operationId;119 handoff now explicit |
| S06 Old policy ack could affect new binding | Security /75 |Version can repeat under another binding generation | Ack includes command identity/generation;120 adds mismatched ack test |
| S07 Browser reload is weak persistence evidence | Adversarial /75 |In-memory client can survive page-level test setup |141 requires real browser process restart/profile evidence and pre-restart event |
| S08 Native source main is not installed compatibility | Feasibility /100 |Bot dependency range and native current main differ |142 requires exact lockfile pair, supported Node patch and actual import/restart proof |
| S09 Generic acceptance examples obscured failure semantics | Coherence /75 |“Main operation completes” gave no falsifiable outcome | All13 now have ticket-specific positive/negative examples |
| S10 Public URL cannot establish owner | Security /100 |Shared link supplies room invitation, not authenticated session evidence |144 isolates critical trust step and retains G-ADMISSION; no mandatory pairing flow invented |
| S11 Automatic inference privacy claim | Security /75 |Model provider necessarily receives approved prompt |138 explicitly separates relay confidentiality and model-provider exposure |

## Per-plan review result and dispatch condition

| Ticket | Deepening focus | Result |
|---|---|---|
|105|Canonical bytes, ownership authority, consumer snapshots, no cross-domain imports|Detailed candidate; admission/retention product gates remain |
|110|Issuer/subject mapping, replay/CSRF, strong-store ambiguity|Detailed candidate; admission/bootstrap decision remains |
|111|Single browser crypto writer, full restart, stale callbacks|Implementation-ready conditional on105/141/substrate predecessors |
|112|Create ambiguity, transaction identity, resumable intro batch|Implementation-ready conditional on105/substrate predecessors |
|113|Invite scope, share issuance, history disclosure, wrong account|Detailed candidate; admission/history decisions remain |
|119|Exact immutable release codec, authenticated owner, all-or-none validation|Implementation-ready conditional on105/106; integration134 owns commit |
|120|Requested/effective policy, ack generation, narrow auto release|Detailed candidate; automation defaults/budgets unresolved |
|128|Forward revocation versus existing plaintext, partial effects|Detailed candidate; retention/removal semantics unresolved |
|129|Endpoint-only secrets, honest missing keys, no release replay|Detailed candidate; approved recovery/retention behavior unresolved |
|138|Real surface inventory, positive canary control, bounded evidence|Implementation-ready after134–137 composition; tested scope explicitly bounded |
|141|Pinned OSS browser persistence and UI seams|Implementation-ready isolated experiment; negative verdict valid |
|142|Pinned TS/native durability, engine/platform/key sharing|Implementation-ready isolated experiment; negative verdict valid |
|144|OAuth-to-existing-session authority without public-link impersonation|Detailed candidate; ownership confirmation product decision pending |

## Verification performed during planning

- Inspected immutable local Archon/Aiur references and recorded external source commits/content hashes in `docs/evidence/security-planning-sources.json`.
- Independently computed105 content fixture (71 bytes) and119 release fixture (230 bytes) SHA-256 using Python hashlib.
- Checked all13 files for required sections, sequential units, closed code fences and origin paths; checked `git diff --check`.
- Reviewed106/117/118 peer contracts for authority, payload and receipt alignment. No product runtime, browser crypto, native install, OAuth flow or live server security tests ran during planning.

## Remaining limits

No unconditional launch approval. G-ADMISSION, G-RETENTION and G-AUTOMATION remain product decisions. Matrix candidate selection and exact installable SDK versions are owned feasibility outputs, not facts established by source inspection. Cross-model review did not run. The single-author lens review cannot substitute for138 runtime boundary evidence.

## Final independent transport-review corrections

The transport author independently identified three further concrete issues in142/128/129; the security author corrected them:

- S12:142 had an undeclared runtime prerequisite on141 despite its no-predecessor graph.142 now owns its minimal browser interoperability peer and isolated runner dependencies; later comparison with141 is optional evidence, not a completion gate.
- S13:128’s “revoked participant” test overstated a device/binding-targeted API. Tests now name the revoked capability, independently check still-authorized devices, and do not imply account-wide removal or retroactive key erasure.
- S14:129’s reference to retaining115 ledger could imply an undeclared component prerequisite.129 uses an injected fake ledger for component no-replay tests;136 owns actual recovery plus115-ledger composition evidence.

These are planning corrections. No crypto, device revocation or recovery runtime test ran.
