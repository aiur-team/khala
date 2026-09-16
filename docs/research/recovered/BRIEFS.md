# Research briefs

The briefs given to each track, condensed. Tracks 04 and 05 were stopped before reporting; redo them from these. Today's date at commissioning was 2026-09-16. Every track was told: use live web sources, prefer recent, flag stale, cite URLs inline, be blunt about announcements versus working systems.

## Common problem statement

Two people at different companies each have a coding agent and act as meat proxies between them. They want one shared conversation with at least four participants, two humans and two agents. Both humans watch and interject. The agents talk directly. It crosses organisational and model-vendor boundaries and generalises beyond four. See `SCOPE.md` for the airlock and trust-level additions.

## 01 Agent-to-agent protocols (done)

A2A including stewardship and cross-org security and whether multi-party or pairwise and whether humans are participants. MCP and precisely where its boundary falls. IBM/BeeAI ACP and any merger. AGNTCY / SLIM including identity and directory. DIDComm v2. Anything newer. For each: what it does, maturity, more-than-two-party support, cross-org peer authentication, confidentiality beyond transport, human as first-class participant, cost to adopt. Blunt verdict on what is usable today.

## 02 Conversation substrate (done)

Matrix including bot key custody and federation practice. XMPP. Slack Connect and Teams shared channels including what an external app can do. Discord, Zulip, newer entrants. Email and agent-native email. Purpose-built human-plus-agent rooms. For each: non-human as first-class, more than two orgs as peers, cross-boundary identity and invitation, confidential from the operator, audit and retention, cost to stand up. Hard question: an agent participant must hold keys, so where do they live and does the guarantee survive.

## 03 Prompt injection across the peer channel (done, as a sub-report of 04)

The peer agent's messages flow into my agent's context, so the peer is an untrusted input channel. Current thinking and practical mitigations: provenance labelling, treating peer content as data, human confirmation gates, published incidents, benchmarks with attacker budgets, guardrail products. What works versus what is aspirational.

## 04 Identity, delegation, trust (NOT DONE, redo)

- Proving who an agent is across an org boundary: SPIFFE/SPIRE, mTLS, OIDC federation, DIDs and verifiable credentials. Which are used for agents rather than services.
- Proving who an agent acts for: the agent's identity versus its human principal; OAuth token exchange, on-behalf-of, macaroon or biscuit style attenuable tokens, anything emerging for agent delegation.
- Authorisation once connected: capability scoping so a peer gets narrow rights, least privilege when the requester is a model that can be talked into things.
- Audit and non-repudiation: signed transcripts, tamper-evident logs, what each party can later prove.
- Governance and legal friction: data residency, what leaves a boundary, retention, disclosure.
- **The airlock**, evaluated properly rather than endorsed: what it blocks and does not; all-or-nothing versus redaction and annotation; provenance display so the reader knows which parts a model wrote; symmetry on replies; behaviour under long threads; prior art in moderated lists, pull-request review, data diodes. How much of the other mitigations it makes unnecessary between two trusting parties and which it does not replace.
- **Trust levels**: turning the airlock off per peer once trusted, and back on. What the human asserts by disabling it given the far agent can change under a model update, prompt change or host compromise unseen; scope per peer, conversation or capability; a lighter gate on consequential actions when off; re-arming on unusual traffic; visibility of the current state; whether the far side is told; audit record contents; prior art in email clients, package managers, browser permissions, federated chat.
- Finish with a recommended design for two trusting parties, and separately what must change for parties who do not trust each other.

## 05 End-to-end encryption (NOT DONE as a whole; two sub-reports exist as 05a and 05b)

- MLS, RFC 9420: implementation maturity, usable libraries, who shipped it, federated delivery service work, membership churn and key rotation, scale.
- Matrix Olm and Megolm: device key model, what a server-side bot does, key backup and verification, weaknesses, migration to MLS.
- Signal's group story and reuse outside Signal.
- Anything else credible for group E2EE, including agent-specific work.
- Where an agent's key lives and the blast radius: process memory, HSM or cloud KMS, TEE. (Covered in `05a-confidential-computing.md`.)
- The inference problem: hosted-model inference sees plaintext, so what is the honest claim; zero-retention terms, confidential inference, local open weights. (Covered in `05b-inference-privacy.md`.)
- Human-visible consequences: what a participant can verify, device verification and cross-signing, what a human sees when a new agent joins, transcript integrity without weakening confidentiality.
- Finish with a plain statement of what "end-to-end encrypted" can honestly mean for a room containing hosted-model agents and what wording would be dishonest, plus the strongest design achievable today and what would have to change.

Still missing from 05: the MLS, Megolm, Signal and human-verification parts. The custody and inference halves are done.
