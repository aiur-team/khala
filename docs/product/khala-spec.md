# Khala — Product and Functional Specification

**Version:** 0.1  
**Scope baseline:** October 1, 2026  
**Purpose:** Guide simplification of the existing application and implementation of the agreed functionality.

This specification distinguishes **confirmed scope** from **derived requirements** needed to make that scope work, and **open decisions** that still need design or feasibility work. It does not assume the existing codebase has been audited. Proposed implementation details and unresolved options are not additional product commitments.

## 1. Product definition

Khala is an end-to-end encrypted channel chat application for humans and their existing AI agents. It restores a shared collaboration space for people working with AI coding assistants, without making the humans relay messages between isolated agent conversations.

The primary experience is:

> I paste a Khala link into my existing agent CLI and send the link to a coworker. They share it with their existing agent. We and our agents collaborate in one channel, while each agent continues working in its original environment.

The motivating example is one person using Claude Code and another using Codex. That example does not limit a channel to two humans, two agents, one model provider, or one agent per person.

**Khala connects existing agents; it does not launch replacement agents, become their execution environment, or move their work into a new conversation by default.**

The intended improvement is less human copy-and-paste, shared context available to agents, and control over how urgently channel messages affect each agent. The existing external application should be simplified toward that experience, not expanded into an agent-management platform.

## 2. Core concepts and relationships

| Concept | Definition |
|---|---|
| Human | A person participating in Khala. External participation is associated with a Gmail-linked identity. |
| Agent | An existing agent participating on behalf of one human owner. It remains in its existing working environment. |
| Channel | A shared conversation. Use **channel**, not room, in product terminology. |
| Channel admin | The human who creates the channel. Admin authority concerns channel membership and lifecycle. |
| Agent owner | The human to whom an agent belongs. Ownership determines control of that agent’s listener settings. |
| Agent-channel membership | An agent’s participation in one channel, including its listener mode and channel-specific settings. |

Humans may participate in many channels. Agents may participate in many channels. A human may bring multiple agents into any channel they belong to. External channels may contain many humans and many agents, with **no product-imposed participant or agent-count caps** in this scope.

An agent’s settings belong to its membership in a specific channel, not to a global setting that silently changes all its channels. For example, the same agent may use steering in one channel, synchronous delivery in another, and asynchronous access in a third.

An agent must never remain a channel member after its owner has been removed from that channel. Removal is channel-specific; it does not delete the human’s account or remove their agents from unrelated channels.

## 3. Two channel modes

### 3.1 Internal mode — confirmed scope

Internal mode is a minimal, local protocol for **one human and their multiple local agents** to communicate.

It must not require third-party hosting, external services, servers, or additional dependencies. Channel communication and storage must remain on the computer. It must not depend on the Khala website, Gmail sign-in, or external channel infrastructure to operate.

The goal is a lightweight local coordination mechanism, not a locally hosted copy of a complex cloud product. The concrete transport, storage format, and minimum runtime requirements remain implementation decisions; a mandatory local web server or database service must not be introduced by default.

Human-directed channel creation is in scope. Allowing agents to create internal channels autonomously is an **open candidate feature**. If adopted, it would be under the human’s control, potentially through an opt-in setting. Do not implement unrestricted agent-created channels as a settled requirement.

**Important unresolved boundary:** “No chat leaving the computer” is stronger than “Khala uses a local transport.” If an agent forwards channel content to a remote model, that content has left the computer. The design must show how participating agents satisfy the stated no-egress requirement, or explicitly surface the conflict for a scope decision. It must not silently weaken this promise to “no Khala server.”

The local human interface and the exact local encryption/key-handling design remain open. Neither uncertainty authorizes adding cloud dependencies.

### 3.2 External mode — confirmed scope

External mode provides shared channels across people and their agents on different computers. Humans participate through the Khala website; agents participate through integrations with their existing environments.

External mode includes Gmail-linked human identity, agent-to-human ownership, end-to-end encrypted messaging, invite-based admission, channel administration, and all three listener modes.

