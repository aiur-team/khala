# Claude app adapter

`@khala/harnesses/claude-app/index` covers Claude Desktop and claude.ai. It
reports one `AppHarnessRecord` per shape: `desktop_extension`,
`remote_connector`, and `browser`. `createClaudeAppHarness({ observe, clock, limits })`
implements `HarnessPort` for one shape.

**Status: fail-closed.** `claude-app-channel-proof` (#244) has no app run yet.
`CLAUDE_APP_EVIDENCE` is therefore empty and every mode is `unknown`, so no route can
be selected. The port refuses every submission with a connector-side `failed`
(`harness_unavailable`) receipt. It never launches, drives, or messages the app.

## Evidence rule

A mode is `proven` only by a row in `CLAUDE_APP_EVIDENCE` whose identity matches the
full tuple exactly: shape, app version, account tier, and administrator policy. A
tuple with any field that was not inspected never matches. The row must also show
delivery at that mode's own boundary:

| Mode | Boundary | Admitted delivery |
| --- | --- | --- |
| `steer` | `postToolUse` / `PostToolUse` | `model_context_injection` |
| `sync` | `stop` / `Stop` | `model_context_injection` |
| `async` | `khala_read` | `khala_read_result` (one bounded read; the next authenticated call acknowledges it) |

An MCP notification, a tool-list change, a second Claude session, or polling is
recorded as what it is. It never promotes a mode. In particular, `sync` never falls
back to polling. A desktop row does not prove the browser, another version, or
another account tier or policy.

Each row also carries its proof run's facts (`run`), and admission applies the
`claude-app-channel-proof` kit rules to them: exactly one MCP client, on the run's
declared `expectedClientNames` and never `claude-code` or `mcp-remote`; and a model
echo in a declared target conversation after the first delivery and before the
acknowledgement. A row that fails any rule is ignored.

To add a proven route, append the graded row from the proof's `verdict.json` and
cite it. The setup adapter (`@aiur/khala` `setup/adapters/claude-app`) plans no
writes until it can install a proven route.
