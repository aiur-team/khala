# Independent transport review of security planning

Reviewed 2026-09-16 by transport_protocols, separate from the security-plan author. Scope: KHA-105,110–113,119,120,128,129,138,141,142,144. The shared105/119/120 contracts received earlier direct producer/consumer review; this pass focused the other ten plans on feasibility, dependency coherence, source-versus-observation claims and ownership/history gates. This is independent cross-agent review in the same model family, not cross-model review. No runtime tests or new infrastructure actions ran.

## Concrete findings

| ID | Severity | Evidence and effect | Required bounded correction |
|---|---|---|---|
| S01 | P1 |142 declares no dependencies but its interoperability unit and verification wait for141's browser candidate; executor graph could dispatch it independently and then discover a hidden wait | Use an experiment-owned pinned browser peer without importing/waiting for141 implementation; later compare141 evidence. Alternatively parent must explicitly change graph dependency |
| S02 | P1 |128 tests that a revoked participant cannot receive a new event, while RevocationPort targets a device/binding and the plan explicitly allows other valid credentials/devices | Assert exclusion for the revoked target; test continued access of still-authorized devices. Whole-membership removal requires its separately approved capability and policy |
| S03 | P1 |129 restore unit says retain115 ledger independently, but129 is a component depending on101/105 and must not require another undeclared implementation | Use an injected ledger/snapshot fixture for component no-replay assertions;136 owns real115-backed restore composition |

All three findings were corrected by crypto_identity and independently rechecked on disk before handoff:142 owns its minimal browser peer and has no141 implementation wait;128 scopes assertions to the revoked target and explicitly preserves other authorized devices;129 uses injected component fixtures and assigns real115-backed integration to136. No unresolved review finding remains.

## Reviewed boundaries

- 105/119/120: exact message/release codecs, literal digests,512-byte opaque IDs, expected binding generation, verified authority separate from command JSON, command identity, unknown results and requested/effective policy agree with106. Backlog handling remains an explicit G-AUTOMATION choice; separate commands avoid a distributed atomicity claim.
- 110: maintained OAuth validation, verified issuer/subject identity, token/cookie separation, callback replay and provisioning uncertainty are specified. Source patterns are references, not copied provider-policy guarantees.
- 111: persistent browser crypto and cross-tab exclusive ownership remain proof-backed prerequisites; account-switch generation fences prevent old callbacks crossing owners.
- 112: no universal room-create or batch-send transaction is claimed. Unknown create/send outcomes preserve operation identity and cannot justify fresh duplicate effects.
- 113: room admission differs from ownership; share issuance is explicitly in the consumer clarification; invite/history policy remains gated and key exclusion is not inferred from homeserver visibility settings.
- 128/129: local enforcement, remote device effect and prior plaintext access are separated. Recovery never turns OAuth login into key recovery and never restores delivery authority by importing keys.
- 138: actual composition and model-surface inventory required; positive leak control, live-case nonzero guard and missing-log coverage gaps are honest. Same-host/inference limits remain stated.
- 141/142: pinned source observations do not imply compatible installable SDK/native pairs or passed persistence. Full process restarts, exact versions and no shared writable crypto machine are required.
- 144: public link alone does not supply trusted session evidence. The missing ownership transition is explicitly gated rather than patched by human technical setup or provider credentials in the URL.

The source manifest was inspected for repository revisions and source hashes. This review did not refetch or independently reproduce every upstream source observation. Existing G-SUBSTRATE/G-ADMISSION/G-RETENTION/G-AUTOMATION and live proof gates remain; no new product feature is proposed.

Review complete
