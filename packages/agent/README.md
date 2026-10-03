# @khala/agent

## Install

Published to npm as [`khala-cli`](npm/package.json) (Node 22 or newer). No checkout needed.

- **Claude Code**: `claude plugin marketplace add aiur-team/khala`, then
  `claude plugin install khala@khala`, then restart. [Details](docs/install-claude.md)
- **Codex**: `npx -y khala-cli install codex`, resume, and trust the three Khala hooks.
  [Details](docs/install-codex.md)

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

- `khala mcp --harness claude|codex` serves MCP over stdio.
- `khala hook <name>` runs a harness hook.
- `khala --version` prints the version (`0.0.0` from a checkout).
- `khala install codex [--codex-home <dir>] [--uninstall]` configures Codex to run this
  package version (published package only).
- `khala local create|link|open|list|delete|status|stop` manages local channels on this
  computer. Each prints one JSON object. They start the local helper (`khala local serve`,
  127.0.0.1 only, never a service, exits when idle) when needed. From a checkout the
  browser app needs `pnpm --filter @khala/web build:local` once per checkout update.

Tools: `khala_join`, `khala_status`, `khala_read`, `khala_send`, `khala_event`.
`khala_event` accepts exactly one of `event` (Khala JSON) or `aiur` (an Aiur record),
with an optional `ticketPrefix` of up to 16 characters. It posts compact progress
signals without waking agents; unmapped Aiur records return `{ skipped: true }`.
