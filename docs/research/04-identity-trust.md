# Identity, delegation and airlock policy

Research proposal, 16 September 2026. The original identity track stopped before producing its main report. This document supplies a design recommendation, not an adoption survey of every identity system in its brief.

## Requirements and open decisions

The recovered scope asks for human review before content reaches the recipient agent's context, reversible trust per peer, distinct human/agent participation, and E2EE as a priority. It does **not** settle whether pending plaintext must be inaccessible to the owner-controlled connector process, whether each side must approve outbound content, or whether agents must keep talking while both browsers are closed. The user has now approved connector-enforced gating: the trusted owner connector may decrypt pending messages, and only released content reaches model context/capability surfaces. Strict cryptographic audience separation is optional future research, not a launch requirement. The [encryption comparison](05-e2ee.md#airlock-options-and-plaintext-custody) compares the approved baseline with optional stronger isolation.

For ticket planning, ask the product owner:

1. **Answered:** connector-enforced review is sufficient; no separate human-only cryptographic audience is required.
2. Must trusted agents exchange messages while all human clients are offline? Who is allowed to operate the endpoint that forwards plaintext then?
3. Can a reviewer edit/redact and annotate releases, or only approve/reject originals? Should the other human see those edits and rejection reasons?
4. Does a new human/device get the full prior transcript, selected messages, or only future messages? Is recovery after losing every device a first-release requirement?
5. Are invitation recipients known named people, or may anyone with the link request access? Does a company need approval authority in addition to the two humans?

Confirmed: connector-enforced gating, TypeScript application code, OSS reuse, and attachment to an existing working agent session across model vendors. Netlify is preferred; a Railway backend is acceptable if it reduces implementation work. Provisional remaining defaults: review in both directions, owner-controlled connector, selected history transfer, explicit device approval, and no enterprise impersonation/federation. These remaining assumptions await answers.

## Identity mapping if Matrix is selected

Following the user's preference for existing OSS and TypeScript, evaluate distinct Matrix human and bot accounts, with explicit device instances and a Khala owner-binding record. The bot should not be another device on the human account. Reuse SDK device verification and key management while preserving the owner approval and airlock policy described here. MLS-specific transition advice below is conditional fallback research; Matrix room/key transitions require their own SDK-backed proof. See [Matrix feasibility](05-e2ee.md#current-priority-typescript-existing-crypto-and-netlify-compatible-delivery).

## Actor model

Keep four identities distinct: human account, human device, agent participant, and agent instance/device. An agent participant belongs to a human principal but is never displayed or authorised as that human. Replacing a connector device/key introduces a new instance and key binding. Attaching another existing harness session is an explicit target change; a model switch within that session does not automatically imply a new cryptographic identity. A model/vendor label is informative metadata, not an authentication mechanism.

Recommended initial authority record:

```
agent_instance -> owning_human -> conversation_membership
                   scopes + expiry + revocation_generation
                   approved_device_key + disclosure_profile
```

The human signs or otherwise explicitly approves the agent/device binding; recipients verify its association before encrypting. Server account authentication alone must not let the server substitute encryption keys. Display verification state and key changes separately from the friendly actor name.

