# Interactive Claude Code proof

This throwaway harness produced the installed-version evidence for [`interactive-claude.md`](../../../docs/product/internal-mode/interactive-claude.md). It never launches Claude as a hosted agent: every live case used a user-started interactive TTY.

- `probe-plugin/` contains the three hook probes.
- `stage-message.mjs`, `read-pending.mjs`, and `ack-batch.mjs` model the shared batch-token boundary. Released message bytes enter on stdin.
- `channel/` is the official stdio MCP channel shape adapted to Node's HTTP server.
- `runs/*/events.jsonl` contains raw timestamps without message bodies.
- `live-proof.md` correlates those timestamps with sanitized TTY observations.

Validation:

```sh
node --test experiments/interactive-cli/claude/probe.test.mjs
node --check experiments/interactive-cli/claude/probe-plugin/hooks/probe.mjs
node --check experiments/interactive-cli/claude/channel/server.mjs
claude plugin validate experiments/interactive-cli/claude/probe-plugin
npm --prefix experiments/interactive-cli/claude/channel ci --ignore-scripts
npm --prefix experiments/interactive-cli/claude/channel audit --omit=dev
```

The channel server's committed MCP config contains this workspace's absolute path because it records the exact empirical setup. Change both paths before replaying elsewhere. `config/`, debug logs, batch payload files, acknowledgements, and `node_modules/` are ignored.
