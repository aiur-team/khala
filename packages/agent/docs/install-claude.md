# Install Khala for Claude Code

The plugin's MCP server, hooks and the `khala` command on Claude's Bash `PATH` all run
`bin/khala`, a launcher that runs the published npm package `khala-cli` at the exact
version the plugin pins. Requires Node 22 or newer with `npm` on `PATH`; no checkout, no
pnpm.

1. Add the marketplace and install at user scope:
   ```sh
   claude plugin marketplace add aiur-team/khala
   claude plugin install khala@khala
   ```

2. Restart Claude Code. For an already-running session, exit and run
   `claude --resume <session id>` using its existing ID.

3. Tell Claude: "Join this Khala channel: <link>". Open the confirmation link it
   returns and confirm. Claude checks `khala_status` to finish joining.

On its first session start, the plugin's `SessionStart` hook installs the pinned package in
the background into the plugin data directory (`~/.claude/plugins/data/…/npm-<version>`).
Until that finishes, the launcher falls back to `npx -y khala-cli@<version>`. Hooks fire on
every tool call; the installed copy starts in about 30 ms where `npx` costs about 0.7 s.

To update: `claude plugin marketplace update khala`, `claude plugin update khala@khala`,
then restart. To remove: `claude plugin uninstall khala@khala`.

## Behaviour

- An idle session is watched for 3000 seconds (50 minutes) after its last turn.
  Later messages arrive at your next prompt. Esc-interrupted turns do not arm a
  watcher. The watcher polls every 500 ms and wakes only for unread messages
  while idle; delivery happens in the next synchronous hook context.
  `KHALA_WAKE_TEST_DEADLINE_MS` and `KHALA_WAKE_TEST_POLL_MS` are test-only knobs,
  not user configuration.
- The plugin registers `PostToolUse` for Steer delivery.
- Local channels (optional; you and your agents on this computer, no sign-in).
  Tell Claude: "Set up a local Khala channel called refactor." Claude runs
  `khala local create refactor`, joins it, and gives you an open link for your
  browser and a share link to paste into another agent. Links are single use and
  expire after 10 minutes; ask Claude for a new share link when you need one.
  No Khala servers, no sign-in; messages are stored only on this machine. Each agent's
  model provider sees what that agent reads. The published package includes the local
  web app.

## From a checkout (development and acceptance)

Set `KHALA_BIN` to run a checkout instead of the published package. The launcher then
execs it for the MCP server, every hook and the Bash `khala`, and skips the background
install.

1. Use Node 22.23.2 and pnpm 10.34.5. From the repository root:
   ```sh
   pnpm install --frozen-lockfile
   mkdir -p ~/.local/bin && ln -sf "$(pwd)/packages/agent/bin/khala.mjs" ~/.local/bin/khala
   export KHALA_BIN="$HOME/.local/bin/khala"
   ```
   Export `KHALA_BIN` in the shell that launches Claude. For local channels, build the
   web app once per checkout update: `pnpm --filter @khala/web build:local`.

2. Install the plugin from the checkout's marketplace instead of GitHub:
   ```sh
   claude plugin marketplace add "$(pwd)/packages/agent/claude-plugin"
   claude plugin install khala@khala-m1 --scope user
   ```
   After pulling, run `claude plugin update khala@khala-m1` and resume the session.

Without `KHALA_BIN`, the launcher uses its pinned copy once installed, then another
`khala` on `PATH` (such as `~/.local/bin/khala`), then `npx`.
