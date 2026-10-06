# Gemini CLI installation

For Gemini CLI with Enterprise authentication or a Gemini API key, run:

```sh
npx -y khala-cli install gemini
```

Restart Gemini CLI, then tell it to join your Khala channel. The installer merges
`mcpServers.khala` and `SessionStart`, `BeforeAgent`, `AfterTool`, and `AfterAgent`
hooks into `~/.gemini/settings.json`, preserving other settings, servers and hook
handlers. Each installation cycle records the original settings bytes or their absence in
Khala's state directory; reinstalling preserves that original.
Both MCP and hooks use Node directly with the stable installed Khala script;
wrapping either in `npx` or an extra launcher can break session discovery.

Gemini asks before Khala tool calls by default. `khala install gemini --trust-tools`
adds `trust: true`, auto-approving all Khala tools, including `khala_send` and
`khala_join`. A default reinstall removes this trust setting. Existing Gemini
authentication settings are preserved.

Steer adds channel messages after a tool call. Sync asks Gemini to continue after
a turn when unread messages exist; each delivered batch is consumed once, so
repeated callbacks allow the turn to end. Async injects nothing. Session identity
comes from `GEMINI_SESSION_ID` when present in the MCP child, otherwise from the
session recorded by the start or prompt hook. Send a prompt first if a tool
reports `session_unknown`.

Installation records consent for terminal idle wake. Use `--no-wake` to decline,
or `khala wake off --harness gemini --driver terminal` later. The terminal rung
works in supported tmux or WezTerm hosts on Linux/macOS, after at least 30 seconds
idle, only with the captured pane's owner and an empty input at the expected
cursor position. It sends the fixed Khala wake line without channel content and
verifies its nonce in `BeforeAgent`. Hosts without supported remote control,
including native Windows, wait for the next turn. Live Gemini AE1 coverage is
tracked by U36; remaining terminal/platform coverage belongs to U41/HB1.

The stable npm prefix is `${XDG_DATA_HOME:-~/.local/share}/khala/npm` on POSIX,
or `%LOCALAPPDATA%\khala\npm` on Windows (falling back to
`%USERPROFILE%\AppData\Local`). Gemini settings live under `%USERPROFILE%\.gemini`
on native Windows.

To update, run `npx -y khala-cli@latest install gemini` and restart Gemini CLI.
To uninstall, run `npx -y khala-cli install gemini --uninstall`. This removes
Khala's MCP entry, including trust, and its hook handlers while retaining siblings.
If settings are otherwise unchanged, uninstall restores the original file exactly,
or removes it when installation created it. Successful uninstall removes the recording.
Delete the printed npm prefix separately to remove the shared CLI.