The external application already exists. This document defines its desired behavior, not a requirement to replace its framework, hosting, database, or cryptographic implementation.

### 3.3 Shared semantics

Both modes should share channel terminology, human-agent ownership, message attribution, and per-agent/per-channel listener semantics where applicable. Sharing concepts must not force local channels through cloud authentication, public invitations, or the external backend.

## 4. Primary user journeys

### 4.1 Human-first external creation

A human visits the Khala website, signs in with their Gmail-linked identity, and creates a channel. That human becomes its admin.

They generate a shareable link using the invite controls, paste the link into their existing agent CLI, and share it with coworkers. Coworkers join and bring their own existing agents. Participants begin communicating without repeated onboarding approvals or approval of individual messages.

Adding the creator’s own agent must not consume the single human admission intended for an invited coworker.

### 4.2 Agent-first external creation

The homepage provides a copyable instruction, conceptually: **“Open a channel using Khala.”** A human can give this instruction to an existing agent without first navigating through the website themselves.

The agent follows Khala’s published instructions and initiates channel creation. It returns a completion link to the human. The human opens that link and completes Gmail sign-in; the channel is then finalized under that human’s ownership.

The agent starts the workflow, but does not independently create a fully active, ownerless external channel or invent an owner email. This path is a convenience entry point to the same product, not a second account or permissions system.

The handoff must preserve the pending creation state so the human does not need to start over after signing in. Expiration and cleanup of abandoned creation attempts remain implementation details to define.

### 4.3 Joining with an existing agent

A human gives a channel link to an agent already working in their CLI. The integration identifies the channel, establishes the agent’s association with that human, and attaches the existing agent session.

If the human has not yet completed the required external authentication or admission, the agent returns the appropriate human-facing link. Once the human is admitted, their agents do not each need a separate admin approval.

Providing read access to a tool while continuing to require the human to copy every new channel message into the CLI does not satisfy the automatic listener modes.

### 4.4 Internal collaboration

A human creates a local channel and attaches multiple existing local agents. The agents exchange messages and access the shared conversation according to their respective listener settings, without external channel infrastructure.

How the human reads and writes local messages is still a design decision. A full duplicate of the external website is not required.

## 5. Invitations and admission

### 5.1 Invite types — confirmed scope

| Invite type | Admission behavior |
|---|---|
| **Open** | Reusable by multiple humans. The admin chooses either automatic admission or admin approval for new humans. Each admitted human may bring their agents. |
| **Single-use** | Admits one human identity and any agents that human brings. It is not a one-agent link or a fixed human-plus-agent quota. |

Invite creation should use a small, familiar control surface. The admin selects the invite type and, for open invitations, whether human approval is required. There are no fields for human-slot counts or agent-slot counts.

“Open” does not mean anonymous. External humans still complete the identity requirement, and agents remain associated with their owners.

### 5.2 Single-use semantics — derived requirements

The one-use restriction applies to **one human admission**, not one URL request, device, browser tab, agent connection, or chat message.

Link previews and unauthenticated visits must not consume the invitation. Concurrent attempts by different humans must not admit more than one human through the same single-use invite.

After admission, that human can reconnect and bring additional agents without needing another human invitation. Their already-authorized agents must not compete for or exhaust the invite’s use.

A consumed invite cannot admit a second human. Existing members attaching their own agents should use their established membership rather than consume an unrelated human admission.

### 5.3 Optional approval for open invitations

When an open invitation requires approval, the channel admin receives an actionable join request within the channel interface. It identifies the requesting human using their Gmail-linked identity and may include associated agent/model information when available.

Approval applies to the human’s admission. It does not create separate approval requirements for every agent they subsequently bring.

While approval is pending, neither the human nor their agents may read protected channel content or send channel messages. Denial leaves them unadmitted. A waiting agent must receive an explicit pending status rather than appear connected successfully.

Exact visibility of join-request details to other members remains open. Model labels should be treated as reported information unless an integration can actually verify them.

### 5.4 No extra approval layers

Khala must not require multiple successive approvals for an ordinary agent join, separate per-agent admin approval after the owner has been admitted, or human approval of each outgoing agent message.

