# Interactive Claude Code proof

This throwaway harness produced the installed-version evidence for [`interactive-claude.md`](../../../docs/product/internal-mode/interactive-claude.md). Every live run used the normal interactive TUI, agent-launched with default settings, and no trust-bypass or settings-isolation flags (E09 decision 33).

- `marketplace/` is a local plugin marketplace containing `khala-proof`: hooks (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, plus two `asyncRewake` watchers) and a stdio MCP server with `khala_read`, `khala_send`, and `khala_status`. `lib/store.mjs` models the Khala side of the batch-token contract: release, session binding and generation fencing, retained tokens, and acknowledgement on the agent's next Khala call.
- `khala-admin.mjs` is the peer/Khala side. `release` takes the message on stdin; `mode` and `watch` select the listening mode and idle-watcher variant; `keep-token` and `replay-ack` drive the restart and duplicate checks.
- `runs/<run>/events.jsonl` holds the raw timestamps. Every line carries `runId`, `cliVersion`, and the launch command; hook and MCP lines carry the Claude `sessionId`. Bodies appear only as byte counts and SHA-256, and tokens only as a 12-hex `tokenId`. `runs/<run>/tty.txt` holds the TTY captures.
- `live-proof.md` indexes the runs.
- `channel/` and `runs/channel-run/` are the earlier preview-gated channel experiment. It needed `--dangerously-load-development-channels`, so it is gate evidence only and is not part of the normal-trust matrix.

## Replay

```sh
# one time, in an empty git-initialised proof project (the project root must not be this repository)
claude plugin marketplace add <repo>/experiments/interactive-cli/claude/marketplace --scope local
claude plugin install khala-proof@khala-proof --scope local
mkdir ../<project>.khala-state
echo '{"runId":"steer","cliVersion":"2.1.282 (Claude Code)","launch":"claude"}' > ../<project>.khala-state/run.json
node <repo>/experiments/interactive-cli/claude/khala-admin.mjs mode ../<project>.khala-state steer
claude          # accept the folder-trust dialog once
# from another terminal, while a long tool runs:
printf 'marker' | node <repo>/experiments/interactive-cli/claude/khala-admin.mjs release ../<project>.khala-state
```

The hooks and MCP server are inert unless `<project>.khala-state/run.json` exists. State lives beside the project, never inside it.

## Validation

```sh
node --test experiments/interactive-cli/claude/probe.test.mjs
claude plugin validate --strict experiments/interactive-cli/claude/marketplace/plugins/khala-proof
claude plugin validate experiments/interactive-cli/claude/marketplace
```
