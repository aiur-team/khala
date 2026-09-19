# Khala product decisions

Updated 2026-09-18. Ticket scope is approved for detailed planning; individual readiness and unresolved product gates remain explicit.

## User requirements

- Prefer as much off-the-shelf open-source software as possible. Evaluate Matrix as the reuse baseline before proposing custom messaging infrastructure. Matrix is a candidate, not yet a user-approved stack selection.
- Khala is a new Aiur product. Inherit branding from the actual `../aiur` and `../archon` implementations.
- A conversation has two humans and their two agents at minimum, with room for more participants across owners and model vendors.
- Humans see the chat and participate directly; agents can communicate without humans copying messages between them.
- End-to-end encryption is required.
- A creator or their agent can queue one or several messages for a recipient human to preview before passing them to their agent.
- A human can disable the airlock once they trust the other human/agent.
- Continue the research through parallel agents, ask product questions, and propose tickets for user sign-off.
- After ticket sign-off, run `ce-brainstorm` then `ce-plan` to create detailed, implementation-ready documents usable by less capable models.

## Decision register

| ID | Decision | Why it changes the design | Status |
|---|---|---|---|
| P01 | Agent compatibility | Model-independent protocol; harness-specific notification setup | **Settled: support any model; existing-session pub/sub with harness-specific mechanisms** |
| P02 | Agent conversations with browsers closed | Determines need and operator of a persistent policy endpoint | Asked: background, opt-in unattended, or browser required |
| P03 | Hosting/federation | Determines runtime/deployment and identity boundaries | **TypeScript required; Netlify Functions/Blobs preferred; avoid separate Hono backend.** Railway-hosted existing backend acceptable if it saves substantial development. Federation remains unrequested |
| P04 | Airlock trust boundary | Connector may decrypt pending messages but must withhold them from the agent/model until release | **Settled: user chose connector-gated** |
| P05 | First collaboration scenario and completion | Determines the end-to-end launch proof | Asked: cross-repo coordination, technical Q&A, or open-ended collaboration |
| P06 | Onboarding/identity expectations | Defines the ordinary human journey | **Settled: Archon-like OAuth sign-in for email; create optionally named chat; copy link to own existing agent and coworker; no manual connector setup** |
| P07 | History, attachments and retention | Determines disclosure on admission, recovery and content interfaces | **Partly settled 2026-09-18 by P12/P13/P14**; attachments still not asked |
| P08 | Automatic conversation control | Determines who can pause/resume, budget turns and authorise tools | Not yet asked |
| P12 | Admission policy per link | Determines who an invitation link admits and what the invitee may read | **Settled 2026-09-18: the creator chooses the policy at link creation, per link; default anyone-with-link-and-no-earlier-history** |
| P13 | Room closure and retention | Determines what closing a room promises and what cleanup means | **Settled 2026-09-18: closure makes no deletion promise; retention is local cleanup only** |
| P14 | History recovery and escrow | Determines device-loss handling and whether any party holds recoverable keys | **Settled 2026-09-18: no history recovery once every device is lost; no escrow anywhere** |
| P15 | Native agent surface | Determines how an agent joins a room and how it is notified | **Settled 2026-09-18: agents install a CLI; native harness mechanism first (CLI or MCP); generic Khala skill plus CLI as fallback; humans get a send/receive UI in the same room** |

The order is a working interview agenda. Do not treat unanswered questions or recommended options as user decisions. Preserve concrete free-text answers and their implications here as they arrive.

## Settled product choices

- **P06 — no-setup human onboarding (user-directed).** Human signs in with OAuth to identify their email, creates a chat with an optional name, and copies the chat link to their own existing agent and coworker. Agent-side setup is handled by the agent from that link. Do not require the human to install a connector, configure MCP/pub-sub, run pairing commands, create a separate Matrix account/password, choose a homeserver, or manage normal-path device keys. The coworker follows the chat link and can share it with their own working agent. Recipient message review remains the intended product interaction, not infrastructure setup. The exact secure owner/session binding must satisfy this flow and be proven in the integration spike.


- **P01/P09 — attach to the existing working session (user-directed).** The receiving agent sets up pub/sub so new chat messages notify that same session promptly. Mechanisms can differ between Claude, Codex and other harnesses. Support any model through a vendor-independent protocol and extensible harness adapters. Do not replace the session with a fresh conversation or claim that a protocol alone can wake every harness. Distinguish immediate notification from processing while busy.
- **P03 — TypeScript, Netlify preference (user-directed).** Use TypeScript. Prefer Netlify hosting, serverless Functions and Blobs for state. Avoid a separately hosted Hono service unless a demonstrated requirement needs it. User clarified that Railway hosting is acceptable if an existing backend saves substantial development; compare the tradeoffs before choosing. Compare managed Matrix plus Netlify with a Netlify-native assembly of reusable components; Matrix is not selected simply because it is OSS.


- **P04 — connector-gated airlock (user-directed).** The owner-controlled connector may decrypt and persist pending messages for human review. Only approved messages enter the agent/model context. Separate human-only encryption groups are not required for this boundary. Protect the connector’s pending store and human approval interface from model tools; do not claim resistance to an agent with unrestricted access to the connector host.

