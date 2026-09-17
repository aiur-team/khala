# Khala research

Research toward a shared, secure conversation between humans and their agents across organisations and model vendors. Minimum four actors: two humans, two agents. Must generalise to more.

Written 2026-09-16 from four parallel research tracks. Two completed, one completed as a sub-report, one was stopped before reporting. Read `SCOPE.md` first.

| file | track | state |
|---|---|---|
| `SCOPE.md` | the problem, the airlock, trust levels | complete |
| `01-agent-protocols.md` | A2A, MCP, ACP, AGNTCY/SLIM, DIDComm, and what is newer | complete |
| `02-substrates.md` | Matrix, Slack Connect, Teams, XMPP, Zulip, Discord, Buzz, email | complete |
| `03-prompt-injection.md` | the untrusted-peer channel, defenses, incidents, numbers | complete |
| `04-identity-trust.md` | cross-org identity, delegation, airlock evaluation, trust levels | **not written**, agent stopped |
| `05-e2ee.md` | MLS, Megolm, key custody on agent hosts, the inference problem | **not written**, agent stopped |

## Where the three completed tracks converge

1. No agent protocol does this. A2A, MCP and the rest are pairwise and task-shaped. A shared room is a group-messaging problem, solved in the chat world since 2014. Use MCP as each agent's local adapter to a real chat substrate, never as the transport between agents.
2. Matrix is the only substrate that is both peer-federated, so neither company owns the room, and confidential from the server operators. It has an October 2026 cliff: clients stop sharing encrypted room keys with devices not cross-signed by their owner, and how a bot does that is still an open issue. Budget a week on bot key custody and do it before October.
3. End-to-end encryption cannot honestly mean "only the four of us can read this" once a hosted-model agent is in the room. The agent holds keys on a server, and it sends plaintext to a model vendor for inference. What can be bought is confidentiality from the chat platform. The honest posture is signed and attributed messages over a platform-blind transport.
4. The peer agent is an untrusted input channel. Nothing in any protocol labels it so; you label it yourself. The only defenses with a security argument are structural: never hold the peer channel and a consequential capability in the same context, close egress and config-write surfaces, and quarantine peer content through a tool-less worker that emits a fixed schema. Human confirmation prompts catch roughly one in seven attacks in a controlled study; detection classifiers are fully evadable by adaptive attackers. Budget for an attacker with thousands of attempts, because a peer that talks to you all day is one by construction.
5. For this month: Slack Connect with one internal app per organisation, or email with a list address and agent mailboxes. For this quarter, if confidentiality from the platform is required: Matrix.
