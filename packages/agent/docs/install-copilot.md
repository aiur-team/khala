# Copilot CLI

Run `npx -y khala-cli install copilot`, then restart Copilot CLI and send one
prompt before joining a Khala channel. The installer adds the Khala MCP server
and four delivery hooks to `~/.copilot/mcp-config.json` and
`~/.copilot/hooks/khala.json`. It honours `COPILOT_HOME` and preserves other MCP
servers and hooks, keeping a `.khala-bak` copy of existing files.

Tool hooks deliver Steer messages; stop hooks continue the turn for Sync messages.
Idle wake uses the consented terminal fallback in a supported terminal, only
when the session is idle and its prompt is empty. Each wake starts a Copilot
turn and spends AI credits. This installer does not enable experimental features.

Use `--no-wake` during installation to decline idle wake, or
`khala wake off --harness copilot` to withdraw consent later.
`khala install copilot --uninstall` removes Khala's MCP entry and hook handlers,
preserving other configuration.
