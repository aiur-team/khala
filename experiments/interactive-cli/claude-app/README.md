# Claude Desktop and claude.ai proof (`claude-app-channel-proof`)

This directory holds the throwaway proof kit and the evidence for the three Claude app rows in
[`interactive-desktop-apps.md`](../../../docs/product/internal-mode/interactive-desktop-apps.md):
the Claude Desktop local extension, the Claude Desktop remote connector, and claude.ai.

## Result (2026-09-25)

No live Claude app session was available, so every cell in these rows is `unknown`. None is
`unsupported`, because no push boundary was inspected in a live session. The per-row reasons are in
[`evidence/<shape>/run.json`](./evidence/) and the graded output is in `evidence/<shape>/verdict.json`.

| Row | Blocked because |
| --- | --- |
| Desktop, local extension | Claude Desktop has no official Linux build, and none is installed on the proof host ([`host-inventory.txt`](./host-inventory.txt)). |
| Desktop, remote connector | Same as above. The row also needs a Claude account for the proof and a public HTTPS endpoint that only the operator may expose. |
| claude.ai | No claude.ai test account was provided, and the agent must not drive the operator's personal browser session. The connector also needs a public HTTPS endpoint. |

The kit below is complete and tested. A person with Claude Desktop on macOS or Windows, and a
claude.ai account, can produce the evidence by following the runbook. Running `verify.mjs` on the
result then grades each row.

## What counts

- **`async` is proven only by an explicit `khala_read` round trip.** The batch token appears only
  in the `khala_read` tool result. When the next `khala_read` call presents that token, the result
  must have reached a model context. `verify.mjs` also requires all of the following:
  - an operator-recorded echo of the marker in a target conversation declared in `run.json`
    (`targetConversations`), recorded after the batch was first delivered and before it was
    acknowledged;
  - a restart recorded after the first fetch, with the same batch replayed on a connection
    opened after that restart and before acknowledgement;
  - a restart recorded after acknowledgement, followed by a read on a new connection with no
    duplicate;
  - a single MCP client for the whole run, whose `clientInfo.name` is one of the
    `expectedClientNames` declared in `run.json` before the run.
- **Never delivery:** a server notification (`notifications/tools/list_changed`,
  `notifications/message`), a change in tool availability, or any call from an MCP client that the
  run did not declare, including a client with an empty or missing name. The check is an
  allowlist, so Claude Code, `mcp-remote`, the MCP inspector, and any other client fail the run.
  Claude Code and `mcp-remote` fail it even when `run.json` declares them.
  Any of these makes the run fail or stay `unknown`.
- **`steer` and `sync` are never simulated.** The kit has no push boundary. Claude Desktop and
  claude.ai document no active-tool or end-turn prompt-injection hook, so these cells stay
  `unknown`. A cell becomes `unsupported` only when an operator records a proven negative for that
  exact app version (`observe negative`). Polling is never mapped to `sync`.
- Evidence is keyed by the full tuple: app, shape, app version, account tier, administrator policy,
  and OS. A stdio (extension) run cannot grade a connector or browser row. The server cannot tell
  a Claude Desktop remote connector from claude.ai: Anthropic's cloud brokers both over the same
  HTTP route. For those two rows, the shape rests on the operator-recorded identity and
  conversation, so run each one separately with its own state directory.

## Files

- `lib/store.mjs`: the Khala side of the batch-token contract. Delivery is bounded
  (`MAX_BATCH`) and follows arrival order. Fetching never acknowledges. An unacknowledged batch
  replays unchanged. A token acknowledges exactly once. The log carries sizes, SHA-256 hashes,
  release ids, and a 12-hex `tokenId`, never message bodies or raw tokens.
- `lib/protocol.mjs`: MCP handling shared by both transports. It exposes one tool, `khala_read`.
- `server/stdio.mjs` and `manifest.json`: the desktop extension (MCPB).
- `server/http.mjs`: the remote connector, a minimal Streamable HTTP endpoint on loopback. It is
  proof-only and has no auth, so use synthetic markers only. An adapter must add OAuth.
- `khala-admin.mjs`: operator controls: `init`, `release` (the body on stdin only), `notify` (a
  content-free probe for the stdio extension only), and `observe`.
- `verify.mjs`: grades one run into mode support. It exits 1 on a wrong implementation.
- `proof.test.mjs` and `mutations.mjs`: tests for the kit and checker.

## Runbook (for a person with the app)

The person starts the app and the conversation. The agent never launches a model session.
Use normal trust settings: install and approve the extension or connector once, the way setup
would, and record that approval.

1. Prepare the state directory outside any project. Start from `evidence/<shape>/run.json`, fill in
   the exact app version (Claude > About), account tier, administrator policy, OS, and launch.
   Declare `expectedClientNames` (the app's MCP `clientInfo.name` for that version, as published or
   read from the app's own MCP log before the proof) and `targetConversations` (the id of the new
   conversation you will start for the proof). Remove `blocked`. Then run
   `node khala-admin.mjs init <state> <filled-run.json>`.