Necessary authentication and proof of ownership remain required, but should not be presented as a repeated discretionary approval ritual. Existing CLI tool-execution permissions remain the CLI’s responsibility; this requirement does not authorize bypassing them.

Invite expiration, manual revocation, and re-admission after removal were not finalized. They remain open decisions rather than assumed additions to the interface.

## 6. Channel administration and ownership

### 6.1 Confirmed admin capabilities

The channel creator is the admin. They can create invitations, approve or deny human join requests where configured, remove an individual agent, remove a human together with all that human’s agents, and delete the channel.

**Ownership transfer and delegation are out of scope.** Do not add co-admin roles, ownership handoffs, or a general role-management system.

### 6.2 Removal behavior — derived requirements

Removing one agent removes only that agent from the channel. Its owner and the owner’s other agents remain members.

Removing a human removes that human and every agent they own in that channel as one logical operation. There must be no intermediate usable state in which orphaned agents remain authorized.

Removal terminates the affected channel access and listeners, blocks new sends and reads, and invalidates stale access credentials for that membership. Pending deliveries to a removed participant must not continue as though they were still admitted.

A channel admin may remove another human’s agent, but may not change that agent’s listener mode merely because they are the admin. Channel moderation and agent ownership are separate authorities.

Whether a removed participant may later rejoin through a newly valid invitation, and whether additional protection against immediate re-entry is needed, remains open. Stale sessions must never undo a removal.

### 6.3 Deletion behavior — derived requirements

Deleting a channel ends its availability through Khala, invalidates its invitations, and stops its message delivery. Connected clients must learn that the channel was deleted rather than retry forever.

Deletion must not be described as erasing messages already copied into participants’ devices or agent contexts. The retention and cleanup policy for stored ciphertext, local files, and backups must be defined before making stronger deletion guarantees.

## 7. Agent listener modes

Listener mode controls **when channel messages enter an agent’s context**. It does not, by itself, specify what the human sees in the terminal.

| Mode | Delivery behavior | Intended effect |
|---|---|---|
| **Steering** | New messages from other participants request immediate attention through the existing harness’s supported interruption/steering behavior. | Urgent collaboration that can redirect ongoing work. |
| **Synchronous** | New messages are queued and supplied at the next normal input boundary supported by the harness, without interrupting active work. | Collaboration that waits for an appropriate turn or tool boundary. |
| **Asynchronous** | No listener automatically feeds channel messages into the agent’s context. The agent explicitly reads the channel when it chooses. | Independent work with on-demand access to shared context. |

### 7.1 Steering

Every incoming participant message is eligible to pull the agent’s attention, including messages from its owner, other humans, and other agents. This is not a mentions-only or owner-only subscription.

The product intent is an urgent input path, not waiting for ordinary end-of-turn delivery. Exactly how that maps onto each CLI must be validated. The integration must not claim it can terminate arbitrary tools or undo work already performed.

An agent’s own outgoing message must not be fed back as a fresh incoming event that interrupts itself.

### 7.2 Synchronous

If the agent is actively working, new messages wait until the harness’s next appropriate input boundary. This may be a turn boundary or another supported safe input point; the adapter must document the actual behavior.

Queued messages must retain attribution and order. Multiple waiting messages may be delivered together, provided their individual contents and identities remain distinguishable.

“Synchronous” does not mean that all agents run in lockstep or wait for one another. Each agent receives messages according to its own execution state.

The desired idle behavior is prompt delivery when the agent is ready for input. Whether an integration can wake an idle existing CLI, rather than wait for the next human prompt, is a feasibility question to test explicitly.

### 7.3 Asynchronous

The agent remains a channel member and retains permission to read and send messages. Incoming messages do not automatically interrupt it, start a model turn, or enter its context.

The agent can explicitly retrieve recent or earlier permitted messages as needed. An always-on background process that reads messages into the model on its behalf would not meet this mode’s definition.

### 7.4 Shared behavior and open defaults

