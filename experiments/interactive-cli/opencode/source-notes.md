# OpenCode 1.17.10 native-surface notes

Source references are pinned to the selected version rather than the moving
default branch.

| Surface | Exact-version finding | Mode consequence |
|---|---|---|
| [Plugin hooks](https://github.com/anomalyco/opencode/blob/v1.17.10/packages/plugin/src/index.ts) | Plugins receive all events and expose `tool.execute.after`, `experimental.chat.messages.transform`, tools, and the SDK client. | Combining the after-tool hook with the next message transform can implement non-abort `steer`. |
| [Session handler](https://github.com/anomalyco/opencode/blob/v1.17.10/packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts) | Session-addressed prompt, `promptAsync`, status/message reads, and abort exist. | `promptAsync` at idle can wake the bound TUI session for `sync`; acceptance alone is not consumption evidence. |
| [TUI handler](https://github.com/anomalyco/opencode/blob/v1.17.10/packages/opencode/src/server/routes/instance/httpapi/handlers/tui.ts) and [TUI events](https://github.com/anomalyco/opencode/blob/v1.17.10/packages/opencode/src/server/tui-event.ts) | `appendPrompt` and `submitPrompt` are directory/TUI controls, not session-addressed delivery. | Useful as a diagnostic fallback, but unsafe as the default because they can touch the focused draft or wrong session. |
| [Server authentication](https://github.com/anomalyco/opencode/blob/v1.17.10/packages/opencode/src/server/auth.ts) | Basic auth is enabled by `OPENCODE_SERVER_PASSWORD`; username defaults to `opencode`. | Headless server auth works, but the embedded TUI cannot authenticate to its own explicit-port server in this version. |
| [MCP client](https://github.com/anomalyco/opencode/blob/v1.17.10/packages/opencode/src/mcp/index.ts) | Server notifications handled by the client are logging and tool-list changes; no notification becomes a user prompt. | MCP tools provide agent-decided `async`; server-initiated notifications are hints only and cannot prove push delivery. |
| [Prompt loop](https://github.com/anomalyco/opencode/blob/v1.17.10/packages/opencode/src/session/prompt.ts) | The model context is rebuilt between tool rounds and runs the message-transform hook. | A batch queued by `tool.execute.after` can enter the next model call without aborting. |
| `attach`, ACP, SDK | These expose alternate clients/protocols but do not make a Khala-hosted or SDK-hosted agent count as the person's TUI. | Inventory only; not product routes for this operator decision. |
| Config reload / stdin | No native durable listening queue was found. Plugin config is loaded for the process; stdin belongs to the TUI. | Use the plugin and Khala's durable batch token, not config polling or synthetic stdin. |

Two negative empirical findings refine the source inventory:

1. Busy `promptAsync` accepted and displayed a user message but did not interrupt
   the current turn or produce the required `khala_send` action before tool 2.
2. Setting server authentication on the TUI's built-in explicit port caused the
   TUI's own provider request to receive `401 Unauthorized` and exit. See
   [`server-auth.md`](evidence/server-auth.md).