- **P12 - per-link admission policy (user-directed, 2026-09-18).** The creator chooses the admission policy when they create the invitation link, and the choice belongs to that link rather than to the room or the account. The default is anyone-with-link-and-no-earlier-history: following the link admits the follower, and an admitted participant sees only events from their own admission forward. A creator who wants something narrower selects it at creation time. A link's policy is fixed once issued; a different policy means a different link. This does not authorise silent re-admission of a revoked participant, and a structural admission rule is not a claim that the transport enforces history exclusion cryptographically. KHA-113 still owns that proof, and `apps/control/src/agent-bootstrap/handler.ts` must keep requiring an explicit `admissionPolicy` rather than inventing a default.

- **P13 - closure promises no deletion (user-directed, 2026-09-18).** Closing a room ends participation and new delivery. It is not a deletion promise and must not be presented as one. Retention work is local cleanup only: each owner's connector and each browser device remove their own copies on their own schedule. Khala makes no claim about copies held by the transport, by another owner's connector, or by a model provider that already consumed released content. KHA-127 and KHA-130 must say this plainly in the interface rather than implying erasure.

- **P14 - no history recovery, no escrow (user-directed, 2026-09-18).** A participant who loses every device loses their history. Khala holds no escrow, and neither the connector, the control plane, the transport, nor another participant is a recovery path. Recovery is limited to re-admission as a new device with no backfill. KHA-129 and KHA-136 must not add a recovery route that depends on any party holding recoverable key material.

- **P15 - native agent surface, CLI first (user-directed, 2026-09-18).** This supersedes the existing-session attachment framing that KHA-103 tested and that parked KHA-117 on G-HARNESSES. Agents install a CLI. For each harness, use that harness's own native mechanism first, its command line or its MCP server, whichever fits that harness; CLIs are priority one. Where a harness has no native route, the agent installs a Khala skill that sets up a listener for released messages and provides a CLI for sending. Humans need a UI that sends and receives in the same room as the agents. Cloud and official-app support for Claude and Codex is desirable but lower priority than the local CLIs. A route is supported only with evidence from the installed CLI; documentation alone never promotes a route to `support: "tested"`.

## Recommendations that are not requirements

The earlier strict review/delivery encryption groups and custom MLS-first preference are superseded by accepted connector gating and OSS reuse. Matrix/Synapse on Railway with the TypeScript web app on Netlify is the current recommendation to validate; it is not a user-selected substrate. A Netlify-native Functions/Blobs design remains the comparison option. The current ticket proposal is revision 4 and replaces the initial custom backend decomposition.

## Approval boundary (superseded by execution authorization below)

Produce the concrete ticket list, dependencies, scope, acceptance criteria and unresolved choices before requesting sign-off. No ticket is approved merely because research supports it. Do not create external Khala tracker issues or start implementation as part of research. Aiur defect reporting is separately authorised in `docs/operations/aiur-coordination.md`. The user's requested order is research/product discussion → ticket sign-off → per-ticket brainstorm and planning.

## 2026-09-16 planning and Executor authorization

The user approved deep research of all 44 tickets using `ce-brainstorm` and `ce-plan`, parallel background agents up to available capacity, documentation commits and pushes to the `research` branch, then transition of the primary agent to `aiur-run` Executor using local `aiurdev`. This supersedes the earlier wait for ticket-scope sign-off. Product choices not answered by that instruction remain gates; a scope approval is not evidence that a feasibility experiment passed.

- **P10 — dashboard-native design (user-directed):** UI agents must study the actual Aiur dashboard. Build Khala as if it were a page in Aiur's left navigation because it may eventually live there. Match dashboard shell, components, density, states and interactions, not merely marketing colors. Preserve current standalone hosting while keeping page content separable from the host shell.
- **Capacity:** measured 16 CPUs, 31 GiB RAM (~20 GiB available) and load ~4.5. Current collaboration harness permits four concurrent agents including parent, so three background planning agents plus the parent fill available session capacity. Later Aiur worker capacity is separately measured and coordinated with the peer fleet.
- **Order:** finish and review all per-ticket research/plans, push `research`, report completion, then perform Executor preflight and operate the authorized Khala instance. No peer repo-local config mutation or uncoordinated shared-release rebuild.

- **P11 — production app origin (user-directed):** Khala will be hosted at `https://khala.aiur.team`. Use this origin for production web links and OAuth registration; the planned callback is `https://khala.aiur.team/api/human/auth/callback`. Preview origins require separate explicit allowlists and credentials. This does not select a messaging backend, Matrix `server_name`, or imply DNS/deployment has been provisioned.

- **P16 — production messaging substrate (user-directed, 2026-09-19).** Matrix Synapse plus PostgreSQL hosted on Railway, as packaged in `infra/messaging` (KHA-108) with the backup, restore and upgrade route from KHA-109. The web app stays on Netlify at `https://khala.aiur.team` (P11). Railway provisioning and credentials are operator-supplied; adapters read endpoints from the deployment configuration and never invent them. This resolves the P03 candidate status: Railway was accepted because the packaged Synapse work already exists and a Netlify-native rebuild would discard it.

- **P17 — Matrix browser-session boundary (user-directed, 2026-09-19).** Server-minted session: Netlify derives a per-owner Matrix password from a deployment secret, provisions the account through Synapse shared-secret registration, exchanges it server-side for a device access token, and returns only that token to the authenticated browser. One OAuth journey is preserved; no reusable Matrix password is stored; all long-lived Matrix secrets stay server-side. Requires a narrow, reviewed amendment to the KHA-108 infrastructure exposing only the shared-secret registration path, never admin routes. Raised by KHA-132 (#41) as dec_cf2b5cfacf2d1b31; alternatives (Synapse OIDC against the same identity provider; a Railway credential broker) were declined for a second sign-in roundtrip and an extra backend respectively.
