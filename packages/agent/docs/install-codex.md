# Install Khala for Codex 0.160.0

1. Use Node ≥ 22.23.2 and a checkout of this repository. From the checkout root,
   run `pnpm install` (provides `tsx`; the agent runs from TypeScript source).
   Check `codex --version` reports `codex-cli 0.160.0`. M1 has no npm-published
   package; do not install Khala from npm.

2. Remove the old install before adding the new one. In `$CODEX_HOME/config.toml`
   (default `~/.codex/config.toml`), delete the old `[mcp_servers.khala]` table
   and its preceding `# Khala MCP server, managed by` comment. Remove old
   `codex-hook` handlers from `hooks.json`; the installer below warns about any
   remaining ones. If `command -v khala` prints an old binary, identify its
   owner with `npm ls -g --depth 0` and remove it using the tool that installed it.

3. Put this checkout's CLI on PATH:
   ```sh
   mkdir -p ~/.local/bin
   ln -sf "$(pwd)/packages/agent/bin/khala.mjs" ~/.local/bin/khala
   export PATH="$HOME/.local/bin:$PATH"
   khala --version
   ```
   Keep this checkout and its installed dependencies available.

4. Append the MCP example:
   ```sh
   cat packages/agent/codex/config.toml.example >> "${CODEX_HOME:-$HOME/.codex}/config.toml"
   ```
   Edit the appended `env` paths to your shell's absolute `HOME` and
   `${XDG_STATE_HOME:-$HOME/.local/state}`. The MCP child uses a reduced
   environment; explicit paths keep its state aligned with the shell hooks.
   These are KM-112's provisional integration defaults, pending KM-151 live verification.

5. Install the three hooks:
   ```sh
   node packages/agent/codex/install-hooks.mjs install
   ```
   The installer preserves other handlers and creates `hooks.json.khala-bak`
   once. It accepts `--codex-home <dir>` to target a custom home. Remove any
   old `codex-hook` handlers it warns about before continuing.

6. Exit the existing Codex session, then run `codex resume <thread id>`.
   In **Hooks need review**, trust the **three** Khala hooks with command
   `khala hook deliver --harness codex` (UserPromptSubmit, PostToolUse and Stop).
   After updating, re-run `node packages/agent/codex/install-hooks.mjs install`,
   then approve the new `PostToolUse` hook in **Hooks need review**. Without that
   approval, Steer works like Sync.

7. Tell Codex “Join this Khala channel: <link>” with your channel link, and open
   the confirmation link it returns.

8. Known limits: untrusted hooks prevent delivery; queued notices cannot deliver
   messages until the hooks are trusted, and the waker caps attempts at two per
   cursor position. Sync delivers at the turn's Stop; Steer delivers at the next
   tool boundary
   without aborting the tool. Both modes wake idle sessions; Async delivers
   nothing automatically, so the agent uses `khala_read`. The waker acts only
   while the Khala MCP server runs.

To remove these hooks, run `node packages/agent/codex/install-hooks.mjs uninstall`
and remove the MCP table from your config. The backup is retained.
