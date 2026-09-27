# Claude 2.1.283 native listening modes

The installed Claude Code 2.1.283 plugin was exercised in one ordinary interactive TUI with normal folder trust, the native default auto permission mode, and no trust or permission override. The Executor launched the TUI under decision 43; a person did not launch it. The owner explicitly granted the experimental route during the run. The native journal contains one session identity across the mode cells, restart and rejoin. No session ID, message body, marker, token, or private capture is retained here.

[`evidence.json`](evidence.json) contains only redacted observations. Its `hook` build was installed for busy and idle `sync` and `steer`; the later `mcpRepair` build repaired structured MCP results and was installed for the successful `async` read, pause/resume and Stop cells. The source diff between these builds leaves the native hook implementation unchanged. The earlier async attempt had a body-delivery defect and is **excluded**. Both exact package digests and source commits are retained as build provenance. The private native journal, raw captures and progress ledger remain outside the repository with the Executor for independent audit.

| Cell | Observed native behavior |
|---|---|
| Idle `sync` | After 46 seconds idle, the Stop-armed watcher woke the same session; a synchronous hook placed the human-authored message in native context and the model responded. |
| Busy `sync` | A human-authored message arrived during a tool. Delivery waited for the Stop boundary; the next Khala call increased its owner receipt count by one. |
| Busy `steer` | A message arrived during a tool. `PostToolUse` supplied context before the next tool started, without interrupting the running tool; the next Khala call acknowledged once. |
| Idle `steer` | After 46 seconds idle, the existing watcher woke the same session; context and model response appeared, followed by one next-call acknowledgement. |
| `async` | No automatic delivery occurred across tools and Stop for more than 46 seconds. The repaired native `khala_read` exposed the body to the model. Its fresh event was absent from owner acknowledgement facts before the next native call and appeared afterward. A failed batch from the earlier build is excluded from that correlation. |
| Pause/resume | While paused, tools, Stop and an explicit native read yielded no held message. Resuming released it into native context; the next call acknowledged it once. |
| Owner restart/rejoin | The same native session could not use its previous launch capability. Its explicit native request reused the approved operation and reactivated the binding under the new launch. |
| Owner Stop | One binding was revoked, none remained. Native read refused the now unbound session, no later message reached it, and the same CLI process completed a Bash command. |

`verify.mjs` checks the exact version and route, finite watcher bound, build lineage, required cells, event order, next-call receipt transitions, pause and Stop, and an exact content-free schema. `verify.test.mjs` changes each guard to prove the verifier refuses incomplete evidence. Run `node --test experiments/internal-mode/listening-modes/claude/verify.test.mjs` and `node experiments/internal-mode/listening-modes/claude/verify.mjs`.

The proof covers **human-authored releases** in this installed internal-mode build. It does not prove autonomous agent-to-agent release or wake, a watcher after its 3,000-second lifetime, an unbounded idle notification claim, hosted delivery, or the final application candidate. When no watcher is live, an idle message waits until the next native turn. `immediateNotification` therefore remains `unknown`; the static owner UI must not claim permanent idle reachability from this run.
