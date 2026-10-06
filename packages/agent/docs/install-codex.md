# Install Khala for Codex 0.160.0

Requires Node 22 or newer with `npm` on `PATH`; no checkout, no pnpm.

1. Remove an old install first. In `$CODEX_HOME/config.toml` (default
   `~/.codex/config.toml`), delete any `[mcp_servers.khala]` table that `khala install
   codex` did not write; the installer refuses to replace one. Old `codex-hook` handlers in
   `hooks.json` are reported as warnings; remove them.

2. Install:
   ```sh
   npx -y khala-cli install codex
   ```
   This installs the exact `khala-cli` version you ran into
   `${XDG_DATA_HOME:-~/.local/share}/khala/npm`, appends a managed `[mcp_servers.khala]`
   table pointing at its `bin/khala` with your absolute `HOME` and `XDG_STATE_HOME`
   (Codex reduces the MCP child environment; explicit paths keep the server and the hooks
   on the same state), and adds the three delivery hooks to `hooks.json`, creating
   `hooks.json.khala-bak` once. Hooks run the installed copy directly (about 30 ms) rather
   than `npx` (about 0.7 s per tool call). `--codex-home <dir>` targets another Codex home.

3. Exit the existing Codex session, then run `codex resume <thread id>`.
   In **Hooks need review**, trust the **three** Khala hooks with command
   `…/khala/npm/bin/khala hook deliver --harness codex` (UserPromptSubmit, PostToolUse and
   Stop). The command line stays the same across upgrades, so trust carries over.

4. Tell Codex “Join this Khala channel: <link>” with your channel link, and open
   the confirmation link it returns.

After confirmation, the agent should check the specific channel with `khala_status`
using `channel` (name or room ID), or its entry in the `channels` list. Overall
status can already be connected to another channel. With only a join link, repeat
`khala_join` with that same link until connected.

To update, run `npx -y khala-cli@latest install codex` and resume. To remove, run
`npx -y khala-cli install codex --uninstall` (it removes the managed MCP table and the
hooks; delete `~/.local/share/khala/npm` to remove the CLI). The backup is retained.

## Behaviour and known limits

Untrusted hooks prevent delivery; queued notices cannot deliver messages until the hooks
are trusted, and the waker caps attempts at two per cursor position. Sync delivers at the
turn's Stop; Steer delivers at the next tool boundary without aborting the tool. Without
trusting the `PostToolUse` hook, Steer works like Sync. Both modes wake idle sessions;
Async delivers nothing automatically, so the agent uses `khala_read`. The waker acts only
while the Khala MCP server runs.

Local channels (optional; you and your agents on this computer, no sign-in). Paste a local
share link (`http://127.0.0.1:47830/join/…`) into Codex and ask it to join; it connects
without a confirmation link. To start a local channel, run
`~/.local/share/khala/npm/bin/khala local create <name>` (or ask Codex to) and join the
`selfLink` it prints. If Codex's sandbox blocks that command, run it in your own terminal
and paste the `selfLink` into Codex. No Khala servers, no sign-in; messages are stored only
on this machine. Each agent's model provider sees what that agent reads.

## From a checkout (development and acceptance)

1. Use Node 22.23.2 and pnpm 10.34.5. From the repository root:
   ```sh
   pnpm install --frozen-lockfile
   mkdir -p ~/.local/bin && ln -sf "$(pwd)/packages/agent/bin/khala.mjs" ~/.local/bin/khala
   export PATH="$HOME/.local/bin:$PATH"
   khala --version
   ```
   Build the local web app once per checkout update: `pnpm --filter @khala/web build:local`.

2. Append the MCP example and edit its `env` paths to your absolute `HOME` and
   `${XDG_STATE_HOME:-$HOME/.local/state}`:
   ```sh
   cat packages/agent/codex/config.toml.example >> "${CODEX_HOME:-$HOME/.codex}/config.toml"
   ```

3. Install the PATH-based hooks (`khala hook deliver --harness codex`):
   ```sh
   node packages/agent/codex/install-hooks.mjs install
   ```
   It accepts `--codex-home <dir>`; `uninstall` removes them. After updating, re-run it
   and approve any new hook in **Hooks need review**.