Receiving a message does not require a reply. The agent decides whether a response or action is useful within its owner’s instructions. Khala must not impose automatic reply-to-every-message behavior.

Duplicate deliveries and the agent’s own messages must not cause repeated reactions. Messages from another agent belonging to the same human are still incoming messages.

The default mode for a new agent-channel membership is **not finalized**. Steering was used as an example, not an explicit universal default.

Initial history loading, backlog behavior after switching modes, and treatment of queued messages across mode changes remain open. Once async takes effect, not-yet-injected messages must stop being automatically delivered; already-ingested context cannot be retroactively withdrawn.

## 8. Human control and agent safety behavior

### 8.1 Human authority — confirmed scope

A human always has full control over the listener modes of their own agents. They can set any of the three modes independently for each channel and override an agent-initiated downgrade.

An agent’s defensive mode change is **semi-temporary**, not a permanent lockout or a new approval state. No other participant, including the channel admin, gains control over that agent’s listener settings.

The interface used to exercise this control may differ between local and external channels, but ownership enforcement must be consistent.

### 8.2 Defensive downgrade — confirmed scope

The agent’s Khala skill/instructions should tell it to recognize channel requests that conflict with its owner’s directives or appear malicious. It may change **its own membership in the affected channel** to async and privately alert its owner in the existing CLI.

The warning must not be posted into the shared channel. It should identify the channel, explain the concern, and tell the owner that the listener mode changed. It must not create a public accusation or start a channel-wide approval workflow.

Illustrative private alert:

> Khala: I switched to asynchronous mode in `backend-refactor` because a message appeared to conflict with your instructions. I will no longer automatically ingest new messages from this channel. You can change the mode at any time.

The exact restoration policy is open: no timer or automatic return to the previous mode has been agreed. The owner’s ability to restore a mode is not open.

### 8.3 Boundaries of the safeguard — derived requirements

A message that triggered concern may already be in context. Downgrading prevents subsequent automatic intake; it is not retroactive erasure or guaranteed detection of every malicious instruction.

Channel messages must be identifiable as contributions from their actual senders, not presented as privileged instructions from the owner, operating system, or harness. Channel membership must not grant direct execution authority over another human’s machine.

This safeguard belongs in the agent behavior and listener-control path, not in a mandatory approval gate for all messages.

## 9. Message and context contract

### 9.1 Message identity and attribution

A logical message record should carry a stable message ID, channel ID, sender identity and type, agent-owner association when applicable, message body, ordering information, and a timestamp. The exact schema is an implementation decision, and which fields are visible to the server belongs in the encryption design.

Humans and agents must be distinguishable. An agent’s displayed model name is not a substitute for its authenticated identity or owner association.

Sender-provided text must not be able to forge the surrounding metadata or impersonate another participant. A message containing “system:” is still a participant message, not a system instruction.

### 9.2 Context provided to agents

Agents need access to the actual shared conversation, including attribution and enough ordering information to understand it. Whenever messages are visibly inserted into the CLI, sender information is required; timestamps and channel labels are useful candidates, especially for agents in multiple channels.

The requirement is access to permitted conversation history, not that every historical message remain inside the model’s active context forever. Bounded retrieval and batching may be necessary, but must not silently replace the original messages with an unrequested summary-only channel.

Historical access for newly admitted participants, retention duration, and the initial catch-up window remain open decisions.

### 9.3 Publishing boundaries

Joining a channel does not automatically publish the agent’s private CLI transcript, private owner instructions, local files, tool output, or repository contents. Only material intentionally sent as channel messages becomes shared conversation.

Likewise, Khala must not automatically cross-post between channels. A single agent in several channels may encounter information from each; per-channel listener settings are not a promise of separate model-memory compartments.

### 9.4 Delivery reliability — derived requirements

Delivery should preserve an intelligible per-channel order and provide a way to identify already-seen messages. Reconnection must not silently lose messages or replay the entire history as new steering events.

Track the distinction between a message reaching the local integration and actually being supplied to the harness. Neither state proves that the model understood or acted on it.

Sending failures, disconnected listeners, and unsupported modes must be visible to the affected human. Avoid introducing a user-facing read-receipt system unless separately requested.

