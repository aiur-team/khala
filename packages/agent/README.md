# @khala/agent

The `khala` bin runs from TypeScript source through tsx; no build step.

- `khala mcp --harness claude|codex` serves MCP over stdio.
- `khala hook <name>` runs a harness hook.
- `node packages/agent/bin/khala.mjs --version` prints the version.
- `khala local create|link|open|list|delete|status|stop` manages local channels on this
  computer. Each prints one JSON object. They start the local helper (`khala local serve`,
  127.0.0.1 only, never a service, exits when idle) when needed. The browser app needs
  `pnpm --filter @khala/web build:local` once per checkout update.

Tools: `khala_join`, `khala_status`, `khala_read`, `khala_send`, `khala_event`.
`khala_event` accepts exactly one of `event` (Khala JSON) or `aiur` (an Aiur record),
with an optional `ticketPrefix` of up to 16 characters. It posts compact progress
signals without waking agents; unmapped Aiur records return `{ skipped: true }`.
The MCP entry currently uses a placeholder client; channel operations await client wiring.

[Install for Claude Code](docs/install-claude.md) · [Install for Codex](docs/install-codex.md)
