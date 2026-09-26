# Desktop and browser agent app support

Status: research complete on 2026-09-24; every app-mode cell is **Blocked** pending
empirical proof in a real, user-started app session. The Cursor proof run on 2026-09-25
([`cursor-app`](../../../experiments/interactive-cli/cursor-app/README.md)) kept every
Cursor cell Blocked. It added a runnable trial kit and a verifier that grades live
evidence.

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
then, every app-mode `ModeSupport` in `HarnessCapabilities` (owned by
[`listening-mode-contract`](./listening-modes.md)) reports `unknown` with a reason and
no evidence reference, and `acknowledgement` reports `unknown`. No cell was inspected
in a live session, so none is a proven negative; `unsupported` is reserved for a cell
whose exact-version experiment shows the boundary is absent.

## Native surface inventory

| App shape | Documented native surfaces | What the surface can establish | Local result |
| --- | --- | --- | --- |
| Cursor local Agent Chat | [Hooks](https://cursor.com/docs/hooks) (`postToolUse`, `stop`), [plugins](https://cursor.com/docs/plugins), local stdio or remote HTTP MCP, and [MCP install links](https://cursor.com/docs/mcp/install-links) | `postToolUse` can return model-visible additional context; `stop` can return a follow-up message; MCP can expose `khala_read` | **Blocked (2026-09-25):** Cursor is not installed and no Cursor account is signed in, so no exact version/tier/policy tuple exists to key a trial. The [cursor-app kit](../../../experiments/interactive-cli/cursor-app/README.md) is ready for a person's own Agent Chat |
| Cursor cloud/background agent | Project/team hooks and remote MCP; [background-agent API](https://cursor.com/docs/background-agent) supports follow-up prompts | A hook deployed with the cloud environment may expose boundaries | **Blocked (2026-09-25):** no Cursor account and no existing cloud agent; creating or prompting a new one would violate the same-session rule. Cloud agents run no `sessionStart` or user-level hooks, so a trial needs project hooks committed to that agent's repository |
| Claude Desktop, local extension | Local stdio MCP packaged as a [desktop extension](https://support.anthropic.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop) | Explicit MCP tool calls can implement `khala_read` | **Blocked (2026-09-25):** Claude Desktop has no official Linux build and is not installed on the proof host; no documented prompt-injection hook was found. [Proof kit ready](../../../experiments/interactive-cli/claude-app/README.md) |
| Claude Desktop, remote connector | [Remote custom connector](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp) | Explicit remote MCP tool calls can implement `khala_read` | **Blocked (2026-09-25):** no installed app, no Claude account for the proof, and no operator-exposed public HTTPS endpoint. [Proof kit ready](../../../experiments/interactive-cli/claude-app/README.md) |
| claude.ai | Remote custom connector/MCP | Explicit remote MCP tool calls can implement `khala_read` | **Blocked (2026-09-25):** no claude.ai test account, and the agent must not drive a personal browser session; no documented active-tool or end-turn injection boundary was found. [Proof kit ready](../../../experiments/interactive-cli/claude-app/README.md) |
| Codex desktop surface | [Hooks](https://learn.chatgpt.com/docs/hooks), [plugins](https://learn.chatgpt.com/docs/plugins), and [MCP](https://learn.chatgpt.com/docs/extend/mcp) | `PostToolUse` may return model-visible output; `Stop` may block stopping with a continuation reason; MCP can expose `khala_read` | **Blocked** ([2026-09-25 record](../../../experiments/interactive-cli/codex-app/README.md)): no native Codex desktop app is installed on the Linux host, and `ChatGPT.desktop` is a browser launcher. There is no exact version, user-started session, or hook timing to observe |
| Codex cloud task | Environment-provided hooks/plugins and remote MCP; [cloud tasks](https://learn.chatgpt.com/docs/cloud) | A task environment may run a Khala hook or invoke `khala_read` | **Blocked** ([2026-09-25 record](../../../experiments/interactive-cli/codex-app/README.md)): the logged-in account has no existing task (`codex cloud list`: `No tasks found.`). The CLI cannot install hooks into a task environment, and `codex cloud exec` would submit a new task, which is not the user's session |

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
| Cursor local Agent Chat | **Blocked.** Candidate: `postToolUse` `additional_context` with one `mcp-inbox-batch`. Cursor is not installed on the proof host and has no version/tier/policy tuple | **Blocked.** Candidate: `stop.followup_message`, one per human turn and never after an aborted turn. Same install blocker; no idle wake is claimed | **Blocked.** Candidate: MCP `khala_read`, bound through the `beforeMCPExecution` caller record. Same install blocker |
| Cursor cloud/background agent | **Blocked.** Candidate: project `postToolUse` hook in the existing cloud agent. No account and no existing cloud agent | **Blocked.** Candidate: cloud `stop` hook. No account and no existing cloud agent | **Blocked.** Candidate: remote MCP `khala_read`. No account and no existing cloud agent |
| Claude Desktop, local extension | **Blocked** (`unknown`). No documented injection boundary; no Linux build, so no boundary could be inspected | **Blocked** (`unknown`). No documented end-turn continuation hook; no Linux build | **Blocked** (`unknown`). Candidate: MCPB extension `khala_read`; kit tested, no app run |
| Claude Desktop, remote connector | **Blocked** (`unknown`). No documented injection boundary; no installed app | **Blocked** (`unknown`). No documented end-turn continuation hook; no installed app | **Blocked** (`unknown`). Candidate: Streamable HTTP `khala_read`; kit tested, no app run |
| claude.ai | **Blocked** (`unknown`). No documented injection boundary; no test account | **Blocked** (`unknown`). No documented end-turn continuation hook; no test account | **Blocked** (`unknown`). Candidate: Streamable HTTP `khala_read`; kit tested, no browser-session run |
| Codex desktop surface | **Blocked.** Candidate: `PostToolUse` returns one batch; no native app on the proof host | **Blocked.** Candidate: `Stop` continuation; no native app on the proof host, so no loop proof | **Blocked.** Candidate: MCP `khala_read`; no native app on the proof host |
| Codex cloud task | **Blocked.** Candidate: task-environment `PostToolUse`; the account has no existing task | **Blocked.** Candidate: task-environment `Stop`; the account has no existing task | **Blocked.** Candidate: remote MCP `khala_read`; the account has no existing task |

### Recommended route by mode

- `steer`: test Cursor `postToolUse` and Codex `PostToolUse` first. Drain after the
  completed tool, never terminate the running tool, and keep hard abort behind a
  separate explicit capability and owner grant. Claude app shapes stay `unknown`: no
  equivalent boundary is documented, and none has been inspected in a live session.
- `sync` (default): test Cursor `stop.followup_message` and Codex `Stop` continuation.
  A bounded follow-up must not create an infinite self-wake loop. Claude app shapes
  stay `unknown` until a live session shows whether an end-turn primitive exists.
- `async`: expose exactly one bounded, ordered `khala_read` operation through local or
  remote MCP. This is the portable app route and the only recommended Claude route.

**Claude app adapter status (2026-09-25).** The adapter
([`packages/harnesses/src/claude-app/`](../../../packages/harnesses/src/claude-app/README.md))
ships fail-closed, as the Executor ruled. It has separate desktop-extension,
remote-connector, and browser records, and every mode is `unknown`. No route can be
selected until a graded exact-tuple proof lands. Setup detects Claude Desktop and
reports it as `claude-app` with its entry `unsupported`. Setup, status, and remove
say that delivery is unproven, and setup writes no Claude app config.

There is no approved PTY or UI-automation fallback for apps. Screen scraping and
synthetic keystrokes are fragile, can corrupt user input, and cannot prove context
consumption. If a native hook is absent, the cell stays Blocked instead of silently
starting a Khala-hosted agent or treating notification as delivery.

## Shared delivery and safety contract

1. A channel URL identifies a channel. An agent may list channels, request to join, or
   ask to create one through `channel-agent-listing`, `channel-access-cli-mcp`, and
   `channel-create-cli-mcp`, and inspect or change its own mode through
   `listening-mode-agent-controls`. D11 human confirmation is required before that
   agent is admitted. App routes reuse those operations and add none of their own.
2. Each delivery is one bounded, ordered `mcp-inbox-batch` containing stable event
   identities and an opaque batch token. The receiver performs no independent dedup.
3. Fetching does not acknowledge. The next authenticated Khala call presents the batch
   token; Khala advances the acknowledgement only after validating it. On disconnect,
   an unacknowledged batch may replay and an acknowledged batch must not.
4. Payload bytes travel in the authenticated request body, hook stdin, or MCP result.
   They never appear in argv, URLs, environment variables, process titles, or logs.
5. Receipts remain progressive: transport or hook acceptance is not model-context
   consumption. A `proven` cell must link exact-version raw evidence.
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

The current record of uninspected, Blocked cells is at
[`experiments/interactive-cli/desktop-apps/`](../../../experiments/interactive-cli/desktop-apps/README.md).
The Codex desktop and cloud cells were rechecked on 2026-09-25 in
[`experiments/interactive-cli/codex-app/`](../../../experiments/interactive-cli/codex-app/README.md).
That directory's verifier also rejects any Khala-started `codex` process (decision 24),
hosted sessions the desktop app did not start, Agents API runs, and new cloud tasks as
delivery. It rejects trust-bypass flags and their equivalents, including `--yolo`,
`danger-full-access`, and `never` approvals (decision 33), and it requires an idle-session trial for `steer` and `sync`
(decisions 34 and 37). It derives every trial fact from the raw trial file.

The Claude rows have a tested proof kit and checker in
[`experiments/interactive-cli/claude-app/`](../../../experiments/interactive-cli/claude-app/README.md):
an MCPB desktop extension and a Streamable HTTP connector, each exposing only `khala_read`.
Its `verify.mjs` grades a run for one exact app/shape/version/account/policy tuple. `async`
becomes proven only through an explicit `khala_read` round trip that shows all of:

- the batch token acknowledged on the next call;
- the marker echoed in a target conversation declared before the run, after delivery and before
  acknowledgement;
- the batch replayed across a restart before acknowledgement;
- no duplicate after acknowledgement.

The run also declares the app's MCP client name(s) up front. Server notifications, tool-list
changes, and calls from any client not on that list, including an unnamed one, never count. `steer`
and `sync` stay `unknown` unless a live session of that version records a proven absence. All
three Claude rows stay Blocked until a person runs the kit's runbook in their own session.

For Cursor, [`experiments/interactive-cli/cursor-app/`](../../../experiments/interactive-cli/cursor-app/README.md)
contains the trial kit. Its `verify.mjs` grades trial directories into `matrix.json`.
A cell becomes `proven` only when a single trial shows all of the following:

- same-session model context;
- the mode's boundary;
- acknowledgement on a later agent call;
- replay across a restart;
- no delivery after acknowledgement;
- a recorded launch of the running Cursor desktop app, with normal trust settings (decision 33). A `cursor-agent` CLI session never proves the app cell;
- for `steer` and `sync`, delivery to an idle chat (decisions 34 and 37).

The shipped `cursor-channel-adapter` ([`packages/harnesses/src/cursor/`](../../../packages/harnesses/src/cursor/README.md))
is fail-closed until that happens. Its proof table is empty and must match
`matrix.json`, so every Cursor mode reports `unknown`. Setup adds only the `khala` MCP
entry to `~/.cursor/mcp.json`, installs no hook, and reports that delivery is unproven.

The census comes from a raw process list, never from typed counts. A background
agent, any Cursor or `cursor-agent` process (matched anywhere in argv) with a Khala
ancestor or a parent missing from the census, a headless agent run, a bypass flag
(combined short flags such as `-pf` are split first) or "Run Everything" auto-run, a hook firing without a
model-context sighting, or a duplicate after restart leaves the cell `unknown`. The
kit has no idle wake, so it cannot prove Cursor `steer` or `sync`.

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
- App updates can invalidate evidence. Unknown, unsupported, or mismatched versions fail
  closed to `async` only when that exact pull route is proven; otherwise they fail closed
  entirely.

## Ticket contracts

Each contract is one agent/PR and uses channel terminology. Product code in the proof
tickets is throwaway; support changes only in the adapter tickets after evidence lands.

### `app-channel-contract`

| Field | Contract |
| --- | --- |
| Title | Identify app harness shapes and their hook boundaries |
| Complexity | 3 |
| Scope | Add only the app-specific harness identity: app shape (local chat, desktop extension, remote connector, browser, cloud task), app version, account tier and administrator-policy scope, and the hook boundary a route uses (`postToolUse`/`PostToolUse`, `stop`/`Stop`, or MCP `khala_read`). Listening modes, `ModeSupport`, grants, hard-cancel, acknowledgement, and evidence references come unchanged from `listening-mode-contract` (decision 6) |
| Out of scope | New mode, support, grant, or evidence vocabulary; vendor adapters; setup automation; claims for any unproved version |
| Files/packages | New `packages/contracts/src/delivery/app-harness.ts`, its fixtures and tests; a minimal export from `packages/contracts/src/delivery/index.ts` |
| Acceptance | An app capability record is keyed by the full shape/version/account-policy tuple; the hook boundary decodes strictly; every mode value is the `listening-mode-contract` type, and an uninspected tuple reports `unknown` |
| Wrong-implementation test | A generic `vendor: "cursor"` record, or a record that redefines mode, support, or evidence fields, must fail to decode; a Cursor cloud tuple cannot match a Cursor local session |
| Blocked-by | `listening-mode-contract` |
| Conflict risk | Medium in `packages/contracts/src/delivery/`; land after `listening-mode-contract` and add a new module rather than editing `harness.ts` |

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
| Acceptance | Desktop-local, desktop-remote, and browser rows each have exact-version evidence; a `steer`/`sync` cell becomes `unsupported` only on a proven negative and is never simulated |
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
| Scope | Package only the proven hook/MCP routes, exact version/policy inspection, bounded continuation, and batch-token acknowledgement; add Cursor's entries to the agent-run `npx @aiur/khala setup` plan and its `status`/`remove` (decisions 18 and 22) |
| Out of scope | Unproved cloud/local shapes, hard abort, background-agent orchestration, and any install step the person runs by hand |
| Files/packages | `packages/harnesses/src/cursor/`, new Cursor modules in `packages/agent-cli/src/`, `tests/conformance/` |
| Acceptance | Capability output matches proof tuples; unknown or unsupported shapes fail closed; setup writes Cursor config only after the person confirms the printed plan through the agent, `remove` restores it, and payload bytes never enter URL/argv/logs |
| Wrong-implementation test | A cloud proof cannot enable local support, and a `postToolUse` receipt alone cannot report context consumption |
| Blocked-by | `cursor-channel-proof`, `app-channel-contract`, `channel-access-cli-mcp`, `channel-create-cli-mcp`, `listening-mode-agent-controls`, `setup-cli-plan`, `mcp-result-piggyback` |
| Conflict risk | Medium in the shared harness registry and CLI setup commands |

### `claude-app-channel-adapter`

| Field | Contract |
| --- | --- |
| Title | Implement the evidence-scoped Claude app adapter |
| Complexity | 4 |
| Scope | Package the proven local-extension and remote-connector pull routes, and add their entries to the agent-run `npx @aiur/khala setup` plan and its `status`/`remove` (decisions 18 and 22); add push modes only if their proof ticket supplies an actual injection boundary |
| Out of scope | Polling disguised as `sync`, UI automation, unproved push modes, and any install step the person runs by hand |
| Files/packages | `packages/harnesses/src/claude-app/`, new Claude app modules in `packages/agent-cli/src/`, `tests/conformance/` |
| Acceptance | Desktop and browser capability records are separate; `async` performs one bounded read and acknowledges only on the next authenticated call |
| Wrong-implementation test | Receiving an MCP notification must not promote `steer`, and absent push proof must not silently map `sync` to polling |
| Blocked-by | `claude-app-channel-proof`, `app-channel-contract`, `channel-access-cli-mcp`, `channel-create-cli-mcp`, `listening-mode-agent-controls`, `setup-cli-plan`, `mcp-result-piggyback` |
| Conflict risk | Medium in the shared harness registry and CLI setup commands |

### `codex-app-channel-adapter`

| Field | Contract |
| --- | --- |
| Title | Implement the evidence-scoped Codex app adapter |
| Complexity | 4 |
| Scope | Package only proven desktop/cloud hook and MCP routes with exact environment inspection, bounded Stop continuation, and batch-token acknowledgement; add their entries to the agent-run `npx @aiur/khala setup` plan and its `status`/`remove` (decisions 18 and 22) |
| Out of scope | Starting new tasks, hard abort, treating web installation as local hook deployment, and any install step the person runs by hand |
| Files/packages | `packages/harnesses/src/codex-app/`, new Codex app modules in `packages/agent-cli/src/`, `tests/conformance/` |
| Acceptance | Desktop and cloud task evidence scopes stay distinct; hosted-tool hook bypass fails closed; hard abort remains opt-in and separate |
| Wrong-implementation test | Installing a web plugin must not imply local hook scripts ran, and launching a new Codex task cannot satisfy same-session delivery |
| Blocked-by | `codex-app-channel-proof`, `app-channel-contract`, `channel-access-cli-mcp`, `channel-create-cli-mcp`, `listening-mode-agent-controls`, `setup-cli-plan`, `mcp-result-piggyback` |
| Conflict risk | Medium in the shared harness registry and CLI setup commands |

### Inputs to acceptance

There is no app acceptance ticket. The `acceptance` area owns every acceptance run,
test script, and log verification (decisions 10 and 11). Each adapter ticket supplies
only its app-side inputs for that area to consume: the exact app shape and version
tuple its evidence covers, the setup step the agent runs, and the modes it may claim.
An app joins an acceptance run only after its adapter lands with `proven` cells;
Blocked or `unknown` cells stay out of the run.

Implementation order is `app-channel-contract`, then the three independent proof
tickets, then only the adapters justified by those proofs. The adapters also wait for
the shared channel operations (`channel-access-cli-mcp`, `channel-create-cli-mcp`,
`listening-mode-agent-controls`) and for `setup-cli-plan`. A Blocked proof cell is a
valid research result but cannot unblock an adapter for that mode.
