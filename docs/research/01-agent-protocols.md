# Agent protocols and reliable wakeup

Research continuation, 16 September 2026. User decisions: maximize OSS reuse and accept connector-gated approval. The 44-ticket scope is approved for detailed planning; unanswered product choices remain explicit gates. Recovered reports remain historical evidence, not a compatibility specification.

## Current product and hosting decisions

Attach Khala to the user's **existing working session**, preserving its identity, context and permissions. The agent sets up the required pub/sub using a harness-specific adapter. Notifications must arrive promptly while connected; replay is recovery, and polling-only operation is not the default. Any model can participate through the model-independent contract; a model vendor and an agent harness are different compatibility dimensions. Do not create a replacement Khala agent/session implicitly.

Khala implementation is TypeScript. Netlify Functions/Blobs are preferred; managed Matrix or an existing OSS backend on Railway is acceptable if it saves meaningful development. Matrix is a candidate, not selected. Both substrate paths in [the comparison](02-substrates.md) must preserve the same connector approval and existing-session contract.

## Existing-session adapter evidence and support ladder

Inspected local CLI help, not live delivery: Claude Code `2.1.271`, Codex CLI `0.154.0`. No message was sent into a user session for this research.

| Harness | Evidence | Integration consequence |
|---|---|---|
| Claude Code | Official channels use `notifications/claude/channel`; registration/organisation opt-in is required; transport write is not an acknowledgement; busy events queue until the next turn | Build approved-only Khala channel plus reply/receipt tool. Verify setup in the original session; if activation requires restarting/resuming, preserve session ID and disclose that limitation. Never silently spawn a new session |
| Codex | Installed `codex queue --help` provides `--thread` by UUID/name and `--message`; app-server supports local control/proxy surfaces | Spike authenticated attach/queue into the existing thread; verify busy behavior, receipt/correlation and restart. CLI help proves a surface exists, not end-to-end delivery |
| Aiur-managed | Local executor event journal, Exchange wakeups and operator-message boundary | Use the existing control/session ownership path rather than inventing a new worker; test backend-specific queue/steer behavior |
| Other harness/model combinations | No universal notification extension is established | Publish adapter protocol and conformance fixture; a third party can implement it without a model-vendor-specific room protocol |

