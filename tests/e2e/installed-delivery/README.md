# Installed delivery

Package and integration tests passed twice while the **installed** runtime path for a
harness was never wired. Claude ran `claudeCapabilities(null)` behind a read port that
always threw (#418), and the OpenCode plugin ran `unavailableOpenCodeDependencies()`
(#430). Only a live proof caught either one. This suite is that proof in CI.

```sh
node --test tests/e2e/installed-delivery/installed-delivery.test.mjs
```

It reuses the setup acceptance harness (`tests/integration/agent-setup/harness.mjs`). The
suite packs `@aiur/khala`, or takes `KHALA_SETUP_TARBALL`, and installs it offline
outside the repository. Each journey then runs on its own synthetic machine:

1. `khala setup` runs into a temporary `HOME`. The PATH holds only fake `claude`,
   `codex`, `opencode` and `cursor` executables that answer the supported version.
2. The installed package starts `khala internal`. The owner redeems the printed
   bootstrap URL exactly as their browser does.
3. The suite drives that harness's entry exactly as its config writes it. Nothing
   imports Khala source.

CI runs it after the setup gate. The release workflow runs it against the exact
tarball it publishes. `KHALA_SETUP_KEEP=1` keeps the scratch machines.

## The journeys

| Harness | Entry, as read from its config | Journey |
| --- | --- | --- |
| Claude | `~/.claude/settings.json` → marketplace → plugin `.mcp.json` (spawned with `CLAUDE_CODE_SESSION_ID`) and `hooks/hooks.json` (run through `sh -c` with `CLAUDE_PLUGIN_ROOT`) | `khala_request_channel_access` → owner approves → the installed Stop hook settles the grant → `khala_read` delivers → the next call (`khala_status`) advances the agent's read cursor, so the next read is empty → `khala_send` reaches the timeline → Stop: read refused `session_not_bound`, hooks silent |
| Codex | `~/.codex/config.toml` `mcp_servers.khala` (each call names its thread in `_meta.threadId`) and `~/.codex/hooks.json`, trusted as Codex's review dialog records it | `khala internal discovery` + `join` under the thread ID, as the skill says → owner approves → `join` connects → the installed UserPromptSubmit hook delivers → `khala_read` returns the batch again until the next call acknowledges it → `khala_send` with `ackBatchToken` advances the read cursor, so the read is empty → Stop: read refused `not_connected`, hook silent |
| OpenCode | `~/.config/opencode/opencode.json` `plugin` URL, imported by `opencode-host.mjs` running as OpenCode 1.17.10. Only OpenCode's in-process client is a fake | discovery + `join` → owner approves → the plugin wakes the idle session with one `promptAsync` → `khala_read` returns that batch → `khala_send` with `ackBatchToken` advances the read cursor, so the read is empty → Stop: read refused `not_connected`, no further prompt |
| Cursor | `~/.cursor/mcp.json` `khala` | Every route is unproven (decisions 34 and 37), so the journey asserts the honest refusal, not a delivery. Setup reports route `unknown` and "idle agents receive messages only at their next turn". The approved binding shows `idleDelivery: unproven` and no proven mode to the owner. The entry refuses `khala_read` and `khala_send` with `not_connected` and never delivers the message. |

An empty next read only shows that the agent's local cursor moved. The owner sees the
acknowledgement only as an `agent_acknowledged` receipt for the delivered message. So
each delivering journey then reads the owner's `GET /api/v1/channels/:id/receipts`. The
suite asserts that receipt in its own subtest, so a missing receipt fails that harness
(#442).

Two more checks keep the suite honest:

- **Coverage.** The harnesses setup installs entries for must equal the journeys here.
  A newly installed harness fails until it has a journey.
- **Wrong implementation.** For each harness, the suite rewrites that harness's entry
  in its own config to a stub that binds nothing. The stub is an MCP server that isn't
  Khala's, hooks that do nothing, or an OpenCode plugin whose tools refuse. The
  harness's journey must then fail with a `DeliveryFailure` whose message starts
  `[<harness>]`.

Every step failure names its harness and step, for example
`[opencode] the plugin delivers the message to the idle session: timed out waiting for promptAsync`.

## Source regressions this suite catches

Each regression below was made in source and repacked, and then the suite ran:

| Regression | Failure |
| --- | --- |
| The OpenCode plugin built with `unavailableOpenCodeDependencies()` (#430, `main` before #432) | `[opencode] the plugin delivers the message to the idle session: timed out waiting for promptAsync` |
| `launcher.ts` claims the Claude route for an uninspected version, `inspectClaudeRoute(async () => null)` (the #418 class) | `[claude] khala_read delivers the message: {"kind":"refused","code":"unproven"}` |
| `cli/main.ts` no longer composes `sessionGrants` for the bare `mcp-serve` entry | `[codex] the MCP entry starts as Khala: MCP entry exited 2: {"ok":false,"error":"not_connected"}`, and the same for `[cursor]`, which runs that entry too |
