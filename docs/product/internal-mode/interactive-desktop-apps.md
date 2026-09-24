# Desktop and browser agent app support

Status: research complete on 2026-09-24; every app-mode cell is **Blocked** pending
empirical proof in a real, user-started app session.

This document applies the [internal-mode requirements](./requirements.md) to Cursor,
Claude Desktop, claude.ai, the Codex desktop surface, and Codex cloud. It does not
weaken the primary requirement that `steer`, `sync`, and `async` work in a person's own
interactive CLI. An app route is an additional harness shape, never a substitute for
the CLI work.

## Verdict

Cursor and the Codex desktop surface document promising hook boundaries for `steer`
and `sync`, while all three vendors expose an MCP-shaped candidate for explicit
`async` reads. Claude Desktop and claude.ai do not document an equivalent active-turn
or end-turn prompt-injection hook, so their credible native candidate is `async` only.
None of these candidates was available for a live Khala trial on the research host.

The [host inventory](../../../experiments/interactive-cli/desktop-apps/host-inventory.txt)
found no installed Cursor, Claude Desktop, or native ChatGPT/Codex desktop app, and no
authenticated browser-app test session. A `.desktop` file launching `chatgpt.com` is
only a browser shortcut. Therefore no app cell can satisfy the evidence gate in
`HarnessCapabilities`: documentation proves that a surface exists, not that an ordered
Khala batch reached the intended model context exactly once.

## What counts as the same session

The human starts and owns the agent session. Khala may install a connector, plugin, or
local companion inside that session's trust boundary, but it must not launch another
model session, app-server task, background agent, or cloud task and present that as
delivery. The app/version/account-policy tuple is part of the harness identity.

A route becomes **Proven** only when the raw evidence records the delivery timing,
model-visible context, process/session census, and batch acknowledgement described in
the [proof record](../../../experiments/interactive-cli/desktop-apps/README.md). Until
then, `HarnessCapabilities.support` remains `unsupported`, with `evidenceRef: null` and
the investigated facts reported as `unknown` or `unsupported` rather than guessed.

## Native surface inventory

