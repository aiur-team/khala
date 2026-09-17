# Agent-to-agent protocols for a 4+ party cross-org, cross-vendor conversation

**Bottom line up front:** none of the named standards implements the thing you described. A2A, MCP, ACP and AGNTCY are all built around *one agent calling another agent or tool* — a directed, pairwise, request/response relationship with a task at the end of it. A shared room with two humans and two agents, all of whom see the same messages, is a *group messaging* problem, and the only mature group-messaging systems with cross-org federation and end-to-end encryption come from the instant-messaging world (Matrix, MLS), not from the agent-protocol world. The one agent-native effort that is genuinely aimed at your shape of problem — Cisco's SLIM — is an unadopted individual IETF draft with a ~200-star repo. Details below.

---

## 1. Google Agent2Agent (A2A)

**Stewardship.** Google donated A2A to the Linux Foundation in June 2025 ([announcement](https://developers.googleblog.com/en/google-cloud-donates-a2a-to-linux-foundation/), [LF press](https://www.linuxfoundation.org/press/linux-foundation-launches-the-agent2agent-protocol-project-to-enable-secure-intelligent-communication-between-ai-agents)). On **17 August 2026** it moved again, into the **Agentic AI Foundation (AAIF)** — the LF directed fund formed 9 December 2025 by Anthropic, Block, OpenAI, AWS, Bloomberg, Cloudflare, Google and Microsoft, which already hosted MCP, goose and AGENTS.md ([LF press](https://www.linuxfoundation.org/press/linux-foundation-announces-the-formation-of-the-agentic-ai-foundation), [Forbes](https://www.forbes.com/sites/janakirammsv/2026/08/19/agent2agent-joins-the-agentic-ai-foundation-alongside-mcp/)). So MCP and A2A now sit under one roof. Note this was a governance reshuffle, not a technical merger — the two protocols remain separate specs with separate scopes.

**Maturity and adoption.** Genuinely the most adopted of the lot. v1.0.0 shipped in 2026, 1.0.1 in May 2026, and the LF claims **150+ organisations**, first-party support in Google Cloud, Azure and AWS, and production deployments in supply chain, financial services, insurance and IT ops ([LF press, April 2026](https://www.linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations-lands-in-major-cloud-platforms-and-sees-enterprise-production-use-in-first-year)). This is real, not vapour. Treat the "150 organisations" figure as a membership/logo count rather than evidence of 150 interoperating deployments.

**Multi-party: no.** This is the disqualifying detail. The [spec](https://a2a-protocol.org/latest/specification/) is client-to-remote-agent and pairwise. A `Task` belongs to exactly one remote agent server. The only grouping primitive is `contextId`, which "logically groups multiple related Task and Message objects" — but that is a correlation key an orchestrator uses to stitch together several independent pairwise calls, not a shared channel. There is no broadcast, no membership list, no "who else is in this conversation". Microsoft's own [guidance on context passing](https://devblogs.microsoft.com/ise/a2a-context-passing-multi-agent-systems/) makes the architecture explicit: a coordinator agent sits in the middle and decides what each domain agent gets to see. Every real "multi-agent A2A" deployment is a star topology with a hub. Your scenario has no natural hub — neither company owns the conversation.

**Cross-org authentication.** The best-developed part. Agent Cards are discoverable JSON describing capabilities and `securitySchemes`; the spec leans on existing standards rather than inventing — OAuth2 (auth code, client credentials, device code), mTLS, HTTP auth schemes, and **JWS-signed Agent Cards** for card integrity (spec §8.4). This is adequate for "company A's agent proves it is company A's agent to company B's endpoint". It gives you no notion of a *conversation-scoped* identity for four parties.

**Confidentiality: transport only.** The spec assumes HTTPS and specifies nothing at the application layer. Payloads are plaintext to any TLS-terminating proxy, gateway, or cloud A2A relay in the path. For a cross-company conversation where both sides' infrastructure teams can read the transcript, that may or may not matter to you — but be clear that A2A gives you *no* end-to-end guarantee.

**Humans: second-class but present.** `TASK_STATE_INPUT_REQUIRED` and `TASK_STATE_AUTH_REQUIRED` let an agent pause and ask for something. That models "agent blocks on human approval", not "human is a participant who can interject unprompted". There is no standard human identity, no human-authored message type; practitioners stuff human-in-the-loop payloads into a `DataPart` by convention ([ADK discussion](https://github.com/google/adk-python/discussions/3276)). A human cannot barge into an A2A task mid-flight; they can only answer when asked.

**Cost to adopt.** Low per-hop — SDKs in Python/Java/JS/Go, well documented, both sides likely already have A2A support in their agent framework. But you would be building the multi-party layer yourself: someone has to run a hub, and that hub sees everything.

---

## 2. Model Context Protocol

**You are right that it is the wrong tool, and it got *more* wrong this year, not less.** MCP is client↔server for tools, resources and prompts. The agent is the client; the thing being called is the server. The relationship is asymmetric by construction: servers expose capability, clients consume it.

The boundary is worth stating precisely, because it is not "MCP can't reach across a network". MCP over Streamable HTTP with OAuth absolutely works across organisational boundaries — remote MCP servers from third parties are routine. The boundary is **asymmetry and the absence of an identity for the calling *agent* as a peer**. In MCP the caller is an application holding a token; there is no notion of two MCP endpoints being co-equal parties in one conversation, no shared session both can post into, no addressing of a third participant.

**The extension-toward-A2A story is now mostly dead.** `sampling` — the server-initiates-a-model-call-back-to-the-client primitive, the one feature that looked like a path to peer-to-peer — was **deprecated in the 2026-07-28 spec** and is scheduled for removal, alongside Roots and Logging ([spec release post](https://blog.modelcontextprotocol.io/posts/2026-07-28/)). That same release made MCP **stateless**: the `initialize`/`initialized` handshake and session IDs are gone, requests carry protocol version and client identity in metadata, and server-initiated streams were replaced by **Multi Round-Trip Requests** — the server returns `resultType: "input_required"` and the client re-issues the call with answers attached. That is deliberate movement *away* from long-lived bidirectional sessions and toward stateless load-balanced RPC. It is excellent for tools and fatal for peer conversation.

You can of course *wrap* a peer as an MCP server ("tool: send_message_to_other_agent"). People do this. It works, and for a 2-agent handoff it is the cheapest thing that could possibly work. It does not scale to a shared multi-party transcript and it makes the other agent look like a vending machine rather than a participant.

**Verdict:** use MCP as the *interface* between each agent and whatever transport you choose. Do not use it *as* the transport between agents.

---

## 3. IBM / BeeAI Agent Communication Protocol (ACP)

**Dead as an independent protocol. Do not start here.** IBM Research launched ACP in March 2025 for the BeeAI platform — REST-based agent invocation, a manifest per agent, work submitted as "runs" carrying MIME-typed message parts. BeeAI was donated to the Linux Foundation, and in **August 2025 ACP formally merged into A2A** under LF AI & Data; the two teams consolidated into a single standard and BeeAI itself was re-platformed onto A2A ([LFAI announcement](https://lfaidata.foundation/communityblog/2025/08/29/acp-joins-forces-with-a2a-under-the-linux-foundations-lf-ai-data/), [i-am-bee discussion](https://github.com/orgs/i-am-bee/discussions/5)).

Be aware that a lot of 2026 blog content still lists "MCP, A2A, ACP" as three live options — that content is stale by a year. The one genuinely interesting thing ACP had that A2A lacks is that its framing explicitly included *humans* alongside agents and applications as message senders. That framing did not obviously survive the merge.

---

## 4. AGNTCY / Internet of Agents (Cisco)

**What it is.** A Cisco/Outshift-originated stack, open-sourced March 2025, accepted by the Linux Foundation with Cisco, Dell, Google Cloud, Oracle and Red Hat as formative members and 65+ supporting companies ([LF press](https://www.linuxfoundation.org/press/linux-foundation-welcomes-the-agntcy-project-to-standardize-open-multi-agent-system-infrastructure-and-break-down-ai-agent-silos)). Note it is **not** in AAIF — different LF home from MCP/A2A, which is itself a signal about consolidation. Components ([docs.agntcy.org](https://docs.agntcy.org/)):

- **OASF** (Open Agent Schema Framework) — data model for agent attributes and skills. Overlaps A2A Agent Cards.
- **Agent Directory Service** — federated registry for publishing, verifying and discovering agents.
- **Identity** — decentralised identity for agents and tools: identifiers, verifiable credentials, policy-based access.
- **SLIM** — the messaging layer, below.
- **SHADI**, observability/eval — runtime sandbox and telemetry.

**SLIM is the single most on-point technology in this entire report.** Per the [overview](https://slim.agntcy.org/latest/slim/slim-overview/) and the [IETF draft](https://www.ietf.org/archive/id/draft-mpsb-agntcy-slim-00.html), SLIM is gRPC over HTTP/2/3 with four session types: point-to-point, **group/multicast** (agents join shared channels named hierarchically), RPC, and multicast RPC. Groups of more than two are native. **MLS (RFC 9420) provides genuine end-to-end group encryption at the session layer** — explicitly designed so that "even a compromised routing node cannot read message content", surviving TLS termination at intermediaries. Identity is DID-shaped (`organization/namespace/service/<hash-of-public-key>`) with SPIRE-based federation for cross-org trust. AGNTCY's own marketing calls out human-in-the-loop and quantum-safe design. On paper this is *exactly* your requirement: multi-party, cross-org, E2E confidential, humans and agents as peers.

**Now the cold water.** The spec is **`draft-mpsb-agntcy-slim`, an individual Internet-Draft** — at -02 as of 7 July 2026, expiring 8 January 2027, all four authors from Cisco, **not adopted by any IETF working group**, no chartered WG, no BOF, IESG state "I-D Exists", no responsible AD. The document carries the standard "not endorsed by the IETF... no formal standing in the IETF standards process" boilerplate. The [reference implementation](https://github.com/agntcy/slim) has roughly **212 stars and 47 forks**. v1.1 milestone closed May 2026. That is a small research-grade project, not an ecosystem. The documentation site does not state maturity levels for any AGNTCY component, which is itself telling. And the overview docs, despite the marketing, **do not model human participants** — SLIM addresses agent-to-agent communication; humans are a slide, not a protocol construct.

**Cost to adopt:** you would be an early adopter of an unratified protocol from one vendor, running your own SLIM routing nodes, on both sides of an inter-company boundary, with Rust/Python/Go bindings that changed API surface within the last four months. For two companies wanting to stop copy-pasting, that is a large bet.

---

## 5. DIDComm v2

**What it is.** DID-based, transport-agnostic, end-to-end encrypted and authenticated messaging. Keys come from DID documents, so there is no shared registry and no central server; sender authentication and encryption are in the message envelope (JWE/JWM), not the transport. It supports routing through mediators without those mediators reading content. This is the only technology in this report where cross-organisation trust *without a common vendor* is the founding assumption rather than an afterthought.

**Maturity.** The v2.0 spec reached DIF **Approved** status in July 2022 and the ecosystem is now on **v2.1** ([DIF announcement](https://blog.identity.foundation/didcomm-v2/), [spec](https://identity.foundation/didcomm-messaging/spec/v2.0/)). Multiple implementations at varying conformance ([repo](https://github.com/decentralized-identity/didcomm-messaging)). It is *stable* rather than *growing* — the spec has not moved much in four years, and a mooted v3 as an IETF standard with a session construct remains imagined, not drafted. Historically its centre of gravity was Hyperledger Aries and verifiable-credential exchange, which is a shrinking constituency.

**Multi-party:** partial and awkward. DIDComm has protocols for multi-recipient encryption and there is a `coordinate-mediation` / routing story, but group conversation with consistent membership and forward secrecy is *not* a solved DIDComm primitive the way it is in MLS. You would be building group semantics on top.

**Is anyone using it for agents?** Yes, and this is the genuinely newer news. **Affinidi** is marketing an explicit ["cross-org agent trust"](https://www.affinidi.com/solutions/cross-org-agent-trust) stack built on W3C VCs, **DIDComm v2.1**, ToIP **Trust Spanning Protocol** (TSP Rev2), SD-JWT and OID4VCI/VP, with a Trust Registry Query Protocol for real-time authorisation and post-quantum signatures (ML-DSA, SLH-DSA). They claim **first TSP integration in production** and, with CardInfoLink, [what they believe is the first commercial deployment in Asia](https://www.affinidi.com/newsroom/affinidi-and-cardinfolink-put-the-missing-trust-layer-for-ai-agents-into-production) running AI agents under an independent trust and governance layer (June 2026, agentic commerce for travel/hospitality). Take vendor "first in production" claims with appropriate salt, but the code exists ([Dart DIDComm library](https://github.com/affinidi/affinidi-didcomm-dart)).

**Humans:** DIDComm is identity-agnostic — a human with a DID and a wallet is exactly as much a first-class participant as an agent. That is a real advantage over everything in sections 1–4. But there is no human-usable client; you would be writing the UI.

**Cost to adopt:** high. DID method choice, resolver infrastructure, key management, wallets, and you still have to build group conversation and a chat UI. Justified if cross-org cryptographic trust is the core requirement; overkill if the real problem is two people wanting a shared channel.

---

## 6. Things you didn't name

### Matrix — the pragmatic answer, and I'd argue the strongest one
This is what I'd actually point at. Matrix is a federated, decentralised messaging protocol where **rooms are the primitive**: N participants, any mix of humans and bots, each on their own homeserver under their own organisation's control, with **E2EE via Olm/Megolm** so the homeservers only ever see ciphertext. Cross-org federation is the entire design. Humans are first-class by definition — that is what it was built for. Multi-party is not an extension, it is the base case.

And the agent ecosystem has already arrived there on its own, without a standards body:
- **OpenClaw** (the ex-Warelay/Moltbot self-hosted agent gateway, ~250K stars, v2026.9.x current) ships a first-class [Matrix channel adapter](https://openclawdoc.com/docs/channels/matrix/) using matrix-js-sdk with DMs, rooms, threads, reactions and **E2EE via the Rust crypto SDK**. Its architecture deliberately separates channel / gateway / agent-runner so the agent logic doesn't know which network a message arrived on.
- Practitioners are already running **multiple agents in one encrypted room** and have hit and solved the obvious problem: [agents seeing each other's messages and looping](https://calegix.com/posts/e2ee-by-default-for-agent-chatter), fixed with a sibling-agent filter at the adapter level. That is a *very* good sign — it means people are past "can this work" and into "here is the specific operational gotcha".
- There are purpose-built bridges, e.g. [matrix-bridge](https://github.com/elkimek/matrix-bridge), an E2EE Matrix bridge exposed as both a CLI and an **MCP server for any AI coding agent** — which is precisely the right layering: MCP as the agent's local interface, Matrix as the federated multi-party transport.
- Alibaba's HiClaw reportedly treats agent communication as a messaging problem and uses Matrix as transport.

Known rough edge: **E2EE device verification was designed for humans**, so onboarding a bot's device involves workarounds. It works once set up, but expect a bad afternoon.

Cost to adopt: low-to-moderate and, critically, *incremental*. Each side runs (or rents) a homeserver, each agent gets an account, both humans join the room in Element. It generalises to N participants for free, works across vendors because neither agent needs to know what model the other runs, and both humans can watch and interject natively because it is a chat app. The tradeoff is that you get no agent-semantic layer: no capability discovery, no task lifecycle, no structured handoff. Messages are messages. For your stated problem — stop being meat proxies — that is arguably the correct amount of protocol.

### CHAP (Collaborative Human-Agent Protocol)
The most interesting *new* thing, and it targets the gap you identified. Open-sourced by Brightbeam AI, [spec](https://github.com/BrightbeamAI/chap/blob/main/SPECIFICATION.md) + [paper (arXiv:2606.09751)](https://arxiv.org/abs/2606.09751). Its explicit thesis is the one in your brief: *"MCP connects agents to tools, A2A connects agents to each other. Both leave out the one party a regulated business cannot treat as optional: the responsible human."* It standardises the verbs of shared work — delegate, accept, decline, review, approve, override, abstain, escalate, hand off — and emits a verifiable audit trail as a byproduct. It describes itself as supporting **multi-human and multi-agent** collaboration, sits *beside* MCP and A2A rather than replacing them, is CC-BY/Apache-2.0, and has runtime adapters for Spring AI, LangChain4j, Google ADK and Quarkus.

Caveats, stated by the project itself: **CHAP 0.2 is a public Draft**, "stable enough for experimentation and early production pilots… not yet sufficient for a normative conformance claim." It is one company, driven substantially by EU AI Act Article 14 compliance demand rather than by your use case. It is not a transport — it assumes you have one. But conceptually it is the only thing I found that models humans and agents as co-equal participants in shared work, and it is worth reading even if you don't adopt it.

### Also noted, mostly not relevant
- **Microsoft Agent Framework group chat orchestration** ([docs](https://learn.microsoft.com/en-us/agent-framework/workflows/orchestrations/group-chat)) — genuine multi-agent group chat with orchestrator-driven speaker selection, but it is a **star topology inside one process/tenant**. Not a cross-org protocol. Same for most framework-level "group chat" features.
- **Know-Your-Agent (KYA)** — Ant International, Visa and Mastercard announced an interoperability framework on 11 September 2026 ([Biometric Update](https://www.biometricupdate.com/202609/ant-international-visa-mastercard-work-to-make-agentic-protocols-interoperable)). Agent identity/authorisation for payments. Days old, payments-scoped, watch it but don't build on it.
- **UCP (Universal Commerce Protocol)** — Google/Shopify, live at Walmart, Target, Etsy, Wayfair. Commerce transactions, not conversation. Wrong domain, but a useful calibration point: this is what "actually shipped" looks like, and nothing in the general agent-conversation space is anywhere near it.
- **A2A community registries** (a2a-registry.org and several competing ones) — fragmented, community-run, no single authoritative directory. A weak point for cross-org discovery.

---

## Blunt assessment

**Usable today, in rough order:**

1. **Matrix.** Ship this. It is the only option that delivers all four of your hard requirements — N participants, cross-organisational federation, cross-vendor indifference, humans as first-class participants — in software that has been running in production for a decade, with E2EE that actually holds against the servers in the middle. The agent integration is not theoretical; OpenClaw and others already do it, including the multi-agents-in-one-room case. You will write a modest adapter per agent and fight the bot-device-verification flow once.
2. **A2A, if and only if you accept a hub.** Mature, widely supported, well-specified cross-org auth. But it will give you a coordinator-mediated star topology, transport-only confidentiality, and humans that can be *asked* but cannot *interject*. If what you really want is "my agent can call your agent", A2A is the right and boring answer. It is not a conversation.
3. **DIDComm v2.1 + TSP**, if cryptographic cross-org trust with no shared vendor is the actual requirement and you have the appetite to build group semantics and a UI on top. Stable spec, real 2026 agent deployments, high build cost.

**Announcements more than working systems:**

- **AGNTCY/SLIM.** The architecture is the best match to your problem of anything designed for agents — MLS groups, DID identity, SPIFFE federation, multicast sessions. The reality is an unadopted individual IETF draft expiring in January 2027, four Cisco authors, ~212 GitHub stars, undocumented maturity levels, and no human participant model despite the marketing. If it gets IETF WG adoption and a second independent implementation, revisit. Today it is a Cisco research project with a foundation logo on it.
- **ACP.** Abandoned as a distinct protocol since August 2025. Any source still presenting it as a live third option is a year stale.
- **CHAP.** A good idea at version 0.2 from one company. Read the paper; don't bet the integration on it.
- **KYA.** One week old.

**The honest summary of the standards landscape:** the agent-protocol world spent 2025–2026 consolidating governance (ACP→A2A, MCP and A2A→AAIF) rather than expanding scope, and MCP's 2026-07-28 release actively *removed* the features that pointed toward peer-to-peer. The multi-party human-and-agent conversation is a real gap that everyone acknowledges — it is why CHAP exists and why AGNTCY markets human-in-the-loop — and nobody has filled it with a ratified standard. Meanwhile federated group chat has been a solved problem since 2014. Use the solved problem.