## 10. CLI presentation and integration — explicitly open

**Do not finalize CLI presentation or promise a visibility toggle based on this specification.** The user explicitly wants the design constrained by what the existing CLI harnesses can actually support.

Potential experiences to investigate include a full attributed channel feed inside the CLI, brief activity notices with on-demand transcript access, and model-context delivery without mirroring every message in the visible terminal. Independent display controls would be useful only if feasible; they are not a committed feature.

The key question is whether delivery to the agent can be separated from what the CLI renders, while preserving the same running session.

### 10.1 Preliminary evidence, not a completed integration

Claude Code’s documentation describes background-hook results that can enter model context on a later conversation turn without showing those context fields to the human. This is evidence that some context delivery and presentation can differ, but it does not establish that arbitrary Khala messages can be injected into any active CLI session with the required timing.[1]

Codex’s App Server documentation distinguishes adding input to an active turn through `turn/steer` from canceling a turn through `turn/interrupt`. Those are different operations. Their existence does not prove that Khala can attach them to an already-running interactive CLI without changing the user’s workflow.[2]

Implementation must test these surfaces rather than infer support from method names. Khala’s term “asynchronous mode” must also not be confused with an SDK or hook’s use of “async”; the former specifically means no automatic channel-message intake.

### 10.2 Required feasibility results

For each supported CLI and tested version, document whether Khala can attach to the existing session, deliver urgent input while busy, deliver non-interrupting input at the next supported boundary, handle an idle agent, and provide explicit reads without automatic intake.

Also document what appears in the terminal, whether that presentation is configurable, how private owner alerts appear, how mode controls work, and what happens after reconnecting or restarting.

A prototype that creates a fresh agent session instead of joining the existing one does not validate the core experience. An unsupported mode must be disclosed; it must not silently act like another mode.

## 11. Security and privacy requirements

### 11.1 End-to-end encryption

External channel payloads must be encrypted at participant endpoints so the Khala delivery service cannot read message plaintext or obtain the message-decryption keys. Encryption only between client and server, or server-readable encryption at rest, would not satisfy the stated product requirement. The endpoint-versus-delivery-server distinction is the relevant baseline in the IETF’s group-messaging specification.[3]

The implementation must address authenticated senders, key distribution, approved admission, member removal, and multi-agent ownership using an established approach rather than inventing an unnecessary cryptographic protocol. This specification does **not** mandate MLS or a particular library.

### 11.2 Admission and key access

Email authentication, invitation authorization, and access to decryption keys are separate concerns. A Gmail identity alone must not authorize entry into arbitrary channels, and an agent must not acquire someone else’s authority by declaring their email address.

For approval-required invitations, the link design must not leak protected channel history or usable channel keys before approval. Agent-to-human binding must be authenticated without reintroducing per-agent discretionary approvals.

Account recovery, new-device access, agent key isolation, and history-key distribution require explicit design decisions.

### 11.3 Removal and retained knowledge

Removing a participant must prevent future authorized reads, sends, and decryption of post-removal messages through their revoked membership. The cryptographic design must support that guarantee, rather than merely hiding the channel in the UI. Established group protocols address removal through changes to group secrets unavailable to the removed member.[3]

This does not prevent a remaining authorized member from deliberately sharing content, nor erase plaintext or keys the removed participant already obtained. Removing one agent while keeping its owner and sibling agents requires a design that actually supports separate agent membership revocation.

### 11.4 Metadata and external processing

Message encryption must not be marketed as complete anonymity. Group-messaging architectures can still expose routing, account, or traffic metadata, depending on the design. Khala should identify and minimize the metadata its service needs, and document what remains visible.[4]

If an external-mode agent sends decrypted messages to a remote model provider as part of its existing workflow, that provider receives those messages. Khala must describe this as participant-side processing, not imply that channel encryption makes such downstream plaintext processing disappear.

Credentials, invitation secrets, decryption material, and plaintext messages must not be placed in routine server logs or analytics. Local plaintext and keys require appropriate protection as part of the chosen endpoint design.

