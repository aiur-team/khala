All four tracks are in. Here is the report.

---

# The conversation substrate for humans + agents across company boundaries
**Research date: 2026-09-16.** All load-bearing claims verified against live primary sources today. Stale things flagged. Where a subagent's WebSearch budget ran out mid-task, the fallback was direct fetches of official docs — noted in the caveats.

---

## The short version

Nothing on this list was designed for your problem. Four things get close from different directions:

1. **Slack Connect with one custom app per org** — the only option deployable *this week* where both companies own their own agent identity in one channel, both humans watch, and the bots can hear each other. Not confidential from Slack.
2. **Matrix** — the only mainstream substrate that is simultaneously federated between peers, E2E encrypted, and has real human clients. Agent tooling on it is 2-star toys, bot key management is an unsolved documented problem with a hard deadline in October 2026, and it's a 2–4 week project.
3. **Email** — the only thing that already federates to every organisation on earth with zero negotiation, and 2026 is the first year it has real agent-native infrastructure (AgentMail, Cloudflare Email Service). No confidentiality, total auditability, ~1 day to stand up, and you write your own loop breaker.
4. **Buzz** (Block/Dorsey, launched 2026-07-21) — the one thing built *from scratch* for exactly this premise: humans and agents as cryptographic peers in one workspace. It is eight weeks old, single-relay, and does not federate.

And one finding that reframes the hard question you asked: **E2EE with agent participants does not mean what you want it to mean.** More below.

---

## The hard question first: where does the agent's key live?

You asked what each option does about the fact that an E2EE room needs the agent to hold keys. The honest answer across every option is the same, and it's worth stating before the option-by-option detail because it changes the ranking.

**In every E2EE design, the agent is a cryptographic *device*.** Matrix: an Olm/Megolm device with its own device keys. XMPP: an OMEMO device with a published bundle. Nostr/Marmot and AGNTCY SLIM: an MLS leaf. The private key sits on whatever host runs the agent — Company A's box for Agent A.

What survives: **confidentiality from the chat server operator.** That is real and non-trivial, especially when the room is hosted on the counterparty's infrastructure or a third party's. In a Matrix room federated between two homeservers, neither company's homeserver admin can read the traffic. That's a genuine property nothing in the Slack/Teams/Zulip/Discord column can offer at any price.

What does *not* survive, and is usually glossed over:

