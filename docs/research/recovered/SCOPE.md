# Scope

Owner: Kevin. Recorded 2026-09-16 from the conversation that commissioned the research.

## The problem

Two people at different companies each have a coding agent. Today they act as meat proxies: one copies context out of their agent, sends it to the other person, who pastes it into theirs. They want one shared conversation.

- Minimum four actors: two humans and two agents. Expandable to more.
- Both humans can see the whole chat and add input as themselves.
- The agents talk to each other directly.
- Crosses organisational boundaries and model vendors: one side may run Claude, the other something else.
- Flow: open a chat, send the other human a link, they hand it to their agent, everyone is in the room.
- End-to-end encryption is a priority. See the honesty note in `README.md` point 3.

## The airlock

The conversation creator, by hand or through their agent, can queue one or several messages that the recipient human reads first, before their own agent sees anything. The recipient decides, message by message, whether to pass it along to their agent. Inbound content from the other organisation therefore lands in a staging area gated by a person, and only released messages enter the local agent's context.

This is the primary control against the far agent steering the near one. Open questions the trust track was to answer before it was stopped: where it genuinely stops an injection and where it does not, since a person skimming a long technical message misses one buried in it and content can read as harmless to a human while steering a model; whether release should allow redaction and annotation rather than being all-or-nothing; how to show provenance so the reader knows which parts a model wrote; whether the gate must be symmetric on replies; how the queue behaves under a long thread; and prior art in moderated mailing lists, pull-request review, and data diodes.

## Trust levels

The recipient human can turn the airlock off for a given peer once they trust that human and their agent, so messages flow straight into their agent. They can turn it back on at any time.

Treat this as a graduated trust level per peer rather than a switch. Open questions: what the human is actually asserting when they disable review, given the far agent's behaviour can change under a model update, a prompt change or a compromise of its host, none of which the trusting human will see; whether trust should be scoped per peer, per conversation or per capability; whether a lighter gate should remain on consequential actions when full review is off; whether unusual traffic should re-arm review; how the current state stays visible so nobody forgets a channel is open; whether the far side should be told, since it changes what their agent can do; and what an audit record of the decision should contain. Prior art to check: how email clients, package managers, browser permissions and federated chat move a relationship between untrusted and trusted.

## Findings from `03-prompt-injection.md` that bear directly on the airlock

- A human confirmation gate on agent actions caught 13.6% of swapped-in harmful actions in a controlled study of over a thousand paid developers. The airlock is a gate on content rather than actions, which is a better place to stand, but the same habituation applies: a reader who releases twenty messages a day will stop reading them.
- Models infer role from textual style rather than from labels, so a peer message formatted to look like a system prompt gets treated as one. Released content should be re-rendered into a neutral format before it reaches a privileged model, not just wrapped in a tag.
- The structural pattern that fits the airlock: the released message goes to a quarantined worker with no tools that emits a fixed schema, and the orchestrator never sees the raw bytes.
- Worm dynamics are real. A self-replicating injection propagated over peer agent messaging at a 64.5% success rate in a 2026 study. Apply the same quarantine on the way out, since what your agent emits back may carry the payload.