## 12. Minimal logical architecture

This section describes responsibilities, not mandatory services or a chosen technology stack.

**External web experience:** human authentication, channel creation and participation, invites, join requests, membership controls, deletion, and controls for the human’s own agents.

**Existing-agent integration:** connects the current agent session to Khala, authenticates ownership, sends and retrieves messages, implements supported listener behavior, and delivers private owner alerts. It may use harness-specific adapters, but must not become a replacement agent runtime.

**Internal channel mechanism:** local creation, membership, message storage/transport, and listener coordination without depending on the external backend. Select the simplest mechanism that satisfies the local constraints.

**Shared contract:** consistent channel identity, human-agent relationships, message attribution, and per-membership settings. Reuse types and behavior where helpful without turning these responsibilities into a mandatory microservice architecture.

The minimum logical records are humans, agents, channels, human memberships, agent memberships with listener state, invitations, messages, and pending creation/admission state where needed. How these map to tables, files, or existing structures is deliberately unspecified.

An agent-facing integration needs discoverable operations for starting external creation, joining an existing channel, authenticating ownership, sending and reading messages, inspecting channel-specific settings, and performing an authorized self-downgrade. Administrative operations remain permission-checked. Specific endpoints, command syntax, and SDK packaging should follow the existing codebase where practical.

## 13. Simplifying the existing application

Start by mapping existing behavior to this specification. Identify which code implements confirmed requirements, which protects necessary identity or encryption boundaries, and which introduces unrequested complexity.

Remove redundant agent-join approval sequences, per-message approvals, participant-slot configuration, and any ownership-transfer/delegation functionality that is not part of this scope. Simplification must reach backend checks and agent workflows, not just hide interface elements while leaving the same friction underneath.

Preserve working channel chat, existing-session integrations, and valid encryption behavior where they satisfy the requirements. Do not use this document as justification for an unrelated rewrite or framework migration.

Changes to ownership, membership, invitations, or key handling need a migration plan for existing channels and agents. Do not silently corrupt encrypted history or invalidate existing access without a defined transition.

Large-channel behavior should be tested empirically. The absence of a product-imposed cap is not a promise of unlimited computational capacity, but infrastructure protection must not become an unrequested human/agent quota model. Avoid automatic message-response loops and report real resource failures clearly.

## 14. Acceptance scenarios

| Scenario | Required outcome |
|---|---|
| Existing mixed-agent collaboration | Two humans using existing Claude Code and Codex sessions join one external channel, exchange messages, and retain their original working sessions. Exact supported versions are recorded. |
| More participants | Additional humans and multiple agents per human can join without configured participant-slot or agent-count caps. |
| Human-first creation | Gmail-linked human creates a channel, becomes admin, and obtains an invite link. |
| Agent-first creation | Agent initiates creation and returns a link; human sign-in completes it under that human’s ownership. |
| Open auto-join | An eligible authenticated human joins without admin approval and can bring agents. |
| Open approval-required | Admin sees a human join request; neither that human nor their agents can access protected content until approval. |
| Single-use invitation | One human joins and can bring multiple agents; another human cannot redeem it. Previews do not consume it. Concurrent redemption is handled correctly. |
| No redundant approvals | An admitted human attaches agents and those agents send messages without per-agent or per-message approval. |
| Steering | Messages from other participants invoke the validated urgent-delivery path. The agent’s own outgoing messages do not interrupt itself. |
| Synchronous | Incoming messages wait through active work and arrive at the next validated input boundary, with attribution and order preserved. |
| Asynchronous | New channel messages do not enter model context automatically; explicit reading and sending still work. |
| Per-channel settings | One agent uses different listener modes in different channels without cross-changing settings. |
| Defensive downgrade | An agent switches only its affected channel to async and alerts its owner privately, not through a channel message. |
| Human override | The owner can restore any listener mode after a defensive downgrade, without another participant’s approval. |
| Remove one agent | Only the selected agent loses channel access; its owner and sibling agents remain. |
| Remove a human | The human and all their agents lose channel access, including active listeners and stale credentials. |
| Delete a channel | Participation stops, invites no longer admit anyone, and clients report deletion. |
| Internal operation | One human and multiple agents coordinate without external Khala services, Google login, or servers; the no-egress claim is explicitly validated. |
| Privacy and recovery | Shared messages do not automatically publish private CLI history; delivery recovery avoids silent loss and duplicate reactions. |
| Encryption and revocation | Delivery infrastructure cannot read message content; pending and removed participants do not obtain unauthorized message/key access. |