- **The org running the agent reads everything.** Obvious but it means "end-to-end" terminates at a server belonging to one participant, which is a third party from the other participants' point of view — and invisible to them.
- **The model vendor reads everything.** The agent decrypts the room and posts the plaintext to Anthropic or OpenAI. *The encrypted room is only as private as the least-private model endpoint any participant's agent uses.* If Agent B runs on a hosted model, encrypting the transport against the homeserver operator while streaming the same content to a third-party inference API is theatre unless you say so explicitly and put it in the contract.
- **Your own compliance obligations may forbid it.** The email track surfaced the cleanest statement of this: Google Workspace CSE deliberately escrows keys with the *sending organisation* via KACLS precisely so Vault/eDiscovery still works ([Google CSE overview](https://developers.google.com/workspace/cse/guides/overview)). If you encrypt so that your own IT cannot read it, you break your employer's retention duty. And 2026 case law has made GenAI prompts and outputs discoverable records subject to preservation ([K&L Gates, Feb 2026](https://klgates.com/Litigation-Minute-Is-AI-Generated-Content-Discoverable-What-Companies-Need-to-Know-in-2026-2-12-2026)) — so the agent's reasoning is discoverable whether or not you encrypt the channel.
- **Operational reality is worse than the theory.** Key backup and recovery for a headless device, cross-signing four devices across two domains, re-keying on membership change — nothing off the shelf does this for agents. See the Matrix section; it is the single most concrete blocker I found anywhere in this research.

**Practical framing:** decide whether your threat model is "the chat vendor" (then E2EE helps, and Matrix is your answer) or "the counterparty and their vendors" (then E2EE helps not at all, and you want *signed, attributed, audited* plaintext instead). For two engineers at two companies collaborating on code, it is almost certainly the latter. Say this out loud rather than buying encryption that protects against the wrong party.

---

## Matrix — strongest on paper, and the paper is still mostly right

### Federation state: healthier than its reputation

Spec **v1.19, released 2026-07-08** ([release notes](https://matrix.org/blog/2026/07/08/matrix-v1.19-release/)); v1.18 was March 2026, so a steady ~3-month cadence. TWIM has published weekly through 2026-09-11. MatrixRooms.info tracks **19,723 discoverable servers**: Synapse 78.6%, Continuwuity 8.3%, Conduit 2.9%, Dendrite 1.6% ([TWIM 2026-07-17](https://matrix.org/blog/2026/07/17/this-week-in-matrix-2026-07-17/)).

The implementation picture shifted since 2025 and matters for cost: conduwuit was abandoned in May 2025, **Continuwuity** picked it up and shipped a landmark **v26.6.0 in mid-2026** (700+ commits, ~65k lines changed, native OAuth2/OIDC, static musl binaries, calendar versioning) — with a breaking change creating Synapse invite incompatibility in v26.6.2, worth knowing before you pick. Synapse is at v1.157.x and being progressively rewritten in Rust. A single-purpose homeserver is now genuinely cheap to run.

Federation is **symmetric and peer-to-peer at the room level**: no single homeserver owns a room, state replicates to every participating server. This is the property that Slack Connect, Teams, and Zulip structurally cannot offer — in all three, one org is the host and the other is a guest.

### The bot encryption problem — this is the real story, and it has a deadline

This is where Matrix's on-paper strength meets 2026 reality, and it is worse than the marketing suggests.

**MSC4153 "Exclude non-cross-signed devices" was merged into the spec on 2025-10-13**, with the spec PR merged 2026-02-24 ([MSC4153](https://github.com/matrix-org/matrix-spec-proposals/pull/4153)). It says encrypted to-device messages SHOULD NOT be sent to non-cross-signed devices. Element announced it would flip this on by default in Element clients in **April 2026** ([announcement, Nov 2025](https://matrix.org/blog/2025/11/exclude-insecure-devices/)) — then **pushed it to October 2026**, and the stated reason is directly your problem: *"some customers weren't ready … and Element's code (especially around bots and bridges) is not quite ready either."*

When it lands, **a bot whose device is not cross-signed cannot participate in encrypted rooms at all.** Not "shows a warning" — excluded from key sharing, its events fail to decrypt.

How does a bot cross-sign itself? **There is no documented answer.** [element-meta#2709, "Find/Document the recommended way for bots to verify themselves"](https://github.com/element-hq/element-meta/issues/2709) was opened 2025-01-28 and is **still open with no resolution**, noting plainly that "interactive verification via emojis is clearly not easy for bots to implement." Four approaches are floated (a manual text-based verification tool; handing the bot a recovery key via env var; a CLI that takes username/password/device ID/recovery key; MSC3062 verification over HTTPS) and none is blessed.

What exists in practice is a workaround, not a solution. The mautrix bridges ship a `self_sign` option: the bot holds the account's cross-signing private keys and signs its own device on startup ([mautrix troubleshooting](https://docs.mau.fi/bridges/general/troubleshooting.html)) — *"You should set it to ensure that the bridge keeps working after clients stop encrypting messages for unverified devices."* (Note: that page still says April 2026; the date moved to October. Stale.) The same docs concede **"Interactive verification isn't supported — you cannot verify the bot's cross-signing keys from your own account,"** and that bridge messages surface as *"Encrypted by a device not verified by its owner."* MSC4350 is meant to eventually let clients suppress those warnings; not shipped.

So the custody answer for Matrix, concretely: **the agent holds its account's cross-signing private key on the agent host and self-signs.** That is a strictly stronger key than a device key — it's the identity key that vouches for all of that user's devices. It works, and it means the agent's host compromises the agent's whole Matrix identity.

Worse for your specific case: **cross-*user* verification across a federation boundary — Org A's human verifying Org B's agent — is documented as broken in the wild.** [openclaw#89254](https://github.com/openclaw/openclaw/issues/89254) (OpenClaw 2026.5.28, self-hosted Synapse, June 2026): inbound DMs to the agent dispatch ~1 in 7, replies never return, bot-initiated verification requests vanish, user-initiated ones report "SAS data is not available." Marked P2, open, no workaround. [hermes-agent#3521](https://github.com/NousResearch/hermes-agent/issues/3521) reports the Matrix gateway cannot decrypt in encrypted rooms and device verification is not implemented, "making E2EE unusable." These are two different agent products hitting the same wall in mid-2026.

The mitigation everyone actually uses is **TOFU** — trust on first use, auto-verify new devices. That's what [elkimek/matrix-bridge](https://github.com/elkimek/matrix-bridge) does (`tofu` / `all` / `explicit` trust modes). TOFU across an org boundary means you are trusting whatever key the counterparty's server hands you the first time, with no out-of-band check. Defensible between two engineers who can compare fingerprints over a call; not defensible as a security architecture.

### Agent frameworks on Matrix: embryonic but the shape is right

- **[elkimek/matrix-bridge](https://github.com/elkimek/matrix-bridge)** — Rust, matrix-sdk + vodozemac, ships both a CLI and an **MCP server** so Claude Code / Cursor / Cline can read and write encrypted Matrix rooms as a tool. Its pitch is verbatim your requirement: *"An agent running on Anthropic can chat with one on OpenAI, or with a human on Element, all through the same Matrix room."* Keys in `~/.matrix-bridge/store`. **2 stars, 13 commits, build-from-source.** Correct design, toy maturity.
- **[MindRoom](https://www.nijho.lt/post/mindroom/)** (2026-06-26) — the most serious attempt. A `MultiAgentOrchestrator` provisions a real Matrix account per agent via matrix-nio; agents appear as users with avatars, typing indicators and presence; routing via explicit mentions, thread continuity, and a router model; backed by Agno with 8+ model providers (OpenAI, Anthropic, Ollama, Groq, Google, OpenRouter, DeepSeek, Cerebras); coordinate and collaborate modes. ~1,000+ commits, Docker Compose deploy — and the author's own number is **"30–100 people have tried it."** He explicitly names the cross-org property as the point: *"agents from different organizations to collaborate natively."*
- matrix.org itself publishes **nothing** about AI agents. This is a community-bottom-up phenomenon, not a platform direction.

### Two 2026 spec items that help you

**MSC4268 encrypted room history sharing**, shipped in v1.19: when someone joins or is invited to an encrypted room, they can now be given the keys to decrypt prior history automatically. For your case this is exactly the "a new agent joins mid-conversation and needs the context" primitive, and it did not exist a year ago.

**MLS is not coming soon.** MSC2883 has been WIP since 2020; MSC4244 (RFC 9420 MLS for Matrix) reads as a discussion document — littered with TODOs, "untested theories," consensus and leader election "deliberately left … for a future MSC," no timeline, no implementation. Plan on Olm/Megolm indefinitely.

### Compliance — the thing that will actually stop a corporate rollout

Out of the box, an E2EE Matrix room is **un-auditable**: each homeserver stores ciphertext, exports yield ciphertext, and there is no eDiscovery tooling. For two individuals that's fine; for two *companies* it means neither legal department can satisfy a hold.

Element's commercial answer is honest and worth knowing: **ESS Pro Auditing** retains records of E2EE conversations by placing an audit participant in the room, **"fully transparent and visibly present in the room member list"**, streaming machine-readable JSON to file/S3, configurable to exclude DMs ([Element auditing](https://element.io/en/server-suite/auditing)). A "supervisor" account's ability to read encrypted content is configurable. This is the correct design — visible surveillance rather than silent key escrow — and it is *another device holding keys*, which is the same custody problem wearing a compliance hat. Element also ships a **Secure Border Gateway** for rules-based federation allowlisting ([Element Pro, 2025-10-16](https://element.io/blog/element-pro-element-x-built-specifically-for-the-workplace/)), which is how an enterprise would actually permit federation with one named counterparty domain.

Note the doc did not state whether the audit captures the *remote* org's messages in a federated room. Assume not without testing — and if it does, that's a disclosure you owe the counterparty.

### Cost

**Self-hosted Continuwuity or Synapse: effectively free**, a small VM per side, an afternoon to stand up, a day with TLS/DNS/well-known and federation testing. **Element Enterprise is priced per seat with a 100-user minimum** ([element.io/pricing](https://element.io/en/pricing)) — irrelevant for a 4-person experiment, relevant the moment compliance asks for auditing. matrix.org's own hosted homeserver has announced Free/Premium tiers but **pricing is still not published** ([matrix.org/homeserver/pricing](https://matrix.org/homeserver/pricing/)) — stale placeholder, don't plan around it.

### Scorecard

| | |
|---|---|
| Non-human first-class? | **Yes** — a bot is a user with a device. No bot/human distinction in the protocol, which is also the problem: no agent identity, capability, or authority primitive exists. |
| >2 orgs? | **Yes, as true peers.** N homeservers, one room, no owner. Best in class. |
| Identity/invite across boundary | Each org runs a homeserver (or uses a host); invite `@agent:companyb.example`; federation allowlist if enterprise. Clean and symmetric. |
| Confidential from operator? | **Yes** — the only mainstream option where this is true. |
| Audit/retention | Ciphertext by default, DIY. ESS Pro Auditing is the commercial answer and is visible-by-design. |
| Cost/time | Free software, **2–4 weeks** to trustworthy, dominated by bot key management. |

---

## Slack Connect — the thing that works this month

Both tracks converged on this independently, so I'll state the verified mechanics once.

**The architecture that works:** each company creates its **own internal app** in its **own workspace**; both bots join one Slack Connect channel; both humans are already there. Neither app is installed in the other's workspace, and no credential crosses the boundary.

**Verified primitives** ([Slack Connect API docs](https://docs.slack.dev/apis/slack-connect/)): apps receive events originated by external users, with `team_id` identifying the originating workspace and `is_ext_shared_channel` on the envelope; `chat.postMessage` reaches everyone; bot-authored messages carry `bot_id` and `bot_profile` and are delivered via `message.channels` ([bot_message](https://docs.slack.dev/reference/events/message/bot_message)). **So the agents can hear each other** — the old "bots can't hear bots" rule was an RTM/classic-bot artifact. Two caveats from the docs review worth heeding: it is *not* documented whether a bot-authored @mention fires `app_mention`, so subscribe to `message.channels` and key off `bot_id`; and Bolt's `message()` listener silently drops subtyped messages, so use `app.event('message')`. **Loop prevention is entirely yours.**

**Documented limits:** slash commands and message actions are workspace-local — the external humans can see your agent's output but cannot invoke it by command, only by @mention. `link_shared` unfurls don't fire for external members. Incoming webhooks can't DM externally. Files need a `files.info` round trip. There is no API to enumerate channels shared with a given org.

**Scale:** up to **250 organisations** in one channel ([Slack Connect guide](https://slack.com/help/articles/115004151203)), each installing its own agent. This generalises past four participants better than anything else on the list except email and Matrix.

**Approval flow:** app install (owner/admin approval if enabled), plus Connect invite send *and* accept approvals configurable per side, with per-partner auto-approve rules on Grid. Two Pro workspaces with permissive defaults: **hours.** Two Enterprise Grids with policy gates: **1–3 weeks of ticket latency and zero engineering.**

**Confidentiality: no, and the audit asymmetry is a trap.** Nothing is E2E encrypted; EKM is Enterprise+ BYOK-at-rest and Slack still decrypts to serve — and in a Connect channel *"only messages and files sent by members of your organization will be encrypted using your keys."* Critically: **"The Discovery API allows all organizations to read content in Slack Connect channels and DMs"** ([EKM/Connect help](https://slack.com/help/articles/115004152843)). Every org eDiscovers the whole channel; each controls deletion only of its own messages; and **one org's shorter retention deletes its messages for everyone.** Settle retention in writing before you start.

**Cost:** Connect channels require a **paid plan on every participating org** (Free is 1:1 DM only); Pro ~$7.25–8.75/user/mo, EKM and Discovery are Enterprise+. Build as **internal apps** — the May 2025 rate-limit tightening (1 req/min, 15 objects) hit non-Marketplace *distributed* apps, grandfathering ended 2026-03-03, and internal apps keep Tier 3.

**2026 context worth knowing:** Slack shipped an MCP server (GA 2026-02-17, internal or directory-published apps only), Slackbot as an MCP *client* (June 2026), `agent_view` + agent sessions + `chat.startStream` replacing the deprecated `assistant_view`, **multi-agent stacking in threads** (Aug 2026), and **Code channels for coding agents** including Claude, Devin and Copilot (GA Aug 2026). But **none of the AI/agent documentation mentions Slack Connect** — grep-verified across the docs. The agent surface is single-thread human↔agent and gives you nothing for agent↔agent; use plain `postMessage` + events.

**One sharp finding:** Anthropic's own Claude Tag is *policy-blocked* from this — it "never replies to the other company's apps or bots" and "never replies to the other company's Claude" in Connect channels ([Claude Tag admin docs](https://claude.com/docs/claude-tag/admins/restrict-access)). Vendor-installed agents won't talk to each other. **Your own two custom apps are not subject to that.** That's the whole reason this approach works and the off-the-shelf one doesn't.

---

## Microsoft Teams shared channels — asymmetric, and one doc is lying to you

Bots in cross-tenant shared channels **went GA mid-January 2026** (MC1168294 / roadmap 505791), for apps on manifest v1.25 with `supportsChannelFeatures: "tier1"` ([build apps for shared and private channels](https://learn.microsoft.com/en-us/microsoftteams/platform/build-apps-for-shared-private-channels), ms.date 2026-06-18). It works: external-tenant users @mention your agent and it replies; `channelShared` events carry the partner `tenantId`; RSC `ChannelMessage.Read.Group` gets all channel messages without mention.

**Flag for your security reviewer:** [limits-specifications-teams](https://learn.microsoft.com/en-us/microsoftteams/limits-specifications-teams) (edited 2026-08-25) *still says* "Bots, connectors, and message extensions aren't supported" in shared channels. **That page is stale** and someone will quote it at you.

**The disqualifier for symmetry:** *"App permissions in shared channels follow the host team's app roster and host tenant's app policy."* Only the host team installs apps; external participants get "Manage tabs and apps — No." For Org B's agent to exist in Org A's channel, **B must publish its app into A's catalog** and A must approve it — a Teams Store listing or an LOB package through A's app-governance process. That is a multi-week project per agent, and it repeats for every new counterparty.

**Bot-to-bot is worse:** no Learn page states the rule, and Microsoft Q&A moderators say bots do not receive other bots' messages even with read-all RSC ([example](https://learn.microsoft.com/en-sg/answers/questions/5528854/my-bot-doesnt-get-requests-from-other-bot)). Also, RSC change-notification subscriptions on channel messages return **403 by design** in shared/private channels — no firehose, on-demand reads only. Treat Teams as not an agent-to-agent bus.

**Scale:** 50 teams per shared channel, 5,000 direct members, no documented tenant cap; Entra cross-tenant access has no partner limit. Not Commercial↔GCC.

**Governance asymmetry is severe and one-sided.** Shared-channel messages live in a `SubstrateGroup` mailbox in the **host tenant**; host admins discover everything regardless of who wrote it; **the external tenant cannot eDiscover the channel at all, cannot place its own people on hold, and gets no audit logs** — Microsoft states plainly there are "no audit logs in the external user's home tenant related to their activity in an external shared channel." Meanwhile a shorter retention policy in *either* tenant deletes messages for everyone. The non-host org is being asked to accept a blind spot; that needs a signed data-sharing agreement, not a config change.

**Encryption:** [Teams encryption](https://learn.microsoft.com/en-us/microsoftteams/teams-encryption) (2026-08-28) — E2EE for 1:1 calls and Premium scheduled meetings only. **Chat messages: No. Shared files: No.** Customer Key covers chat at rest but search, DLP, retention, eDiscovery and Copilot all require plaintext access.

**Time:** both tenants configure Entra cross-tenant access (inbound + outbound B2B direct connect, trust settings), Teams channel policies, external access — a Security Administrator's job, up to 6h propagation. Motivated IT on both sides: 1–2 days. Two unrelated enterprises with third-party risk review: **2–6 weeks**, plus the separate multi-week app-publication track for the second agent.

**2026 Microsoft agent context:** Teams SDK 2.1 GA (Aug 2026), M365 Agents SDK GA, Agent 365 GA (May 2026, governance not collaboration), Entra Agent ID GA, Copilot Studio **outbound A2A GA April 2026**, Foundry inbound A2A in preview. The first-party Channel Agent is in preview and explicitly **not functional with external users**. Anthropic models (Claude Sonnet 5, Opus 4.7) are GA in Copilot Studio with Anthropic enabled as a Microsoft subprocessor since 2026-05-01. **No Microsoft-brokered cross-tenant agent identity exists** — cross-org A2A is you wiring OAuth over the public internet.

---

## XMPP — a serious plaintext option, a research project encrypted

**Still alive, smaller than it was.** 516 public federated servers on the [Conversations compliance tester](https://compliance.conversations.im/). Servers ship on tight cadences: ejabberd 26.07 (2026-07-30), Prosody 13.0.6 (2026-05-27, no 14.x), Openfire 5.1.2 (2026-08-17), MongooseIM 6.8.1, Snikket stable.20260611 after a six-month gap. The XSF is convening rather than steering: the [Chat of the Future Initiative](https://xmpp.org/2026/01/chat-of-the-future-initiative/) is quarterly calls with no roadmap; Summit 28 outcomes were never published; Summit 29 (Sept 2026) was the first fully-online, three-hours-a-day summit. **Every newsletter from Dec 2025 through Aug 2026 contains zero AI/agent content**, and none of the ~10 new 2026 XEPs is agent-relevant.

**OMEMO is the blocker.** [XEP-0384](https://xmpp.org/extensions/xep-0384.html) is **v0.9.1, revised 2026-04-06, still Experimental after eight years.** Group chat is specified — rooms MUST be non-anonymous, SHOULD be members-only, sender encrypts to the union of all members' devices, re-key on every affiliation change — but the community reference page for OMEMO-in-MUC was **last edited 2019-04-19** and still documents unresolved breakage. And client adoption of the `urn:xmpp:omemo:2` namespace is **mid-migration, which is the worst possible moment to arrive**: Converse.js 14.0.0 and Monocles 2.3 ship it, but **Conversations 2.20.3 is still on the legacy `eu.siacs.conversations.axolotl` namespace** and Dino hasn't released in ten months. Namespace mismatch means messages silently fail to decrypt. Python bots are the bright spot — Syndace's `twomemo`/`oldmemo` 2.1.0 and `slixmpp-omemo` 2.2.0 speak both.

A 4-member MUC with two bots as OMEMO devices across two domains has **no prior art anywhere**. You would be first.

**MIX is dead for your purposes.** [XEP-0369](https://xmpp.org/extensions/xep-0369.html) is v0.14.6 dated **2020-12-01**, Experimental, last two revisions typo fixes; ejabberd has `mod_mix`, Prosody and Openfire have nothing, no client implements it. MUC (Stable, updated 2026-05-03, 51 implementations) is the only choice.

**Bots:** slixmpp is thriving and **moved to [Codeberg](https://codeberg.org/poezio/slixmpp)** — 1.17.0 (July 2026), commits Sept 2026; the [GitHub mirror is archived and misleading](https://github.com/poezio/slixmpp); pin below 1.16.0 for async compat. Use client accounts, not XEP-0114 components (Historical, bind to one server, can't be an OMEMO peer in a remote room). LLM agents over XMPP: near-zero — a dozen-odd repos at 0–2 stars, notably [xmpp-mcp](https://github.com/alcalin/xmpp-mcp) and [claude-code-xmpp](https://github.com/AyoKeito/claude-code-xmpp) (working legacy-OMEMO, 1:1 only).

**Verdict:** as a *plaintext* federated substrate it is genuinely good and cheap — **2–3 days** for two servers, one members-only MUC, four accounts, two slixmpp bots, full peer federation. Encrypted, it is the same project as Matrix with a staler spec, less prior art, and no ecosystem. **If you need E2EE, choose Matrix, not this.**

---

## Discord — demo this week, dead end as a deployment

Two orgs, two apps, one guild works, and it's actually the cleanest *credential* isolation in the survey: each org registers its own application, holds its own token, runs its own gateway.

Everything else disqualifies it. **One personal account owns the guild** and can read, kick and delete everything — no tenancy boundary. External humans join by consumer invite link; `VERY_HIGH` verification requires a phone number on a personal account. The [ToS](https://discord.com/terms) doesn't forbid business use but caps liability at the greater of three months' fees or **$100**, with no business tier and no DPA-shaped product.

**The mechanic that breaks it:** `MESSAGE_CONTENT` is a privileged intent — without it your agent receives *empty* content for the other agent's messages unless @mentioned. Self-enable under 10,000 users; above that it's a reviewed, annually re-approved application, and Discord is [documented as hostile](https://www.zikeji.com/2026/07/21/seven-years-three-rejections-and-counting-the-discord-privileged-intent-saga/) to "I need to read other bots' messages" as a justification.

**E2EE: voice/video only, permanently.** DAVE (MLS 1.0) is mandatory for calls since 2026-03-01 and default-on by May 2026; text is not in scope and [not listed as future work](https://daveprotocol.com). **Audit:** admin-actions only, **45 days**, never message content; no admin export, no retention controls, no legal hold.

$0 and an hour to a demo. Not a deployment.

---

## Zulip — best "one org hosts" option, no federation, no E2EE

**Bots are genuinely first-class**: a generic bot is a full user with its own API key, subscribes to channels, and **sees every message including other bots' with no privileged-intent gate** ([bots overview](https://zulip.com/help/bots-overview)). Long-polling events API. No Discord-style perception problem.

**Topics are the structural fit and the most underrated finding here.** Every message lives in a channel *and* a movable, resolvable, splittable topic. Each agent↔agent exchange gets its own named topic that humans can follow, mute, or split off — a flat channel cannot do that, and `#project > deploy-plan` is a stable addressing target an agent can be told to reply into. If you are designing the interaction protocol, this is the best primitive on offer anywhere on this list.

**Federation: definitively no.** [Issue #356](https://github.com/zulip/zulip/issues/356) has been open since 2015-12-04 with no 2025–26 work. Cross-org means guests on one org's server — and the visiting org's *bot* must be created by a non-guest on the host side, so **your admin mints the counterparty's agent identity.** That's a real asymmetry.

**E2EE: none for messages.** 12.0's "E2E encryption" is **push notifications only** ([security](https://zulip.com/security/)); the production security model states root reads everything; group E2EE is issue #6096, open since 2017.

**Compliance is the standout** — org and per-channel retention, and four export tiers including a **filtered compliance export** by sender/recipient/keyword/date ([export docs](https://zulip.com/help/export-your-organization)). Best eDiscovery primitive of any self-hostable option here.

**Governance risk, flagged:** on **2026-05-15** Kandra Labs was donated to a new nonprofit Zulip Foundation — and in the same announcement Tim Abbott, Alya Abbott, Greg Price and Alex Vandiver **joined Anthropic** ([announcement](https://blog.zulip.com/2026/05/15/announcing-zulip-foundation/)). Twelve staff remain. Neutral governance is now an argument you can make to two legal teams; price in pace-of-development risk. Releases: 12.0 (2026-04-27), 12.2 (2026-08-10), no 13.0.

**Cost:** Cloud Free / Standard $6.67 / Plus $10 per user-month annual; self-hosted Free / Basic $3.50 / Business $6.67; free Standard for open source; Cloud includes 5×N guests free. *(The plans page says a 25-user self-hosted Business minimum, the billing page says 100 — confirm before quoting.)* A 4 GB VM, an afternoon to a working server, a day with SSO/guests/backups.

---

## Email — the universal one, and 2026 is when it grew agent infrastructure

This is the only option that federates to **every** organisation with zero bilateral setup, and the surprise of this research is that it now has a real agent-native vendor ecosystem.

**Threading works and is better than it looks.** `Message-ID`/`In-Reply-To`/`References` gives you *content-addressed, replica-independent* threading — a DAG any participant can reconstruct from any subset of messages. No chat product offers that. Anthropic's own Cloudflare deployment **encodes the agent session ID inside the Message-ID** and routes inbound mail by (1) plus-subaddress, (2) `In-Reply-To`/`References`, (3) sender history ([agent-email.md](https://github.com/cloudflare/claude-managed-agents/blob/main/docs/agent-email.md)) — the single most useful concrete artifact found in this whole research, and the pattern to copy.

**What breaks, in order of danger:**
1. **Loops.** Two agents on reply-all with no stop condition is unbounded and expensive. The standards answer ([RFC 3834](https://datatracker.ietf.org/doc/html/rfc3834): `Auto-Submitted`, `Precedence`, `X-Auto-Response-Suppress`) literally means *"agents never reply to agents"* — the thing you want. So you need your own signal: a custom turn header, a hop count derived from `References` depth, a per-agent budget, and a hard cap enforced at a list address. **Build the circuit breaker before the first send.**
2. **Quoting.** Clients quote the entire prior thread inline, so token cost grows quadratically, the agent re-reads stale instructions, and old text returns verbatim as a prompt-injection surface. Strip quotes on ingest (talon / email-reply-parser, all heuristic) and rebuild context from your own store keyed by `References`.
3. **No ordering.** No total order, `Date:` is sender-clock, greylisting delays one party by minutes. Two agents will reply to the same parent concurrently. You need explicit turn-taking.
4. **Latency** 5–60s, minutes under greylisting. Fine for two coding agents; kills anything interactive.

**Use a list address, not reply-all.** Reply-all makes the membership list editable by every participant on every message, with no authority. One canonical list address gives you membership, dedup, rate-limiting and the loop breaker in one place — and it's what generalises past four.

**Deliverability is the tax.** A self-run MTA on a fresh domain gets silently filtered. Gmail now requires SPF+DKIM+FCrDNS+TLS+DMARC of *all* senders and [escalated to permanent rejections in November 2025](https://redsift.com/resources/blog/gmails-enforcement-ramps-up-what-bulk-senders-need-to-know); Microsoft [rejects outright since 2025-05-05](https://techcommunity.microsoft.com/blog/microsoftdefenderforoffice365blog/strengthening-email-ecosystem-outlook%E2%80%99s-new-requirements-for-high%E2%80%90volume-senders/4399730) above 5k/day. You're nowhere near bulk volume, but new-domain reputation is real. **Send from a subdomain of each company's existing reputable domain** (`agents.example.com`) — free DMARC alignment and the agent reads as part of the company. **The #1 cross-org failure:** if either company publishes `p=reject`, an agent sending as `agent@company.com` from third-party infra must have DKIM delegated or it's rejected by the counterparty. Use ARC or don't modify messages at the list.

**A 2026 gotcha:** Exchange Online SMTP AUTH Basic is [disabled by default for existing tenants end of December 2026](https://techcommunity.microsoft.com/blog/exchange/updated-exchange-online-smtp-auth-basic-authentication-deprecation-timeline/4489835). An agent logging into a *corporate* mailbox needs OAuth2 with admin consent — an IT ticket. Own-domain agent mailboxes dodge this entirely.

**Agent-native email is now a product category.** [AgentMail](https://www.agentmail.to/) (YC S25, **$6M seed March 2026** led by General Catalyst) makes the *inbox* the primitive: programmatic inbox creation, persistent threads, webhooks + WebSockets, per-tenant Pods, custom domains with DKIM/SPF/DMARC, IMAP/SMTP escape hatches, an MCP server. Free tier 3 inboxes; $20/mo Developer. **[Cloudflare Email Service](https://blog.cloudflare.com/email-for-agents/)** went public beta 2026-04-16 during Agents Week: auto SPF/DKIM/DMARC on onboarding, per-agent addresses, `isAutoReplyEmail()` for RFC 3834 loop detection, and **HMAC-SHA256-signed `X-Agent-Name`/`X-Agent-ID` routing headers with 30-day expiry** so a reply provably returns to the agent instance that sent it — the only cryptographic anti-spoofing found in any agent-email product.

**Format decision that matters most:** `multipart/alternative` with `text/plain` for humans plus an `application/json` part for agents. Works everywhere, forever, and both audiences get the right view of the same message. **Do not build on AMP for Email** (Gmail/Yahoo/Mail.ru only, needs full HTML fallback, ecosystem collapsed) or Gmail schema.org Email Actions (Gmail-only, one-way, allowlisted).

**E2EE over email: no.** S/MIME and PGP never recovered from EFAIL. The standards did land — **RFC 9787** (E2E mail guidance, Aug 2025) and **RFC 9788** (header protection, 2025-08-22, finally protects Subject) — but no shipping client implements them as far as could be verified. Gmail's "E2EE" is Workspace CSE: GA for external recipients 2025-10-02, Enterprise Plus + Assured Controls, and mechanically it is **organisational key escrow via KACLS** — Google can't decrypt, *your IT can*, which is the point and is why Vault still works.

**Audit: email's superpower, and it's involuntary.** Every message is journaled, retained, held, DLP-scanned and eDiscoverable at *both* companies, independently, with no new tooling. Microsoft retired classic eDiscovery 2025-08-31; Purview is the surface. Two consequences: DLP will **silently** eat an agent message containing a secret with no bounce (test this early), and everything the agents say is permanent and readable by both legal departments — **tell the agents so in the system prompt.**

**Cost/time: ~1 day to a demo, 3–5 days to trustworthy, $0–20/mo.** Humans join by being Cc'd and never learn a new tool. That is the best invitation flow in this entire report.

**JMAP** (RFC 8620/8621) is real but narrow — Fastmail, Cyrus, Apache James, Stalwart; Thunderbird rolling out. It's better than IMAP for an agent (HTTP+JSON, push instead of IDLE, threading as a first-class object, OAuth-native) but it's **client-to-own-server only — federation stays SMTP forever**, and the agent-native REST APIs above give you the same ergonomics with better deliverability and no server to run.

---

## Purpose-built for humans + agents: what has actually appeared

I went looking rather than assuming, and there is more than there was a year ago.

### Buzz (Block / Jack Dorsey) — the most direct answer to your premise, and eight weeks old

Launched **2026-07-21**, Apache-2.0 at [github.com/block/buzz](https://github.com/block/buzz), free desktop apps for macOS/Windows/Linux, v0.4.21 at launch ([TechCrunch](https://techcrunch.com/2026/07/21/jack-dorsey-is-taking-on-slack-with-buzz-a-group-chat-platform-for-teams-and-their-ai-agents/)). It is explicitly built for **human-agent parity**: every human and every agent gets **its own Nostr keypair**, with agents receiving "narrowly scoped authorization signed by the agent's human owner," revocable without touching the human identity. Channels merge with a software forge — Git branches *are* discussion threads. Model-agnostic via the **Agent Client Protocol**, supporting Claude Code, Codex and Block's own goose. Architecture: Rust `buzz-relay` (NIP-01, NIP-42 Schnorr auth), Postgres, Redis, S3/MinIO; `buzz-acp` harness and `buzz-cli` for agents.

This is, on paper, the cleanest agent identity model in the entire report — cryptographic, per-principal, delegated, revocable. Nothing else has that.

**But:** **no federation.** "Buzz currently has no peer-to-peer event exchange, gossip layer or replication between relays. All reads and writes in a workspace pass through a single relay." Self-hosting is deployment flexibility, not decentralisation — so it is structurally the same "one org hosts, the other is a guest" shape as Zulip, with the trust concentrated in one relay operator. **Encryption is unaddressed** in the docs; Nostr's E2EE group story is NIP-EE, now marked `final` but **`unrecommended`** and superseded by the **[Marmot Protocol](https://github.com/parres-hq/marmot)** (MLS over Nostr identities, adopted, 138 stars) — Buzz does not appear to implement either. An unsolved permissions gap is called out publicly: what a multi-channel agent may repeat across channels a given human can't see. Mobile, push and approval gates were incomplete at launch.

**Watch it. Don't bet a cross-company workflow on it this month.** But it is the clearest signal in this research that the category you're describing is now a category.

### Alook — the most credible open-source "agent room"

[alook.ai](https://alook.ai) / [github.com/alookai/alook](https://github.com/alookai/alook): Apache-2.0, **1.2k stars, 1,872 commits**, TypeScript/Next.js on Cloudflare Workers, **v0.0.160**. Discord-shaped servers/channels/threads with persistent agent identities, "bring your own runtime" (Claude Code, Codex, Cursor, OpenCode, Pi). Multi-vendor: yes. **Cross-org: not addressed** — single-tenant, no federation, no stated E2EE. Closest product shape to what you described; pre-1.0.

### The rest of the product crowd

**[Bloome](https://bloome.im)** — shipping desktop/mobile apps, agents as first-class group-chat members coordinating via @mentions/replies/threads, connects Claude Code and Codex, free to start with credit billing, "last reviewed June 29 2026." No cross-org story, no self-host, minimal company information. **nexscope-plugin / H2A2A2H** — an open-source WebSocket relay letting Claude Code, Codex CLI and humans share one room, with **manual mode (mentions queue for human approval) and auto mode with a hop limit, default 3**, plus audit logging ([writeup](https://www.nexscope.ai/blog/agent2agent-communication)). Not a substrate you'd deploy, but **the loop-control and human-gating design is worth stealing verbatim** — it is the only project that treats "humans watch and interject" as the primary design constraint rather than an afterthought. **AgentMeet** — a demo toy. **Linear** ([agent docs](https://linear.app/developers/agents)) — agents as mentionable, delegatable workspace members with `AgentSession` states; the most mature agent-as-participant model outside Slack, but workspace-scoped and issue-shaped, not a conversation. **GitHub Agent HQ** — multi-vendor agents as parallel workers on one org's repos, task-shaped.

### The agent protocols are not substrates

**A2A** reached **v1.0** under the Linux Foundation (Google donated it 2025-06-23; 150+ orgs; native in Azure AI Foundry, Bedrock AgentCore and Google Cloud; reportedly moving to the Agentic AI Foundation Aug 2026 — press-reported, not doc-confirmed). But the [spec](https://a2a-protocol.org/latest/specification/) is **strictly bilateral client→server** JSON-RPC/gRPC/REST: AgentCard, Task, Message, `contextId` scoped to one client-server pair, auth all bilateral. **No room, no broadcast, no human seat, no confidentiality from intermediaries.** It is the right thing for Agent A to *call* Agent B's capability. It is not a place two people can watch them talk. Same for **MCP** (spec revision 2026-07-28) — host/client/server, purely point-to-point. Note the correct pattern that keeps recurring: matrix-bridge, xmpp-mcp and zulipmcp all use MCP as the agent's *adapter to a real chat substrate*. That's the right layering.

**AGNTCY SLIM** is the one genuine exception and deserves a look. Cisco-originated, Linux Foundation, Rust, Apache-2.0 ([github.com/agntcy/slim](https://github.com/agntcy/slim), 218 stars), IETF draft `draft-mpsb-agntcy-slim` (2026-02-24): a **multi-party pub/sub message bus with MLS group encryption where routing nodes see only the channel name and ciphertext**, self-hostable via Helm, identity via SPIFFE/SPIRE + mTLS, with a companion [AGNTCY Identity](https://github.com/agntcy/identity) project doing W3C DID + Verifiable Credential badges for agents. This is the strongest cryptographic story in the entire report — MLS leaf keys on each agent host, confidential from every router including a neutral third party's, and it survives the custody analysis better than Matrix does. **But there is no human client, no UI, no conversation-log semantics, one vendor's authors, and an Internet-Draft rather than an RFC.** You would write the human half yourself. 4–6 weeks.

---

## Recommendation

**Rank 1 — Slack Connect, two internal apps, this week.** It is the only option where both companies own their own agent identity in one conversation, both humans are already present with clients they use daily, bots hear each other by default, and it scales to 250 orgs. Hours to stand up if both sides are on paid plans with permissive defaults. Spend the first half-day on an **empirical test of cross-Connect bot-to-bot event delivery** — the docs support it but do not guarantee it — and the rest on the interaction protocol: mention discipline, hop caps, thread-per-task. You will learn more about what the protocol actually needs in one week here than in a month of designing on Matrix. Accept that Slack reads everything and that all orgs eDiscover the whole channel; settle retention in writing first.

**Rank 2 — Email with a list address, this week, as the durable fallback.** Universally federated, N orgs with zero negotiation, humans join by being Cc'd, agents are first-class via AgentMail or Cloudflare Email Service, everything audited at both ends by default. ~1 day to demo, 3–5 days to trustworthy, $0–20/mo. Use `multipart/alternative` with a JSON part, strip quotes on ingest, and build the loop breaker into the list before the first send. This is the answer if either legal department balks at a shared Slack channel, or if you need a third, fourth or tenth company next quarter.

**Rank 3 — Matrix, if and only if confidentiality from the operator becomes a hard requirement.** It is the only mainstream option that delivers it alongside genuine peer federation, and v1.19's encrypted history sharing solves the "agent joins mid-conversation" problem. But be clear-eyed: the bot cross-signing story is an **open, unresolved issue with no documented answer** and a hard MSC4153 deadline in **October 2026**; cross-user verification across federation is documented as broken in two separate agent products this year; the practical workaround is TOFU or handing the agent your cross-signing private key; the agent ecosystem is a 2-star bridge and a 30-user project. **2–4 weeks**, and most of that is key management you own. Do it as a deliberate migration once you know the protocol, not as the first attempt.

**Rank 4 — Zulip self-hosted, if one side (or a neutral third party) will host and E2EE is not required.** Best bot model of any option, best compliance export of any self-hostable one, and topic threading is the single best structural fit for agent conversations in this entire report. An afternoon to a server. Costs: no federation ever, so one org is permanently a guest and the host mints the guest's agent identity; and note the Zulip Foundation/Anthropic staffing change of May 2026 when assessing pace.

**Not this month, worth watching:** **Buzz** (right idea, right identity model, eight weeks old, no federation, encryption unaddressed); **AGNTCY SLIM** (the correct cryptographic substrate, no human client); **Alook** (right product shape, v0.0.160, single-tenant); **Teams** (workable only asymmetrically — one host-owned agent, the counterparty's agent reached via A2A behind it — and the non-host org's total audit blindness needs a signed agreement).

**Rule out:** **Discord** (plaintext text forever, one personal owner, 45-day admin-only audit, $100 liability cap, and a privileged-intent gate squarely on "bots reading bots"). **XMPP with OMEMO** (the same project as Matrix with a staler spec — Experimental at v0.9.1 after eight years, MUC guidance last touched in 2019, mid-namespace-migration clients, and no prior art for multi-agent encrypted MUC). XMPP *without* OMEMO is a fine 2–3 day plaintext federated option if you want peer federation without Matrix's complexity — but if you're accepting plaintext, Slack Connect gets you there in hours with clients the humans already have.

**The one thing to build regardless of substrate:** loop control and turn-taking. Every option delegates it to you, no option ships it, and it is the failure that will bite first. The nexscope H2A2A2H design — manual mode where mentions queue for human approval, auto mode with a default hop limit of 3, full audit — is the best-articulated version of it found anywhere, and it maps onto Slack, email, and Matrix equally well.

---

### Caveats and stale flags

- **This session exhausted its 200-call WebSearch budget** partway through; the back half of every track is direct fetches of primary sources, which is stronger sourcing but meant a few intended checks never ran.
- **Known stale docs you will be quoted at:** [Teams limits-specifications](https://learn.microsoft.com/en-us/microsoftteams/limits-specifications-teams) (2026-08-25) still says bots aren't supported in shared channels — wrong since Jan 2026. [mautrix troubleshooting](https://docs.mau.fi/bridges/general/troubleshooting.html) still says April 2026 for the unverified-device cutover — it moved to October. The [XMPP OMEMO-in-MUC wiki page](https://wiki.xmpp.org/web/Tech_pages/OMEMO/MUC) was last edited 2019-04-19. The archived [slixmpp GitHub mirror](https://github.com/poezio/slixmpp) is misleading; development is on Codeberg. [matrix.org homeserver pricing](https://matrix.org/homeserver/pricing/) is an unfilled placeholder.
- **Unverified, flagged:** A2A's move to the Agentic AI Foundation (press-reported only); IBM ACP/BeeAI status; XMPP Summit 28 outcomes and current XSF Board; OMEMO namespace for Gajim/Monal/Movim/Dino; whether Element ESS Pro auditing captures a *remote* org's messages in a federated room; whether a Google CSE key can be issued to a non-human service identity (load-bearing, unresolved); Proton/Tuta programmatic access for agents; Thunderbird's JMAP ship date; the Teams multi-tenant vs single-tenant bot registration question (a Learn doc and a Microsoft Q&A moderator contradict each other); Zulip's self-hosted Business user minimum (plans page says 25, billing page says 100); Notion/Asana agent features.
- Vendor content marketing appears in the agent-email and agent-room clusters (including AgentMail's own blog ranking for comparisons of AgentMail); funding, product shape and pricing were cross-checked against primary sites, but treat competitive superlatives as marketing.