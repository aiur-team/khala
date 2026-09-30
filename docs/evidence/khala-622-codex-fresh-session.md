# Codex 0.159.2 fresh-session MCP and discovery proof

2026-09-30, Linux x86_64. The tested source commit was
`ba727b14806ee0663fa740928ac4a36f4c7aef9d` (merged PR #621). The
installed Codex executable was `@openai/codex` 0.159.2 (`codex-cli 0.159.2`).
The globally installed `@aiur/khala` reported package version 0.1.0 but had
an older setup bundle: its disposable-home dry run classified Codex 0.159.2 as
unsupported. This proof instead built the `@aiur/khala` 0.1.0 CLI from the
tested commit and installed its payload into a disposable home. The model
turn used existing Codex authentication; no credential value was recorded.
No production session, channel, invite, or Khala capability was used.

The initial source-built dry run also classified Codex as unsupported while
the explicit disposable `CODEX_HOME` path did not exist: `codex mcp list
--json` itself exits before reading configuration in that condition. Creating
the empty directory made the native probe succeed. The confirmed setup then
reported Codex version 0.159.2 supported, with skill and MCP entry `ready`,
hooks `awaiting_hook_review`, and delivery route `unknown`. `codex mcp list
--json` showed an enabled Khala stdio entry pointing to the staged launcher.
A direct MCP `initialize` / `tools/list` exchange with that launcher returned
protocol `2025-03-26`, server `khala-agent-cli`, and all 11 intended tools:
`khala_send`, `khala_read`, `khala_listening_mode`, `khala_list_channels`,
`khala_list_agents`, `khala_request_channel_access`,
`khala_channel_access_status`, `khala_create_channel`,
`khala_channel_create_status`, `khala_pair`, and `khala_connect`.

A newly started real `codex exec` session under this home exposed
`mcp__khala__khala_read` to the model. The model called it through Codex's
MCP tool route; the tool completed with structured
`{kind:"refused",code:"not_connected"}`, which is expected without a binding.
Codex's default `never` approval policy had blocked a previous disposable
MCP call before Khala received it. The successful call used Codex's
`--approve-for-me` option. While the successful session was still running,
`khala internal discovery --harness codex --session <that session's thread ID>`
returned `{ok:false,error:"not_running"}` and issued no descriptor. The
thread ID was taken from that running session's `thread.started` event, not
from another process or a generic `khala connect` invocation.

The confirmed discovery boundary is the absent owner-started internal
service in the isolated home. MCP registration and launch worked; the
model-visible call reached Khala's native route. No internal join, successful
read/send, hook execution, or hosted access is claimed. Those remain with
#523 after the hosted request path is ready. The older globally installed
Khala bundle must be replaced with the #621 build before the same setup works
through the ambient `khala` command.

Focused verification on the repository's pinned Node 22.23.2: 41 agent-cli
tests passed, including the opt-in installed-Codex setup contract; seven
agent-skill tests passed. The installed-Codex test previously spent its
deadline repeatedly snapshotting Codex-owned cache files after removal. It
now checks Khala's owned paths and the post-removal native MCP listing; the
existing confined filesystem tests retain byte-preservation coverage.
Repository `pnpm typecheck` and `pnpm lint` also passed.
