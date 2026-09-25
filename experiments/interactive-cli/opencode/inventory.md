# OpenCode inventory

Captured on `<executor-host>` on 2026-09-24.

## Installed versions

The issue's expected ordering had drifted. The shell `PATH` selected `1.17.10`,
while `mise exec` selected the Node-installed `1.15.6` executable.

```text
$ hostname
<executor-host>

$ command -v opencode
~/.local/share/mise/installs/opencode/1.17.10/opencode
$ opencode --version
1.17.10
$ sha256sum ~/.local/share/mise/installs/opencode/1.17.10/opencode
4536e58d53033b0c5ef4d25bbbe6715199a675b3fbec56f10997bb989b3e8c2b

$ mise which opencode
~/.local/share/mise/installs/node/lts/bin/opencode
$ mise exec -- opencode --version
1.15.6
$ readlink -f ~/.local/share/mise/installs/node/lts/bin/opencode
~/.local/share/mise/installs/node/24.18.0/lib/node_modules/opencode-ai/bin/opencode.exe
$ sha256sum ~/.local/share/mise/installs/node/24.18.0/lib/node_modules/opencode-ai/bin/opencode.exe
15a6e5f8f713b086704a4f156522a09f6ba539e054a456b955b1903085eca5fe
```

The proof target was the explicit `1.17.10` path. The isolated target catalog
resolved `deepseek/deepseek-flash` and `deepseek/deepseek-v4-pro`; the proof used
`deepseek/deepseek-flash`. The workspace pins `@opencode-ai/plugin` to
`1.17.10`; the user's unrelated global plugin configuration was not retained.

## CLI surface

`opencode --help` exposed the interactive TUI (default), `attach`, `serve`,
`web`, ACP, MCP management, session management, and these relevant TUI flags:

```text
--port          port to listen on (default 0)
--hostname      hostname to listen on (default 127.0.0.1)
--model         provider/model
--continue      continue the last session
--session       session id to continue
--prompt        prompt to use
```

`opencode attach --help` additionally exposed `--password` and `--username` for
Basic authentication. `opencode serve --help` did not expose password flags;
the server reads `OPENCODE_SERVER_PASSWORD` and
`OPENCODE_SERVER_USERNAME`. `opencode mcp --help` exposed add/list/auth/logout
and debug operations. There was no interactive stdin queue or remote-attach
command that supplied the three listening semantics by itself.

Message bodies were typed through the TUI's PTY. The OpenCode launch argv for
the 2026-09-25 mode proofs was `opencode --model deepseek/deepseek-flash`,
plus `--session <id>` on relaunch. It had no port, host, nonce, or channel
message. Hard abort was not invoked in any mode proof.
