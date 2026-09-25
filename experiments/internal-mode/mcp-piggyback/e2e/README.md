# MCP piggyback end-to-end proof

Proves the merged product MCP route inside an interactive Codex 0.154.0 TUI.
Results and commands are in
[`docs/evidence/mcp-piggyback.md`](../../../../docs/evidence/mcp-piggyback.md).

| File | Role |
|---|---|
| `serve.ts` | The MCP server Codex starts: product `runCli(['mcp-serve'])` with the real inbox, a fixture held binding, and a recording send port. Taps every JSON-RPC line into `<fixture>/events.jsonl`. |
| `khala.ts` | Khala side: `setup`, `enqueue` (canonical releases from stdin, never argv), and `status` (durable cursor). |
| `setup-project.mjs` | Writes the project-scoped `[mcp_servers.khala]` entry and the skill stand-in `AGENTS.md` (from `AGENTS.proof.md`). Codex's folder-trust prompt still gates it. |
| `kill-after-delivery.mjs` | Restart trial: SIGKILLs the interactive Codex process and the server right after a batch is written. |
| `collect.mjs` | Builds `evidence/live-run.json` from the tap logs and the Khala-call, prompt, and reply items of Codex's own rollouts. |
| `verify.mjs` | Checks the retained evidence against the contract; `test/verify.test.mjs` mutates it. |
| `headroom.ts` | Measures the product byte budget against complete serialized responses (`evidence/headroom.json`). |

Run from the repository root after `pnpm install`:

```sh
node --test experiments/internal-mode/mcp-piggyback/e2e/test/*.test.mjs
node experiments/internal-mode/mcp-piggyback/e2e/verify.mjs \
  experiments/internal-mode/mcp-piggyback/e2e/evidence/live-run.json
node_modules/.bin/tsx experiments/internal-mode/mcp-piggyback/e2e/headroom.ts
```

The TUIs are agent-launched with default settings, never user-started, and use
no trust-bypass flag. This is evidence code: production must not copy the
fixture binding or send port.
