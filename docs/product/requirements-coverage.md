# Requirements coverage for ticket review

Audited 2026-09-16 against the recovered commissioning conversation and subsequent user messages. Ticket reference: [revision 4](ticket-breakdown.md). These requirement IDs are traceability labels for later plans; they do not turn unapproved technical recommendations into requirements.

| Requirement | User-directed outcome or constraint | Ticket coverage | Evidence required from implementation |
|---|---|---|---|
| R01 | Shared conversation with at least two humans and two agents, expandable beyond four actors | KHA-112, KHA-123, KHA-132, KHA-137, KHA-139 | Four-actor complete task plus third human/agent admission; independent participant state, no two-owner assumptions |
| R02 | Humans read the shared chat and add messages as themselves | KHA-110, KHA-123, KHA-132, KHA-139 | Both humans see the conversation and post with distinct authenticated attribution |
| R03 | Creator or their agent can queue one or several messages before recipient-agent disclosure | KHA-112, KHA-122, KHA-125, KHA-134, KHA-139 | Human-created and delegated agent-created batches; recipient preview works before pairing/release; creator authority remains explicit |
| R04 | Recipient controls what enters their agent; connector-gated review is acceptable | KHA-106, KHA-115, KHA-119, KHA-121, KHA-125, KHA-133, KHA-134, KHA-138 | Connector can hold pending plaintext; every model-facing read/notification surface excludes unreleased content; exact-item/version release |
| R05 | Human can disable review when trusting a peer and turn it back on | KHA-120, KHA-126, KHA-135, KHA-138 | Effective policy acknowledged at connector; pending/offline policy changes visible; existing context cannot be retroactively withdrawn |
| R06 | End-to-end encrypted conversations | KHA-102, KHA-105, KHA-108, KHA-111, KHA-115, KHA-128, KHA-129, KHA-138, KHA-141, KHA-142 | Supported SDK/engine, device verification/recovery, server inspection showing no message keys/plaintext; downstream model disclosure described accurately |
| R07 | Attach to the existing working agent session, retaining context and workspace | KHA-103, KHA-104, KHA-114, KHA-117, KHA-118, KHA-133, KHA-139 | Real existing session IDs preserved during setup, live message receipt, busy delivery and same-session reconnect/resume |
| R08 | Agent sets up immediate pub/sub using the harness's supported mechanism | KHA-103, KHA-104, KHA-116, KHA-117, KHA-118, KHA-133, KHA-139 | Authenticated setup probe, live subscription, measured receipt/enqueue/consumption, clear unsupported or opt-in-required status |
| R09 | Support any model and cross-owner conversations | KHA-105, KHA-106, KHA-117, KHA-118, KHA-137, KHA-139 | Vendor-independent protocol, documented adapter capabilities/fixtures, representative harness tests; no untested claim of universal runtime injection |
| R10 | Use TypeScript for Khala code and maximise existing OSS reuse | KHA-101, KHA-102, KHA-107, KHA-141, KHA-142, KHA-143 | Pinned component inventory, license identities, integration boundaries and rejection rationale for unnecessary custom implementations |
| R11 | Prefer Netlify Functions/Blobs; Railway backend acceptable if it saves development; avoid unnecessary Hono daemon | KHA-102, KHA-108, KHA-109, KHA-131 | Compare actual components/custom work/operation; record chosen topology explicitly; no accidental extra app server |
| R12 | Inherit Aiur product branding from Archon and Aiur | KHA-107, KHA-122, KHA-123, KHA-124, KHA-125, KHA-126, KHA-127, KHA-139 | Exact asset/token/type provenance; desktop/mobile/keyboard/contrast checks; no invented replacement identity |
| R13 | Research through parallel agents and ask product questions before planning | KHA-102, KHA-103, KHA-104, KHA-141, KHA-142, KHA-143, KHA-144 | Parallel protocol/state, security and brand reports; primary-source/local evidence; recorded answers and unresolved questions |
| R15 | No-setup onboarding: Archon-like OAuth, optionally named chat, share link to own agent and coworker | KHA-103, KHA-104, KHA-110, KHA-111, KHA-114, KHA-122, KHA-124, KHA-132, KHA-133, KHA-139, KHA-144 | A new human completes the ordinary journey without connector install/config, pairing commands, homeserver choice, separate Matrix registration or manual keys; agent sets up its own integration |
| R14 | Propose tickets for user sign-off, then use ce-brainstorm and ce-plan for detailed lower-model implementation docs | All approved KHA-101–144 scope cards; detailed plans after sign-off | Approval tied to proposal revision; canonical per-ticket product contract enriched to implementation-ready plan with required reviews and exact verification |

## Audit findings addressed

- The initial proposal treated separate cryptographic audiences as necessary. User accepted connector gating; current documents remove that mandatory complexity.
- The original custom log/WebSocket/MLS tickets would have bypassed the OSS preference. Revision 2 uses integration tickets and leaves substrate selection explicit.
- Initial acceptance language implied exactly-once external model execution. Current tickets guarantee local deduplication and require explicit unknown-outcome reconciliation when a harness does not acknowledge acceptance.
- “Expandable” was present in prose but only four actors were tested. KHA-139 now includes a third owner/agent pair with independent review states.
- Agent-authored introductory messages were at risk of implying permission to create rooms. KHA-112 distinguishes those capabilities and leaves agent-created rooms as a product choice.

## What is already evidenced

Current research covers protocols/substrates, peer-content handling, identity, E2EE/custody, backend state/realtime, branding and hosting tradeoffs. The [research index](../research/README.md) links all current reports. Historical material remains preserved, with incomplete or unverified claims labelled. Branding was traced to actual sibling sources. The ticket proposal includes dependencies, acceptance boundaries and conditional features.

These facts establish research and proposal progress, not a working product. No Khala code, E2EE interoperability test, deployed service, measured latency or production cost benchmark exists yet.

## What is not yet approved or complete

- The ticket structure is approved for detailed planning; Matrix/Railway selection remains a separate pending question.
- Product questions about the first collaboration task, unattended operation, admission, history/attachments, busy-session behaviour and trust/backlog policy remain open.
- The requested per-ticket `ce-brainstorm` and `ce-plan` work is in progress, preserving the user's ordering.
- No Khala implementation, external issue creation, paid infrastructure provisioning or Aiur launch is implied by this audit.

Aiur bug reporting and executor coordination are separately authorised and recorded in [operations](../operations/aiur-coordination.md).
