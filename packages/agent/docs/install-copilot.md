# Copilot CLI

Run `npx -y khala-cli install copilot`, then restart Copilot CLI,
join a Khala channel, then send one prompt to enable terminal wake. The installer adds the Khala MCP server
and four delivery hooks to `~/.copilot/mcp-config.json` and
`~/.copilot/hooks/khala.json`. It honours `COPILOT_HOME` and preserves other MCP
servers and hooks, keeping a `.khala-bak` copy of existing files.

Tool hooks deliver Steer messages; stop hooks continue the turn for Sync messages.
Idle wake uses the consented terminal fallback in a supported terminal, only
when the session is idle and its prompt is empty. Terminal wake becomes available
after the first prompt following a channel join. Each wake starts a Copilot
turn and spends AI credits. This installer does not enable experimental features.

Use `--no-wake` during installation to decline idle wake, or
`khala wake off --harness copilot` to withdraw consent later.
`khala install copilot --uninstall` restores unchanged existing files byte for
byte and deletes unchanged files created by the installer. If you edited a file,
uninstall removes only Khala's MCP entry or hook handlers, preserving your edits.
Uninstall also removes its backup and installed-content tracking files.
