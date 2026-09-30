# Codex 0.159.2 existing-session MCP boundary

2026-09-30. This is a redacted diagnostic of the production Codex Join-Test
session, not a live hosted channel success claim. No invite, room identifier,
session identifier, token, proof key, cookie, or channel content is recorded.

| Boundary | Observation |
| --- | --- |
| Exact Codex Join-Test model session, reported in the shared agent message document | Neither `khala_connect` nor `khala_request_channel_access` is model-visible; no request or consent was submitted. |
| Same-terminal preflight after the reviewed CLI installation, reported by Join-Test | Codex 0.159.2 `supported:true`, native route `unknown`, `connected:false`, effective route `unavailable`, overall configuration `drifted`, MCP entry `ready`, hooks `awaiting_hook_review`. |
| Independent installed CLI check in the ticket workspace | `codex-cli 0.159.2`; `codex mcp list --json` lists an enabled `khala` entry. `codex mcp --help` offers list/get/add/remove/login/logout, with no reload command. |
| Khala CLI composition check in the ticket workspace | Overall configuration is `drifted` while Codex's `mcp_entry` is `ready` and hooks await review. The overall drift includes a separate Claude payload component. A bounded Codex probe in this sandbox can time out through the ambient launcher, so this workspace status cannot replace Join-Test's same-terminal preflight. |
| Existing isolated proof | [Fresh-session test](khala-622-codex-fresh-session.md) reached `mcp__khala__khala_read` from a newly started Codex 0.159.2 process and received typed `not_connected`. It did not prove the already-running Join-Test session. |

The setup adapter reads and edits Codex's on-disk MCP table. Its route value
`unknown` deliberately does not certify model delivery. The observed tool
inventory fits startup-bound registration: changing the global Khala
executable or config after Codex started did not inject tool definitions into
Join-Test's existing model session. The installed 0.159.2 CLI exposes no MCP
reload command, and a newly started process did receive Khala tools in the
isolated proof. The setup state `drifted` is aggregate and cannot be
used to infer that Codex's `mcp_entry` is drifted. Hook trust governs automatic
delivery separately; it does not create missing MCP request tools.

The smallest safe recovery is for Join-Test to stop its current Codex process
and resume **its own conversation** in the same terminal with `codex resume`,
selecting the exact prior conversation rather than a new agent. On resumption,
verify the model can see Khala's native tools and that its native session
descriptor still identifies the intended conversation before using the
owner's existing hosted link. The agent may then submit one native access
request, preserve its operation identifier across proof-key and access
approval steps, and attempt a native read and send only after a connected
outcome. If the tool remains absent, keep access fail-closed and report the
provider tool-registration failure. No shell connect or browser invite visit
substitutes for a native call.

This ticket cannot assert a live read/send outcome until Join-Test performs
that exact model-visible call after resuming. [Official OpenAI plugin session
documentation](https://developers.openai.com/api/docs/guides/agents-api/tools/plugins)
also says existing sessions do not reload tools; the installed Codex CLI's
`mcp` command surface provides no reload operation. The source-backed and
observed conclusion is a current-session tool-registration limitation. No
hosted authorization result exists for this session yet.
