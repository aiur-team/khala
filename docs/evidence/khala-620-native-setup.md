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
| Isolated local channel, operator-reported on candidate `a40dea4a` | Both installed sessions discovered and requested one channel, received owner approval, and returned `connected` on retry. Claude send and Codex reply send were accepted; each agent read one release and ACK returned empty. The owner browser showed both agents and messages. No hosted request was retried. |

The running Claude MCP process used the Sep 29 installed `khala.js` bundle.
That bundle requires Claude version `2.1.284` exactly, while the running
session reports `2.1.285`. Its local proof-key candidate inspection therefore
returns `unsupported`; the candidate client maps this to the typed
`unavailable` outcome before any hosted HTTP exchange. This is a code-path
cause for the observed retry, independent of the server-log inference. The
candidate build removes that exact-version admission gate. It records fixed
component/stage/result diagnostics, plus HTTP status when present, at the
pre-exchange and post-access activation stages. A Claude MCP host may hide
child stderr, so each process also writes those fields to its private Khala
state `hosted/diagnostics-<pid>.jsonl` file. No further live request was made.

Codex 0.159.2 may use its exact MCP session label for an owner-approved hosted
access request. Native queue and hook delivery remain unproven for that
version. Claude 2.1.285 retains an experimental delivery claim. The isolated
local channel proof applies to an earlier candidate; the backend
`unavailable` result leaves hosted join/read/send acceptance open.

The Codex CLI in this sandbox is wrapped by `npx`, which cannot write its
default npm cache under the agent filesystem policy. The actual installed
vendor binary passed the private-home contract; probing that binary directly
also reported version 0.159.2. The wrapper failure is a local test environment
limit, not evidence about hosted admission.