2. Install the route:
   - Local extension: run `npx @anthropic-ai/mcpb pack experiments/interactive-cli/claude-app`,
     open the `.mcpb` in Claude Desktop (Settings > Extensions), and choose `<state>` as the proof
     state directory.
   - Remote connector or claude.ai: run `KHALA_PROOF_STATE=<state> node server/http.mjs`, expose it
     over HTTPS by a route you choose, and add it as a custom connector (Settings > Connectors).
3. In a new conversation you started, release a marker:
   `printf 'KHALA-MARKER-<nonce>' | node khala-admin.mjs release <state>`. Then ask the model to
   call `khala_read` and to restate the marker. Record the echo:
   `node khala-admin.mjs observe <state> model-echo release=<id> conversation=<conversation id>`.
4. Before the model acknowledges, quit and reopen the app (or restart `server/http.mjs`). Run
   `observe <state> restart phase=before-ack`. In the same conversation, ask for `khala_read`
   again: the same batch must replay. Let the model acknowledge it with `ackBatchToken`.
5. Restart again and run `observe <state> restart phase=after-ack`. Then `khala_read` must return
   no messages.
6. Investigate push boundaries without inferring them. For the local extension, while the model is
   idle and again mid-turn, run `node khala-admin.mjs notify <state> tools_list_changed` (and
   `log_message`), and note whether the conversation changes. Record `observe <state> negative mode=<steer|sync>
   reason=<text>` only for a proven absence in that exact version. Record a process census with
   `observe <state> census processes=<n> note=<text>`.
7. Run `node verify.mjs <state>`. Copy `run.json`, `events.jsonl`, and the verdict into
   `evidence/<shape>-<app version>/`.

## Validation

```sh
node --test experiments/interactive-cli/claude-app/proof.test.mjs
node experiments/interactive-cli/claude-app/mutations.mjs
node experiments/interactive-cli/claude-app/verify.mjs experiments/interactive-cli/claude-app/evidence/browser
```

`mutations.mjs` reverts each guarded line in a temporary copy and confirms the suite fails. The
table lists each line, the test that fails when it is reverted, and whether that happened on
2026-09-25.

| Guarded line reverted | Test that fails | Result |
| --- | --- | --- |
| `store.mjs` replay of the outstanding batch (`if (outstanding)`) | fetching never acknowledges…; a complete explicit pull run… | KILLED |
| `store.mjs` duplicate-ack refusal (`if (batch.ackedAt)`) | fetching never acknowledges… | KILLED |
| `store.mjs` arrival-order `.sort()` | batches are bounded and leave in arrival order | KILLED |
| `store.mjs` logs a hash, not the body | payload bytes and raw batch tokens never reach the event log | KILLED |
| `store.mjs` reserved log fields written last | operator observations cannot forge reserved event fields | KILLED |
| `store.mjs` breaks a stale lock | a lock left by a server killed mid-read is broken | KILLED |
| `khala-admin.mjs` refuses `notify` on HTTP shapes | notify probes are refused on the HTTP shapes | KILLED |
| `http.mjs` 404 for an unknown session | remote connector speaks Streamable HTTP… | KILLED |
| `verify.mjs` async evidence gaps | wrong implementation: an MCP notification or tool-list change is not delivery | KILLED |
| `verify.mjs` declared-client allowlist (also rejects empty names) | wrong implementation: a run from any undeclared or unnamed client proves nothing | KILLED |
| `verify.mjs` rejects known non-app clients even when declared | wrong implementation: a known non-app client proves nothing even when run.json declares it | KILLED |
| `verify.mjs` declared clients and target conversations required | a run without declared app clients or target conversations is not graded | KILLED |
| `verify.mjs` echo between first delivery and acknowledgement | wrong implementation: an echo before delivery, after acknowledgement, or in another conversation… | KILLED |
| `verify.mjs` echo in a declared target conversation | wrong implementation: an echo before delivery, after acknowledgement, or in another conversation… | KILLED |
| `verify.mjs` one client per run | wrong implementation: an acknowledgement from a second Claude session… | KILLED |
| `verify.mjs` ack needs an identified client | an acknowledgement on a connection with no recorded client… | KILLED |
| `verify.mjs` replay ordered after a before-ack restart | a replay counts only after a recorded before-ack restart… | KILLED |
| `verify.mjs` read on a new connection after the after-ack restart | the after-ack restart counts only when a later connection reads again | KILLED |
| `verify.mjs` shape/transport match | wrong implementation: stdio evidence cannot claim the browser… | KILLED |
| `verify.mjs` no delivery after ack | a duplicate after acknowledgement or a reordered release fails the run | KILLED |
| `verify.mjs` arrival order | a duplicate after acknowledgement or a reordered release fails the run | KILLED |
| `verify.mjs` push mode needs a recorded negative | steer and sync become unsupported only on a recorded negative… | KILLED |
| `verify.mjs` identity gate for push modes | an incomplete identity tuple reports unknown for every mode | KILLED |

The MCP clients in `proof.test.mjs` are test drivers that stand in for the app. Their runs exercise
the checker and are never evidence.
