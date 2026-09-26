# @khala/claude-plugin

The single user-scope Claude Code plugin (decision 27): the `khala` skill, the
hooks and the Khala MCP entry in one directory. `setup-cli-claude` installs it;
there is no separate installed `/khala` skill. This scaffold ships stub hooks
only. Hook bodies, the bundled skill and the installer arrive in later tickets
that edit disjoint parts of this package.

```text
.claude-plugin/plugin.json   manifest, name `khala`
hooks/hooks.json             the frozen hook registrations
hooks/*.mjs                  stubs: exit 0, no output, no imports, no network
.mcp.json                    the `khala` MCP entry
src/contract.ts              the frozen names below, as code
src/validate.ts              fails on any departure from them
```

## Frozen names

Changing any of these needs a decision, not a drive-by edit. `src/contract.ts`
is the source; `validatePlugin` enforces it.

| Surface | Frozen names |
|---|---|
| Plugin | `khala` |
| Hook events | `PostToolUse`, `Stop`, `SessionEnd`; the idle watcher is a second `Stop` entry with `asyncRewake` (#178 amendment, no `UserPromptSubmit`) |
| Hook commands | `hooks/post-tool-use.mjs`, `hooks/stop.mjs`, `hooks/stop-watcher.mjs`, `hooks/session-end.mjs` |
| Skill and commands | skill `khala`; exact forms `/khala send`, `/khala read`, `/khala create`, `/khala join <channel-url>`, `/khala who` |
| MCP entry | server `khala`, launched as `khala mcp-serve`; tools `khala_send`, `khala_read`, `khala_status` (carries tokens), `khala_listening_mode`, `khala_create_channel`, `khala_list_channels`, `khala_request_channel_access`, `khala_list_agents` |

The command and tool lists are the full planned set from decisions 24 and 30 and
the claude-plugin, room-discovery and listening-modes contracts. Later tickets
implement them; adding a name still needs a decision.

Who edits what: #252 owns `hooks/`, #253 owns `skills/khala/`, and #259 lives
outside this package.

The MCP entry embeds no port or token; the runtime reads them from the local
descriptor. Nothing in this package uses `--dangerously-*` flags or isolated
`--setting-sources` (decision 33).

## Verify

```sh
claude plugin validate packages/claude-plugin </dev/null
pnpm --filter @khala/claude-plugin test
```

The wrong-implementation test is
`pnpm --filter @khala/claude-plugin test -t "outside the frozen list"`: a
manifest that registers a hook event outside the frozen list must fail
validation. `claude plugin validate` alone accepts any real Claude event, so the
frozen-list check in `validatePlugin` is what rejects it.
