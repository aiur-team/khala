# Khala product decisions

Updated 2026-09-16. Ticket scope is approved for detailed planning; individual readiness and unresolved product gates remain explicit.

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
| P07 | History, attachments and retention | Determines disclosure on admission, recovery and content interfaces | Not yet asked |
| P08 | Automatic conversation control | Determines who can pause/resume, budget turns and authorise tools | Not yet asked |

The order is a working interview agenda. Do not treat unanswered questions or recommended options as user decisions. Preserve concrete free-text answers and their implications here as they arrive.

## Settled product choices

- **P06 — no-setup human onboarding (user-directed).** Human signs in with OAuth to identify their email, creates a chat with an optional name, and copies the chat link to their own existing agent and coworker. Agent-side setup is handled by the agent from that link. Do not require the human to install a connector, configure MCP/pub-sub, run pairing commands, create a separate Matrix account/password, choose a homeserver, or manage normal-path device keys. The coworker follows the chat link and can share it with their own working agent. Recipient message review remains the intended product interaction, not infrastructure setup. The exact secure owner/session binding must satisfy this flow and be proven in the integration spike.


- **P01/P09 — attach to the existing working session (user-directed).** The receiving agent sets up pub/sub so new chat messages notify that same session promptly. Mechanisms can differ between Claude, Codex and other harnesses. Support any model through a vendor-independent protocol and extensible harness adapters. Do not replace the session with a fresh conversation or claim that a protocol alone can wake every harness. Distinguish immediate notification from processing while busy.
- **P03 — TypeScript, Netlify preference (user-directed).** Use TypeScript. Prefer Netlify hosting, serverless Functions and Blobs for state. Avoid a separately hosted Hono service unless a demonstrated requirement needs it. User clarified that Railway hosting is acceptable if an existing backend saves substantial development; compare the tradeoffs before choosing. Compare managed Matrix plus Netlify with a Netlify-native assembly of reusable components; Matrix is not selected simply because it is OSS.


- **P04 — connector-gated airlock (user-directed).** The owner-controlled connector may decrypt and persist pending messages for human review. Only approved messages enter the agent/model context. Separate human-only encryption groups are not required for this boundary. Protect the connector’s pending store and human approval interface from model tools; do not claim resistance to an agent with unrestricted access to the connector host.

## Recommendations that are not requirements

The earlier strict review/delivery encryption groups and custom MLS-first preference are superseded by accepted connector gating and OSS reuse. Matrix/Synapse on Railway with the TypeScript web app on Netlify is the current recommendation to validate; it is not a user-selected substrate. A Netlify-native Functions/Blobs design remains the comparison option. The current ticket proposal is revision 4 and replaces the initial custom backend decomposition.

## Approval boundary (superseded by execution authorization below)

Produce the concrete ticket list, dependencies, scope, acceptance criteria and unresolved choices before requesting sign-off. No ticket is approved merely because research supports it. Do not create external Khala tracker issues or start implementation as part of research. Aiur defect reporting is separately authorised in `docs/operations/aiur-coordination.md`. The user's requested order is research/product discussion → ticket sign-off → per-ticket brainstorm and planning.

## 2026-09-16 planning and Executor authorization

The user approved deep research of all 44 tickets using `ce-brainstorm` and `ce-plan`, parallel background agents up to available capacity, documentation commits and pushes to the `research` branch, then transition of the primary agent to `aiur-run` Executor using local `aiurdev`. This supersedes the earlier wait for ticket-scope sign-off. Product choices not answered by that instruction remain gates; a scope approval is not evidence that a feasibility experiment passed.

- **P10 — dashboard-native design (user-directed):** UI agents must study the actual Aiur dashboard. Build Khala as if it were a page in Aiur's left navigation because it may eventually live there. Match dashboard shell, components, density, states and interactions, not merely marketing colors. Preserve current standalone hosting while keeping page content separable from the host shell.
- **Capacity:** measured 16 CPUs, 31 GiB RAM (~20 GiB available) and load ~4.5. Current collaboration harness permits four concurrent agents including parent, so three background planning agents plus the parent fill available session capacity. Later Aiur worker capacity is separately measured and coordinated with the peer fleet.
- **Order:** finish and review all per-ticket research/plans, push `research`, report completion, then perform Executor preflight and operate the authorized Khala instance. No peer repo-local config mutation or uncoordinated shared-release rebuild.
