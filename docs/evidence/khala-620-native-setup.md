# Current native setup and hosted request check

Observed on 2026-09-30 with installed Codex CLI 0.159.2 and Claude Code
2.1.285. This record contains route and typed outcome only; no invite,
session ID, operation ID, proof key, or credential is retained.

| Check | Redacted observation |
| --- | --- |
| Installed binaries | `codex-cli 0.159.2`; `2.1.285 (Claude Code)` |
| Real Codex setup contract, private home | MCP entry accepted and Khala skill discovered by the app server; hooks remain `awaiting_hook_review` until user trust |
| Real Claude setup contract, private home | `claude mcp list` resolved `plugin:khala:khala` from the setup-owned marketplace |
| Rebuilt local CLI against operator home | Codex version `supported:true`, skill/hooks/MCP absent, route `unknown`; Claude version `supported:true`, marketplace ready, plugin payload absent relative to this checkout, route `unavailable`; overall `connected:false` |
| Existing Claude session, operator-reported | Native MCP request returned `{ok:false,error:unavailable,next:reuse_operation_id}` at 16:17:52Z. Hosted function logs in the same two-minute window contained Duration entries, with no `hosted_channel_exchange` stage. |

The existing Claude observation localizes the failure to a point before hosted
channel exchange. It does not distinguish proof-key candidate inspection,
challenge or submission from discovery authorization, local journaling, or
the channel-link transport. The client now emits a fixed component/stage/result
and optional HTTP status on these failure paths, without request identifiers
or secrets. No further live request was made for this check.

Codex 0.159.2 may use its exact MCP session label for an owner-approved hosted
access request. Native queue, hook delivery, join, read, and send are still
unproven for that version. Claude 2.1.285 retains an experimental delivery
claim. A backend `unavailable` result leaves final join/read/send acceptance
open.

The Codex CLI in this sandbox is wrapped by `npx`, which cannot write its
default npm cache under the agent filesystem policy. The actual installed
vendor binary passed the private-home contract; probing that binary directly
also reported version 0.159.2. The wrapper failure is a local test environment
limit, not evidence about hosted admission.
