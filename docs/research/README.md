# Research continuation — 16 September 2026

## Origin recovered

Claude session `bcca04a8-b41d-403f-aa1d-d6add4fffd16`, started from `../archon`:

`~/.claude/projects/-home-everdred-github-everdred-archon/bcca04a8-b41d-403f-aa1d-d6add4fffd16.jsonl`

The Khala commissioning message is at zero-based JSONL record 8869, timestamp `2026-09-16T17:21:03.901Z` (10:21 Pacific). It asks for secure cross-owner, cross-model human/agent conversations, minimum two humans and two agents, and a new `aiur-team/khala` repository with research on a `research` branch. Follow-ups require E2EE, recipient preview of one or several queued messages, and the ability to disable the airlock after trust develops. The user later said “stop agents”; no Claude research agents were restarted for this continuation.

The session spawned parallel protocol, substrate, identity/trust, and E2EE research, with further specialised tracks. Reports were extracted into `/home/everdred/tmp-agents/khala`, but Claude exhausted its session allowance before completing the handoff. GitHub inspection during recovery found the private repository with no branches. This local workspace was initially empty. During the continuation the user cloned the repository here; its initial `main` commit is `6d46941` and its origin is `git@github.com:aiur-team/khala.git`. This continuation saves research here; it does not claim the earlier push succeeded.

## Current direction

Later user decisions supersede early recommendations: TypeScript application code; prefer Netlify Functions/Blobs but consider Railway if OSS reuse saves substantial development; connector-gated review is accepted; attach pub/sub to the existing working agent session across model vendors; inherit Aiur branding; OAuth → optionally named channel → share link, with no human connector setup. Read [hosting pros and cons](11-hosting-tradeoffs.md), [product decisions](../product/decisions.md), and the current synthesis rather than treating the recovered reports as chosen architecture.

## Current research coverage

The requested parallel continuation has produced current protocol, substrate, prompt-injection, identity, E2EE, state/transport, security-evidence, branding and hosting comparisons. Three parallel agents researched and cross-checked backend/protocol, identity/crypto, and brand/client reuse tracks; the parent integrated product decisions and tickets. This is source-grounded research, not runtime verification.

## Reading order

| Document | Purpose |
|---|---|
| [Ticket scope, revision 4](../product/ticket-breakdown.md) | Approved planning scope, dependencies and acceptance criteria; all 44 detailed plans are written and reviewed |
| [Hosting comparison](11-hosting-tradeoffs.md) | Matrix on Railway versus Netlify-native pros and cons |
| [Protocols and agent attachment](01-agent-protocols.md) | Model-independent interface and existing-session notifications |
| [Substrates](02-substrates.md) | OSS reuse and minimal custom components |
| [Peer-content controls](03-prompt-injection.md) | Airlock limits, model tools, deterministic acceptance tests |
| [Security evidence](08-security-evidence.md) | Primary-source claims and disposition of historical security reports |
| [Aiur brand and experience](09-brand-and-product-experience.md) | Exact sibling assets/tokens and reusable client options |
| [Recovered scope](recovered/SCOPE.md) | Original requirements and airlock follow-ups |
| [Architecture](06-architecture.md) | Recommendation, encryption boundaries, substrate choices, Archon reuse |
| [Identity and trust](04-identity-trust.md) | Human/agent delegation, invitations, policy, provenance |
| [E2EE](05-e2ee.md) | Key custody, library evaluation, recovery, precise confidentiality claim |
| [State and transport](07-state-and-transport.md) | Durable state, WebSockets, replay, idempotency, client state |
| [Recovered reports](recovered/README.md) | Original findings; some claims require correction or verification |

`recovered/05c-mls-ecosystem.md` was additionally recovered from a completed task notification after the session limit. `*.PARTIAL.md` are original placeholders, not completed reports. The recovered README predates the additional reports and its completeness table is stale; this index is authoritative for the continuation.

## Evidence and corrections

New documents distinguish inspected local implementation, primary-source facts, and proposed Khala design. Archon reference commit: `c7d3254097acaa02eed1e3be6fd8fbf06c0e8128`. Source links into `../archon` assume these repositories remain siblings.

Do not adopt the earlier Slack/email recommendation as satisfying E2EE. Ordinary transport encryption does not make those substrates platform-blind. Do not adopt “Matrix is the only option” as an architectural conclusion: a custom MLS delivery service is another option, and federation was not explicitly required by the user.

The Matrix device-verification issue is real, but a universal October 2026 cutoff is not established. [Matrix's announcement](https://matrix.org/blog/2025/11/exclude-insecure-devices/) gives an April 2026 Element plan; [mautrix's current documentation](https://docs.mau.fi/bridges/general/troubleshooting.html) mentions October and also retains April wording. The actionable requirement is to test verified bot devices with the exact client/SDK versions, rather than rely on one ecosystem-wide date. That documentation also describes `self_sign`; “no usable bot self-verification exists” is too broad.

The earlier MCP report treats the July revision as settled deployment reality. The [official July release-candidate announcement](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/) describes deprecation with compatibility, not immediate disappearance. Khala's adapter should negotiate supported revisions and avoid depending on sampling, regardless of adoption timing.

Recovered market-share numbers, production-adoption claims, prompt-injection percentages, confidential-computing attack details, and library release versions have not all been independently rechecked. They should not drive a launch claim. This continuation concentrates on the technical decisions needed for Khala.
