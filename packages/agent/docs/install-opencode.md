# OpenCode

Run `npx -y khala-cli install opencode`, then restart OpenCode. The installer installs a stable Khala CLI and adds `khala-opencode@<exact CLI version>` to the global `opencode.json` plugin list, preserving other plugins and settings. The plugin registers Khala's local MCP server; no separate `mcp.khala` config is needed.

OpenCode's [global config](https://opencode.ai/docs/config/#global) is `${XDG_CONFIG_HOME:-~/.config}/opencode/opencode.json` on macOS and Linux, and `%USERPROFILE%\.config\opencode\opencode.json` on native Windows (or under an absolute `XDG_CONFIG_HOME`). The CLI is installed under `${XDG_DATA_HOME:-~/.local/share}/khala/npm` on POSIX and `%LOCALAPPDATA%\khala\npm` on Windows. An existing config is backed up once as `opencode.json.khala-bak`. Invalid JSON is left unchanged. `opencode.json.khala-plugin` records the managed plugin spec so an arbitrary test override can be replaced or removed later.

`khala install opencode --uninstall` removes the Khala plugin and any OpenCode Khala MCP entry while keeping sibling config. Delete the printed npm prefix separately to remove the CLI.

For testing unpublished builds only, `KHALA_INSTALL_SPEC` selects the CLI tarball and `KHALA_OPENCODE_PLUGIN_SPEC` overrides the plugin pin, for example `file:/tmp/khala-opencode-0.1.0.tgz`. Reinstall replaces the previous Khala plugin entry. Production installs use the exact version pin.

The plugin stamps `khala_session` on MCP calls so each OpenCode session gets its own Khala identity. Hook session mappings provide a fallback. Delivery hooks accept `session-start`, `prompt`, `post-tool`, `turn-end` and `idle`; stdout is the raw frame for the plugin to inject. Sync receives frames at turn end/idle, Steer after tools, and Async leaves reads to the agent. Idle wake and native plugin conformance are supplied by the OpenCode plugin unit (U22).
