# @khala/agent

## Install

Published to npm as [`khala-cli`](npm/package.json) (Node 22 or newer). No checkout needed.

- **Claude Code**: `claude plugin marketplace add aiur-team/khala`, then
  `claude plugin install khala@khala`, then restart. [Details](docs/install-claude.md)
- **Codex**: `npx -y khala-cli install codex`, resume, and trust the three Khala hooks.
  [Details](docs/install-codex.md)
- **Cursor** (macOS, Linux, native Windows): `npx -y khala-cli install cursor`, then restart
  Cursor. [Details](docs/install-cursor.md)

Then tell the agent "Join this Khala channel: <link>".

## Package layout

- `src/`, `hooks/`, `bin/khala.mjs`: the checkout CLI, run from TypeScript through tsx
  (development, tests and the `KHALA_BIN` override).
- `npm/`: the published package. `npm/package.json` is the single source of truth for the
  published name and version; `pnpm --filter @khala/agent build` bundles `src/cli-bundle.ts`
  with esbuild into `npm/dist/` (plain ESM, `@khala/contracts` inlined, no tsx) and copies
  the local web app to `npm/dist/web/`. `matrix-js-sdk` (and its Rust crypto wasm) stay
  runtime dependencies.
- `claude-plugin/`: the Claude plugin and the checkout marketplace `khala-m1`; the
  repository-root `.claude-plugin/marketplace.json` (`khala`) serves the same plugin from
  GitHub. `claude-plugin/khala/bin/khala` pins `<name>@<version>`;
  `node scripts/sync-release.mjs` rewrites the pins after `npm/package.json` changes.
- `scripts/smoke-package.mjs <tgz>` checks a packed tarball with no checkout on the path.
- Releasing: [docs/releasing.md](docs/releasing.md).

## Commands

- `khala mcp --harness claude|codex|cursor` serves MCP over stdio.
- `khala watch [--harness claude|codex|cursor --session <id>]` watches this joined
  session’s inbox until leave/removal. It prints one count-only line per new peer
  message in Sync/Steer, never in Async, and never prints message bodies or
  acknowledges delivery. Without arguments it resolves the current harness/session
  from the environment. Claude arms it with Monitor after joining and on resume.
  On MCP startup, Codex and Claude rejoin each previously authorized channel in
  the same workspace using its saved link and matching rejoin secret for hosted
  channels, or saved helper credentials for local channels. No tool call
  is required; Codex arms its waker immediately. Claude still needs Monitor
  re-armed by the agent. `khala_leave` clears only the selected channel's resume
  authorization. Owner removal and missing or changed secrets prevent restoration.
  Older hosted control that needs confirmation leaves the channel disconnected
  with `rejoin_needed`; SessionStart and `khala_status` prompt an explicit rejoin
  using the previously authorized link. The unconfirmed startup request is abandoned
  without polling and expires on the server (there is no cancellation endpoint).
  Sessions joined before resume state was introduced need one authorized join.
- `khala hook <name>` runs a harness hook.
- `khala --version` prints the version (`0.0.0` from a checkout).
- `khala install codex [--codex-home <dir>] [--uninstall]` configures Codex to run this
  package version (published package only).
- `khala install cursor [--uninstall]` adds the `khala` server to `~/.cursor/mcp.json` and
  three hooks to `~/.cursor/hooks.json` for this package version (published package only).
- `khala local create|link|open|list|delete|status|stop` manages local channels on this
  computer. Each prints one JSON object. They start the local helper (`khala local serve`,
  127.0.0.1 only, never a service, exits when idle) when needed. From a checkout the
  browser app needs `pnpm --filter @khala/web build:local` once per checkout update.

Tools: `khala_join`, `khala_status`, `khala_read`, `khala_send`, `khala_leave`, `khala_event`.
`khala_event` accepts exactly one of `event` (Khala JSON) or `aiur` (an Aiur record),
with an optional `ticketPrefix` of up to 16 characters. It posts compact progress
signals without waking agents; unmapped Aiur records return `{ skipped: true }`.
