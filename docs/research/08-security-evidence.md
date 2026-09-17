# Security evidence and disposition of historical research

Research continuation, 16 September 2026. This is an evidence ledger for decisions, not a production security assessment. Live primary sources below were inspected during this continuation; mutable library pages must be pinned again in feasibility work. Recovered reports remain historical and are not silently promoted into requirements.

User steering prioritises TypeScript, existing OSS and ideally Netlify Functions/Blobs. Connector gating and attachment to existing agent sessions are approved. Railway is acceptable when it saves development work; Netlify preference is not an absolute serverless constraint. Compare Matrix SDK crypto/device lifecycle against a Netlify ciphertext relay with an existing crypto core; neither substrate is selected.

## Findings that affect the build

| Claim | Current evidence | Planning consequence |
|---|---|---|
| MLS protects groups, not per-message human approval | [RFC 9420](https://www.rfc-editor.org/rfc/rfc9420.html), group membership and application message semantics | A connector holding room secrets can decrypt pending content; use the approved trusted connector gate; distinct audiences are an optional future boundary |
| Application admission remains necessary | [RFC 9750](https://www.rfc-editor.org/rfc/rfc9750.html), authentication/delivery architecture; [OpenMLS commit processing](https://book.openmls.tech/user_manual/processing.html) | Bind devices to humans and validate membership changes at clients, not solely the relay API |
| Browser compilation is not production browser support | [OpenMLS README](https://raw.githubusercontent.com/openmls/openmls/main/README.md), supported-platform table | WASM is explicitly built but not tested/unsupported; prototype browser storage, lifecycle and native interoperation before committing to this engine |
| mls-rs is an alternative with provider caveats | [mls-rs README](https://raw.githubusercontent.com/awslabs/mls-rs/main/mls-rs/README.md) | WASM/configurable storage exist; experimental provider markings and absence of a full third-party audit are evaluation inputs |
| Persistent state is security-sensitive | [OpenMLS persistence](https://book.openmls.tech/user_manual/persistence.html) | Integrity, irreversible deletion and crash/rollback behavior need application work; backups can preserve supposedly retired keys |
| A browser cryptography API is not a trusted UI/runtime | [W3C Web Cryptography security considerations](https://www.w3.org/TR/webcrypto/#security-considerations) | Non-exportable keys do not make malicious same-origin code harmless; browser distribution and XSS remain endpoint threats |
| Attested key release exists as a building block | [AWS Nitro Enclaves attestation](https://docs.aws.amazon.com/enclaves/latest/user/set-up-attestation.html) describes signed measurements, KMS integration and external-service policy | Confirms feasibility of measured endpoint key release, not confidentiality of an arbitrary hosted model API |
| Confidential VMs are an available infrastructure category | [Azure confidential VM overview](https://learn.microsoft.com/en-us/azure/confidential-computing/confidential-vm-overview) | A possible later hosting experiment, not proof of Khala workload measurement, egress control or end-to-end model confidentiality |
| Model hosting security depends on service configuration and operator responsibilities | [Amazon Bedrock data protection](https://docs.aws.amazon.com/bedrock/latest/userguide/data-protection.html) | Evaluate a selected model/service/configuration if hosted connectors become scope; do not generalise a provider policy into cryptographic exclusion |

The release-race and optional strict-gateway-custody conclusions in [E2EE](05-e2ee.md) are design inferences: an endpoint needs plaintext to transform an approved message, and agent-readable ciphertext cannot be made unreadable by later relay policy. These are architecture constraints, not capabilities claimed by a crypto library.

## Follow-through of every recovered security track

| Historical source | Current continuation | Accepted or unresolved disposition |
|---|---|---|
| [Identity brief/placeholder](recovered/04-identity-trust.PARTIAL.md) | [Identity and trust](04-identity-trust.md) | Concrete actor/admission/release model and scoped credentials proposed; product must choose invitation, edit and recovery behavior |
| [E2EE placeholder](recovered/05-e2ee.PARTIAL.md) | [E2EE and custody](05-e2ee.md) | Browser/native feasibility, separate audiences versus connector review, recovery and unattended custody now have bounded evaluation criteria |
| [Confidential computing](recovered/05a-confidential-computing.md) | Attestation evidence above; custody section in E2EE | Keep as later option if an untrusted connector operator is in scope. Reject any inference that a TEE badge alone proves the complete plaintext path. Recheck exact hardware/firmware/measurement and threat exclusions before selection |
| [Inference privacy](recovered/05b-inference-privacy.md) | Honest confidentiality wording and endpoint disclosure in E2EE | Correct the report's blanket claim that hosted inference erases E2EE: it is downstream disclosure by an authorised endpoint. Do not promise model-provider exclusion from ordinary hosted inference |
| [MLS ecosystem](recovered/05c-mls-ecosystem.md) | Library matrix and feasibility gate in E2EE | Recovered the completed late notification in this continuation. Adoption counts, unreleased features, vendor rollouts and performance figures remain unverified historical leads; engine evaluation relies on current primary docs |
| [Prompt injection](recovered/03-prompt-injection.md) | Current prompt-injection synthesis and identity/tool boundary | Human review and provenance are controls, not proof of safety. Do not use recovered attack percentages to calculate a Khala guarantee |

The inference report's claims about all frontier providers' retention exceptions, one-provider attestation rankings, hardware attacks invalidating whole categories, and benchmark gaps are not verified here and are not prerequisites for the recommended owner-controlled endpoint design. This is an explicit unresolved disposition, not a claim those statements are false. No plan should copy their numbers or legal conclusions. If vendor selection becomes necessary, replace each relevant claim with dated primary evidence for the exact account, endpoint, model, region and enabled feature, plus a separate attestation-path assessment where applicable.

## Threat boundaries to include in the eventual plan

| Adversary or failure | Intended control | Remaining limit |
|---|---|---|
| Relay reads stored data | Client encryption; no relay keys or plaintext logging | Metadata, timing, size and availability remain observable |
| Relay substitutes device keys | Human-approved key binding and verified membership | Verification UX and recovery can undermine the binding |
| Agent receives peer injection | Review, narrow harness API, local tool authority and loop budgets | Approval does not establish harmlessness; malicious meaning can survive rewriting |
| Delivery connector compromised | Separate audiences if selected | Connector-enforced model deliberately trusts that process; strict model still trusts its review endpoint |
| Agent shares review host with unrestricted tools | Separate OS authority/host if strict isolation required | Encryption at rest does not isolate unlocked co-resident processes |
| Browser code distributor compromised | Independently verifiable distribution if required | Ordinary hosted web E2EE does not withstand a malicious replacement app |
| Device loss or old backup restore | Fresh enrolment, selected history transfer, defined unlock/recovery | All-device loss may mean unrecoverable history; retained backups weaken erasure |
| Trusted recipient leaks content | Clear audience/provider disclosure | No cryptographic recall of plaintext already disclosed |

## Decision record still needed

Before detailed implementation plans, record the confirmed connector-gated boundary and settle browser-off behavior, endpoint operator, approved history transfer, recovery promise, and whether attachments and enterprise identity are launch scope. Then turn the candidate slices in identity/E2EE into approved tickets with acceptance tests. No security engine, hosting service, or recovery scheme is considered selected by this research. Invitation admission must also distinguish named-recipient verification from deliberately transferable bearer authority; an extra claim/approval step is not yet required. Automatic release authority belongs to the trusted connector under human policy, never to the model-facing adapter.


## TypeScript/Netlify follow-up evidence

Source review now distinguishes a browser SDK constraint from overall TypeScript feasibility. Matrix JS's modern crypto initializer opens IndexedDB or memory, while a separate existing TypeScript bot SDK wraps a Node crypto binding with local persistence. [Matrix initializer](https://github.com/matrix-org/matrix-js-sdk/blob/develop/src/rust-crypto/index.ts), [WASM store](https://github.com/matrix-org/matrix-rust-sdk-crypto-wasm/blob/main/src/store.rs), [bot storage provider](https://github.com/turt2live/matrix-bot-sdk/blob/main/src/storage/RustSdkCryptoStorageProvider.ts). The current native binding implements SQLite persistence. [Node implementation](https://github.com/matrix-org/matrix-rust-sdk-crypto-nodejs/blob/main/src/machine.rs).

These are inspected source capabilities, not a successful Khala integration test. Exact package-version compatibility, native binary distribution, verification APIs, restart behavior and at-rest unlock remain proof gates. A GitHub API request to pin current commit SHAs hit rate limiting; links identify the inspected mutable branches, so the eventual experiment must pin actual resolved releases/commits before relying on them.

The [expanded comparison](05-e2ee.md#typescript-endpoint-and-hosting-comparison) keeps TS application code, allows vetted WASM/native dependencies explicitly, compares Netlify delivery options, and rejects neither Matrix nor a custom relay prematurely. It does not assume a standalone Rust connector or place plaintext endpoint keys in Netlify. Browser/desktop IndexedDB is a possible reuse path; no durable Node IndexedDB shim was validated. Matrix crypto implementation reuse still needs Matrix services; using a low-level primitive library alone does not supply a secure group messaging protocol.