Claude channel registration currently does not support negotiated MCP `2026-07-28`; pin the compatible channel protocol separately from generic MCP tools. The preview feature can be absent from CLI help. These are compatibility constraints to detect, not reasons to infer that generic MCP notifications wake every host. [Claude channels](https://code.claude.com/docs/en/channels), [channel reference](https://code.claude.com/docs/en/channels-reference). Codex's app-server documents thread/turn control; use generated protocol bindings matched to the installed version. [Codex app-server](https://developers.openai.com/codex/app-server).

Support levels: (1) **protocol-compatible** means an adapter can register identity/capabilities and exchange approved events; (2) **integration-tested** means a named harness/version passes existing-session, idle/busy, disconnect and replay fixtures; (3) **unsupported capability** is visible, not silently replaced with a polling loop or new agent. “Any model” is an open protocol/product requirement, not a claim that every host has already passed those tests.

Registration should bind owner, room/device, harness kind, existing session/thread ID, process generation and supported notification/receipt capabilities. Preserve current model choice, working directory, tool permissions and session history. Send a harmless authenticated setup probe and confirm through the adapter before showing attached. Distinguish `published`, `connector_received`, `harness_queued`, `context_consumed`, and `responded`; prompt notification while busy does not mean immediate interruption. Never emit pending review plaintext in the probe, wake metadata or channel message.

## Layering decision

Khala needs a conversation protocol, an encrypted delivery protocol, and adapters that make an agent act. These are separate contracts. An HTTP success, a socket frame, a decrypted message, a scheduled turn, and a completed turn must have distinct receipts. No transport alone supplies exactly-once model execution or tool side effects.

| Boundary | Proposed owner | Responsibility |
|---|---|---|
| Human/agent participant → room | Khala command API | Authorised membership, immutable envelope submission, stable idempotency key |
| Room → participant device | Khala durable feeds | Audience-scoped replay, retention errors, revocation |
| Approved delivery → harness | Local connector | Decrypt room content into isolated pending storage; expose approved content to model; durable inbox/scheduling |
| Model → connector | MCP or equivalent tools | Send, read approved context, inspect own delivery status |
| Agent → remote capability | Optional A2A adapter | Task delegation and status mapping |
| Controller → interactive agent | Harness API or ACP | Start/continue/cancel a session under explicit operator policy |

The relay never schedules a model from arbitrary untrusted message text. A typed, authenticated release references immutable approved material and the intended agent instance. The trusted owner connector may already hold pending plaintext; the gate protects model-context delivery, not confidentiality from that connector. Crypto/identity contracts are defined in [identity](04-identity-trust.md) and [E2EE](05-e2ee.md).

## External protocol facts verified in this continuation

**MCP revisions differ materially.** The 2025-11-25 transport permits optional SSE resumption. The 2026-07-28 source removes protocol sessions, the GET stream, and Last-Event-ID resumability; long-lived change notifications use `subscriptions/listen`. Pin and negotiate supported revisions per harness. Never substitute MCP connection state for Khala's durable feed cursor. [2025 transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports), [2026 transport source](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/basic/transports/streamable-http.mdx).

**A2A is useful for tasks.** Its specification defines task/message operations, discovery, streaming, push notifications, and multiple bindings. That does not establish Khala room membership, recipient approval, or group encryption. A room identifier must not be equated with an A2A task/context identifier. Use an explicit mapping if interoperability is selected. [A2A specification](https://a2a-protocol.org/latest/specification/).

**ACP describes controller-driven turns.** Its v1 prompt lifecycle includes client `session/prompt`, agent updates, and cancellation. This is useful at the harness boundary; it is not evidence that an installed tool automatically wakes an idle agent. Verify the implemented version and capabilities on each chosen backend. [ACP prompt turn](https://agentclientprotocol.com/protocol/v1/prompt-turn).

MCP notifications can inform a host; whether the host inserts context or starts another turn remains a harness behavior to prove. Background operation after the terminal closes additionally requires a running connector/service and permitted harness lifecycle. An MCP-only launch cannot promise always-on participation.

## Aiur evidence and limits

Inspected sibling checkout: `../aiur` HEAD `1f618cddf`; working-tree source is the evidence, not a deployment claim.

- `src/lib/aiur/executor_events.ex`: `listen/1` subscribes to Exchange before journal replay, then drains live messages; persisted executor events and transient wake projections take different paths. Reuse the separation of journal and wake hint.
- `src/lib/aiur/events/exchange.ex`: ETS pattern routing uses asynchronous `send`; subscribers drain their own mailboxes. This is an in-process notification mechanism, not durable delivery or bounded network backpressure.
- `src/lib/aiur/events/subscription_store.ex`: transient enqueue failures hold the cursor; later events wait behind a stall. Permanent failures emit an alert and advance. `advance_cursor_inline` ignores the result of persistence. These are concrete limitations to revisit, not an exactly-once guarantee to inherit.
- `src/lib/aiur/executor_wake_projection.ex` and `src/lib/aiur/orchestrator/operator_messages.ex` identify relevant integration boundaries. A Khala adapter must enter through a supported control surface with a release correlation ID, not copy a dashboard stream into model context.

No live Aiur run, provider call, or backend compatibility test was performed for this report.

## Connector contract to prototype

Persist an inbox row keyed by `(agent_instance_id, release_id)` before scheduling. Record states `received`, `verified`, `queued`, `dispatching`, `running`, `completed`, `failed`, and `outcome_unknown` separately from conversation read status. Treat the state names as a proposed contract, not an implementation mandate.

A worker claims a delivery with a lease and fencing token. Reconnect/replay may repeat the delivery; the unique key prevents a second queue record. Fencing protects local state changes; it cannot undo an external model call. If a crash occurs after harness acceptance but before recording its turn ID, reconcile using a harness-supported request ID. If the harness offers no lookup/idempotency primitive, expose `outcome_unknown` and require a declared retry policy. Do not quietly promise exactly-once effects.

For an agent already working, propose queue-until-turn-boundary as the initial behavior. Interrupt/steer is an explicit capability and product choice. A stopped session may require human resume of that same session; a disconnected connector remains queued, never represented as having consumed the message. Cancellation is best effort once an external action has begun.

Each delivery carries an authenticated causal chain/root ID, target, parent release, and policy generation. Apply configurable per-chain turn/message budgets and timeouts outside model reasoning. Mentions and quoted text are not authority to release or schedule. Pausing a room must stop new dispatch without pretending to retract already disclosed plaintext.

Local model tools should expose only approved feeds and sending/status operations. Pending content may exist in the trusted connector but is excluded from model-visible interfaces. Human approval and pending review payloads must remain outside those tools, including error details, resources, logs, and debug endpoints.

## Product decisions needed

1. Settled: existing working sessions, immediate notification, model-independent support. Remaining: which harness/version pairs must be integration-tested for the first release?
2. Must agents remain reachable after the owner's laptop sleeps or terminal closes? That determines connector hosting and inference custody.
3. Within the existing session, should new approved input queue or interrupt at a supported safe boundary? What should users see when a harness cannot honor that choice? Starting a separate task/session is outside the default attachment requirement.
4. Is the first workflow collaborative conversation, task delegation, or both? A2A belongs in the first release only if task interoperability is a real user need.
5. Should automatic agent-to-agent exchanges stop after a fixed budget, ask for another human release, or continue within a time/cost allowance?

## Proposed ticket slices

| Slice | Dependencies | Acceptance evidence |
|---|---|---|
| Harness capability spike | Product target selection, release envelope draft | Record exact backend/version; prove idle wake, busy delivery, disconnect, cancellation, and unknown-outcome recovery for each chosen target |
| Connector durable inbox | Identity instance binding, selected substrate crypto/sync, connector approval contract | Replay and restart create one inbox job; no pending review content reaches harness; stale instance is rejected |
| Harness dispatch adapter | Capability spike, inbox | Existing session ID/context/permissions survive attachment; busy-session policy is honored; accepted request ID reconciles restart or reports uncertainty; no implicit rerun |
| MCP tool adapter | Connector API, selected MCP versions | Version compatibility fixtures; approved-only reads; errors/resources cannot disclose pending review data |
| Turn-budget and pause controls | Dispatch, signed policy/release model | Cycles stop at configured cap; replay cannot reset budget; pause blocks new turns; UI shows why work stopped |
| Optional A2A adapter | Explicit product approval, dispatch and task mapping | Task identity/cancellation/status map correctly; A2A credentials grant no extra room or approval authority |

These are proposal slices for consolidation into the shared ticket breakdown; no ticket numbers or implementation plans are approved here.

## Candidate ticket: existing-session notification conformance

Proposed acceptance criteria, pending ticket sign-off:

1. The current agent runs setup, binds its existing session ID, and installs/activates the harness adapter without replacing its model, context, working directory or permissions. Any required same-session resume is explicit and tested.
2. Setup records exact harness/adapter/protocol versions and capabilities; an authenticated round-trip probe verifies readiness. Configuration presence or a successful transport write alone is insufficient.
3. A released event reaches the connector through live subscription and triggers the harness path without waiting for a periodic poll. Record timestamps for room acceptance, connector receipt, harness enqueue and observed consumption. A latency target is set in the ticket, not invented by this research.
4. An idle-session case demonstrates the original session reacting. A busy-session case demonstrates prompt enqueue/notification and the harness's documented consumption boundary; no claim of immediate model interruption unless observed and supported.
5. Disconnect/reconnect and connector restart recover accepted releases by stable ID without a second inbox job. When harness consumption cannot be acknowledged/reconciled, expose uncertainty rather than claiming delivery or silently repeating an external action.
6. Pending content never enters wake messages, tools, resources or diagnostic output; a replay cannot bypass approval. An unsupported or policy-blocked notification capability is visible and cannot silently fall back to polling-only mode or a replacement agent.
7. Publish an adapter contract and reusable fixtures for other harness/model pairs. The compatibility matrix labels only actually exercised pairs as integration-tested; the open contract carries no model-vendor restriction.
