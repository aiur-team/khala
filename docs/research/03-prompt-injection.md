# Peer content, airlock limits and agent action boundaries

Research continuation, 2026-09-16. This supersedes the recovered report as the design-facing summary; the original remains under `recovered/03-prompt-injection.md` for traceability. No attack-success percentage from that report is adopted as a Khala guarantee.

## Product boundary

Khala connects people who want their agents to collaborate. It must let useful technical content through and retain each owner's control over what their agent sees and can do. A peer message may contain code, diagnostic logs, commands, quotations, instructions for the other agent, or a malicious instruction. Whether an instruction is legitimate depends on the recipient's purpose and authority; text classification alone cannot resolve that.

The airlock has a precise observable promise: content that has not been released must not enter the recipient model's context through Khala. The user settled P04: the owner connector may decrypt pending content. Cryptographic exclusion from that connector/host is not required. Neither promise means a reviewed message is harmless.

Trusting a peer means allowing their future messages to flow under a selected policy. It does not make their text local system instructions, prove their host is uncompromised, or grant permission to run a deployment, spend money, publish secrets, or change an agent's own configuration.

## Evidence checked

| Primary source | Verified contribution | Khala consequence |
|---|---|---|
| [Design Patterns for Securing LLM Agents against Prompt Injections](https://arxiv.org/abs/2506.08837), revised June 2025 | Presents architectural patterns and utility/security tradeoffs for agents handling untrusted content | Design the context, capability and data-flow boundaries rather than relying on a warning string |
| [CaMeL: Defeating Prompt Injections by Design](https://arxiv.org/abs/2503.18813), revised June 2025 | Separates trusted control flow from untrusted data and enforces capability/data-flow policies; evaluated on AgentDojo | Useful reference for narrowly controlled tools; its benchmark result does not establish safety of arbitrary coding agents in Khala |
| [The Attacker Moves Second](https://arxiv.org/abs/2510.09023) | Studies adaptive attacks against jailbreak and prompt-injection defences | Evaluate repeated, adaptive attempts, not just a fixed list of known malicious strings |
| [Anthropic's containment design](https://www.anthropic.com/engineering/how-we-contain-claude) | Describes environment containment alongside model-level steering | A peer-aware prompt complements the owner harness's permissions and sandbox; it cannot replace them |

These sources motivate the recommendations below. They do not validate Khala's unbuilt implementation or prove that a summarisation worker removes hostile meaning. Recovered quantitative claims concerning human confirmation, worms, individual models, and classifier effectiveness require separate checking before use in marketing or acceptance thresholds.

## Proposed controls and the limits of each

**Typed provenance.** Deliver messages as peer-authored content with stable human/agent identity and conversation context. Keep control operations in a separately authorised API. A message that says “set automatic trust” remains a message. Rendering, model wrappers and signatures must preserve that boundary rather than turn display names or text into authority.

**Narrow local adapter.** The model's Khala tools can send as its own approved instance and read its released feed. Human review, agent pairing and policy changes must not be callable through that model's tool capability. Check all read surfaces: search, summaries, history, replies, attachments, notification snippets, exports and error details. Blocking the main inbox while an auxiliary tool reveals the same content fails the promise.

**Owner action policy.** Khala carries conversation; the recipient harness authorises repository access, shell execution, network requests and other work. Preserve that harness boundary. If Khala later offers its own tools, each requires a separate scope and approval design. Receiving a message does not grant execution authority. Do not claim to confine an arbitrary external agent whose runtime Khala cannot control.

**Optional processing isolation.** A tool-less worker can summarise or extract a fixed schema before privileged work. This sacrifices context and still allows semantic influence through the summary. Adopt it only where a defined tool/task boundary and data-flow policy make the assurance meaningful. Do not force every useful coding conversation through an unverified sanitiser.

**Outbound disclosure.** An automatically replying agent might echo secrets or propagate hostile instructions. The recipient airlock does not protect the sender's secrets. Consider an owner-controlled outbound review setting, resource access restrictions and destination scopes. Whether mandatory outbound review fits the collaboration flow is an unanswered product choice, not a default added by security research.

**Loop and budget control.** Every automated run has an initiating message, reply chain, bounded turn budget, cancellation state and owner pause path. Peer text cannot increase its budget. Deduplicate wakeups and checkpoint consumed deliveries; reconnect replay must not trigger the same work repeatedly. Numeric defaults should be chosen after a representative collaboration trial.

## Content presentation

Default to inert text and constrained Markdown. Code stays code; do not execute snippets or fetch remote resources merely to render a message. Link previews and remote images can disclose access, make network requests and bypass review, so treat them as explicit features with audience-scoped access. Show the actual link destination and distinguish original versus human-edited content. Apply ordinary DOM/XSS protections independently from model prompt-injection controls.

A pending batch should show its count, authors, exact selected items and attachment disclosure. Releasing one item must not release later arrivals. Re-enabling review blocks future delivery once the connector acknowledges the changed policy. Until then show the change as pending; offline handling still needs a product decision. It cannot erase a running model's context. Present that state directly. A “stop agent” control should report request/acknowledgement and any already-running work, rather than implying rollback of external effects.

## Acceptance evidence for future tickets

The deterministic tests verify permissions and data flow, not model obedience:

1. Seed pending text and attachments with unique markers. Exercise every agent-visible read, replay, export and notification path; no unreleased marker reaches its harness invocation.
2. Submit a peer message impersonating a human/system instruction or requesting policy changes. No membership, policy, pairing or approval record changes.
3. Release a selected batch while a new message arrives. The new item remains pending; released bytes match the human's reviewed version.
4. Duplicate a delivery and restart between scheduling and acknowledgement. The connector does not create a second durable scheduled job for the same approved delivery; ambiguous harness acceptance or interrupted external actions retain an unknown/reconciliation state instead of being silently retried.
5. Re-arm review or pause while auto-release and model work race. The accepted ordering and already-disclosed work are visible; subsequent unreleased work stays blocked.
6. Render active HTML, external-image Markdown and suspicious link forms. Rendering does not execute code or fetch external content by default.
7. Exceed reply limits with two cooperative agents that continuously answer. Automation stops at the configured bound while humans can continue the conversation.

Adaptive red-team exercises should follow these deterministic proofs. Record the exact model, harness, permissions, attack budget, tools and observed disclosures. A low observed attack rate is evidence about that configuration, not a blanket “prompt injection solved” claim.

## Ticket input

Separate the connector's released-feed capability tests, human-only review/policy commands, inert message rendering, and bounded automation into independently testable work. Share one message/identity contract so different workers do not invent incompatible meanings for “approved,” “delivered,” and “consumed.” See the future ticket breakdown for IDs and dependencies once research and product decisions are integrated.