[OAuth Token Exchange](https://www.rfc-editor.org/rfc/rfc8693.html) distinguishes delegation from impersonation and defines actor claims, audience and scope. Use its semantics if enterprise federation is needed; it does not establish cross-company trust policy automatically. [DPoP](https://www.rfc-editor.org/rfc/rfc9449.html) can sender-constrain HTTP credentials, but its HTTP proof rules are not a general WebSocket message signature scheme. [SPIFFE](https://spiffe.io/docs/latest/spiffe-about/overview/) identifies workloads in trust domains; it does not by itself prove that Karl approved a particular conversation. Defer SPIRE, DID/VC and attenuable-token infrastructure until concrete organisational requirements justify them.

For a two-owner prototype, account authentication, owner-authorised session pairing and scoped credentials are a candidate. Distinguish the trusted connector from its agent-facing adapter: the connector may read/decrypt room content and execute releases already authorised by the human or an active automatic policy. The adapter exposes only released content and cannot approve pending messages, change trust policy, enrol devices or gain repository/cloud privileges through chat. Exact credential scopes depend on the chosen SDK/substrate; Matrix account tokens do not inherently implement Khala's proposed fine-grained scopes.

## Invitation flow

A link starts the chosen admission flow; possession alone is not proof of a named person's identity. The product has not selected named-recipient admission versus an intentionally transferable bearer invite. Do not force an extra creator-approval screen into the baseline without that decision.

1. Creator queues encrypted messages before the recipient joins. Decide which queued history admission should disclose; a link must not accidentally reveal private keys in logs/referrers.
2. For a named-recipient invite, authenticate and bind the claim to that recipient/device; creator confirmation is one option when no prior binding exists. For an intentionally transferable invite, clearly describe that anyone holding it may redeem the authority it grants.
3. Enforce the selected expiry/use-count rules atomically. For single-use invites, hash bearer secrets at rest and handle concurrent redemption and lost acknowledgements idempotently.
4. Disclose the agreed queued history through the selected SDK's supported key-sharing behavior. A future strict MLS design would need explicit history transfer; do not impose a custom history package on Matrix by default.
5. Recipient pairs an existing agent session with an independent connector identity. In the approved baseline, the connector may decrypt pending room messages; its agent-facing interface exposes only content authorised by manual release or the human's automatic policy.

Archon's [auth store](../../../archon/netlify/lib/hosted/auth-store.mjs) is a useful implementation reference for hashed tokens, expiry and guarded consumption. The crypto admission and history disclosure are additional Khala work.

## Airlock state

Policy belongs to the recipient, scoped to `(conversation, recipient_agent_instance, sender_participant)`. Only that recipient's human devices can change it. Initial modes: `review_required` and `auto_release`. Additional graduated modes should wait for a demonstrated need.

Each change carries a monotonically increasing policy version. A release binds immutable original message IDs/digests, exact authorised bytes, target connector and harness session, and policy version. Manual releases identify the approving human device; automatic releases identify the human-authorised policy and executing connector, without fabricating a per-message human approval. Record a batch selection explicitly; avoid approvals of “everything pending” that include arrivals the human never saw.

The release operation needs an explicit ordering boundary for policy changes and context delivery. Proposed behavior: serialise releases and policy application in the trusted connector, and display re-arming as pending until that connector acknowledges the new policy version. A disconnected connector cannot know about an unseen remote change; define its offline policy before promising immediate revocation. Already delivered context cannot be recalled. Queued, undelivered releases should be rechecked when review is re-armed. A relay receipt alone is not proof that the connector has stopped forwarding.

The relay can enforce who submits a release and persist opaque ciphertext. The approved baseline trusts the owner connector to decrypt pending room events while withholding them from model context and agent-facing APIs. Cryptographic exclusion from that connector is not promised. Rich approval details can be encrypted to the relevant humans; route only the metadata needed for authorisation and replay.

Show the recipient who is on automatic release. Tell the sender their message was queued/delivered, but do not needlessly expose private recipient trust assessments. Disabling review changes content forwarding; it grants no tool-execution authority. Re-arming on changed instance keys is reasonable; claims that an invisible remote model/prompt change can always be detected are not.

## Provenance and actions

Preserve agent-original content and distinguish forwarded, human-edited, redacted and annotated messages. [Ed25519](https://www.rfc-editor.org/rfc/rfc8032.html) is a standard signature option for application provenance. Bind any application signature to a canonical versioned encoding, conversation, author instance, message ID and content; review/export the disclosure tradeoff before making transferable signatures mandatory. Attribution does not mean content is safe or true.

The airlock is a disclosure control. It does not prove that a person identified every prompt injection. The connector must retain local action policy and require its owner's authority for consequential tools. Released peer text stays peer text; do not turn it into system instructions. Automatic replies need addressed recipients, reply correlation, maximum turns, rate/token budgets and an owner pause control to prevent loops. Quarantine/summarisation can reduce exposure but is not proof that malicious meaning was removed.

Revocation denies future authorised reads/releases and disconnects or invalidates active transports where supported, alongside the selected protocol's device/key removal procedure. Previously delivered plaintext remains disclosed. A tamper-evident transcript needs client-held authenticated checkpoints and, if relay equivocation matters, comparison between participants; a relay-maintained hash chain alone is insufficient.


## Admission and delegation transitions

Invitation state depends on the chosen admission model. A named-recipient approval flow may use `pending -> claimed -> admitted`; a bearer flow can use `pending -> redeemed`. Both need explicit expiry/revocation, guarded redemption and a stable retry outcome. A separate claim/approval step is not a product requirement. For named identity checks, bind approval to the exact account/device rather than trusting a display name.

Conditional MLS guidance: keep room authority and encryption authority aligned: authorising `add_member` at the HTTP endpoint is insufficient if clients automatically merge an MLS commit carrying an unauthorised device. Each endpoint must validate admission policy before merging membership changes; OpenMLS exposes staged proposals/commits for application inspection. [OpenMLS processing guide](https://book.openmls.tech/user_manual/processing.html).

Proposed agent-facing adapter capabilities are `publish_own`, `receive_released`, and `ack_delivery`. The trusted connector additionally receives room ciphertext and executes authorised manual/automatic releases; this does not authorise the model-facing adapter to approve content or change policy. SDK-level account credentials and Khala adapter capabilities must not be conflated. Session expiry/revocation belongs to relay authentication; removing group membership belongs to client crypto. Report both transitions and retry the unfinished one. A revoked socket may still have in-flight bytes; revoke before future authorisations and rotate the affected audience before claiming future cryptographic exclusion.

Use Archon's hashed, purpose-separated transient records and strong reads as a design reference. Its comments also document why a storage SDK's success value can be ambiguous and why guarded writes require a real ETag. Borrow those invariants, not its exact 15-minute/24-hour lifetimes or Netlify storage choice. [Inspected auth-store implementation](../../../archon/netlify/lib/hosted/auth-store.mjs).

## Release record and user-visible outcomes

A proposed release payload includes `release_id`, `conversation_id`, `source_message_ids`, source digests, approved derived-content digest, recipient instance, harness session and membership generation, manual reviewer or automatic-policy actor, policy version, and attachment manifest references. Include a schema version and a domain separator in signed/hashed encodings. This is a contract sketch, not a mandated wire format.

Recommended state distinctions: `pending_review`, `rejected`, `release_committed`, `connector_received`, and `agent_context_accepted`. A relay acknowledgement proves storage; it does not prove that a model processed the message. Retry by stable release ID and deduplicate at the connector. If a harness cannot confirm context insertion, display the narrower connector receipt. Human rejection can remain private; sender-visible delivery status needs a product decision.

A policy change applies when acknowledged at the chosen connector ordering boundary. For automatic mode, the connector must enforce that applied policy version before inserting content into the paired existing session. Re-pairing to another session requires explicit owner action; never silently redirect a queued release to whichever session is currently active. In the optional strict variant an authorised forwarding endpoint checks policy before encrypting and transmitting approved content. Once agent-readable ciphertext exists outside that endpoint, a hostile relay could disclose it irrespective of a later policy change. Therefore the product cannot promise that re-arming review recalls every previously created ciphertext; the endpoint must not precompute agent-readable ciphertext for still-pending messages. Define the guarantee around the trusted endpoint's release decision, with relay ordering used for ordinary races and audit rather than retroactive secrecy.

Batch approval includes exactly the reviewed immutable items. Editing the source while a release screen is open produces a new message/version and invalidates approval of substituted bytes. An agent instance replacement invalidates old target bindings and requests pairing/review again; inheriting automatic trust is a separate explicit action.

## Candidate ticket slices for sign-off

| Slice | Dependency | Acceptance evidence |
|---|---|---|
| Identity and invitation admission | Product admission/history answers | Named-recipient mode rejects wrong identity/device; bearer mode grants only its documented authority; concurrent redemption follows chosen use count; retry returns same outcome |
| Connector pairing and scoped credentials | Chosen endpoint custody | Owner approves exact instance key; agent-facing adapter cannot approve/invite/change policy; trusted connector can execute authorised automatic releases; revocation denies future access and exposes pending crypto rotation |
| Airlock release state machine | Chosen airlock model, content-edit policy | Race between release/re-arm has defined result; exact batch and bytes bound; duplicate release is harmless; stale policy/instance rejected; receipt stages distinguish model acceptance |
| Provenance and local tool boundary | Harness support decision | Original and derived authors shown separately; untrusted text never becomes privileged instructions; loops have per-room budgets/pause; no claim that review detects all injection |

These are proposal slices for the parent ticket breakdown; they are not approved implementation instructions.
