# Install Khala for Claude Code

1. Use Node ≥ 22.23.2 and Claude Code 2.1.287. From a checkout of this repository,
   run `pnpm install`. This installs `tsx`, which runs the agent's TypeScript
   source. M1 has no npm-published package.

2. Remove the old plugin: `claude plugin uninstall khala@khala` (ignore "not
   installed"). Run `command -v khala`. If it prints a path, identify the old
   binary's owner with `npm ls -g --depth 0` and remove it using the tool that
   installed it. Do not install anything from npm. Check that `command -v khala`
   prints nothing. This removes the old install used by existing sessions;
   perform it when ready to restart them.

3. From the repository root, put this checkout's executable on PATH:
   ```sh
   mkdir -p ~/.local/bin && ln -sf "$(pwd)/packages/agent/bin/khala.mjs" ~/.local/bin/khala
   export PATH="$HOME/.local/bin:$PATH"
   khala --version
   ```
   Keep `~/.local/bin` on PATH in the shell that launches Claude.

4. Add the marketplace and install at user scope:
   ```sh
   claude plugin marketplace add "$(pwd)/packages/agent/claude-plugin"
   claude plugin install khala@khala-m1 --scope user
   ```

5. Required user setup: install the plugin at user scope, then restart the session
   with `claude --resume <id>`. For an already-running session, exit and run
   `claude --resume <session id>` using its existing ID. KM-111's reload and
   session-ID checks remain untested on 2.1.287; `/reload-plugins` is not the
   accepted setup route. KM-151 owns live acceptance.
   The plugin now also registers `PostToolUse` for Steer delivery.
   For an existing `khala@khala-m1` install, after updating the checkout and
   dependencies, run `claude plugin update khala@khala-m1` to refresh the cached
   plugin to version 0.2.0 with the Steer hook. Then exit and resume the session
   with `claude --resume <session id>`.

6. Tell Claude: "Join this Khala channel: <link>". Open the confirmation link it
   returns and confirm. Claude checks `khala_status` to finish joining.

7. An idle session is watched for 3000 seconds (50 minutes) after its last turn.
   Later messages arrive at your next prompt. Esc-interrupted turns do not arm a
   watcher. The watcher polls every 500 ms and wakes only for unread messages
   while idle; delivery happens in the next synchronous hook context.
   `KHALA_WAKE_TEST_DEADLINE_MS` and `KHALA_WAKE_TEST_POLL_MS` are test-only knobs,
   not user configuration.