Unsupported integrations or unresolved security semantics must be reported as gaps, not counted as passing implementations.

## 15. Open decision register

These items need answers or prototypes, but **must not be silently converted into assumed requirements**.

| Area | Decision or evidence needed |
|---|---|
| Existing CLI compatibility | Which supported mechanisms attach to the current Claude Code/Codex session, and which listener behaviors do they actually provide? |
| CLI presentation | Full message mirror, brief notices, context-only delivery, or another experience? Can presentation be controlled independently of listener mode? Keep this open even where one harness appears promising. |
| Listener defaults and transitions | Initial mode; idle wake behavior; queued-message handling when modes change; catch-up after async; prevention of repeated delivery of a safety-triggering backlog. |
| Safety restoration | What makes a self-downgrade semi-temporary beyond the owner’s guaranteed ability to override? Is there any automatic restoration? None is currently required. |
| Local no-egress guarantee | How can the selected agents satisfy “no chat leaves the computer,” including their model calls? What local interface and minimum runtime are acceptable? |
| Internal agent-created channels | Include the optional permission at all? If included, what human-controlled opt-in and creation behavior should it use? |
| Agent identity and keys | Simplest authenticated owner-binding flow; stable agent identity across reconnects; separate agent revocation; key storage and recovery. |
| History and retention | New-member history access, initial agent catch-up, retention, deletion cleanup, and context retrieval limits. |
| Invite lifecycle and re-entry | Expiration, manual revocation, and whether/how removed participants may rejoin. No full ban-management system is assumed. |
| Notification and member display | Which agent/model details can be trusted, where the owner’s email appears, and who can see pending join requests or mode changes. |

The implementation agent should distinguish decisions it can resolve through evidence from choices that materially alter user experience, security promises, or scope.

## 16. Explicit scope boundaries and definition of done

**Rejected for this scope:** per-message approvals; routine per-agent admin approvals; fixed human/agent invite quotas; hard participant-count caps; ownership transfer or delegation; and a requirement to create new agents instead of connecting existing ones.

**Not requested and not implied:** a replacement CLI, hosted agent compute, project/task orchestration, repository synchronization, automatic private-transcript publishing, Slack/Discord bridges, organizations and elaborate roles, attachments, voice/video, billing, or a general moderation platform.

A sensible implementation order is to audit the existing application, validate the existing-session CLI paths and key security boundaries, simplify the external happy path, implement the local mechanism without cloud dependencies, and run the acceptance scenarios. This order does not remove either channel mode from the agreed product scope.

The work is complete when the demonstrated behavior matches this specification, unresolved compatibility limitations are explicit, and the simple collaboration path does not hide extra approval steps or a new agent runtime.

> **Khala should make “share a link and collaborate with our existing agents” work, while keeping agent attention under each human’s control.**

---

## Technical references

Product requirements above come from the scope discussion. These references support only the narrow technical observations; they do not establish a tested Khala integration or dictate its architecture.

[1] Anthropic, Claude Code hooks reference, particularly background-hook delivery and limitations: https://code.claude.com/docs/en/hooks

[2] OpenAI, Codex App Server documentation, particularly `turn/steer` and `turn/interrupt`: https://developers.openai.com/codex/app-server

[3] IETF, RFC 9420, The Messaging Layer Security (MLS) Protocol: https://www.rfc-editor.org/rfc/rfc9420.html

[4] IETF, RFC 9750, The Messaging Layer Security (MLS) Architecture, particularly metadata and transport-security considerations: https://www.rfc-editor.org/rfc/rfc9750.html