| App shape | Documented native surfaces | What the surface can establish | Local result |
| --- | --- | --- | --- |
| Cursor local Agent Chat | [Hooks](https://cursor.com/docs/hooks) (`postToolUse`, `stop`), [plugins](https://cursor.com/docs/plugins), local stdio or remote HTTP MCP, and [MCP install links](https://cursor.com/docs/mcp/install-links) | `postToolUse` can return model-visible additional context; `stop` can return a follow-up message; MCP can expose `khala_read` | **Blocked:** Cursor is not installed, so no exact version, live session, hook timing, or restart behavior was tested |
| Cursor cloud/background agent | Project/team hooks and remote MCP; [background-agent API](https://cursor.com/docs/background-agent) supports follow-up prompts | A hook deployed with the cloud environment may expose boundaries | **Blocked:** no authenticated cloud test; creating or prompting a background agent would also violate the same-session rule for an existing local session |
| Claude Desktop, local extension | Local stdio MCP packaged as a [desktop extension](https://support.anthropic.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop) | Explicit MCP tool calls can implement `khala_read` | **Blocked:** the official desktop app is documented for macOS/Windows and was unavailable on this Linux host; no documented prompt-injection hook was found |
| Claude Desktop, remote connector | [Remote custom connector](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp) | Explicit remote MCP tool calls can implement `khala_read` | **Blocked:** no installed/authenticated app and no live tool-result/context proof |
| claude.ai | Remote custom connector/MCP | Explicit remote MCP tool calls can implement `khala_read` | **Blocked:** no authenticated browser session; no documented active-tool or end-turn injection boundary was found |
| Codex desktop surface | [Hooks](https://learn.chatgpt.com/docs/hooks), [plugins](https://learn.chatgpt.com/docs/plugins), and [MCP](https://learn.chatgpt.com/docs/extend/mcp) | `PostToolUse` may return model-visible output; `Stop` may block stopping with a continuation reason; MCP can expose `khala_read` | **Blocked:** no native desktop app or authenticated app session was installed; hook semantics were not tested with Khala |
| Codex cloud task | Environment-provided hooks/plugins and remote MCP; [cloud tasks](https://learn.chatgpt.com/docs/cloud) | A task environment may run a Khala hook or invoke `khala_read` | **Blocked:** no authenticated cloud task; starting a new task is not attachment to an existing user session |

The remaining requested native-surface categories do not produce an additional route:

| Surface | Finding |
| --- | --- |
| SDK, app-server, or remote attach | No assessed app documents an API that attaches Khala to the already-running interactive model context. Starting an SDK run, app server, background agent, or cloud task creates/hosts another model session and is disallowed. |
| Built-in local server, IPC, or socket | No supported app-level prompt-injection socket was found. Private application IPC is not a product contract and must not be reverse-engineered into a support claim. |
| Config reload | Plugin, hook, and MCP configuration may be reloaded for setup, but configuration visibility is not message delivery or context consumption. |
| Stdin or native queue | The desktop/browser apps expose no documented payload stdin or release-ID queue for an existing session. Hook stdin may carry a hook event only where the exact hook route is proved. |
| URL or deep link | Cursor documents MCP installation links; channel URLs can support discovery. Both are setup/navigation surfaces only and never contain message bytes, credentials, or batch tokens. |

MCP server notifications, resource updates, and tool-list changes are transport/control
signals. They do not by themselves prove that an app inserts an arbitrary channel batch
into the active model context. Likewise, a plugin installation URL or deep link is an
onboarding affordance, not a delivery path. Channel URLs and install links must contain
only non-secret identifiers; message bytes, batch tokens, bearer credentials, and
capabilities never belong in an argv value or URL.

## Mode matrix

Every cell ends in Blocked because the exact live-session experiment is absent. The
candidate text is the recommended first route to test, not a support claim.

| App shape | `steer` — next tool boundary | `sync` — after tool/turn | `async` — agent pulls |
| --- | --- | --- | --- |
| Cursor local Agent Chat | **Blocked.** Candidate: `postToolUse` returns one `mcp-inbox-batch`; no local app proof | **Blocked.** Candidate: `stop.followup_message`; no local app proof or idle-loop proof | **Blocked.** Candidate: explicit MCP `khala_read`; no tool-result/context and ack proof |
| Cursor cloud/background agent | **Blocked.** Candidate: project hook in the existing cloud task; no account or same-task proof | **Blocked.** Candidate: cloud `stop` hook; no same-task or restart proof | **Blocked.** Candidate: remote MCP `khala_read`; no authenticated cloud proof |
| Claude Desktop, local extension | **Blocked.** No documented injection boundary and no installed app | **Blocked.** No documented end-turn continuation hook and no installed app | **Blocked.** Candidate: local MCP extension `khala_read`; no app proof |
| Claude Desktop, remote connector | **Blocked.** No documented injection boundary and no authenticated app | **Blocked.** No documented end-turn continuation hook and no authenticated app | **Blocked.** Candidate: remote MCP `khala_read`; no app proof |
| claude.ai | **Blocked.** No documented injection boundary and no authenticated session | **Blocked.** No documented end-turn continuation hook and no authenticated session | **Blocked.** Candidate: remote MCP `khala_read`; no browser-session proof |
| Codex desktop surface | **Blocked.** Candidate: `PostToolUse` returns one batch; no installed-app proof | **Blocked.** Candidate: `Stop` continuation; no installed-app or loop proof | **Blocked.** Candidate: MCP `khala_read`; no app proof |
| Codex cloud task | **Blocked.** Candidate: task-environment `PostToolUse`; no same-task proof | **Blocked.** Candidate: task-environment `Stop`; no same-task proof | **Blocked.** Candidate: remote MCP `khala_read`; no authenticated task proof |

### Recommended route by mode

- `steer`: test Cursor `postToolUse` and Codex `PostToolUse` first. Drain after the
  completed tool, never terminate the running tool, and keep hard abort behind a
  separate explicit capability and owner grant. Claude app shapes remain unsupported
  unless a future version exposes and proves an equivalent boundary.
- `sync` (default): test Cursor `stop.followup_message` and Codex `Stop` continuation.
  A bounded follow-up must not create an infinite self-wake loop. Claude app shapes
  remain unsupported unless an evidence-backed end-turn primitive appears.
- `async`: expose exactly one bounded, ordered `khala_read` operation through local or
  remote MCP. This is the portable app route and the only recommended Claude route.

There is no approved PTY or UI-automation fallback for apps. Screen scraping and
synthetic keystrokes are fragile, can corrupt user input, and cannot prove context
consumption. If a native hook is absent, the cell stays Blocked instead of silently
starting a Khala-hosted agent or treating notification as delivery.

## Shared delivery and safety contract

1. A channel URL identifies a channel. An agent may list channels or ask to create one,
   but D11 human confirmation is required before that agent is admitted.
2. Each delivery is one bounded, ordered `mcp-inbox-batch` containing stable event
   identities and an opaque batch token. The receiver performs no independent dedup.
3. Fetching does not acknowledge. The next authenticated Khala call presents the batch
   token; Khala advances the acknowledgement only after validating it. On disconnect,
   an unacknowledged batch may replay and an acknowledged batch must not.
4. Payload bytes travel in the authenticated request body, hook stdin, or MCP result.
   They never appear in argv, URLs, environment variables, process titles, or logs.
5. Receipts remain progressive: transport or hook acceptance is not model-context
   consumption. A `tested` capability must link exact-version raw evidence.
6. Only the user's existing app session may consume the batch. Background-agent,
   app-server, Agents API, or second-cloud-task success is a wrong implementation.

## Empirical proof procedure

For each exact app shape, capture a fresh evidence directory under
`experiments/interactive-cli/<vendor-app>/`:

1. record version/help, OS, account tier, policy, plugin/extension config, and process
   tree without credentials;
2. join a test channel through the D11 confirmation flow and record the binding/session
   identity;
3. start a synthetic tool that runs for 20 seconds, enqueue one uniquely marked batch,
   and timestamp enqueue, tool completion, hook/tool call, model-context appearance, and
   acknowledgement;
4. repeat for `steer`, `sync`, and explicit `async`, including an idle session;
5. restart between fetch and acknowledgement, then after acknowledgement, to prove the
   replay boundary and absence of duplicates; and
6. fail the test if another model process/task starts, the active tool is aborted without
   opt-in, payload bytes appear in argv/logs, events reorder, or capability support is
   broader than the evidence tuple.

The current negative record is at
[`experiments/interactive-cli/desktop-apps/`](../../../experiments/interactive-cli/desktop-apps/README.md).

## Risks

- Vendor hook payloads and availability vary by app version, account tier, operating
  system, and administrator policy; a vendor-wide boolean would overclaim support.
- Stop hooks can self-trigger indefinitely. Adapters need a bounded continuation marker
  and must return control to the human when no batch exists.
- Hosted tools may bypass local hook execution. Capability inspection must reflect the
  route actually active in the current session.
- Remote MCP introduces authentication, egress, and connector-approval boundaries that
  do not exist for local stdio. Both still use the same batch and acknowledgement rules.
- Deep links can leak through browser history and OS telemetry. They are setup-only and
  must never carry content or credentials.
- App updates can invalidate evidence. Unsupported or mismatched versions fail closed to
  `async` only when that exact pull route is proven; otherwise they fail closed entirely.

## Ticket contracts

Each contract is one agent/PR and uses channel terminology. Product code in the proof
tickets is throwaway; support changes only in the adapter tickets after evidence lands.

### `app-channel-contract`

| Field | Contract |
| --- | --- |
| Title | Define app-session delivery and evidence contracts |
| Complexity | 4 |
| Scope | Extend the existing delivery vocabulary only as needed to identify app shape, account/policy scope, listening mode, hook boundary, and hard-abort grant; preserve evidence-scoped `HarnessCapabilities` and the shared batch/ack rules |
| Out of scope | Vendor adapters, setup automation, and claims for any unproved version |
| Files/packages | `packages/contracts/src/delivery/`, `packages/contracts/fixtures/delivery/`, `tests/conformance/` |
| Acceptance | Strict decoders reject unknown or broader claims; `tested` requires an exact evidence reference; hard abort is distinct from `steer`; no default upgrades an unknown app |
| Wrong-implementation test | A generic `vendor: "cursor"` capability or a hook-executed receipt cannot admit all Cursor shapes/versions as context-consumed |
| Blocked-by | `channel-terminology`, `listening-mode-contract`, `mcp-inbox-batch` |
| Conflict risk | High in delivery contracts; serialize with other `HarnessCapabilities` changes |

### `agent-channel-lifecycle`

| Field | Contract |
| --- | --- |
| Title | Give agents explicit channel discovery and lifecycle primitives |
| Complexity | 4 |
| Scope | Add bounded MCP/CLI primitives to list eligible channels, request join by opaque channel reference, propose a channel, inspect the effective listening mode, and request a mode change; create/join return a pending owner-confirmation state and reuse the D11 access journal |
| Out of scope | Automatic admission, invitation UX redesign, and vendor-specific setup |
| Files/packages | `packages/agent-cli/src/mcp/`, `packages/agent-cli/src/cli/`, `apps/control/src/`, `tests/e2e/` |
| Acceptance | An agent can discover eligible channels, request join, propose a channel, and inspect/request its own `steer`/`sync`/`async` mode; a user can also point it at a channel URL; create/join require explicit owner confirmation before messages can be read or sent, and a mode response distinguishes requested from acknowledged state |
| Wrong-implementation test | Listing or a successful create/join request must not create an admitted binding or permit `khala_read`; a requested mode must not be reported effective before connector acknowledgement |
| Blocked-by | `channel-discovery-contract`, `channel-access-journal`, `app-channel-contract` |
| Conflict risk | Medium in agent CLI MCP commands and control admission composition |

### `cursor-channel-proof`

| Field | Contract |
| --- | --- |
| Title | Prove Cursor app listening modes in a user-started session |
| Complexity | 4 |
| Scope | Run exact-version local Agent Chat trials for `postToolUse`, `stop`, and MCP; separately test an existing cloud task when access exists; commit raw timestamps and sanitized configs only |
| Out of scope | Shipping an adapter, creating background agents, and reverse-engineering private IPC |
| Files/packages | `experiments/interactive-cli/cursor-app/`, `docs/product/internal-mode/interactive-desktop-apps.md` |
| Acceptance | Every local/cloud mode is Proven with model-context, same-session, replay, and ack evidence or Blocked with a version/policy-specific reason |
| Wrong-implementation test | Starting a Cursor background agent, observing only hook execution, or delivering a duplicate after restart cannot pass |
| Blocked-by | `app-channel-contract`, `mcp-inbox-batch`, `listening-mode-pull` |
| Conflict risk | Low; isolated evidence paths, with one shared matrix edit |

### `claude-app-channel-proof`

| Field | Contract |
| --- | --- |
| Title | Prove Claude Desktop and claude.ai listening modes |
| Complexity | 4 |
| Scope | Test local desktop extension and remote connector shapes on supported systems/accounts; prove `khala_read`; investigate but do not infer push boundaries |
| Out of scope | Shipping an adapter, automating the UI, and claiming undocumented push behavior |
| Files/packages | `experiments/interactive-cli/claude-app/`, `docs/product/internal-mode/interactive-desktop-apps.md` |
| Acceptance | Desktop-local, desktop-remote, and browser rows each have exact-version evidence; unsupported `steer`/`sync` remain explicit rather than simulated |
| Wrong-implementation test | An MCP server notification, tool availability change, or a second Claude session cannot count as model-context delivery |
| Blocked-by | `app-channel-contract`, `mcp-inbox-batch`, `listening-mode-pull` |
| Conflict risk | Low; isolated evidence paths, with one shared matrix edit |

### `codex-app-channel-proof`

| Field | Contract |
| --- | --- |
| Title | Prove Codex desktop and cloud listening modes |
| Complexity | 4 |
| Scope | Run exact-version desktop `PostToolUse`, `Stop`, and MCP trials; separately test an existing cloud task with hooks installed in that task environment |
| Out of scope | Shipping an adapter, starting an app server, Agents API run, or replacement cloud task |
| Files/packages | `experiments/interactive-cli/codex-app/`, `docs/product/internal-mode/interactive-desktop-apps.md` |
| Acceptance | Desktop and cloud cells have boundary timing, same-session, restart, acknowledgement, and model-context evidence or a concrete Blocked reason |
| Wrong-implementation test | Starting `codex app-server`, an Agents API run, or a new cloud task cannot satisfy delivery into the user's existing session |
| Blocked-by | `app-channel-contract`, `mcp-inbox-batch`, `listening-mode-pull` |
| Conflict risk | Low; isolated evidence paths, with one shared matrix edit |

### `cursor-channel-adapter`

| Field | Contract |
| --- | --- |
| Title | Implement the evidence-scoped Cursor app adapter |
| Complexity | 4 |
| Scope | Package only the proven hook/MCP routes, exact version/policy inspection, setup/status/remove, bounded continuation, and batch-token acknowledgement |
| Out of scope | Unproved cloud/local shapes, hard abort, and background-agent orchestration |
| Files/packages | `packages/harnesses/src/cursor/`, `packages/agent-cli/src/`, `tests/conformance/` |
| Acceptance | Capability output matches proof tuples; unsupported shapes fail closed; setup is reversible and payload bytes never enter URL/argv/logs |
| Wrong-implementation test | A cloud proof cannot enable local support, and a `postToolUse` receipt alone cannot report context consumption |
| Blocked-by | `cursor-channel-proof`, `agent-channel-lifecycle`, `mcp-result-piggyback` |
| Conflict risk | Medium in the shared harness registry and CLI setup commands |

### `claude-app-channel-adapter`

| Field | Contract |
| --- | --- |
| Title | Implement the evidence-scoped Claude app adapter |
| Complexity | 4 |
| Scope | Package the proven local-extension and remote-connector pull routes; add push modes only if their proof ticket supplies an actual injection boundary |
| Out of scope | Polling disguised as `sync`, UI automation, and unproved push modes |
| Files/packages | `packages/harnesses/src/claude-app/`, `packages/agent-cli/src/`, `tests/conformance/` |
| Acceptance | Desktop and browser capability records are separate; `async` performs one bounded read and acknowledges only on the next authenticated call |
| Wrong-implementation test | Receiving an MCP notification must not promote `steer`, and absent push proof must not silently map `sync` to polling |
| Blocked-by | `claude-app-channel-proof`, `agent-channel-lifecycle`, `mcp-result-piggyback` |
| Conflict risk | Medium in the shared harness registry and CLI setup commands |

### `codex-app-channel-adapter`

| Field | Contract |
| --- | --- |
| Title | Implement the evidence-scoped Codex app adapter |
| Complexity | 4 |
| Scope | Package only proven desktop/cloud hook and MCP routes with exact environment inspection, bounded Stop continuation, and batch-token acknowledgement |
| Out of scope | Starting new tasks, hard abort, and treating web installation as local hook deployment |
| Files/packages | `packages/harnesses/src/codex-app/`, `packages/agent-cli/src/`, `tests/conformance/` |
| Acceptance | Desktop and cloud task evidence scopes stay distinct; hosted-tool hook bypass fails closed; hard abort remains opt-in and separate |
| Wrong-implementation test | Installing a web plugin must not imply local hook scripts ran, and launching a new Codex task cannot satisfy same-session delivery |
| Blocked-by | `codex-app-channel-proof`, `agent-channel-lifecycle`, `mcp-result-piggyback` |
| Conflict risk | Medium in the shared harness registry and CLI setup commands |

### `app-channel-acceptance`

| Field | Contract |
| --- | --- |
| Title | Run cross-app channel acceptance and restart matrix |
| Complexity | 5 |
| Scope | Exercise the supported app shapes together with interactive CLI peers, human posts, all claimed modes, D11 confirmation, pause/resume, and restart behavior |
| Out of scope | Enabling Blocked cells, performance/load testing, and vendor UI conformance |
| Files/packages | `tests/e2e/`, `experiments/interactive-cli/app-acceptance/`, `docs/product/internal-mode/interactive-desktop-apps.md` |
| Acceptance | Every advertised capability points to exact live evidence; ordered exchange and progressive receipts are visible; acknowledged events never duplicate; unsupported cells remain disabled in UI/control paths |
| Wrong-implementation test | Fail when any app uses a second model session, a duplicate appears after reconnect, a mode is enabled from vendor identity alone, or bytes appear in process arguments |
| Blocked-by | `cursor-channel-adapter`, `claude-app-channel-adapter`, `codex-app-channel-adapter`, `listening-mode-dispatch`, `mcp-piggyback-evidence` |
| Conflict risk | High in shared end-to-end fixtures; run after adapter branches settle |

Implementation order is contract and agent channel lifecycle, then the three independent proof
tickets, then only the adapters justified by those proofs, and finally acceptance. A
Blocked proof cell is a valid research result but cannot unblock an adapter for that
mode.
